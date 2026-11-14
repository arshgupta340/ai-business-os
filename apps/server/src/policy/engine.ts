// The approval engine (B-07, reworked at integration). The server connects as `abos_app`, which
// cannot write approval_requests or action_executions (SPEC D-10). So every change to those tables
// goes through one database routine, via the typed wrappers in @abos/db:
//   create an approval      -> createApproval            (the database rebuilds the material and checks the hash)
//   decide and enqueue       -> runtimeDecideAndEnqueue   (the database derives every idempotency key and inserts the steps)
//   expire past-due approvals-> runtimeExpireApprovals
//   run the local fact step  -> runtimeClaimExecution + finishExecution
// This file builds the exact material payload, stores the subject (order, booking or the fact it
// edits), writes the activity events the routines do not write, and maps routine refusals to the
// contract error codes. It never performs an external write.
import {
  ActionExecutionSchema, ApprovalRequestSchema, OrderSchema, BookingSchema, BusinessIdSchema, UserIdSchema,
  MessageChannelSettingSchema, ContactSchema, BookingCustomerSchema, FactKindSchema,
  BUNDLE_ACTIONS, APPROVAL_EXPIRY_MS, ACTION_TYPE_CAPABILITY, CAPABILITIES,
  executionStepsFor, cartHash, payloadHash, idempotencyKey, canonicalJson, hashCanonical, pickMaterialFields,
  type ApprovalRequest, type BundleType, type ActivityEventType, type ActivityEventPayloads, type ActorType,
  type ActionExecution, type ErrorCode, type FactEditApprovalRequest, type Order, type Booking, type JsonValue,
} from '@abos/contracts';
import { createApproval, finishExecution, runtimeClaimExecution, runtimeDecideAndEnqueue, runtimeExpireApprovals, type ExpiredApproval } from '@abos/db';
import { mapRow } from '../api/rows';
import { emitActivity } from './activity';
import {
  PolicyError, type PolicyDb, type PolicyDeps, type QueryInterface,
  type OrderProposalInput, type BookingProposalInput, type FactEditInput, type DecisionInput,
} from './types';

/** The worker ID the engine uses when it runs the one local step it owns, `local.fact.update`. */
export const FACT_UPDATE_WORKER = 'policy-fact-update';

type Row = Record<string, unknown>;

async function one(tx: QueryInterface, text: string, params: unknown[]): Promise<Row | undefined> {
  return (await tx.query(text, params)).rows[0] as Row | undefined;
}

/** The database clock for this transaction. `now()` is also the default of every created_at column. */
async function dbNow(tx: QueryInterface): Promise<Date> {
  const row = await one(tx, 'select now() as now', []);
  const value = row?.now;
  return value instanceof Date ? value : new Date(String(value));
}

/** Contract view of an execution row. The routine leaves capability_id empty, so it is derived from the action type (SPEC 2.3). */
export function executionFromRow(row: unknown): ActionExecution {
  const mapped = mapRow(row);
  const capability = ACTION_TYPE_CAPABILITY[mapped.actionType as keyof typeof ACTION_TYPE_CAPABILITY];
  const { capabilityId: _ignored, ...rest } = mapped;
  return ActionExecutionSchema.parse({ ...rest, ...(capability ? { capabilityId: capability } : {}) });
}

export function approvalFromRow(row: unknown): ApprovalRequest {
  return ApprovalRequestSchema.parse(mapRow(row));
}

/** Routine refusals carry a short prefix (packages/db README). Map each to the contract code. */
export function routineErrorCode(error: unknown): ErrorCode | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === '23505') return 'INVALID_STATE'; // a second PENDING approval for one subject
  const message = 'message' in error ? String((error as { message: unknown }).message) : '';
  const prefix = /^([A-Z]+):/.exec(message)?.[1];
  switch (prefix) {
    case 'SCOPE': return 'NOT_FOUND';
    case 'OWNER': return 'FORBIDDEN_BUSINESS';
    case 'HASH': return 'PAYLOAD_HASH_MISMATCH';
    case 'EXPIRED': return 'APPROVAL_EXPIRED';
    case 'DECIDED': return 'APPROVAL_ALREADY_DECIDED';
    case 'SUBJECT': case 'MATERIAL': case 'IDENTITY': case 'DECISION': return 'INVALID_STATE';
    default: return undefined;
  }
}

