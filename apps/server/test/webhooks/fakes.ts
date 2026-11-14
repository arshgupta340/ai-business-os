import { createHmac, timingSafeEqual } from 'node:crypto';
import { vi } from 'vitest';
import { orderPaymentPending } from '@abos/contracts/fixtures';
import type { ActivityEvent, Order } from '@abos/contracts';
import type { WebhookDependencies, PaymentOrder, PaymentVerification } from '../../src/webhooks/types.js';

export function fixture() {
  const order: PaymentOrder = { ...orderPaymentPending, status: 'PAYMENT_PENDING', squareOrderId: 'sq_order', locationId: 'loc', linkReadyAt: '2026-11-13T20:00:00Z' };
  const events: ActivityEvent[] = [];
  const jobs: Array<() => Promise<void>> = [];
  const stored = new Set<string>();
  let verification: PaymentVerification = { verified: true };
  let lock = Promise.resolve();
  const queuedOrders = new Set<string>();
  const sync = { queueOrder: vi.fn(async (value: Order) => { queuedOrders.add(value.id); }) };
  const activity = { write: vi.fn(async (event: ActivityEvent) => { events.push(event); }) };
  const move = vi.fn(async (to: Order['status']) => { order.status = to; });
  const deps: WebhookDependencies = {
    config: { squareNotificationUrl: 'https://example.test/webhooks/square', squareSignatureKey: 'test-only-key', twilioStatusUrl: 'https://example.test/webhooks/twilio/status' },
    clock: { now: () => new Date('2026-11-13T20:05:00Z') },
    square: {
      verifyWebhookSignature: vi.fn(({ rawBody, notificationUrl, signatureKey, signatureHeader }) => {
        const expected = sign(rawBody, notificationUrl, signatureKey);
        return !!signatureHeader && Buffer.byteLength(signatureHeader) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
      }),
      verifyPayment: vi.fn(async () => verification),
      findPaymentForOrder: vi.fn(async () => 'sq_payment'),
    },
    store: { recordOnce: vi.fn(async (event) => {
      const key = `${event.source}:${event.providerEventId}`;
      if (stored.has(key)) return undefined;
      stored.add(key);
      return { ...event, id: `whk_${stored.size}` };
    }) },
    integrations: { findOwner: vi.fn(async () => ({ businessId: order.businessId })) },
    orders: {
      findBySquareOrderId: vi.fn(async (id) => id === order.squareOrderId ? { ...order } : undefined),
      listWaitingForPayment: vi.fn(async () => [{ ...order }]),
      withLockedOrder: async (_id, fn) => {
        const previous = lock;
        let unlock = () => {};
        lock = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        const before = structuredClone(order);
        const eventCount = events.length;
        const queuedBefore = new Set(queuedOrders);
        try { await fn({ order, move, savePaymentId: async (id) => { order.squarePaymentId = id; }, activity, sync }); }
        catch (error: unknown) {
          for (const key of Object.keys(order)) Reflect.deleteProperty(order, key);
          Object.assign(order, before);
          events.splice(eventCount);
          queuedOrders.clear();
          for (const id of queuedBefore) queuedOrders.add(id);
          throw error;
        } finally { unlock(); }
      },
    },
    activity,
    jobs: { enqueue: vi.fn(async (_id, job) => { jobs.push(job); }) },
    twilio: { validate: vi.fn(async ({ signatureHeader }) => signatureHeader === 'valid') },
    calls: { findByProviderId: vi.fn(async () => undefined), endOnce: vi.fn(async () => false) },
    dispatch: { findByProviderId: vi.fn(async () => undefined), updateStatus: vi.fn(async () => false) },
  };
  return { deps, order, events, jobs, move, sync, stored, queuedOrders, setVerification: (value: PaymentVerification) => { verification = value; }, drain: async () => { for (const job of jobs.splice(0)) await job(); } };
}
export function sign(body: Buffer, url = 'https://example.test/webhooks/square', key = 'test-only-key') {
  return createHmac('sha256', key).update(url).update(body).digest('base64');
}
export function paymentEvent(id = 'event_1', squareOrderId = 'sq_order') {
  return JSON.stringify({ event_id: id, type: 'payment.updated', data: { object: { payment: { id: 'sq_payment', order_id: squareOrderId, status: 'COMPLETED', amount_money: { amount: 1 } } } } });
}
