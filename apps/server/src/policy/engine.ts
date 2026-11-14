import {
  ActionExecutionSchema, ApprovalRequestSchema, OrderSchema, BookingSchema, BusinessFactSchema,
  ApprovalDecisionSchema, BusinessIdSchema, UserIdSchema, MessageChannelSettingSchema,
  OrderApprovalPayloadSchema, BookingApprovalPayloadSchema, FactEditApprovalPayloadSchema,
  BUNDLE_ACTIONS, APPROVAL_EXPIRY_MS, ACTION_TYPE_CAPABILITY, CAPABILITIES,
  executionStepsFor, assertTransition, cartHash, payloadHash, idempotencyKey, canonicalJson,
  type ApprovalRequest, type ApprovalPayload, type BundleType, type ActivityEventType,
  type ActivityEventPayloads, type ActorType, type ActionExecution,
} from '@abos/contracts';
import { decideApproval, expireApprovals } from '@abos/db';
import { emitActivity } from './activity';
import {
  PolicyError, type PolicyDb, type PolicyDeps, type QueryInterface,
  type OrderProposalInput, type BookingProposalInput, type FactEditInput, type DecisionInput,
} from './types';

// Database rows are converted once, then validated with the shared schemas.
function fromRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') throw new PolicyError('NOT_FOUND');
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    value instanceof Date ? value.toISOString() : key === 'confidence' ? Number(value) : value,
  ]));
}
async function one(tx: QueryInterface, text: string, params: unknown[]): Promise<Record<string, unknown> | undefined> {
  return (await tx.query(text, params)).rows[0] as Record<string, unknown> | undefined;
}
async function insert(tx: QueryInterface, table: string, values: Record<string, unknown>): Promise<unknown> {
  const keys = Object.keys(values);
  const args = keys.map((key) => {
    const value = values[key];
    return ['cart', 'quote', 'contact', 'fulfillment', 'customer', 'payload', 'value'].includes(key) ? JSON.stringify(value) : value;
  });
  return (await tx.query(`insert into ${table} (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`, args)).rows[0];
}

