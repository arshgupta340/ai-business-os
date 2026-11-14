// The approval engine (B-07, reworked at integration). The server connects as `abos_app`, which
// cannot write approval_requests or action_executions (SPEC D-10). So every change to those tables
// goes through one database routine, via the typed wrappers in @abos/db:
//   create an approval      -> createApproval            (the database rebuilds the material and checks the hash)
//   decide and enqueue       -> runtimeDecideAndEnqueue   (the database derives every idempotency key and inserts the steps)
//   expire past-due approvals-> runtimeExpireApprovals
//   run the local fact step  -> runtimeClaimExecution + applyFactUpdate (0005: it supersedes or promotes, audits and finishes)
// This file builds the exact material payload, stores the subject (order, booking or the fact it
// edits), writes the activity events the routines do not write, and maps routine refusals to the
// contract error codes. It never performs an external write.
import {
  ActionExecutionSchema, ApprovalRequestSchema, PriceEditApprovalPayloadSchema, type PriceEditApprovalPayload, OrderSchema, BookingSchema, BusinessIdSchema, UserIdSchema,
  MessageChannelSettingSchema, ContactSchema, BookingCustomerSchema, FactKindSchema, FactConflictIdSchema, FactSourceTypeSchema,
  BUNDLE_ACTIONS, APPROVAL_EXPIRY_MS, ACTION_TYPE_CAPABILITY, CAPABILITIES,
  executionStepsFor, cartHash, payloadHash, idempotencyKey, canonicalJson, hashCanonical, pickMaterialFields,
  type ApprovalRequest, type BundleType, type ActivityEventType, type ActivityEventPayloads, type ActorType,
  type ActionExecution, type ErrorCode, type FactEditApprovalRequest, type Order, type Booking, type JsonValue,
} from '@abos/contracts';
import { applyFactUpdate, createApproval, runtimeClaimExecution, runtimeDecideAndEnqueue, runtimeExpireApprovals, type ExpiredApproval } from '@abos/db';
import { mapApprovalRow, mapRow } from '../api/rows';
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
  return ApprovalRequestSchema.parse(mapApprovalRow(row));
}

/**
 * The conflict a fact edit named when it was proposed (API 3.1 `resolvesConflictId`). It is not hashed
 * material, so it is not in `payload_canonical`. It is stored once, by `create_approval`, in the approval
 * row's `payload` beside the material: the database requires `payload` to contain the canonical material
 * (not to equal it), rebuilds the material from it, and freezes the column from insert, and abos_app
 * cannot write the table at all. So the ID travels from the proposal to the step inside the database,
 * and nothing a later request carries can set or change it.
 */
