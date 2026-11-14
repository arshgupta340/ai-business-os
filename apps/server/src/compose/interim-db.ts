// INTERIM(0005): the writes in this file wait for migration 0005 (branch arsh/B-06b-migration-0005),
// which adds one checked, all-or-nothing routine for each. Until then they run here, as abos_app, each
// in one transaction, using only what 0004 grants: finish_execution and enqueue_sheets_sync (routines)
// and direct UPDATEs on orders and bookings. Every function is marked INTERIM(0005).
//
// To swap: implement InterimDb (compose/ports.ts) with the 0005 wrappers and pass it to composeServer
// as `interim`, or replace the body of createInterimDb. Nothing else changes.
import type { ActivityEvent } from '@abos/contracts';
import { enqueueSheetsSync, finishExecution } from '@abos/db';
import type { Db, QueryDb } from '../db/index';
import { emitActivity } from '../policy/activity';
import { executionFromRow } from '../policy/engine';
import type { InterimDb } from './ports';

type Row = Record<string, unknown>;

export function createInterimDb(db: Db, deps: { newId(prefix: string): string; now(): Date }): InterimDb {
  const statusEvent = (q: QueryDb, businessId: string, correlationId: string, type: 'order.status_changed' | 'booking.status_changed', payload: Record<string, unknown>) =>
    emitActivity(q, { id: deps.newId('evt_'), businessId, correlationId, type, actorType: 'system', occurredAt: deps.now().toISOString(), payload });

  return {
    // INTERIM(0005): replace with private.recover_stale_executions(p_older_than timestamptz) returns setof public.action_executions.
    // abos_app cannot UPDATE action_executions, so this finishes each stale step through finish_execution
    // under the dead worker's own lease and attempt (read from the row): the only path 0004 allows.
    async recoverStaleExecutions({ olderThan }) {
      const stale = (await db.query(`select id from public.action_executions where status = 'RUNNING' and locked_at < $1 order by locked_at`, [olderThan])).rows as Row[];
      const moved = [];
      for (const s of stale) {
        const row = await db.transaction(async (tx) => {
          const x = (await tx.query(`select e.*, a.bundle_type, a.subject_id from public.action_executions e join public.approval_requests a on a.id = e.approval_id
            where e.id = $1 and e.status = 'RUNNING' and e.locked_at < $2`, [s.id, olderThan])).rows[0] as Row | undefined;
          if (!x || typeof x.locked_by !== 'string') return undefined;
          const businessId = String(x.business_id);
          const finished = await finishExecution(tx, { businessId, executionId: String(x.id), workerId: x.locked_by, attempt: Number(x.attempts),
            status: 'NEEDS_REVIEW', error: 'INTERNAL: lease went stale; the provider outcome is unknown' });
          if (x.action_type === 'square.checkout.create') {
            const o = (await tx.query(`update public.orders set status = 'RECOVERY_REQUIRED' where id = $1 and business_id = $2 and status = 'CREATING_CHECKOUT' returning call_id`, [x.subject_id, businessId])).rows[0] as Row | undefined;
            if (o) await statusEvent(tx, businessId, String(x.approval_id), 'order.status_changed', { orderId: x.subject_id, callId: o.call_id, from: 'CREATING_CHECKOUT', to: 'RECOVERY_REQUIRED' });
          } else if (x.action_type === 'calendar.event.create') {
            const b = (await tx.query(`update public.bookings set status = 'RETRY_REQUIRED' where id = $1 and business_id = $2 and status = 'RECHECKING_SLOT' returning call_id`, [x.subject_id, businessId])).rows[0] as Row | undefined;
            if (b) await statusEvent(tx, businessId, String(x.approval_id), 'booking.status_changed', { bookingId: x.subject_id, ...(typeof b.call_id === 'string' ? { callId: b.call_id } : {}), from: 'RECHECKING_SLOT', to: 'RETRY_REQUIRED' });
          }
          return finished;
        });
        if (row) moved.push(executionFromRow(row));
      }
      return moved;
    },

    // INTERIM(0005): replace with private.mark_order_paid(p_business text, p_order text, p_payment_id text, p_events jsonb) returns public.orders.
    async markPaid(tx, { businessId, orderId, paymentId, events }) {
      const paid = (await tx.query(`update public.orders set status = 'PAID_VERIFIED', square_payment_id = $3
        where id = $1 and business_id = $2 and status in ('PAYMENT_PENDING', 'PAYMENT_FAILED') and (square_payment_id is null or square_payment_id = $3)
        returning approval_id`, [orderId, businessId, paymentId])).rows[0] as Row | undefined;
      if (!paid) throw new Error('INVALID_STATE: order is not waiting for payment');
      const job = await enqueueSheetsSync(tx, { businessId, recordType: 'order', recordId: orderId });
      const ready = await tx.query(`update public.orders set status = 'FULFILLMENT_READY' where id = $1 and business_id = $2 and status = 'PAID_VERIFIED' returning id`, [orderId, businessId]);
      if (ready.rows.length !== 1) throw new Error('INVALID_STATE: paid order did not move to FULFILLMENT_READY');
      // The caller's events, in order: to PAID_VERIFIED, payment.verified, to FULFILLMENT_READY. sync.queued follows the first.
      const [toPaid, ...rest] = events;
      if (toPaid) await emitActivity(tx, toPaid);
      await emitActivity(tx, { id: deps.newId('evt_'), businessId, correlationId: String(paid.approval_id ?? orderId), type: 'sync.queued', actorType: 'system',
        occurredAt: deps.now().toISOString(), payload: { target: 'google_sheets', syncJobId: job.id, recordType: 'order', recordId: orderId } });
      for (const e of rest) await emitActivity(tx, e);
    },

    // INTERIM(0005): replace with private.mark_order_payment_failed(p_business text, p_order text, p_payment_id text, p_events jsonb) returns public.orders.
    async markFailed(tx, { businessId, orderId, events }: { businessId: string; orderId: string; paymentId: string; events: ActivityEvent[] }) {
      const failed = await tx.query(`update public.orders set status = 'PAYMENT_FAILED' where id = $1 and business_id = $2 and status = 'PAYMENT_PENDING' returning id`, [orderId, businessId]);
      if (failed.rows.length !== 1) throw new Error('INVALID_STATE: order is not PAYMENT_PENDING');
      for (const e of events) await emitActivity(tx, e);
    },

    // INTERIM(0005): replace with a routine such as private.mark_webhook_processed(p_id text, p_error text). It is not in the
    // 0005 brief yet. 0004 grants abos_app INSERT but no UPDATE on webhook_events, so processed_at cannot be set here.
    async markWebhookProcessed() {
      return false;
    },
  };
}