export function createPolicyEngine(db: PolicyDb, deps: PolicyDeps) {
  const time = () => deps.now().toISOString();
  async function event<T extends ActivityEventType>(tx: QueryInterface, businessId: string, correlationId: string,
    type: T, payload: ActivityEventPayloads[T], actorType: ActorType = 'system') {
    await emitActivity(tx, { id: deps.newId('evt_'), businessId, correlationId, type, payload, actorType, occurredAt: time() });
  }
  async function owner(tx: QueryInterface, businessId: string, ownerUserId: string) {
    BusinessIdSchema.parse(businessId);
    UserIdSchema.parse(ownerUserId);
    const business = await one(tx, 'select * from businesses where id=$1 for update', [businessId]);
    if (!business || business.owner_id !== ownerUserId) throw new PolicyError('FORBIDDEN_BUSINESS');
  }
  async function call(tx: QueryInterface, businessId: string, callId: string | undefined, agentVersionId: string) {
    const row = await one(tx, 'select * from calls where id=$1 and business_id=$2 for update', [callId, businessId]);
    if (!row || row.agent_version_id !== agentVersionId) throw new PolicyError('FORBIDDEN_BUSINESS');
  }
  async function approval(tx: QueryInterface, bundleType: BundleType, payload: ApprovalPayload, createdAt: string) {
    const actorType = bundleType === 'fact_edit' ? 'owner' : 'deployed_agent';
    const a = ApprovalRequestSchema.parse({ id: deps.newId('apv_'), businessId: payload.businessId,
      subjectId: payload.subjectId, actorType, bundleType, actionBundle: BUNDLE_ACTIONS[bundleType], payload,
      payloadHash: await payloadHash(payload), state: 'PENDING', createdAt, expiresAt: payload.expiresAt });
    await insert(tx, 'approval_requests', { id: a.id, business_id: a.businessId, subject_id: a.subjectId,
      actor_type: a.actorType, bundle_type: a.bundleType, action_bundle: a.actionBundle, payload: a.payload,
      payload_hash: a.payloadHash, state: a.state, created_at: a.createdAt, expires_at: a.expiresAt });
    return a;
  }
  async function requested(tx: QueryInterface, a: ApprovalRequest) {
    await event(tx, a.businessId, a.id, 'approval.requested', { approvalId: a.id, bundleType: a.bundleType,
      subjectId: a.subjectId, actionBundle: a.actionBundle, expiresAt: a.expiresAt,
      ...('messageRecipient' in a.payload ? { recipientLast4: a.payload.messageRecipient.slice(-4) } : {}) }, a.actorType);
  }
  async function executions(tx: QueryInterface, approvalId: string) {
    return (await tx.query('select * from action_executions where approval_id=$1 order by step_index', [approvalId]))
      .rows.map((row) => ActionExecutionSchema.parse(fromRow(row)));
  }
  async function moveSubject(tx: QueryInterface, a: ApprovalRequest, target: 'approve' | 'reject') {
    if (a.bundleType !== 'order_bundle' && a.bundleType !== 'booking_bundle') return;
    const isOrder = a.bundleType === 'order_bundle';
    const row = await one(tx, `select * from ${isOrder ? 'orders' : 'bookings'} where id=$1 and business_id=$2 for update`, [a.subjectId, a.businessId]);
    if (!row) throw new PolicyError('NOT_FOUND');
    if (isOrder) {
      const subject = OrderSchema.parse(fromRow(row));
      const next = target === 'approve' ? 'APPROVED' : 'REJECTED';
      assertTransition('order', subject.status, next);
      await tx.query('update orders set status=$2 where id=$1', [subject.id, next]);
      await event(tx, a.businessId, a.id, 'order.status_changed', { orderId: subject.id, callId: subject.callId, from: subject.status, to: next });
    } else {
      const subject = BookingSchema.parse(fromRow(row));
      const next = target === 'approve' ? 'RECHECKING_SLOT' : 'REJECTED';
      assertTransition('booking', subject.status, next);
      await tx.query('update bookings set status=$2 where id=$1', [subject.id, next]);
      await event(tx, a.businessId, a.id, 'booking.status_changed', { bookingId: subject.id, callId: subject.callId, from: subject.status, to: next });
    }
  }
  async function applyFact(tx: QueryInterface, a: ApprovalRequest, userId: string) {
    if (a.bundleType !== 'fact_edit') return;
    const p = a.payload;
    // Serialize edits of one business so two approvals cannot verify competing fact versions.
    await owner(tx, a.businessId, userId);
    const previous = await one(tx, `select * from business_facts where business_id=$1 and kind=$2 and key=$3 and status='verified' for update`, [a.businessId, p.kind, p.key]);
    if ((previous?.version ?? 0) !== p.fromVersion || canonicalJson(previous?.value ?? null) !== canonicalJson(p.before)) throw new PolicyError('INVALID_STATE', 'The fact version changed. Propose a new edit.');
    const draft = BusinessFactSchema.parse(fromRow(await one(tx, 'select * from business_facts where id=$1 and business_id=$2 for update', [p.subjectId, a.businessId])));
    if (draft.status !== 'draft' || draft.kind !== p.kind || draft.key !== p.key) throw new PolicyError('INVALID_STATE');
    assertTransition('fact', draft.status, 'verified');
    if (previous) {
      assertTransition('fact', 'verified', 'superseded');
      await tx.query("update business_facts set status='superseded' where id=$1", [previous.id]);
    }
    await tx.query(`update business_facts set value=$2, status='verified', version=$3, supersedes_id=$4,
      verified_at=$5, verified_by=$6 where id=$1`, [draft.id, JSON.stringify(p.after), p.fromVersion + 1, previous?.id ?? null, time(), userId]);
    if (draft.sourceRef) {
      const conflict = await one(tx, 'select * from fact_conflicts where id=$1 and business_id=$2 and kind=$3 and key=$4 for update', [draft.sourceRef, a.businessId, p.kind, p.key]);
      if (!conflict || conflict.state !== 'open') throw new PolicyError('CONFLICT_UNRESOLVED');
      assertTransition('factConflict', 'open', 'resolved');
      await tx.query("update fact_conflicts set state='resolved', resolved_fact_id=$2, resolved_by=$3, resolved_at=$4 where id=$1", [draft.sourceRef, draft.id, userId, time()]);
    }
    await event(tx, a.businessId, a.id, 'fact.changed', { factId: draft.id, kind: p.kind, key: p.key,
      fromVersion: p.fromVersion, toVersion: p.fromVersion + 1, sourceType: draft.sourceType }, 'owner');
  }

  return {
    async createOrderProposal(input: OrderProposalInput) {
      return db.transaction(async (tx) => {
        const createdAt = time();
        const channel = MessageChannelSettingSchema.parse(input.messageChannel);
        const order = OrderSchema.parse({ ...input, id: deps.newId('ord_'), status: 'AWAITING_OWNER_APPROVAL',
          cartHash: await cartHash(input.cart), totalMinor: input.quote.totalMinor, currency: input.quote.currency,
          createdAt, updatedAt: createdAt });
        if (new Date(order.quote.expiresAt) <= deps.now()) throw new PolicyError('QUOTE_EXPIRED');
        await call(tx, order.businessId, order.callId, input.agentVersionId);
        const existing = await one(tx, 'select * from orders where business_id=$1 and call_id=$2 and cart_hash=$3', [order.businessId, order.callId, order.cartHash]);
        if (existing) {
          const storedOrder = OrderSchema.parse(fromRow(existing));
          const storedApproval = ApprovalRequestSchema.parse(fromRow(await one(tx, 'select * from approval_requests where id=$1 and business_id=$2', [storedOrder.approvalId, order.businessId])));
          return { order: storedOrder, approval: storedApproval };
        }
        const payload = OrderApprovalPayloadSchema.parse({ businessId: order.businessId, subjectId: order.id,
          agentVersionId: input.agentVersionId, cartHash: order.cartHash, totalMinor: order.totalMinor, currency: order.currency,
          pickupAt: order.fulfillment.pickupAt, messageRecipient: order.contact.messageRecipient, messageChannel: channel,
          actionBundle: BUNDLE_ACTIONS.order_bundle, expiresAt: new Date(new Date(createdAt).getTime() + APPROVAL_EXPIRY_MS).toISOString() });
        await insert(tx, 'orders', { id: order.id, business_id: order.businessId, call_id: order.callId, status: order.status,
          cart: order.cart, cart_hash: order.cartHash, quote: order.quote, total_minor: order.totalMinor,
          currency: order.currency, contact: order.contact, fulfillment: order.fulfillment, created_at: createdAt, updated_at: createdAt });
        const a = await approval(tx, 'order_bundle', payload, createdAt);
        await tx.query('update orders set approval_id=$2 where id=$1', [order.id, a.id]);
        await event(tx, order.businessId, order.callId, 'proposal.created', { subjectId: order.id, subjectType: 'order', callId: order.callId, totalMinor: order.totalMinor, currency: order.currency }, 'deployed_agent');
        await requested(tx, a);
        await event(tx, order.businessId, order.callId, 'order.status_changed', { orderId: order.id, callId: order.callId, to: order.status });
        return { order: OrderSchema.parse(fromRow(await one(tx, 'select * from orders where id=$1', [order.id]))), approval: a };
      });
    },
    async createBookingProposal(input: BookingProposalInput) {
      return db.transaction(async (tx) => {
        const createdAt = time();
        const channel = MessageChannelSettingSchema.parse(input.messageChannel);
        const booking = BookingSchema.parse({ ...input, id: deps.newId('bkg_'), status: 'AWAITING_OWNER_APPROVAL', createdAt, updatedAt: createdAt });
        if (channel !== 'qr_only' && !booking.customer.messageConsent) throw new PolicyError('VALIDATION_FAILED', 'Message consent is required.');
        await call(tx, input.businessId, input.callId, input.agentVersionId);
        const p = BookingApprovalPayloadSchema.parse({ ...input, subjectId: booking.id,
          messageRecipient: booking.customer.messageRecipient, actionBundle: BUNDLE_ACTIONS.booking_bundle,
          expiresAt: new Date(new Date(createdAt).getTime() + APPROVAL_EXPIRY_MS).toISOString() });
        await insert(tx, 'bookings', { id: booking.id, business_id: booking.businessId, call_id: booking.callId,
          status: booking.status, service_id: booking.serviceId, service_name: booking.serviceName, calendar_id: booking.calendarId,
          start_utc: booking.startUtc, end_utc: booking.endUtc, timezone: booking.timezone, customer: booking.customer,
          created_at: createdAt, updated_at: createdAt });
        const a = await approval(tx, 'booking_bundle', p, createdAt);
        await tx.query('update bookings set approval_id=$2 where id=$1', [booking.id, a.id]);
        await event(tx, booking.businessId, input.callId!, 'proposal.created', { subjectId: booking.id, subjectType: 'booking', callId: input.callId!, serviceName: booking.serviceName, startUtc: booking.startUtc }, 'deployed_agent');
        await requested(tx, a);
        await event(tx, booking.businessId, a.id, 'booking.status_changed', { bookingId: booking.id, callId: booking.callId, to: booking.status });
        return { booking: { ...booking, approvalId: a.id }, approval: a };
      });
    },
    async proposeFactEdit(input: FactEditInput) {
      return db.transaction(async (tx) => {
        await owner(tx, input.businessId, input.ownerUserId);
        const createdAt = time();
        const previous = await one(tx, "select * from business_facts where business_id=$1 and kind=$2 and key=$3 and status='verified'", [input.businessId, input.kind, input.key]);
        const draftFact = BusinessFactSchema.parse({ ...input, id: deps.newId('fact_'), status: 'draft',
          sourceType: 'owner_chat', sourceRef: input.resolvesConflictId, confidence: 1, version: Number(previous?.version ?? 0) + 1,
          createdAt, updatedAt: createdAt });
        if (draftFact.kind === 'menu_item') throw new PolicyError('CAPABILITY_NOT_ALLOWED');
        const p = FactEditApprovalPayloadSchema.parse({ businessId: input.businessId, subjectId: draftFact.id,
          kind: draftFact.kind, key: draftFact.key, fromVersion: previous?.version ?? 0, before: previous?.value ?? null,
          after: draftFact.value, actionBundle: BUNDLE_ACTIONS.fact_edit,
          expiresAt: new Date(new Date(createdAt).getTime() + APPROVAL_EXPIRY_MS).toISOString() });
        await insert(tx, 'business_facts', { id: draftFact.id, business_id: draftFact.businessId, kind: draftFact.kind,
          key: draftFact.key, value: draftFact.value, source_type: draftFact.sourceType, source_ref: draftFact.sourceRef ?? null,
          status: draftFact.status, version: draftFact.version, created_at: createdAt, updated_at: createdAt });
        const a = await approval(tx, 'fact_edit', p, createdAt);
        await requested(tx, a);
        return { approval: a, draftFact };
      });
    },
    async decide(input: DecisionInput) {
      ApprovalDecisionSchema.parse(input);
      return db.transaction(async (tx) => {
        // Check ownership before examining a decision, including an idempotent replay.
        await owner(tx, input.businessId, input.ownerUserId);
        const row = await one(tx, 'select * from approval_requests where id=$1 for update', [input.approvalId]);
        if (!row) throw new PolicyError('NOT_FOUND');
        if (row.business_id !== input.businessId) throw new PolicyError('FORBIDDEN_BUSINESS');
        const a = ApprovalRequestSchema.parse(fromRow(row));
        if (a.payloadHash !== input.payloadHash || await payloadHash(a.payload) !== a.payloadHash) throw new PolicyError('PAYLOAD_HASH_MISMATCH');
        const target = input.decision === 'approve' ? 'APPROVED' : 'REJECTED';
        if (a.state === target) return { approval: a, executions: await executions(tx, a.id) };
        if (a.state === 'EXPIRED' || (a.state === 'PENDING' && new Date(a.expiresAt) <= deps.now())) throw new PolicyError('APPROVAL_EXPIRED');
        if (a.state !== 'PENDING') throw new PolicyError('APPROVAL_ALREADY_DECIDED');
        assertTransition('approval', a.state, target);
        const decided = await decideApproval(tx, { ...input, decision: target });
        if (!decided) {
          const current = await one(tx, 'select * from approval_requests where id=$1', [a.id]);
          if (!current) throw new PolicyError('NOT_FOUND');
          if (current.business_id !== input.businessId) throw new PolicyError('FORBIDDEN_BUSINESS');
          if (current.payload_hash !== input.payloadHash) throw new PolicyError('PAYLOAD_HASH_MISMATCH');
          if (current.state === 'EXPIRED' || new Date(String(current.expires_at)).getTime() <= Date.now()) throw new PolicyError('APPROVAL_EXPIRED');
          throw new PolicyError('APPROVAL_ALREADY_DECIDED');
        }
        const result = ApprovalRequestSchema.parse(fromRow(decided));
        if (target === 'APPROVED') {
          for (const step of executionStepsFor(a.bundleType)) {
            const skip = 'messageChannel' in a.payload && a.payload.messageChannel === 'qr_only' && step.actionType.startsWith('message.');
            if (skip) assertTransition('execution', 'QUEUED', 'SKIPPED');
            await insert(tx, 'action_executions', { id: deps.newId('exe_'), business_id: a.businessId,
              approval_id: a.id, action_type: step.actionType, step_index: step.stepIndex,
              capability_id: ACTION_TYPE_CAPABILITY[step.actionType],
              idempotency_key: await idempotencyKey({ businessId: a.businessId, subjectId: a.subjectId, actionType: step.actionType, approvalId: a.id }),
              status: skip ? 'SKIPPED' : 'QUEUED' });
          }
          await applyFact(tx, result, input.ownerUserId);
          if (a.bundleType === 'fact_edit') {
            const execution = (await executions(tx, a.id))[0]!;
            assertTransition('execution', 'QUEUED', 'RUNNING');
            await tx.query("update action_executions set status='RUNNING', attempts=1, started_at=$2 where id=$1", [execution.id, time()]);
            await event(tx, a.businessId, a.id, 'execution.started', { executionId: execution.id, approvalId: a.id, actionType: execution.actionType, stepIndex: 0, attempt: 1 });
            assertTransition('execution', 'RUNNING', 'SUCCEEDED');
            await tx.query("update action_executions set status='SUCCEEDED', finished_at=$2 where id=$1", [execution.id, time()]);
            await event(tx, a.businessId, a.id, 'execution.succeeded', { executionId: execution.id, actionType: execution.actionType });
          }
        }
        await moveSubject(tx, result, input.decision);
        await event(tx, a.businessId, a.id, 'approval.decided', { approvalId: a.id, subjectId: a.subjectId, decision: target, decidedBy: input.ownerUserId }, 'owner');
        return { approval: result, executions: await executions(tx, a.id) };
      });
    },
    async expireDue() {
      return db.transaction(async (tx) => {
        // The database uses its own clock for the atomic sweep.
        const due = (await tx.query("select * from approval_requests where state='PENDING' and expires_at<=now() for update")).rows;
        for (const row of due) {
          const a = ApprovalRequestSchema.parse(fromRow(row));
          assertTransition('approval', a.state, 'EXPIRED');
          if (a.bundleType === 'order_bundle') assertTransition('order', 'AWAITING_OWNER_APPROVAL', 'APPROVAL_EXPIRED');
          if (a.bundleType === 'booking_bundle') assertTransition('booking', 'AWAITING_OWNER_APPROVAL', 'EXPIRED');
        }
        const expired = await expireApprovals(tx);
        for (const a of expired) {
          await event(tx, a.business_id, a.id, 'approval.expired', { approvalId: a.id, subjectId: a.subject_id });
          if (a.subject_moved && a.bundle_type === 'order_bundle') {
            const row = OrderSchema.parse(fromRow(await one(tx, 'select * from orders where id=$1', [a.subject_id])));
            await event(tx, a.business_id, a.id, 'order.status_changed', { orderId: row.id, callId: row.callId, from: 'AWAITING_OWNER_APPROVAL', to: 'APPROVAL_EXPIRED' });
          } else if (a.subject_moved && a.bundle_type === 'booking_bundle') {
            const row = BookingSchema.parse(fromRow(await one(tx, 'select * from bookings where id=$1', [a.subject_id])));
            await event(tx, a.business_id, a.id, 'booking.status_changed', { bookingId: row.id, callId: row.callId, from: 'AWAITING_OWNER_APPROVAL', to: 'EXPIRED' });
          }
        }
        return expired;
      });
    },
    async authorizeStep(input: { executionId: string; businessId: string }) {
      return db.transaction(async (tx) => {
        let execution: ActionExecution | undefined;
        let a: ApprovalRequest | undefined;
        const row = await one(tx, 'select * from action_executions where id=$1', [input.executionId]);
        let reason: import('@abos/contracts').ErrorCode | undefined;
        if (!row) reason = 'NOT_FOUND';
        else if (row.business_id !== input.businessId) reason = 'FORBIDDEN_BUSINESS';
        else {
          const raw = await one(tx, 'select * from approval_requests where id=$1', [row.approval_id]);
          if (!raw) reason = 'NOT_FOUND';
          else if (raw.business_id !== input.businessId) reason = 'FORBIDDEN_BUSINESS';
          else if (raw.state !== 'APPROVED') reason = raw.state === 'EXPIRED' ? 'APPROVAL_EXPIRED' : 'INVALID_STATE';
          else if (!raw.decided_at || new Date(String(raw.decided_at)) >= new Date(String(raw.expires_at))) reason = 'APPROVAL_EXPIRED';
          else {
            try {
              a = ApprovalRequestSchema.parse(fromRow(raw));
              if (await payloadHash(a.payload) !== a.payloadHash) reason = 'PAYLOAD_HASH_MISMATCH';
            } catch { reason = 'PAYLOAD_HASH_MISMATCH'; }
            if (!reason && a) {
              const parsed = ActionExecutionSchema.safeParse(fromRow(row));
              if (!parsed.success) reason = 'CAPABILITY_NOT_ALLOWED';
              else {
                execution = parsed.data;
                const step = executionStepsFor(a.bundleType).find((s) => s.stepIndex === execution?.stepIndex);
                if (step?.actionType !== execution.actionType || a.actionBundle[execution.stepIndex] !== execution.actionType) reason = 'CAPABILITY_NOT_ALLOWED';
                else if (!['QUEUED', 'RUNNING'].includes(execution.status)) reason = 'INVALID_STATE';
                else if (execution.capabilityId) {
                  const registered = await one(tx, 'select effect, approval_mode from capabilities where id=$1', [execution.capabilityId]);
                  const effect = CAPABILITIES[execution.capabilityId].effect;
                  if (!registered || registered.effect !== effect || registered.approval_mode !== 'required' || !['write', 'external_message'].includes(effect)) reason = 'CAPABILITY_NOT_ALLOWED';
                }
                if (!reason && process.env.SQUARE_ENVIRONMENT !== 'sandbox') reason = 'ENVIRONMENT_MISMATCH';
                if (!reason && execution.idempotencyKey !== await idempotencyKey({ businessId: a.businessId, subjectId: a.subjectId, actionType: execution.actionType, approvalId: a.id })) reason = 'PAYLOAD_HASH_MISMATCH';
              }
            }
          }
        }
        if (reason) {
          const business = await one(tx, 'select id from businesses where id=$1', [input.businessId]);
          if (business) {
            const subject = a ? await one(tx, `select call_id from ${a.bundleType === 'booking_bundle' ? 'bookings' : 'orders'} where id=$1`, [a.subjectId]) : undefined;
            await event(tx, input.businessId, input.executionId, 'guardrail.refused', {
              callId: typeof subject?.call_id === 'string' ? subject.call_id : 'call_policy',
              rule: reason === 'FORBIDDEN_BUSINESS' ? 'no_cross_business' : 'no_approval_bypass', toolName: reason });
          }
          return { ok: false as const, reason, code: reason };
        }
        if (!execution || !a) throw new PolicyError('INTERNAL');
        return { ok: true as const, execution, approval: a };
      });
    },
  };
}