const RESOLVES_CONFLICT = 'resolvesConflictId';
/** Also read by the executor for a price edit's conflict (issue #96), from the stored approval row. */
export function namedConflictId(row: Row | undefined): string | undefined {
  const payload = row?.payload;
  const id = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Row)[RESOLVES_CONFLICT] : undefined;
  return typeof id === 'string' && FactConflictIdSchema.safeParse(id).success ? id : undefined;
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

  /**
   * FLOWS X1 for an approval refused by the overlap rule: AWAITING_OWNER_APPROVAL -> SLOT_CONFLICT (a move
   * the contract machine and 0005's bookings_runtime_guard allow), with booking.status_changed and
   * booking.slot_conflict. Alternatives (FLOWS X2) need a free/busy read, which the engine has no port
   * for, so the event carries none.
   */
  async function markSlotConflict(a: ApprovalRequest): Promise<void> {
    await db.transaction(async (tx) => {
      const row = await one(tx, 'select status, call_id, start_utc from public.bookings where id=$1 and business_id=$2 for update', [a.subjectId, a.businessId]);
      if (!row || row.status !== 'AWAITING_OWNER_APPROVAL') return;
      const moved = await tx.query("update public.bookings set status='SLOT_CONFLICT' where id=$1 and business_id=$2 and status='AWAITING_OWNER_APPROVAL' returning id", [a.subjectId, a.businessId]);
      if (moved.rows.length !== 1) return;
      const at = await dbNow(tx);
      const callId = row.call_id ? String(row.call_id) : undefined;
      const correlationId = callId ?? a.id;
      await event(tx, at, a.businessId, correlationId, 'booking.status_changed',
        { bookingId: a.subjectId, ...(callId ? { callId } : {}), from: 'AWAITING_OWNER_APPROVAL', to: 'SLOT_CONFLICT' });
      const startUtc = row.start_utc instanceof Date ? row.start_utc.toISOString() : new Date(String(row.start_utc)).toISOString();
      await event(tx, at, a.businessId, correlationId, 'booking.slot_conflict', { bookingId: a.subjectId, approvalId: a.id, startUtc, alternatives: [] });
    });
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
    // A proposal belongs to a live call (voice NOTES 1): an ended call cannot propose.
    if (row.status !== 'IN_PROGRESS') throw new PolicyError('INVALID_STATE', 'The call has ended.');
  }

  /** Stores the approval through the routine: payload is exactly the material, hashed as canonical JSON. */
  async function storeApproval(tx: QueryInterface, bundleType: BundleType, source: Record<string, unknown>,
    actorType: 'owner' | 'deployed_agent', actorId: string, beside: Record<string, string> = {}): Promise<ApprovalRequest> {
    const payload = pickMaterialFields(bundleType, source);
    const canonical = canonicalJson(payload);
    // `beside` is stored in the row's payload next to the material and is never hashed. The material
    // is spread last, so a field stored beside it can never replace a material field.
    const row = await createApproval(tx, {
      businessId: payload.businessId, bundleType, subjectId: payload.subjectId, actorType, actorId,
      payload: { ...beside, ...(payload as unknown as Record<string, unknown>) }, canonical, payloadHash: await hashCanonical(payload),
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
   * the edited fact, insert the new verified version with the approved value, resolve the one conflict
   * the proposal named (if it named one and it is still open), and finish the step. One transaction. Returns false when the step was not claimable
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
        // apply_fact_update re-checks the subject against the signed material under the lease, then either
        // supersedes the verified row and inserts the next version, or promotes the new-key draft to
        // verified version 1. It writes fact.changed and finishes the step in this transaction.
        const fact = await applyFactUpdate(tx, { businessId: a.businessId, executionId: claimed.id, workerId, attempt: claimed.attempts });
        // Review finding 2 and issue #97: only the conflict this approval named when it was proposed is
        // resolved, never "whatever is open on this key". The ID is read from the stored approval row, and
        // the update names the conflict, this business, the approved kind and key, and the open state, so
        // a conflict that was resolved meanwhile, or one opened later on the same key, is left alone. It
        // runs in the step's transaction: the fact and its conflict change together or not at all.
        const conflictId = namedConflictId(await one(tx, 'select payload from public.approval_requests where id=$1 and business_id=$2', [a.id, a.businessId]));
        if (conflictId) {
          const resolved = await tx.query(`update public.fact_conflicts set state='resolved', resolved_by=$5, resolved_at=pg_catalog.clock_timestamp(), resolved_fact_id=$6
            where id=$1 and business_id=$2 and kind=$3 and key=$4 and state='open' returning id`,
          [conflictId, a.businessId, a.payload.kind, a.payload.key, a.decidedBy, fact.id]);
          // apply_fact_update already wrote fact.changed for the version change and cannot take a conflict
          // ID. This second event says the conflict is resolved by that fact; like the "keep the current
          // value" event (api/conflicts.ts) it changes no version, so fromVersion equals toVersion.
          if (resolved.rows.length === 1) {
            await event(tx, at, a.businessId, a.id, 'fact.changed', { resolvedConflictId: conflictId, factId: String(fact.id), kind: a.payload.kind, key: a.payload.key,
              fromVersion: Number(fact.version), toVersion: Number(fact.version), sourceType: FactSourceTypeSchema.parse(fact.source_type) }, 'owner');
          }
        }
        await event(tx, at, a.businessId, a.id, 'execution.succeeded', { executionId: claimed.id, actionType: 'local.fact.update' });
        return true;
      });
    } catch (error) { return rethrow(error); }
  }

  /** Reuses a draft of this kind and key whose value equals `value`, or inserts one (owner_ui). */
  async function newKeyDraft(tx: QueryInterface, businessId: string, kind: string, key: string, value: JsonValue): Promise<string> {
    const drafts = (await tx.query(`select id, value from public.business_facts where business_id=$1 and kind=$2 and key=$3 and status='draft' order by created_at, id for update`,
      [businessId, kind, key])).rows as Row[];
    const same = drafts.find((d) => canonicalJson(d.value) === canonicalJson(value));
    if (same) return String(same.id);
    const id = deps.newId('fact_');
    await tx.query(`insert into public.business_facts (id, business_id, kind, key, value, source_type, status, version)
      values ($1,$2,$3,$4,$5::jsonb,'owner_ui','draft',1)`, [id, businessId, kind, key, JSON.stringify(value)]);
    return id;
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
          // orders.approval_id is written only by decide_and_enqueue (0005 guards it), so the pending
          // approval is found by its subject.
          const existing = await one(tx, `select o.*, a.id as pending_approval_id from public.orders o
            join public.approval_requests a on a.subject_id = o.id and a.business_id = o.business_id and a.bundle_type = 'order_bundle' and a.state = 'PENDING'
            where o.business_id=$1 and o.call_id=$2 and o.cart_hash=$3 and o.status='AWAITING_OWNER_APPROVAL' order by a.created_at desc limit 1`, [input.businessId, input.callId, hash]);
          // Issue #93 item 3: only a repeat with the same contact, pickup and channel is the same proposal.
          // The stored order is frozen from insert (0006) and orders are unique per call and cart, so a
          // changed recipient or pickup time for the same cart on the same call is refused, never merged
          // into the pending one: the owner only ever approves the details the caller confirmed.
          const pickupIso = new Date(input.fulfillment.pickupAt).toISOString();
          if (existing) {
            const approval = await approvalById(tx, String(existing.pending_approval_id), input.businessId);
            const { pending_approval_id: _p, ...orderRow } = existing;
            const stored = OrderSchema.parse(mapRow(orderRow));
            // consentAt is the time of each propose, so it is not a detail the owner approves.
            const material = (c: typeof contact) => ({ name: c.name, messageRecipient: c.messageRecipient ?? null, messageConsent: c.messageConsent });
            const same = canonicalJson(material(stored.contact)) === canonicalJson(material(contact))
              && stored.fulfillment.type === input.fulfillment.type && new Date(stored.fulfillment.pickupAt).toISOString() === pickupIso
              && (approval?.payload as { messageChannel?: string } | undefined)?.messageChannel === channel;
            if (approval?.state === 'PENDING') {
              if (same) return { order: { ...stored, approvalId: approval.id }, approval };
              throw new PolicyError('INVALID_STATE', 'A proposal for this cart is already waiting for the owner with different details.');
            }
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
          // Issue #93 "smaller": a repeated propose for the same call, service and start returns the stored
          // proposal, as an order repeat does. The database allows one booking row per call and slot
          // (bookings_one_proposal_per_call_slot, 0002), and assertCall holds the call row, so this lookup
          // and the insert below cannot interleave with another proposal of this call. The answer comes
          // from the database, so it is the same after a restart and from another server process.
          const startIso = new Date(input.startUtc).toISOString();
          const stored = await one(tx, 'select * from public.bookings where business_id=$1 and call_id=$2 and service_id=$3 and start_utc=$4 for update', [input.businessId, callId, input.serviceId, startIso]);
          if (stored) {
            const pendingRow = await one(tx, `select * from public.approval_requests where business_id=$1 and subject_id=$2 and bundle_type='booking_bundle' and state='PENDING'
              order by created_at desc limit 1`, [input.businessId, stored.id]);
            const approval = pendingRow ? approvalFromRow(pendingRow) : undefined;
            if (stored.status !== 'AWAITING_OWNER_APPROVAL' || !approval) throw new PolicyError('INVALID_STATE', 'This slot was already proposed on this call and is no longer waiting for the owner.');
            const had = BookingSchema.parse(mapRow(stored));
            const material = (c: typeof customer) => ({ name: c.name, messageRecipient: c.messageRecipient ?? null, messageConsent: c.messageConsent });
            const same = canonicalJson(material(had.customer)) === canonicalJson(material(customer))
              && new Date(had.endUtc).toISOString() === new Date(input.endUtc).toISOString() && had.calendarId === input.calendarId
              && (approval.payload as { messageChannel?: string }).messageChannel === channel;
            // The owner only ever approves the details the caller confirmed: a changed name, number or channel is refused.
            if (!same) throw new PolicyError('INVALID_STATE', 'A proposal for this slot is already waiting for the owner with different details.');
            return { booking: { ...had, approvalId: approval.id }, approval };
          }
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
          if (current && canonicalJson(current.value) === canonicalJson(input.value)) throw new PolicyError('VALIDATION_FAILED', 'The new value equals the current value.');
          const at = await dbNow(tx);
          const expiresAt = new Date(at.getTime() + APPROVAL_EXPIRY_MS).toISOString();
          // A brand-new key (0005): the subject is a draft row whose value is exactly `after`, with
          // fromVersion 0 and before null. Confirming promotes that draft to verified version 1.
          if (input.fromVersion !== undefined && input.fromVersion !== (current ? Number(current.version) : 0)) throw new PolicyError('VALIDATION_FAILED', 'The fact changed since it was read.');
          if (input.before !== undefined && canonicalJson(input.before ?? null) !== canonicalJson(current ? current.value : null)) throw new PolicyError('VALIDATION_FAILED', 'The fact changed since it was read.');
          if (current && input.subjectId !== undefined && input.subjectId !== String(current.id)) throw new PolicyError('VALIDATION_FAILED', 'The subject is not the verified fact.');
          let subjectId: string;
          if (current) subjectId = String(current.id);
          else if (input.subjectId !== undefined) {
            const draft = await one(tx, `select id, value from public.business_facts where id=$1 and business_id=$2 and kind=$3 and key=$4 and status='draft' for update`,
              [input.subjectId, input.businessId, kind, input.key]);
            if (!draft || canonicalJson(draft.value) !== canonicalJson(input.value)) throw new PolicyError('VALIDATION_FAILED', 'The subject is not a draft with this value.');
            subjectId = String(draft.id);
          } else subjectId = await newKeyDraft(tx, input.businessId, kind, input.key, input.value);
          // The same answer for the same subject returns the approval already pending for it.
          const pending = await one(tx, `select * from public.approval_requests where business_id=$1 and subject_id=$2 and bundle_type='fact_edit' and state='PENDING'
            and expires_at > $3 order by created_at desc limit 1`, [input.businessId, subjectId, at.toISOString()]);
          if (pending) {
            const existing = approvalFromRow(pending);
            if (existing.bundleType === 'fact_edit' && canonicalJson((existing.payload as { after: unknown }).after) === canonicalJson(input.value)) {
              // The stored approval is frozen. It is the same proposal when it named the same conflict, or
              // when this repeat names none. It can never gain a conflict it was not proposed with.
              const named = namedConflictId(pending);
              if (!input.resolvesConflictId || input.resolvesConflictId === named) return { approval: existing };
              throw new PolicyError('INVALID_STATE', 'This edit is already waiting for confirmation without the conflict. Decide it first, then keep the current value on the conflict.');
            }
          }
          const approval = await storeApproval(tx, 'fact_edit', {
            businessId: input.businessId, subjectId, kind, key: input.key, fromVersion: current ? Number(current.version) : 0,
            before: current ? current.value as JsonValue : null, after: input.value, actionBundle: BUNDLE_ACTIONS.fact_edit, expiresAt,
          }, 'owner', input.ownerUserId, input.resolvesConflictId ? { [RESOLVES_CONFLICT]: input.resolvesConflictId } : {});
          await requested(tx, at, approval, approval.id);
          if (approval.bundleType !== 'fact_edit') throw new PolicyError('INTERNAL');
          return { approval };
        });
      } catch (error) { return rethrow(error); }
    },

    /**
     * P-11 price change (api/prices). Stores a PENDING price_edit approval through create_approval and
     * writes approval.requested, in one transaction. An identical pending proposal for the variation is
     * returned as it is; a different one pending for the same row is a conflict. Nothing is written to
     * Square until the owner approves and the executor runs the step.
     */
    async createPriceEditApproval(input: { ownerUserId: string; payload: PriceEditApprovalPayload; payloadHash: string; resolvesConflictId?: string | undefined }):
      Promise<{ kind: 'created' | 'existing'; approval: ApprovalRequest } | { kind: 'conflict' }> {
      const p = PriceEditApprovalPayloadSchema.parse(input.payload);
      if (input.resolvesConflictId !== undefined && !FactConflictIdSchema.safeParse(input.resolvesConflictId).success) throw new PolicyError('VALIDATION_FAILED');
      try {
        return await db.transaction(async (tx) => {
          await assertOwner(tx, p.businessId, input.ownerUserId);
          // Issue #96: "use the uploaded price" in one step. The conflict must be open, in this business, a
          // menu_item conflict, and one whose Square candidate is this catalog row (the builder's
          // conflicts.ts stores the catalog row ID as that candidate's sourceRef). As for a fact edit (#118)
          // the ID is stored beside the hashed material, never hashed and never returned, and the executor
          // resolves that one conflict when local.catalog.sync succeeds.
          if (input.resolvesConflictId) {
            const conflict = await one(tx, 'select kind, state, candidates @> $3::jsonb as names_row from public.fact_conflicts where id=$1 and business_id=$2',
              [input.resolvesConflictId, p.businessId, JSON.stringify([{ sourceType: 'square', sourceRef: p.subjectId }])]);
            if (!conflict) throw new PolicyError('NOT_FOUND');
            if (conflict.state !== 'open') throw new PolicyError('INVALID_STATE', 'The conflict is already resolved.');
            if (conflict.kind !== 'menu_item' || conflict.names_row !== true) throw new PolicyError('VALIDATION_FAILED', 'The conflict is not about this item.');
          }
          const pending = await one(tx, `select * from public.approval_requests where business_id=$1 and subject_id=$2 and bundle_type='price_edit' and state='PENDING'
            order by created_at desc limit 1`, [p.businessId, p.subjectId]);
          if (pending) {
            const existing = approvalFromRow(pending);
            // The same proposal again differs only in its expiry (read from the clock): return the pending one.
            const { expiresAt: _a, ...had } = existing.payload as Record<string, unknown>;
            const { expiresAt: _b, ...asked } = p as unknown as Record<string, unknown>;
            if (canonicalJson(had) !== canonicalJson(asked)) return { kind: 'conflict' as const };
            // The stored approval is frozen: it can never gain a conflict it was not proposed with.
            const named = namedConflictId(pending);
            if (input.resolvesConflictId && input.resolvesConflictId !== named) {
              throw new PolicyError('INVALID_STATE', 'This price change is already waiting for confirmation without the conflict. Decide it first.');
            }
            return { kind: 'existing' as const, approval: existing };
          }
          const at = await dbNow(tx);
          const approval = await storeApproval(tx, 'price_edit', p as unknown as Record<string, unknown>, 'owner', input.ownerUserId,
            input.resolvesConflictId ? { [RESOLVES_CONFLICT]: input.resolvesConflictId } : {});
          if (approval.payloadHash !== input.payloadHash) throw new PolicyError('PAYLOAD_HASH_MISMATCH');
          await requested(tx, at, approval, approval.id);
          return { kind: 'created' as const, approval };
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
        // Issue #93 item 4: approving a booking whose slot overlaps an approved one trips bookings_no_overlap.
        // FLOWS X1: the booking moves to SLOT_CONFLICT with a booking.slot_conflict event (the decision
        // routine rolled back, so the approval itself stays PENDING and later expires).
        if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '23P01') {
          if (target === 'APPROVED' && pending.bundleType === 'booking_bundle') await markSlotConflict(pending);
          throw new PolicyError('SLOT_CONFLICT');
        }
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
