import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { webhooksPlugin } from '../../src/webhooks/plugin.js';
import { pollPendingPayments } from '../../src/reconcile/index.js';
import { fixture, paymentEvent, sign } from './fakes.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const f = fixture();
  const app = Fastify(); apps.push(app);
  await app.register(webhooksPlugin, f.deps).ready();
  const send = (body = paymentEvent(), signature = sign(Buffer.from(body)), headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    app.inject({ method: 'POST', url: '/webhooks/square', headers: { ...headers, 'x-square-hmacsha256-signature': signature }, payload: body });
  const twilio = (payload: string, sig = 'valid') => app.inject({ method: 'POST', url: '/webhooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, payload });
  return { ...f, app, send, twilio };
}

it('answers 401 to a forged Square webhook even when no integration owner is found', async () => {
  const f = await setup(); vi.mocked(f.deps.integrations.findOwner).mockResolvedValue(undefined);
  const res = await f.send(paymentEvent(), 'forged');
  expect(res.statusCode).toBe(401); expect(res.json().code).toBe('SIGNATURE_INVALID');
  expect(f.stored.size).toBe(0); expect(f.events).toHaveLength(0); expect(f.jobs).toHaveLength(0);
});
it('answers 401 to a forged Square webhook when the rejection event cannot be written', async () => {
  const f = await setup(); f.deps.activity.write = vi.fn(async () => { throw new Error('db down'); });
  const res = await f.send(paymentEvent(), 'forged');
  expect(res.statusCode).toBe(401); expect(f.stored.size).toBe(0); expect(f.jobs).toHaveLength(0);
});
it('answers 401 to a forged Twilio status callback when no integration owner is found', async () => {
  const f = await setup(); vi.mocked(f.deps.integrations.findOwner).mockResolvedValue(undefined);
  expect((await f.twilio('CallSid=CA1&CallStatus=completed', 'bad')).statusCode).toBe(401); expect(f.stored.size).toBe(0);
});
it('rejects a forged Square body with no content type as a bad signature, storing nothing', async () => {
  const f = await setup();
  const res = await f.app.inject({ method: 'POST', url: '/webhooks/square', headers: { 'x-square-hmacsha256-signature': 'forged' }, payload: paymentEvent() });
  expect(res.statusCode).toBe(401); expect(f.stored.size).toBe(0); expect(f.events.map(e => e.type)).toEqual(['webhook.rejected']);
});
it('verifies a signed Square body sent with a non-JSON content type over its raw bytes', async () => {
  const f = await setup(); const res = await f.send(paymentEvent(), undefined, { 'content-type': 'text/plain; charset=utf-8' });
  expect(res.statusCode).toBe(200); await f.drain(); expect(f.order.status).toBe('FULFILLMENT_READY');
});
it('answers an oversized Square body with a 4xx, never a retryable 500, and stores nothing', async () => {
  const f = await setup(); const res = await f.send('x'.repeat(1_100_000), 'forged');
  expect(res.statusCode).toBe(413); expect(f.stored.size).toBe(0); expect(f.move).not.toHaveBeenCalled();
});
it('reads Square before taking the order lock, so no provider call runs inside the database transaction', async () => {
  const f = await setup(); const inLock: boolean[] = [];
  vi.mocked(f.deps.square.verifyPayment).mockImplementation(async () => { inLock.push(f.lockHeld()); return { verified: true }; });
  await f.send(); await f.drain(); await pollPendingPayments(f.deps);
  expect(inLock.length).toBeGreaterThan(0); expect(inLock.every(held => !held)).toBe(true);
});
it('poller recovers a completed payment when Square also holds an earlier declined payment for the order', async () => {
  const f = await setup();
  vi.mocked(f.deps.square.findPaymentsForOrder).mockResolvedValue(['sq_declined', 'sq_completed']);
  vi.mocked(f.deps.square.verifyPayment).mockImplementation(async ({ paymentId }) => paymentId === 'sq_completed' ? { verified: true } : { verified: false, field: 'status', status: 'FAILED' });
  await pollPendingPayments(f.deps);
  expect(f.order.status).toBe('FULFILLMENT_READY'); expect(f.order.squarePaymentId).toBe('sq_completed'); expect(f.queuedOrders.size).toBe(1);
});
it('poller recovers a later completed payment on an order already marked PAYMENT_FAILED within the window', async () => {
  const f = await setup(); f.order.status = 'PAYMENT_FAILED';
  await pollPendingPayments(f.deps);
  expect(f.order.status).toBe('FULFILLMENT_READY'); expect(f.queuedOrders.size).toBe(1);
});
it('the payment lookup is scoped to the business that owns the Square integration', async () => {
  const f = await setup(); await f.send(); await f.drain();
  expect(f.deps.orders.findBySquareOrderId).toHaveBeenCalledWith(f.order.businessId, 'sq_order');
});
it('ends a call that belongs to the other business sharing the Twilio number', async () => {
  const f = await setup();
  vi.mocked(f.deps.calls.findByProviderId).mockResolvedValue({ id: 'call_barber', businessId: 'biz_barber_01', startedAt: '2026-11-13T20:00:00Z' });
  vi.mocked(f.deps.calls.endOnce).mockResolvedValue(true);
  expect((await f.twilio('CallSid=CA9&CallStatus=completed')).statusCode).toBe(204); await f.drain();
  expect(f.deps.calls.endOnce).toHaveBeenCalledWith('call_barber', 'COMPLETED', expect.any(String));
  expect(f.events.filter(e => e.type === 'call.ended')).toMatchObject([{ businessId: 'biz_barber_01' }]);
});
it('updates a WhatsApp dispatch that belongs to the other business sharing the Twilio account', async () => {
  const f = await setup();
  vi.mocked(f.deps.dispatch.findByProviderId).mockResolvedValue({ id: 'msg_barber', businessId: 'biz_barber_01', subjectId: 'bkg_1', channel: 'whatsapp_sandbox' });
  vi.mocked(f.deps.dispatch.updateStatus).mockResolvedValue(true);
  await f.twilio('MessageSid=SM9&MessageStatus=delivered'); await f.drain();
  expect(f.deps.dispatch.updateStatus).toHaveBeenCalledWith('msg_barber', 'DELIVERED');
});
it('ignores a Twilio status for an unknown call without storing it', async () => {
  const f = await setup(); expect((await f.twilio('CallSid=CAx&CallStatus=failed')).statusCode).toBe(204); expect(f.stored.size).toBe(0);
});

it('ignores signed events of other types and wrong-shape payment events without reading Square', async () => {
  const f = await setup();
  for (const body of [
    JSON.stringify({ event_id: 'e_refund', type: 'refund.updated', data: { object: { refund: { id: 'r1', payment_id: 'sq_payment', order_id: 'sq_order' } } } }),
    JSON.stringify({ event_id: 'e_order', type: 'order.updated', data: { object: { order_updated: { order_id: 'sq_order', state: 'COMPLETED' } } } }),
    JSON.stringify({ event_id: 'e_shape', type: 'payment.updated', data: 'COMPLETED' }),
    JSON.stringify({ event_id: 'e_arr', type: 'payment.updated', data: { object: { payment: [{ id: 'sq_payment', order_id: 'sq_order' }] } } }),
  ]) expect((await f.send(body)).statusCode).toBe(200);
  await f.drain(); expect(f.deps.square.verifyPayment).not.toHaveBeenCalled(); expect(f.order.status).toBe('PAYMENT_PENDING');
});
it('stores only routing ids from a verified Square body, never status, amount or card data', async () => {
  const f = await setup();
  await f.send(JSON.stringify({ event_id: 'e1', type: 'payment.updated', data: { id: 'sq_payment', object: { payment: { id: 'sq_payment', order_id: 'sq_order', status: 'COMPLETED', amount_money: { amount: 1, currency: 'USD' }, card_details: { card: { last_4: '1111' } } } } } }));
  expect(vi.mocked(f.deps.store.recordOnce).mock.calls[0]![0].payload).toEqual({ paymentId: 'sq_payment', squareOrderId: 'sq_order' });
});
it('a rejected webhook event carries nothing from the request', async () => {
  const f = await setup(); await f.send(JSON.stringify({ event_id: 'secret_evt', type: 'payment.updated', note: '+15555550123' }), 'forged');
  await f.twilio('CallSid=CA1&CallStatus=completed&From=%2B15555550123', 'bad');
  expect(f.events.map(e => e.payload)).toEqual([{ provider: 'square', reason: 'signature_invalid' }, { provider: 'twilio', reason: 'signature_invalid' }]);
  expect(JSON.stringify(f.events)).not.toMatch(/secret_evt|15555550123|CA1/);
});
it('rejects a Twilio callback with no signature header', async () => {
  const f = await setup();
  const res = await f.app.inject({ method: 'POST', url: '/webhooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'CallSid=CA1&CallStatus=completed' });
  expect(res.statusCode).toBe(401); expect(f.stored.size).toBe(0);
});
it('a second completed payment for an already paid order changes nothing and queues no second Sheets job', async () => {
  const f = await setup(); await f.send(); await f.drain();
  vi.mocked(f.deps.square.findPaymentsForOrder).mockResolvedValue(['sq_payment_2']);
  await f.send(JSON.stringify({ event_id: 'e2', type: 'payment.updated', data: { object: { payment: { id: 'sq_payment_2', order_id: 'sq_order' } } } }));
  await f.drain(); await pollPendingPayments(f.deps);
  expect(f.order.squarePaymentId).toBe('sq_payment'); expect(f.queuedOrders.size).toBe(1); expect(f.sync.queueOrder).toHaveBeenCalledTimes(1);
});
it('does not mark paid when the locked row no longer matches what Square was checked against', async () => {
  const f = await setup();
  vi.mocked(f.deps.square.verifyPayment).mockImplementation(async () => { f.order.totalMinor = f.order.totalMinor + 100; return { verified: true }; });
  await f.send(); await f.drain(); expect(f.order.status).toBe('PAYMENT_PENDING'); expect(f.sync.queueOrder).not.toHaveBeenCalled();
});
it('a recorded event whose job is lost is recovered by the poller inside the window', async () => {
  const f = await setup(); await f.send(); f.jobs.splice(0);
  expect(f.order.status).toBe('PAYMENT_PENDING');
  await pollPendingPayments(f.deps); expect(f.order.status).toBe('FULFILLMENT_READY'); expect(f.queuedOrders.size).toBe(1);
});
it('a Square timeout during polling leaves the order unpaid, not failed, for the next tick', async () => {
  const f = await setup(); vi.mocked(f.deps.square.verifyPayment).mockRejectedValueOnce(new Error('timeout'));
  await expect(pollPendingPayments(f.deps)).rejects.toThrow('Payment reconciliation requires retry');
  expect(f.order.status).toBe('PAYMENT_PENDING'); expect(f.events).toHaveLength(0);
  await pollPendingPayments(f.deps); expect(f.order.status).toBe('FULFILLMENT_READY');
});
