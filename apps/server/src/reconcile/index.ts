import { PAYMENT_POLL_DURATION_MS } from '@abos/contracts';
import { processPayment } from '../webhooks/square.js';
import type { WebhookDependencies } from '../webhooks/types.js';

/** Schedule every PAYMENT_POLL_INTERVAL_MS. Expiry is measured from link creation, never updatedAt. */
export async function pollPendingPayments(deps: WebhookDependencies): Promise<void> {
  const now = deps.clock.now().getTime();
  const errors: unknown[] = [];
  for (const order of await deps.orders.listWaitingForPayment()) {
    const age = now - Date.parse(order.linkReadyAt);
    // PAYMENT_FAILED stays eligible: a declined customer can retry on the same link (PAYMENT_FAILED -> PAID_VERIFIED).
    if ((order.status !== 'PAYMENT_PENDING' && order.status !== 'PAYMENT_FAILED') || !order.squareOrderId || !Number.isFinite(age) || age < 0 || age >= PAYMENT_POLL_DURATION_MS) continue;
    try {
      // Check every payment Square holds for the order; one completed match is enough.
      for (const paymentId of await deps.square.findPaymentsForOrder(order.squareOrderId)) {
        if (await processPayment(deps, order, paymentId) === 'paid') break;
      }
    } catch (error: unknown) { errors.push(error); }
  }
  // One unavailable order must not prevent reconciliation of the others.
  if (errors.length) throw new AggregateError(errors, 'Payment reconciliation requires retry');
}
