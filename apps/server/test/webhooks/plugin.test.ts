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
  app.post('/ordinary', async (req) => req.body);
  await app.register(webhooksPlugin, f.deps).ready();
  const send = (body = paymentEvent(), signature = sign(Buffer.from(body))) => app.inject({ method: 'POST', url: '/webhooks/square', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature }, payload: body });
  return { ...f, app, send };
}
it('AC-11 rejects forged signatures before parsing or claiming an event id', async () => {
  const f = await setup();
  const res = await f.send('{broken', 'forged');
  expect(res.statusCode).toBe(401); expect(res.json().code).toBe('SIGNATURE_INVALID');
  expect(f.stored.size).toBe(0); expect(f.move).not.toHaveBeenCalled(); expect(f.jobs).toHaveLength(0);
  expect(f.events).toHaveLength(1); expect(f.events[0]).toMatchObject({ businessId: f.order.businessId, type: 'webhook.rejected', payload: { provider: 'square', reason: 'signature_invalid' } });
  await f.send(); await f.drain(); expect(f.order.status).toBe('FULFILLMENT_READY');
});
it('verifies the original bytes and exact configured URL, while ordinary JSON routes stay parsed', async () => {
  const f = await setup(); const body = ` \n ${paymentEvent()} \n`;
  expect((await f.send(body, sign(Buffer.from(paymentEvent())))).statusCode).toBe(401);
  expect((await f.send(body)).statusCode).toBe(200);
  expect(f.deps.square.verifyWebhookSignature).toHaveBeenLastCalledWith(expect.objectContaining({ rawBody: Buffer.from(body), notificationUrl: f.deps.config.squareNotificationUrl }));
  const res = await f.app.inject({ method: 'POST', url: '/ordinary', payload: { value: 1 } }); expect(res.json()).toEqual({ value: 1 });
});
it('AC-10 processes an event id once and queues one Sheets job after two status moves', async () => {
  const f = await setup(); await f.send(); await f.send(); await f.drain();
  expect(f.deps.square.verifyPayment).toHaveBeenCalledTimes(1);
  expect(f.move.mock.calls.map(([to]) => to)).toEqual(['PAID_VERIFIED', 'FULFILLMENT_READY']);
  expect(f.order.squarePaymentId).toBe('sq_payment'); expect(f.sync.queueOrder).toHaveBeenCalledTimes(1);
  expect(f.events.filter(e => e.type === 'payment.verified')).toHaveLength(1);
  expect(f.deps.square.verifyPayment).toHaveBeenCalledWith({ paymentId: 'sq_payment', expected: { amountMinor: f.order.totalMinor, currency: f.order.currency, locationId: 'loc', squareOrderId: 'sq_order' } });
});
it.each(['amount', 'currency', 'location', 'order'] as const)('refuses %s mismatch without marking paid', async field => {
  const f = await setup(); f.setVerification({ verified: false, field }); await f.send(); await f.drain();
  expect(f.order.status).toBe('PAYMENT_PENDING'); expect(f.sync.queueOrder).not.toHaveBeenCalled(); expect(f.events.at(-1)?.type).toBe('guardrail.refused');
});
it.each(['FAILED', 'CANCELED', 'PENDING', 'APPROVED'] as const)('AC-12 never marks %s paid', async status => {
  const f = await setup(); f.setVerification({ verified: false, field: 'status', status }); await f.send(); await f.drain();
  expect(f.order.status).toBe(status === 'FAILED' || status === 'CANCELED' ? 'PAYMENT_FAILED' : 'PAYMENT_PENDING'); expect(f.sync.queueOrder).not.toHaveBeenCalled();
});
it('webhook and poller racing produce one paid transition and one sync job', async () => {
  const f = await setup(); await f.send(); await Promise.all([f.drain(), pollPendingPayments(f.deps)]);
  expect(f.move.mock.calls.map(([to]) => to)).toEqual(['PAID_VERIFIED', 'FULFILLMENT_READY']); expect(f.sync.queueOrder).toHaveBeenCalledTimes(1);
});
it('ignores a late older event after payment verification', async () => {
  const f = await setup(); await f.send(); await f.drain(); f.setVerification({ verified: false, field: 'status', status: 'FAILED' });
  await f.send(paymentEvent('older')); await f.drain(); expect(f.order.status).toBe('FULFILLMENT_READY'); expect(f.deps.square.verifyPayment).toHaveBeenCalledTimes(1);
});
it('ignores unknown orders with 200', async () => {
  const f = await setup(); expect((await f.send(paymentEvent('unknown', 'unknown'))).statusCode).toBe(200); await f.drain(); expect(f.deps.square.verifyPayment).not.toHaveBeenCalled();
});
it('answers before slow processing completes', async () => {
  const f = await setup(); let finish = () => {};
  vi.mocked(f.deps.square.verifyPayment).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ verified: true }); }));
  expect((await f.send()).statusCode).toBe(200);
  const work = f.drain(); await vi.waitFor(() => expect(f.deps.square.verifyPayment).toHaveBeenCalled());
  expect(f.order.status).toBe('PAYMENT_PENDING'); finish(); await work; expect(f.order.status).toBe('FULFILLMENT_READY');
});
it('rejects bad Twilio signatures and deduplicates call statuses', async () => {
  const f = await setup(); vi.mocked(f.deps.calls.findByProviderId).mockResolvedValue({ id: 'call_test', businessId: f.order.businessId, startedAt: '2026-11-13T20:00:00Z' });
  vi.mocked(f.deps.calls.endOnce).mockResolvedValue(true);
  const send = (sig: string) => f.app.inject({ method: 'POST', url: '/webhooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, payload: 'CallSid=CA1&CallStatus=completed' });
  expect((await send('bad')).statusCode).toBe(401); expect(f.stored.size).toBe(0);
  expect((await send('valid')).statusCode).toBe(204); await send('valid'); await f.drain(); expect(f.deps.calls.endOnce).toHaveBeenCalledTimes(1); expect(f.events.filter(e => e.type === 'call.ended')).toHaveLength(1);
});

it.each([
  ['completed', 'COMPLETED', 'completed'], ['busy', 'DROPPED', 'dropped'],
  ['no-answer', 'DROPPED', 'dropped'], ['canceled', 'DROPPED', 'dropped'], ['failed', 'FAILED', 'failed'],
] as const)('maps Twilio call status %s and emits call.ended only for the winning callback', async (status, expected, reason) => {
  const f = await setup();
  vi.mocked(f.deps.calls.findByProviderId).mockResolvedValue({ id: 'call_test', businessId: f.order.businessId, startedAt: '2026-11-13T20:00:00Z' });
  vi.mocked(f.deps.calls.endOnce).mockResolvedValueOnce(true).mockResolvedValue(false);
  const post = (state: string) => f.app.inject({ method: 'POST', url: '/webhooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'valid' }, payload: `CallSid=CA1&CallStatus=${state}` });
  await post(status); await f.drain();
  expect(f.deps.calls.endOnce).toHaveBeenCalledWith('call_test', expected, '2026-11-13T20:05:00.000Z');
  expect(f.events.filter(e => e.type === 'call.ended')).toMatchObject([{ payload: { status: expected, reason, durationSec: 300 } }]);
  await post(status === 'failed' ? 'completed' : 'failed'); await f.drain();
  expect(f.events.filter(e => e.type === 'call.ended')).toHaveLength(1);
});
it.each(['whatsapp_sandbox', 'surge', 'android_gateway'] as const)('only updates WhatsApp dispatches: %s', async channel => {
  const f = await setup();
  vi.mocked(f.deps.dispatch.findByProviderId).mockResolvedValue({ id: 'msg_test', businessId: f.order.businessId, subjectId: f.order.id, channel });
  vi.mocked(f.deps.dispatch.updateStatus).mockResolvedValue(true);
  const post = () => f.app.inject({ method: 'POST', url: '/webhooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'valid' }, payload: 'MessageSid=SM1&MessageStatus=undelivered&To=%2B15555550123' });
  expect((await post()).statusCode).toBe(204); await post(); await f.drain();
  expect(f.deps.dispatch.updateStatus).toHaveBeenCalledTimes(channel === 'whatsapp_sandbox' ? 1 : 0);
  if (channel === 'whatsapp_sandbox') {
    expect(f.events.at(-1)).toMatchObject({ type: 'message.failed', payload: { channel, status: 'FAILED' } });
    expect(JSON.stringify(vi.mocked(f.deps.store.recordOnce).mock.calls)).not.toContain('15555550123');
  }
});
it('unknown Twilio call and message IDs are ignored safely', async () => {
  const f = await setup();
  for (const payload of ['CallSid=unknown&CallStatus=completed', 'MessageSid=unknown&MessageStatus=failed']) {
    expect((await f.app.inject({ method: 'POST', url: '/webhooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'valid' }, payload })).statusCode).toBe(204);
  }
  await f.drain(); expect(f.deps.calls.endOnce).not.toHaveBeenCalled(); expect(f.deps.dispatch.updateStatus).not.toHaveBeenCalled();
});
it('ignores Square references for another business', async () => {
  const f = await setup(); vi.mocked(f.deps.orders.findBySquareOrderId).mockResolvedValue({ ...f.order, businessId: 'biz_other' });
  await f.send(); await f.drain(); expect(f.deps.square.verifyPayment).not.toHaveBeenCalled();
});
it('does not store verified malformed envelopes and does not trust body totals or status', async () => {
  const f = await setup(); expect((await f.send('{broken')).statusCode).toBe(400); expect(f.stored.size).toBe(0);
  f.setVerification({ verified: false, field: 'status', status: 'PENDING' }); await f.send(); await f.drain();
  expect(f.order.status).toBe('PAYMENT_PENDING'); expect(f.events).toHaveLength(0);
});
it('a provider read error leaves the pending order eligible for job retry', async () => {
  const f = await setup(); vi.mocked(f.deps.square.verifyPayment).mockRejectedValueOnce(new Error('Provider unavailable'));
  await f.send(); const job = f.jobs[0]!; await expect(job()).rejects.toThrow('Provider unavailable');
  expect(f.order.status).toBe('PAYMENT_PENDING'); expect(f.events).toHaveLength(0);
  await job(); expect(f.order.status).toBe('FULFILLMENT_READY'); expect(f.sync.queueOrder).toHaveBeenCalledTimes(1);
});
it('responds while an immediately started job is still waiting on the provider', async () => {
  const f = await setup(); let finish = () => {}; let work = Promise.resolve();
  vi.mocked(f.deps.square.verifyPayment).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ verified: true }); }));
  vi.mocked(f.deps.jobs.enqueue).mockImplementation(async (_id, run) => { work = run(); await work; });
  const res = await f.send(); expect(res.statusCode).toBe(200);
  await vi.waitFor(() => expect(f.deps.square.verifyPayment).toHaveBeenCalled());
  expect(f.order.status).toBe('PAYMENT_PENDING'); finish(); await work; expect(f.order.status).toBe('FULFILLMENT_READY');
});
it('ignores unrecognized Twilio statuses, including object prototype names', async () => {
  const f = await setup();
  for (const payload of ['CallSid=CA1&CallStatus=constructor', 'MessageSid=SM1&MessageStatus=toString']) {
    expect((await f.app.inject({ method: 'POST', url: '/webhooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'valid' }, payload })).statusCode).toBe(204);
  }
  expect(f.stored.size).toBe(0);
});
it('never exposes injected provider errors in the HTTP response', async () => {
  const f = await setup(); vi.mocked(f.deps.square.verifyWebhookSignature).mockImplementation(() => { throw new Error('private-provider-detail'); });
  const res = await f.send(); expect(res.statusCode).toBe(500); expect(res.json().code).toBe('INTERNAL'); expect(res.body).not.toContain('private-provider-detail');
});
it('rolls back payment changes and activity if queuing the local sync job fails, then retries safely', async () => {
  const f = await setup(); f.sync.queueOrder.mockRejectedValueOnce(new Error('Database unavailable'));
  await f.send(); const job = f.jobs[0]!;
  await expect(job()).rejects.toThrow('Database unavailable');
  expect(f.order.status).toBe('PAYMENT_PENDING'); expect(f.order.squarePaymentId).toBeUndefined(); expect(f.events).toHaveLength(0); expect(f.queuedOrders.size).toBe(0);
  await job(); await job();
  expect(f.order.status).toBe('FULFILLMENT_READY'); expect(f.queuedOrders.size).toBe(1); expect(f.events.filter(e => e.type === 'payment.verified')).toHaveLength(1);
});
it('accepts a later verified successful payment after a declined attempt', async () => {
  const f = await setup(); f.setVerification({ verified: false, field: 'status', status: 'FAILED' });
  await f.send(); await f.drain(); expect(f.order.status).toBe('PAYMENT_FAILED');
  f.setVerification({ verified: true }); await f.send(paymentEvent('later_success')); await f.drain();
  expect(f.order.status).toBe('FULFILLMENT_READY'); expect(f.queuedOrders.size).toBe(1);
  expect(f.events.filter(e => e.type === 'order.status_changed')).toMatchObject([
    { payload: { from: 'PAYMENT_PENDING', to: 'PAYMENT_FAILED' } },
    { payload: { from: 'PAYMENT_FAILED', to: 'PAID_VERIFIED' } },
    { payload: { from: 'PAID_VERIFIED', to: 'FULFILLMENT_READY' } },
  ]);
});