function rethrow(error: unknown): never {
  if (error instanceof PolicyError) throw error;
  const code = routineErrorCode(error);
  if (code) throw new PolicyError(code);
  throw error;
}

export function createPolicyEngine(db: PolicyDb, deps: PolicyDeps) {
  const squareEnvironment = () => deps.squareEnvironment ?? process.env.SQUARE_ENVIRONMENT;

  async function event<T extends ActivityEventType>(tx: QueryInterface, at: Date, businessId: string, correlationId: string,
    type: T, payload: ActivityEventPayloads[T], actorType: ActorType = 'system') {
    await emitActivity(tx, { id: deps.newId('evt_'), businessId, correlationId, type, payload, actorType, occurredAt: at.toISOString() });
  }

  async function assertOwner(tx: QueryInterface, businessId: string, ownerUserId: string) {
    BusinessIdSchema.parse(businessId);
    UserIdSchema.parse(ownerUserId);
    const business = await one(tx, 'select owner_id from public.businesses where id=$1', [businessId]);
    if (!business || business.owner_id !== ownerUserId) throw new PolicyError('FORBIDDEN_BUSINESS');
  }

  /** The call must exist in this business and be pinned to the version the proposal claims (SPEC 2.9). */
  async function assertCall(tx: QueryInterface, businessId: string, callId: string | undefined, agentVersionId: string) {
    const row = await one(tx, 'select agent_version_id, status from public.calls where id=$1 and business_id=$2 for update', [callId ?? '', businessId]);
    if (!row || row.agent_version_id !== agentVersionId) throw new PolicyError('FORBIDDEN_BUSINESS');
  }

  /** Stores the approval through the routine: payload is exactly the material, hashed as canonical JSON. */
  async function storeApproval(tx: QueryInterface, bundleType: BundleType, source: Record<string, unknown>,
    actorType: 'owner' | 'deployed_agent', actorId: string): Promise<ApprovalRequest> {
    const payload = pickMaterialFields(bundleType, source);
    const canonical = canonicalJson(payload);
    const row = await createApproval(tx, {
      businessId: payload.businessId, bundleType, subjectId: payload.subjectId, actorType, actorId,
      payload: payload as unknown as Record<string, unknown>, canonical, payloadHash: await hashCanonical(payload),
      actionBundle: [...BUNDLE_ACTIONS[bundleType]], expiresAt: payload.expiresAt,
    });
    return approvalFromRow(row);
  }

  async function requested(tx: QueryInterface, at: Date, a: ApprovalRequest, correlationId: string) {
    const recipient = 'messageRecipient' in a.payload ? a.payload.messageRecipient : undefined;
    await event(tx, at, a.businessId, correlationId, 'approval.requested', {
      approvalId: a.id, bundleType: a.bundleType, subjectId: a.subjectId, actionBundle: [...a.actionBundle], expiresAt: a.expiresAt,
      ...('totalMinor' in a.payload ? { totalMinor: a.payload.totalMinor } : {}),
      ...(recipient ? { recipientLast4: recipient.slice(-4) } : {}),
    }, a.actorType);
  }

  async function executionsOf(q: QueryInterface, approvalId: string): Promise<ActionExecution[]> {
    return (await q.query('select * from public.action_executions where approval_id=$1 order by step_index', [approvalId])).rows.map(executionFromRow);
  }

  async function approvalById(q: QueryInterface, approvalId: string, businessId: string): Promise<ApprovalRequest | undefined> {
    const row = await one(q, 'select * from public.approval_requests where id=$1 and business_id=$2', [approvalId, businessId]);
    return row ? approvalFromRow(row) : undefined;
  }

  /**
   * Runs `local.fact.update` for an approved fact edit: claim the step through the routine, supersede
   * the edited fact, insert the new verified version with the approved value, settle open conflicts on
   * that key, and finish the step. One transaction. Returns false when the step was not claimable
   * (already done, or claimed by another worker). The executor can call this for the same step; the
   * claim routine lets exactly one caller run it.
   */
  async function runFactUpdate(input: { businessId: string; executionId: string; workerId?: string }): Promise<boolean> {
    const workerId = input.workerId ?? FACT_UPDATE_WORKER;
    try {
      return await db.transaction(async (tx) => {
        const claimed = await runtimeClaimExecution(tx, { businessId: input.businessId, executionId: input.executionId, workerId });
        if (!claimed) return false;
        if (claimed.action_type !== 'local.fact.update') throw new PolicyError('CAPABILITY_NOT_ALLOWED');
        const at = await dbNow(tx);
        const a = await approvalById(tx, claimed.approval_id, input.businessId);
        if (!a || a.bundleType !== 'fact_edit' || a.state !== 'APPROVED' || !a.decidedBy) throw new PolicyError('INVALID_STATE');
        await event(tx, at, a.businessId, a.id, 'execution.started', { executionId: claimed.id, approvalId: a.id, actionType: 'local.fact.update', stepIndex: claimed.step_index, attempt: claimed.attempts });
        const p = a.payload;
        // The claim routine already checked this row against the signed material. Lock it and check again.
        const current = await one(tx, `select * from public.business_facts where id=$1 and business_id=$2 for update`, [p.subjectId, a.businessId]);
        if (!current || current.status !== 'verified' || current.version !== p.fromVersion || canonicalJson(current.value) !== canonicalJson(p.before)) {
          throw new PolicyError('INVALID_STATE', 'The fact changed after the edit was proposed.');
        }
        await tx.query("update public.business_facts set status='superseded' where id=$1", [p.subjectId]);
        const newId = deps.newId('fact_');
        await tx.query(`insert into public.business_facts (id, business_id, kind, key, value, source_type, status, confidence, version,
          supersedes_id, verified_at, verified_by, created_at, updated_at)
          values ($1,$2,$3,$4,$5::jsonb,'owner_ui','verified',1,$6,$7,$8,$9,$8,$8)`,
        [newId, a.businessId, p.kind, p.key, JSON.stringify(p.after), p.fromVersion + 1, p.subjectId, at, a.decidedBy]);
        // An owner-confirmed value for a key settles every open conflict on that key.
        await tx.query(`update public.fact_conflicts set state='resolved', resolved_fact_id=$4, resolved_by=$5, resolved_at=$6
          where business_id=$1 and kind=$2 and key=$3 and state='open'`, [a.businessId, p.kind, p.key, newId, a.decidedBy, at]);
        await event(tx, at, a.businessId, a.id, 'fact.changed', { factId: newId, kind: p.kind, key: p.key, fromVersion: p.fromVersion, toVersion: p.fromVersion + 1, sourceType: 'owner_ui' }, 'owner');
        await finishExecution(tx, { businessId: a.businessId, executionId: claimed.id, workerId, attempt: claimed.attempts, status: 'SUCCEEDED' });
        await event(tx, at, a.businessId, a.id, 'execution.succeeded', { executionId: claimed.id, actionType: 'local.fact.update' });
        return true;
      });
    } catch (error) { return rethrow(error); }
  }

  return {
    async createOrderProposal(input: OrderProposalInput): Promise<{ order: Order; approval: ApprovalRequest }> {
      const channel = MessageChannelSettingSchema.parse(input.messageChannel);
      if (Date.parse(input.quote.expiresAt) <= deps.now().getTime()) throw new PolicyError('QUOTE_EXPIRED');
      const contact = ContactSchema.parse(input.contact);
      if (!contact.messageConsent && channel !== 'qr_only') throw new PolicyError('VALIDATION_FAILED', 'A caller who declined messages must use qr_only.');
      const hash = await cartHash(input.cart);
      if (hash !== input.quote.cartHash) throw new PolicyError('QUOTE_EXPIRED', 'The cart changed after the quote.');
      try {
        return await db.transaction(async (tx) => {
          await assertCall(tx, input.businessId, input.callId, input.agentVersionId);
          // A repeated propose for the same call and cart returns the stored proposal.
          const existing = await one(tx, `select * from public.orders where business_id=$1 and call_id=$2 and cart_hash=$3
            and status='AWAITING_OWNER_APPROVAL' and approval_id is not null`, [input.businessId, input.callId, hash]);
          if (existing) {
            const approval = await approvalById(tx, String(existing.approval_id), input.businessId);
            if (approval?.state === 'PENDING') return { order: OrderSchema.parse(mapRow(existing)), approval };
          }
          const at = await dbNow(tx);
          const createdAt = at.toISOString();
          const expiresAt = new Date(at.getTime() + APPROVAL_EXPIRY_MS).toISOString();
          const fulfillment = { type: input.fulfillment.type, pickupAt: new Date(input.fulfillment.pickupAt).toISOString() };
          const order = OrderSchema.parse({ id: deps.newId('ord_'), businessId: input.businessId, callId: input.callId, status: 'AWAITING_OWNER_APPROVAL',
            cart: input.cart, cartHash: hash, quote: input.quote, totalMinor: input.quote.totalMinor, currency: input.quote.currency,
            contact, fulfillment, createdAt, updatedAt: createdAt });
          await tx.query(`insert into public.orders (id, business_id, call_id, status, cart, cart_hash, quote, total_minor, currency, contact, fulfillment, created_at, updated_at)
            values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12,$12)`,
          [order.id, order.businessId, order.callId, order.status, JSON.stringify(order.cart), order.cartHash, JSON.stringify(order.quote),
            order.totalMinor, order.currency, JSON.stringify(order.contact), JSON.stringify(order.fulfillment), at]);
          const approval = await storeApproval(tx, 'order_bundle', {
            businessId: order.businessId, subjectId: order.id, agentVersionId: input.agentVersionId, cartHash: order.cartHash,
            totalMinor: order.totalMinor, currency: order.currency, pickupAt: fulfillment.pickupAt,
            ...(contact.messageConsent && contact.messageRecipient ? { messageRecipient: contact.messageRecipient } : {}),
            messageChannel: channel, actionBundle: BUNDLE_ACTIONS.order_bundle, expiresAt,
          }, 'deployed_agent', input.agentVersionId);
          await tx.query('update public.orders set approval_id=$2 where id=$1', [order.id, approval.id]);
          await event(tx, at, order.businessId, order.callId, 'proposal.created', { subjectId: order.id, subjectType: 'order', callId: order.callId, totalMinor: order.totalMinor, currency: order.currency }, 'deployed_agent');
          await requested(tx, at, approval, order.callId);
          await event(tx, at, order.businessId, order.callId, 'order.status_changed', { orderId: order.id, callId: order.callId, to: 'AWAITING_OWNER_APPROVAL' });
          return { order: { ...order, approvalId: approval.id }, approval };
        });
      } catch (error) { return rethrow(error); }
    },

    async createBookingProposal(input: BookingProposalInput): Promise<{ booking: Booking; approval: ApprovalRequest }> {
      const channel = MessageChannelSettingSchema.parse(input.messageChannel);
      const customer = BookingCustomerSchema.parse(input.customer);
      if (!customer.messageConsent && channel !== 'qr_only') throw new PolicyError('VALIDATION_FAILED', 'A caller who declined messages must use qr_only.');
      if (!input.callId) throw new PolicyError('VALIDATION_FAILED', 'A booking proposal needs its call.');
      const callId = input.callId;
      try {
        return await db.transaction(async (tx) => {
          await assertCall(tx, input.businessId, callId, input.agentVersionId);
          const at = await dbNow(tx);
          const createdAt = at.toISOString();
          const expiresAt = new Date(at.getTime() + APPROVAL_EXPIRY_MS).toISOString();
          const booking = BookingSchema.parse({ id: deps.newId('bkg_'), businessId: input.businessId, callId, status: 'AWAITING_OWNER_APPROVAL',
            serviceId: input.serviceId, serviceName: input.serviceName, calendarId: input.calendarId,
            startUtc: new Date(input.startUtc).toISOString(), endUtc: new Date(input.endUtc).toISOString(), timezone: input.timezone,
            customer, createdAt, updatedAt: createdAt });
          await tx.query(`insert into public.bookings (id, business_id, call_id, status, service_id, service_name, calendar_id, start_utc, end_utc, timezone, customer, created_at, updated_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12)`,
          [booking.id, booking.businessId, callId, booking.status, booking.serviceId, booking.serviceName, booking.calendarId,
            booking.startUtc, booking.endUtc, booking.timezone, JSON.stringify(booking.customer), at]);
          const approval = await storeApproval(tx, 'booking_bundle', {
            businessId: booking.businessId, subjectId: booking.id, agentVersionId: input.agentVersionId, serviceId: booking.serviceId,
            calendarId: booking.calendarId, startUtc: booking.startUtc, endUtc: booking.endUtc, timezone: booking.timezone,
            ...(customer.messageConsent && customer.messageRecipient ? { messageRecipient: customer.messageRecipient } : {}),
            messageChannel: channel, actionBundle: BUNDLE_ACTIONS.booking_bundle, expiresAt,
          }, 'deployed_agent', input.agentVersionId);
          await tx.query('update public.bookings set approval_id=$2 where id=$1', [booking.id, approval.id]);
          await event(tx, at, booking.businessId, callId, 'proposal.created', { subjectId: booking.id, subjectType: 'booking', callId, serviceName: booking.serviceName, startUtc: booking.startUtc }, 'deployed_agent');
          await requested(tx, at, approval, callId);
          await event(tx, at, booking.businessId, callId, 'booking.status_changed', { bookingId: booking.id, callId, to: 'AWAITING_OWNER_APPROVAL' });
          return { booking: { ...booking, approvalId: approval.id }, approval };
        });
      } catch (error) {
        // The bookings no-overlap rule (per calendar) is the local slot lock (SPEC 2.9).
        if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '23P01') throw new PolicyError('SLOT_CONFLICT');
        return rethrow(error);
      }
    },

    /**
     * Flow D / P-09: the owner proposes a new value for an existing verified fact. The approval's subject
     * is the fact being edited (the database checks its version and value against the signed `before`).
     * Nothing changes until the owner confirms through the decision endpoint.
     */
    async proposeFactEdit(input: FactEditInput): Promise<{ approval: FactEditApprovalRequest }> {
      const kind = FactKindSchema.parse(input.kind);
      if (kind === 'menu_item') throw new PolicyError('CAPABILITY_NOT_ALLOWED', 'A menu item comes from Square, not from a fact edit.');
      try {
        return await db.transaction(async (tx) => {
          await assertOwner(tx, input.businessId, input.ownerUserId);
          if (input.resolvesConflictId) {
            const conflict = await one(tx, 'select kind, key, state from public.fact_conflicts where id=$1 and business_id=$2', [input.resolvesConflictId, input.businessId]);
            if (!conflict) throw new PolicyError('NOT_FOUND');
            if (conflict.state !== 'open') throw new PolicyError('INVALID_STATE');
            if (conflict.kind !== kind || conflict.key !== input.key) throw new PolicyError('VALIDATION_FAILED');
          }
          const current = await one(tx, `select * from public.business_facts where business_id=$1 and kind=$2 and key=$3 and status='verified' for update`, [input.businessId, kind, input.key]);
          // DATA-MODEL: versions start at 1 and the routine binds the edit to the current version, so a brand-new key cannot be proposed here.
          if (!current) throw new PolicyError('NOT_FOUND', 'There is no verified fact with that kind and key to edit.');
          if (canonicalJson(current.value) === canonicalJson(input.value)) throw new PolicyError('VALIDATION_FAILED', 'The new value equals the current value.');
          const at = await dbNow(tx);
          const expiresAt = new Date(at.getTime() + APPROVAL_EXPIRY_MS).toISOString();
          const approval = await storeApproval(tx, 'fact_edit', {
            businessId: input.businessId, subjectId: String(current.id), kind, key: input.key, fromVersion: Number(current.version),
            before: current.value as JsonValue, after: input.value, actionBundle: BUNDLE_ACTIONS.fact_edit, expiresAt,
          }, 'owner', input.ownerUserId);
          await requested(tx, at, approval, approval.id);
          if (approval.bundleType !== 'fact_edit') throw new PolicyError('INTERNAL');
          return { approval };
        });
      } catch (error) { return rethrow(error); }
    },

    /** API 3.7. The routine does the checks, the decision, the subject move, its audit events and the enqueue. */
    async decide(input: DecisionInput): Promise<{ approval: ApprovalRequest; executions: ActionExecution[] }> {
      const target = input.decision === 'approve' ? 'APPROVED' : 'REJECTED';
      const pending = await approvalById(db, input.approvalId, input.businessId);
      if (!pending) throw new PolicyError('NOT_FOUND');
      if (target === 'APPROVED' && (pending.bundleType === 'order_bundle' || pending.bundleType === 'price_edit') && squareEnvironment() !== 'sandbox') {
        throw new PolicyError('ENVIRONMENT_MISMATCH');
      }
      try {
        await db.transaction((tx) => runtimeDecideAndEnqueue(tx, {
          businessId: input.businessId, approvalId: input.approvalId, ownerUserId: input.ownerUserId,
          payloadHash: input.payloadHash, decision: target, reason: input.reason ?? null,
        }));
      } catch (error) {
        const code = routineErrorCode(error);
        if (code !== 'APPROVAL_ALREADY_DECIDED') return rethrow(error);
        // A repeat that differs only in its reason is still the same decision (AC-10).
        const current = await approvalById(db, input.approvalId, input.businessId);
        if (!current) throw new PolicyError('NOT_FOUND');
        if (current.state === 'EXPIRED') throw new PolicyError('APPROVAL_EXPIRED');
        if (current.state !== target) throw new PolicyError('APPROVAL_ALREADY_DECIDED');
      }
      const approval = await approvalById(db, input.approvalId, input.businessId);
      if (!approval) throw new PolicyError('NOT_FOUND');
      let executions = await executionsOf(db, approval.id);
      if (approval.bundleType === 'fact_edit' && approval.state === 'APPROVED') {
        const step = executions.find((e) => e.actionType === 'local.fact.update' && e.status === 'QUEUED');
        if (step && await runFactUpdate({ businessId: approval.businessId, executionId: step.id })) executions = await executionsOf(db, approval.id);
      }
      return { approval, executions };
    },

    runFactUpdate,

    /** The expiry sweep. The routine updates approvals, subjects and their audit in one statement per business. */
    async expireDue(businessId?: string): Promise<ExpiredApproval[]> {
      const ids = businessId ? [businessId] : (await db.query('select id from public.businesses order by id')).rows.map((r) => String((r as Row).id));
      const expired: ExpiredApproval[] = [];
      for (const id of ids) expired.push(...await runtimeExpireApprovals(db, id));
      return expired;
    },

    /**
     * Read-only gate the executor may call before a provider write. It re-checks the approval, the
     * step's place in the bundle, its key and the stored hash. A refusal writes `guardrail.refused`.
     */
    async authorizeStep(input: { executionId: string; businessId: string }) {
      return db.transaction(async (tx) => {
        let execution: ActionExecution | undefined;
        let a: ApprovalRequest | undefined;
        let reason: ErrorCode | undefined;
        const row = await one(tx, 'select * from public.action_executions where id=$1', [input.executionId]);
        if (!row) reason = 'NOT_FOUND';
        else if (row.business_id !== input.businessId) reason = 'FORBIDDEN_BUSINESS';
        else {
          const raw = await one(tx, 'select * from public.approval_requests where id=$1', [row.approval_id]);
          if (!raw) reason = 'NOT_FOUND';
          else if (raw.business_id !== input.businessId) reason = 'FORBIDDEN_BUSINESS';
          else if (raw.state !== 'APPROVED') reason = raw.state === 'EXPIRED' ? 'APPROVAL_EXPIRED' : 'INVALID_STATE';
          else {
            try {
              a = approvalFromRow(raw);
              if (await payloadHash(a.payload) !== a.payloadHash) reason = 'PAYLOAD_HASH_MISMATCH';
            } catch { reason = 'PAYLOAD_HASH_MISMATCH'; }
            if (!reason && a) {
              try { execution = executionFromRow(row); } catch { reason = 'CAPABILITY_NOT_ALLOWED'; }
              if (execution) {
                const step = executionStepsFor(a.bundleType).find((s) => s.stepIndex === execution?.stepIndex);
                if (step?.actionType !== execution.actionType || a.actionBundle[execution.stepIndex] !== execution.actionType) reason = 'CAPABILITY_NOT_ALLOWED';
                else if (!['QUEUED', 'RUNNING'].includes(execution.status)) reason = 'INVALID_STATE';
                else if (execution.capabilityId) {
                  const registered = await one(tx, 'select effect, approval_mode from public.capabilities where id=$1', [execution.capabilityId]);
                  const effect = CAPABILITIES[execution.capabilityId].effect;
                  if (!registered || registered.effect !== effect || registered.approval_mode !== 'required' || !['write', 'external_message'].includes(effect)) reason = 'CAPABILITY_NOT_ALLOWED';
                }
                if (!reason && squareEnvironment() !== 'sandbox') reason = 'ENVIRONMENT_MISMATCH';
                if (!reason && execution.idempotencyKey !== await idempotencyKey({ businessId: a.businessId, subjectId: a.subjectId, actionType: execution.actionType, approvalId: a.id })) reason = 'PAYLOAD_HASH_MISMATCH';
              }
            }
          }
        }
        if (reason) {
          const business = await one(tx, 'select id from public.businesses where id=$1', [input.businessId]);
          if (business) {
            const at = await dbNow(tx);
            const subject = a && (a.bundleType === 'order_bundle' || a.bundleType === 'booking_bundle')
              ? await one(tx, `select call_id from public.${a.bundleType === 'booking_bundle' ? 'bookings' : 'orders'} where id=$1`, [a.subjectId]) : undefined;
            await event(tx, at, input.businessId, a?.id ?? input.executionId, 'guardrail.refused', {
              ...(typeof subject?.call_id === 'string' ? { callId: subject.call_id } : {}),
              ...(row && /^exe_[A-Za-z0-9_]+$/.test(input.executionId) ? { executionId: input.executionId } : {}),
              ...(a ? { approvalId: a.id } : {}),
              reasonCode: reason,
              rule: reason === 'FORBIDDEN_BUSINESS' ? 'no_cross_business' : 'no_approval_bypass',
            });
          }
          return { ok: false as const, reason, code: reason };
        }
        if (!execution || !a) throw new PolicyError('INTERNAL');
        return { ok: true as const, execution, approval: a };
      });
    },
  };
}

export type PolicyEngine = ReturnType<typeof createPolicyEngine>;
