// The recovery routes (B-32, API 3.12) wired to the database and the provider reads.
//
// Resolution of a NEEDS_REVIEW step goes through owner_resolve_execution (migration 0008). It checks the
// signed-in owner in the database, then calls resolve_execution (0005), which locks the approval and the
// step, re-checks the signed material and, from the evidence given, completes the step with its subject
// (checkout references and PAYMENT_LINK_READY, the verified booking and its one Sheets job, a sent
// dispatch), requeues the same step after proven absence, or abandons it. An abandoned message step's
// UNKNOWN dispatch becomes FAILED with it, and a message is never requeued. The routines write the
// events. Lookups are provider reads only and fail to "unknown" on any doubt.
import { MessageDispatchSchema, type Order } from '@abos/contracts';
import { ownerResolveExecution } from '@abos/db';
import type { RecoveryLookup, RecoveryPorts, RecoveryRecord, RecoveryScope, RecoveryTransaction } from '../api/recovery/index';
import { mapRow } from '../api/rows';
import type { Db, QueryDb } from '../db/index';
import { emitActivity } from '../policy/activity';
import { approvalFromRow, executionFromRow, routineErrorCode } from '../policy/engine';
import { bookingFromDbRow, orderFromDbRow } from './executor';
import type { Providers } from './providers';
import type { SeamDeps } from './seams';

type Row = Record<string, unknown>;
const one = async (q: QueryDb, text: string, params: unknown[]) => (await q.query(text, params)).rows[0] as Row | undefined;

/**
 * A routine refusal as a contract code. The routine's own text never reaches the response. An overlap
 * on the way back to RECHECKING_SLOT (bookings_no_overlap) is a slot conflict.
 */
export function recoveryRefusal(error: unknown): 'INVALID_STATE' | 'SLOT_CONFLICT' | ReturnType<typeof routineErrorCode> | 'INTERNAL' {
  if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '23P01') return 'SLOT_CONFLICT';
  const mapped = routineErrorCode(error);
  if (mapped) return mapped;
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  return /^(LEASE|RESULT|TRANSITION|PREDECESSOR):/.test(message) ? 'INVALID_STATE' : 'INTERNAL';
}

/** A provider read that does not answer in time is "unknown", never a verdict. */
export const RECOVERY_LOOKUP_TIMEOUT_MS = 8000;

async function bounded<T>(ms: number, fn: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  try { return await Promise.race([fn(), timeout]); } finally { clearTimeout(timer); }
}

