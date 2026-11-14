import { randomUUID } from 'node:crypto';
import { ActivityEventSchema, ID_PREFIXES, assertTransition, canTransition, type ActivityEvent, type WebhookProvider } from '@abos/contracts';
import type { PaymentOrder, WebhookDependencies } from './types.js';

export function makeActivity(deps: Pick<WebhookDependencies, 'clock'>, businessId: string, correlationId: string, event: Pick<ActivityEvent, 'type' | 'payload'>): ActivityEvent {
  return ActivityEventSchema.parse({ ...event, id: `${ID_PREFIXES.event}${randomUUID().replaceAll('-', '')}`, businessId, correlationId, actorType: 'provider', occurredAt: deps.clock.now().toISOString() });
}

export async function rejectWebhook(deps: WebhookDependencies, provider: WebhookProvider, url: string, correlationId: string): Promise<void> {
  const owner = await deps.integrations.findOwner(provider, url);
  if (!owner) throw new Error('Webhook integration owner is not configured');
  await deps.activity.write(makeActivity(deps, owner.businessId, correlationId, { type: 'webhook.rejected', payload: { provider, reason: 'signature_invalid' } }));
}

/** Shared by verified webhook jobs and the missed-webhook poller. */
export async function processPayment(deps: WebhookDependencies, candidate: PaymentOrder, paymentId: string): Promise<void> {
  await deps.orders.withLockedOrder(candidate.id, async (tx) => {
    const order = tx.order;
    if (!order || !canTransition('order', order.status, 'PAID_VERIFIED') || !order.squareOrderId) return;
    const result = await deps.square.verifyPayment({ paymentId, expected: { squareOrderId: order.squareOrderId, amountMinor: order.totalMinor, currency: order.currency, locationId: order.locationId } });
    const write = (event: Pick<ActivityEvent, 'type' | 'payload'>) => tx.activity.write(makeActivity(deps, order.businessId, order.callId, event));
    const move = async (from: PaymentOrder['status'], to: PaymentOrder['status']) => {
      assertTransition('order', from, to);
      await tx.move(to);
      await write({ type: 'order.status_changed', payload: { orderId: order.id, callId: order.callId, from, to } });
    };
    if (result.verified) {
      await tx.savePaymentId(paymentId);
      await move(order.status, 'PAID_VERIFIED');
      await write({ type: 'payment.verified', payload: { orderId: order.id, squarePaymentId: paymentId, amountMinor: order.totalMinor, currency: order.currency, sandbox: true } });
      await tx.sync.queueOrder({ ...order, status: 'PAID_VERIFIED', squarePaymentId: paymentId });
      await move('PAID_VERIFIED', 'FULFILLMENT_READY');
    } else if (result.field === 'status') {
      if ((result.status !== 'FAILED' && result.status !== 'CANCELED') || order.status !== 'PAYMENT_PENDING') return;
      await move('PAYMENT_PENDING', 'PAYMENT_FAILED');
      await write({ type: 'payment.failed', payload: { orderId: order.id, squarePaymentId: paymentId, reason: result.status, sandbox: true } });
    } else {
      await write({ type: 'guardrail.refused', payload: { callId: order.callId, rule: 'no_approval_bypass', reasonCode: `payment_${result.field}_mismatch` } });
    }
  });
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
  const order = await deps.orders.findBySquareOrderId(payload.squareOrderId);
  if (order && order.businessId === businessId) await processPayment(deps, order, payload.paymentId);
}
