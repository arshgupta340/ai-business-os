import { randomUUID } from 'node:crypto';
import { ActivityEventSchema, ID_PREFIXES, assertTransition, canTransition, type ActivityEvent, type WebhookProvider } from '@abos/contracts';
import type { PaymentOrder, WebhookDependencies } from './types.js';

export function makeActivity(deps: Pick<WebhookDependencies, 'clock'>, businessId: string, correlationId: string, event: Pick<ActivityEvent, 'type' | 'payload'>): ActivityEvent {
  return ActivityEventSchema.parse({ ...event, id: `${ID_PREFIXES.event}${randomUUID().replaceAll('-', '')}`, businessId, correlationId, actorType: 'provider', occurredAt: deps.clock.now().toISOString() });
}

/** Never throws: a forged request always gets 401, even when the rejection event cannot be attributed or written. */
export async function rejectWebhook(deps: WebhookDependencies, provider: WebhookProvider, url: string, correlationId: string): Promise<void> {
  try {
    const owner = await deps.integrations.findOwner(provider, url);
    if (!owner) return;
    await deps.activity.write(makeActivity(deps, owner.businessId, correlationId, { type: 'webhook.rejected', payload: { provider, reason: 'signature_invalid' } }));
  } catch { /* The 401 is the guard; the audit event is best effort. */ }
}

export type PaymentOutcome = 'paid' | 'failed' | 'refused' | 'ignored';
const FINAL_FAILURES = new Set(['FAILED', 'CANCELED']);

/** Shared by verified webhook jobs and the missed-webhook poller. */
export async function processPayment(deps: WebhookDependencies, candidate: PaymentOrder, paymentId: string): Promise<PaymentOutcome> {
  if (!candidate.squareOrderId || !canTransition('order', candidate.status, 'PAID_VERIFIED')) return 'ignored';
  const expected = { squareOrderId: candidate.squareOrderId, amountMinor: candidate.totalMinor, currency: candidate.currency, locationId: candidate.locationId };
  // Read Square before taking the row lock, so no provider call runs inside the database transaction.
  // Square's answer is the only authority for status and amount; the webhook body is never consulted.
  const result = await deps.square.verifyPayment({ paymentId, expected });
  if (!result.verified && result.field !== 'status') {
    await deps.activity.write(makeActivity(deps, candidate.businessId, candidate.callId, { type: 'guardrail.refused', payload: { callId: candidate.callId, rule: 'no_approval_bypass', reasonCode: `payment_${result.field}_mismatch` } }));
    return 'refused';
  }
  if (!result.verified && !FINAL_FAILURES.has(result.status)) return 'ignored';
  let outcome: PaymentOutcome = 'ignored';
  await deps.orders.withLockedOrder(candidate.id, async (tx) => {
    const order = tx.order;
    // The locked row must still be the one we verified against.
    if (!order || order.businessId !== candidate.businessId || order.squareOrderId !== expected.squareOrderId || order.totalMinor !== expected.amountMinor || order.currency !== expected.currency || order.locationId !== expected.locationId) return;
    const event = (e: Pick<ActivityEvent, 'type' | 'payload'>) => makeActivity(deps, order.businessId, order.callId, e);
    const changed = (from: PaymentOrder['status'], to: PaymentOrder['status']) => { assertTransition('order', from, to); return event({ type: 'order.status_changed', payload: { orderId: order.id, callId: order.callId, from, to } }); };
    if (result.verified) {
      if (!canTransition('order', order.status, 'PAID_VERIFIED')) return;
      await tx.markPaid({ paymentId, events: [
        changed(order.status, 'PAID_VERIFIED'),
        event({ type: 'payment.verified', payload: { orderId: order.id, squarePaymentId: paymentId, amountMinor: order.totalMinor, currency: order.currency, sandbox: true } }),
        changed('PAID_VERIFIED', 'FULFILLMENT_READY'),
      ] });
      outcome = 'paid';
    } else {
      if (order.status !== 'PAYMENT_PENDING') return;
      await tx.markFailed({ paymentId, events: [
        changed('PAYMENT_PENDING', 'PAYMENT_FAILED'),
        event({ type: 'payment.failed', payload: { orderId: order.id, squarePaymentId: paymentId, reason: result.status, sandbox: true } }),
      ] });
      outcome = 'failed';
    }
  });
  return outcome;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Parse only routing identifiers after signature verification. No body status or totals survive. */
export function parseSquareEvent(rawBody: Buffer): { providerEventId: string; eventType: string; payload: Record<string, string> } | undefined {
  let value: unknown;
  try { value = JSON.parse(rawBody.toString('utf8')) as unknown; } catch { return undefined; }
  const event = record(value);
  if (!event || typeof event.event_id !== 'string' || !event.event_id || typeof event.type !== 'string') return undefined;
  const data = record(event.data);
  const payment = record(record(data?.object)?.payment);
  const payload: Record<string, string> = {};
  const paymentId = payment?.id ?? data?.id;
  if (typeof paymentId === 'string' && paymentId) payload.paymentId = paymentId;
  if (typeof payment?.order_id === 'string' && payment.order_id) payload.squareOrderId = payment.order_id;
  return { providerEventId: event.event_id, eventType: event.type, payload };
}

export async function processSquareEvent(deps: WebhookDependencies, eventType: string, payload: Record<string, string>, businessId: string): Promise<void> {
  if (eventType !== 'payment.created' && eventType !== 'payment.updated') return;
  if (!payload.squareOrderId || !payload.paymentId) return;
  const order = await deps.orders.findBySquareOrderId(businessId, payload.squareOrderId);
  if (order && order.businessId === businessId) await processPayment(deps, order, payload.paymentId);
}
