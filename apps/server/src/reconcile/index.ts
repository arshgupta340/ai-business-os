import { PAYMENT_POLL_DURATION_MS } from '@abos/contracts';
import { processPayment } from '../webhooks/square.js';
import type { WebhookDependencies } from '../webhooks/types.js';

/** Schedule every PAYMENT_POLL_INTERVAL_MS. Expiry is measured from link creation, never updatedAt. */
export async function pollPendingPayments(deps: WebhookDependencies): Promise<void> {
  const now = deps.clock.now().getTime();
  const errors: unknown[] = [];
  for (const order of await deps.orders.listWaitingForPayment()) {
    const age = now - Date.parse(order.linkReadyAt);
    if (order.status !== 'PAYMENT_PENDING' || !order.squareOrderId || !Number.isFinite(age) || age < 0 || age >= PAYMENT_POLL_DURATION_MS) continue;
    try {
      const paymentId = await deps.square.findPaymentForOrder(order.squareOrderId);
      if (paymentId) await processPayment(deps, order, paymentId);
    } catch (error: unknown) { errors.push(error); }
  }
  // One unavailable order must not prevent reconciliation of the others.
  if (errors.length) throw new AggregateError(errors, 'Payment reconciliation requires retry');
}