export function createDbRecoveryPorts(deps: Pick<SeamDeps, 'db' | 'now' | 'newId'> & {
  providers: Providers;
  /** One payment reconciliation pass (webhooks.ts reconcileNow). Absent: cancellation of a linked order fails closed. */
  reconcile?: (() => Promise<void>) | undefined;
  lookupTimeoutMs?: number;
}): RecoveryPorts {
  const { db, providers } = deps;
  // The module looks up provider evidence inside withRecovery, so the lookup must not open its own
  // database query (one connection per transaction). The step's saved Square references are read
  // with the record, in the transaction, and kept here for the lookup.
  const savedRefs = new WeakMap<RecoveryRecord, { squareOrderId?: string | undefined; paymentLinkId?: string | undefined }>();

  function transaction(tx: QueryDb, scope: RecoveryScope): RecoveryTransaction {
    return {
      async loadOrder() {
        const row = await one(tx, 'select * from public.orders where id = $1 and business_id = $2 for update', [scope.id, scope.businessId]);
        return row ? orderFromDbRow(row) : undefined;
      },
      async loadExecution() {
        const e = await one(tx, 'select * from public.action_executions where id = $1 and business_id = $2', [scope.id, scope.businessId]);
        if (!e) return undefined;
        const a = await one(tx, 'select * from public.approval_requests where id = $1 and business_id = $2', [e.approval_id, scope.businessId]);
        if (!a) return undefined;
        const approval = approvalFromRow(a);
        const record: RecoveryRecord = { execution: executionFromRow(e), approval };
        const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
        savedRefs.set(record, { squareOrderId: str(e.square_order_id) ?? str(e.external_ref), paymentLinkId: str(e.square_payment_link_id) });
        if (approval.bundleType === 'order_bundle') {
          const o = await one(tx, 'select * from public.orders where id = $1 and business_id = $2 for update', [approval.subjectId, scope.businessId]);
          if (o) record.order = orderFromDbRow(o);
        } else if (approval.bundleType === 'booking_bundle') {
          const b = await one(tx, 'select * from public.bookings where id = $1 and business_id = $2 for update', [approval.subjectId, scope.businessId]);
          if (b) record.booking = bookingFromDbRow(b);
        }
        const d = await one(tx, 'select * from public.message_dispatches where execution_id = $1 and business_id = $2', [scope.id, scope.businessId]);
        if (d) record.dispatch = MessageDispatchSchema.parse(mapRow(d));
        return record;
      },
      // INTEGRATION GAP: there is no durable recovery receipt table. The execution row itself is the
      // record: once resolved it is no longer NEEDS_REVIEW, so any repeat is refused as INVALID_STATE.
      async recoveryDecision() { return undefined; },
      async cancelOrder(order: Order) {
        // Fence work in flight: a running step may be about to write to a provider.
        const running = order.approvalId ? await one(tx, "select 1 from public.action_executions where approval_id = $1 and status = 'RUNNING' limit 1", [order.approvalId]) : undefined;
        if (running) throw { code: 'INVALID_STATE' };
        // No routine moves an order to CANCELLED; 0005's guard trigger checks this move against the machine.
        const row = await one(tx, "update public.orders set status = 'CANCELLED' where id = $1 and business_id = $2 and status = $3 returning *", [order.id, order.businessId, order.status]);
        if (!row) throw { code: 'INVALID_STATE' };
        return orderFromDbRow(row);
      },
      async resolveNeedsReview({ record, action, status, lookup }) {
        // The route chose `status` from the lookup; the routine re-derives it from the action and the
        // evidence, and refuses anything the state machines do not allow.
        const row = await ownerResolveExecution(tx, {
          businessId: record.execution.businessId, executionId: record.execution.id, ownerUserId: scope.ownerUserId, action,
          externalRef: status === 'SUCCEEDED' && lookup.outcome === 'exists' ? lookup.externalRef : null,
          nothingWritten: status === 'QUEUED' && lookup.outcome === 'absent',
          ...(status === 'SUCCEEDED' && lookup.outcome === 'exists' && lookup.checkout ? { checkout: lookup.checkout } : {}),
        }).catch((error: unknown) => { throw { code: recoveryRefusal(error) }; });
        if (row.status !== status) throw { code: 'INTERNAL' };
        // The routines write the execution.succeeded or execution.failed event (and message.failed) themselves.
        return { action, generation: record.execution.attempts, execution: executionFromRow(row) };
      },
      activity: { write: (event) => emitActivity(tx, event) },
    };
  }

  return {
    async ownsBusiness({ businessId, ownerUserId }) {
      return !!(await one(db, 'select 1 from public.businesses where id = $1 and owner_id = $2', [businessId, ownerUserId]));
    },
    withRecovery: (scope, fn) => db.transaction((tx) => fn(transaction(tx, scope))),
    async lookup(record): Promise<RecoveryLookup> {
      const unknown: RecoveryLookup = { outcome: 'unknown' };
      const e = record.execution;
      try {
        if (e.actionType === 'square.checkout.create' && record.order) {
          // Evidence needs the Square order the step created: saved by save_checkout, or kept on the step.
          const raw = savedRefs.get(record);
          const squareOrderId = raw?.squareOrderId ?? record.order.squareOrderId;
          if (!squareOrderId || !providers.square) return unknown;
          const square = providers.square;
          const paymentLinkId = raw?.paymentLinkId ?? record.order.squarePaymentLinkId;
          // Read only: reads the link back and checks its total against the approved total.
          const refs = await bounded(deps.lookupTimeoutMs ?? RECOVERY_LOOKUP_TIMEOUT_MS, () => square.resumeCheckout({
            squareOrderId, ...(paymentLinkId ? { paymentLinkId } : {}), approvedTotalMinor: record.order!.totalMinor, currency: record.order!.currency, idempotencyKey: e.idempotencyKey }));
          if (!refs || refs.squareOrderId !== squareOrderId || !/^https:\/\//.test(refs.url)) return unknown;
          return { outcome: 'exists', externalRef: refs.squareOrderId, checkout: { squareOrderId: refs.squareOrderId, paymentLinkId: refs.paymentLinkId, url: refs.url } };
        }
        if ((e.actionType === 'message.checkout.send' || e.actionType === 'message.booking.confirm') && record.dispatch) {
          // The stored dispatch is the evidence: a provider message ID on a sent row.
          const d = record.dispatch;
          if ((d.status === 'SENT' || d.status === 'DELIVERED') && d.providerMessageId) return { outcome: 'exists', externalRef: d.providerMessageId };
          return unknown;
        }
        // Calendar: the adapter has no read-only lookup of the event by the step's key yet.
        return unknown;
      } catch {
        return unknown;
      }
    },
    async reconcilePayment(order) {
      // Review finding 3. A linked order is checked with its own bounded Square read. A read that fails or
      // times out is unknown, and unknown refuses the cancel. A successful read still cannot prove the
      // link stays unpaid after a cancel (no link deactivation flow exists, and adding that provider
      // write needs its own approval), so a linked order is never cancelled here: a payment found is
      // reconciled first (it may verify), and the cancel is refused either way.
      if (!deps.reconcile || !providers.square || !order.squareOrderId) throw { code: 'INTEGRATION_UNAVAILABLE' };
      const square = providers.square;
      const squareOrderId = order.squareOrderId;
      const payments = await bounded(deps.lookupTimeoutMs ?? RECOVERY_LOOKUP_TIMEOUT_MS, () => square.findPaymentForOrder(squareOrderId)).catch(() => undefined);
      if (!payments) throw { code: 'INTEGRATION_UNAVAILABLE' };
      if (payments.length > 0) await deps.reconcile();
      throw { code: 'INVALID_STATE' };
    },
    clock: { now: deps.now },
    ids: { next: (prefix) => deps.newId(prefix) },
  };
}
