// The database writes that migration 0005 serves, behind the InterimDb port (compose/ports.ts).
// Since the 0005 merge most of them call the routine wrappers from @abos/db. What still runs here
// without a routine is marked INTERIM(0005), with the routine it waits for.
//
// To swap again: change the bodies below. Callers see only InterimDb.
import type { ActivityEvent } from '@abos/contracts';
import { markOrderPaid, markOrderPaymentFailed, recoverStaleExecutions } from '@abos/db';
import type { Db } from '../db/index';
import { emitActivity } from '../policy/activity';
import { executionFromRow } from '../policy/engine';
import type { InterimDb } from './ports';

type Row = Record<string, unknown>;

/** 0005 refuses a stale window under one minute. */
export const MIN_STALE_AFTER_MS = 60_000;

export function createInterimDb(db: Db, deps: { newId(prefix: string): string; now(): Date }): InterimDb {
  return {
    // private.recover_stale_executions, per business, on the database clock. The executor gives a
    // cutoff; the routine wants the window, which is now minus that cutoff (at least one minute).
    async recoverStaleExecutions({ olderThan }) {
      const staleAfterMs = Math.max(MIN_STALE_AFTER_MS, deps.now().getTime() - olderThan.getTime());
      const businesses = (await db.query("select distinct business_id from public.action_executions where status = 'RUNNING' order by business_id", [])).rows as Row[];
      const moved = [];
      for (const b of businesses) {
        const rows = await recoverStaleExecutions(db, { businessId: String(b.business_id), staleAfterMs });
        moved.push(...rows.map(executionFromRow));
      }
      return moved;
    },

    // private.mark_order_paid writes PAID_VERIFIED, the payment ID, the Sheets job and the events
    // order.status_changed, payment.verified and sync.queued itself, so only the caller's last event
    // (PAID_VERIFIED to FULFILLMENT_READY) is written here.
    async markPaid(tx, { businessId, orderId, paymentId, amountMinor, currency, events }) {
      await markOrderPaid(tx, { businessId, orderId, paymentId, amountMinor, currency });
      // INTERIM(0005): replace with a routine such as private.mark_order_fulfillment_ready(p_business text, p_order text).
      // abos_app still has UPDATE on orders, so the move runs here, conditional on PAID_VERIFIED, in the same transaction.
      const ready = await tx.query(`update public.orders set status = 'FULFILLMENT_READY' where id = $1 and business_id = $2 and status = 'PAID_VERIFIED' returning id`, [orderId, businessId]);
      if (ready.rows.length !== 1) throw new Error('INVALID_STATE: paid order did not move to FULFILLMENT_READY');
      const last = events.filter((e: ActivityEvent) => e.type === 'order.status_changed').at(-1);
      if (last && (last.payload as { to?: string }).to === 'FULFILLMENT_READY') await emitActivity(tx, last);
    },

    // private.mark_order_payment_failed writes the status change and payment.failed itself.
    async markFailed(tx, { businessId, orderId, paymentId, events }) {
      const failed = events.find((e: ActivityEvent) => e.type === 'payment.failed');
      const reason = String((failed?.payload as { reason?: unknown } | undefined)?.reason ?? 'FAILED').slice(0, 200) || 'FAILED';
      await markOrderPaymentFailed(tx, { businessId, orderId, paymentId, reason });
    },

    // INTERIM(0005): replace with a routine such as private.mark_webhook_processed(p_id text, p_error text). 0004 and 0005
    // grant abos_app INSERT but no UPDATE on webhook_events, so processed_at cannot be set here.
    async markWebhookProcessed() {
      void deps.newId;
      return false;
    },
  };
}
