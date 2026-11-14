// B-23 group 3 (AGENTS rules 2 and 5): Square webhooks under attack. Forged, replayed, reordered,
// cross-business, mismatched and malformed deliveries, each with the exact number of external writes
// and the stored state afterwards. The body of a webhook is never trusted: the fake Square's own
// record of the payment is what the server reads.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentRole } from '../support/db';
import { PUBLIC_URL, SQUARE_SIGNATURE_KEY, createWorld, type World } from '../e2e/world';
import {
  BARBER, NONE, PIZZA, SQUARE_URL, count, counts, delta, order, paymentEvent, pizzaToPaymentPending, postSquare, signWith, webhookState,
} from './helpers';

let w: World;
beforeAll(async () => { w = await createWorld(); }, 120_000);
afterAll(async () => { await w?.close(); });

const reads = () => w.square.calls.filter((c) => c === 'payments.get').length;
const eventsFor = (orderId: string, type: string) => count(w, "activity_events where type = $1 and payload->>'orderId' = $2", [type, orderId]);
const syncJobsFor = (orderId: string) => count(w, 'sync_jobs where record_id = $1', [orderId]);

it('runs as abos_app with the webhook routes enabled', async () => {
  expect(await currentRole(w.t.db)).toBe('abos_app');
  expect(w.app.composed.webhooks?.enabled).toBe(true);
});

describe('signature', () => {
  it('a bad signature in every form: 401 SIGNATURE_INVALID, nothing stored, no Square read, one webhook.rejected each', async () => {
    const { orderId, squareOrderId } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const state = await webhookState(w);
    const readsBefore = reads();
    const body = paymentEvent('evt_adv_forged_1', 'PAY_FORGED', squareOrderId);
    const good = w.squareSignature(body);
    const forged: [string, string, string][] = [
      ['signed with another key', body, signWith('attacker-key', body)],
      ['signed for another URL', body, signWith(SQUARE_SIGNATURE_KEY, body, 'https://attacker.example.test/webhooks/square')],
      ['signed for the URL without its path', body, signWith(SQUARE_SIGNATURE_KEY, body, PUBLIC_URL)],
      ['signed for the http URL', body, signWith(SQUARE_SIGNATURE_KEY, body, SQUARE_URL.replace('https:', 'http:'))],
      ['body changed after signing', body.replace('PAY_FORGED', 'PAY_FORGE2'), good],
      ['whitespace added to the signed body', `${body} `, good],
      ['the right signature as hex', body, Buffer.from(good, 'base64').toString('hex')],
      ['the right signature truncated', body, good.slice(0, -4)],
      ['the right signature with a suffix', body, `${good}AAAA`],
      ['an empty signature', body, ''],
      ['the signing key itself', body, SQUARE_SIGNATURE_KEY],
      ['a very long signature', body, 'A'.repeat(20_000)],
      ['the body as the signature', body, Buffer.from(body).toString('base64')],
    ];
    for (const [name, sentBody, signature] of forged) {
      const res = await postSquare(w, sentBody, signature);
      expect(res.statusCode, name).toBe(401);
      expect(res.json(), name).toMatchObject({ code: 'SIGNATURE_INVALID', retryable: false });
      expect(res.body, name).not.toContain(SQUARE_SIGNATURE_KEY);
      expect(res.body, name).not.toContain(good);
    }
    expect(await webhookState(w)).toEqual({ ...state, rejected: state.rejected + forged.length });
    // The rejection event carries nothing from the unverified body (SPEC 2.9).
    const rejected = (await w.t.db.query("select business_id, actor_type, payload from activity_events where type = 'webhook.rejected' order by occurred_at desc limit $1", [forged.length])).rows as { business_id: string; actor_type: string; payload: unknown }[];
    for (const r of rejected) expect(r).toEqual({ business_id: PIZZA, actor_type: 'provider', payload: { provider: 'square', reason: 'signature_invalid' } });
    expect(reads()).toBe(readsBefore);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(delta(w, before)).toEqual(NONE);
  });

  it('no signature header at all: 401, nothing stored, even when Square would confirm the payment', async () => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const state = await webhookState(w);
    const readsBefore = reads();
    // The payment is real at Square. The unsigned delivery still must not be what marks it paid.
    w.square.addPayment({ id: 'PAY_UNSIGNED', orderId: squareOrderId, amountMinor: totalMinor, status: 'COMPLETED' });
    const body = paymentEvent('evt_adv_unsigned_1', 'PAY_UNSIGNED', squareOrderId);
    const res = await postSquare(w, body, null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    // The header under another name is not accepted either.
    const misnamed = await w.app.inject({ method: 'POST', url: '/webhooks/square', headers: { 'content-type': 'application/json', 'x-square-signature': w.squareSignature(body) }, payload: body });
    expect(misnamed.statusCode).toBe(401);
    await w.settle();
    expect(await webhookState(w)).toEqual({ ...state, rejected: state.rejected + 2 });
    expect(reads()).toBe(readsBefore);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(delta(w, before)).toEqual(NONE);
    w.square.payments.delete('PAY_UNSIGNED');
  });
});

describe('duplicate delivery', () => {
  it('one correctly signed body delivered 50 times: stored once, paid once, one Sheets row', async () => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const state = await webhookState(w);
    w.square.addPayment({ id: 'PAY_REPLAY', orderId: squareOrderId, amountMinor: totalMinor, status: 'COMPLETED' });
    const body = paymentEvent('evt_adv_replay_1', 'PAY_REPLAY', squareOrderId);
    const signature = w.squareSignature(body);
    const send = () => w.app.inject({ method: 'POST', url: '/webhooks/square', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature }, payload: body });
    // 25 at once, then 25 one after another once the first has been processed.
    const burst = await Promise.all(Array.from({ length: 25 }, send));
    await w.settle();
    const readsAfterBurst = reads();
    const later = [];
    for (let i = 0; i < 25; i++) { later.push(await send()); await w.settle(); }
    expect([...burst, ...later].map((r) => r.statusCode)).toEqual(Array.from({ length: 50 }, () => 200));
    const after = await webhookState(w);
    expect(after).toEqual({ ...state, stored: state.stored + 1, verified: state.verified + 1, syncJobs: state.syncJobs + 1 });
    expect(await count(w, "webhook_events where source = 'square' and provider_event_id = 'evt_adv_replay_1'")).toBe(1);
    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_REPLAY' });
    expect(await eventsFor(orderId, 'payment.verified')).toBe(1);
    expect(await syncJobsFor(orderId)).toBe(1);
    expect(w.sheets.appended.filter((a) => a.recordId === orderId)).toHaveLength(1);
    // A replay of a processed event does not even read Square again.
    expect(reads()).toBe(readsAfterBurst);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 1 });
  });

  it('two different event IDs for the same payment: both stored, paid once, one Sheets row', async () => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const state = await webhookState(w);
    w.square.addPayment({ id: 'PAY_TWICE', orderId: squareOrderId, amountMinor: totalMinor, status: 'COMPLETED' });
    const created = paymentEvent('evt_adv_twice_created', 'PAY_TWICE', squareOrderId, { type: 'payment.created' });
    const updated = paymentEvent('evt_adv_twice_updated', 'PAY_TWICE', squareOrderId, { type: 'payment.updated' });
    const [a, b] = await Promise.all([postSquare(w, created), postSquare(w, updated)]);
    expect([a!.statusCode, b!.statusCode]).toEqual([200, 200]);
    // And a third ID for it, well after the order is paid.
    expect((await postSquare(w, paymentEvent('evt_adv_twice_again', 'PAY_TWICE', squareOrderId))).statusCode).toBe(200);
    expect(await webhookState(w)).toEqual({ ...state, stored: state.stored + 3, verified: state.verified + 1, syncJobs: state.syncJobs + 1 });
    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_TWICE' });
    expect(await eventsFor(orderId, 'payment.verified')).toBe(1);
    expect(await count(w, "activity_events where type = 'order.status_changed' and payload->>'orderId' = $1 and payload->>'to' = 'PAID_VERIFIED'", [orderId])).toBe(1);
    expect(await syncJobsFor(orderId)).toBe(1);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 1 });
  });

  it('the stored row keeps routing IDs only, never the status or amount the body claimed', async () => {
    const stored = (await w.t.db.query("select payload, business_id from webhook_events where source = 'square' and provider_event_id = 'evt_adv_replay_1'")).rows[0] as { payload: Record<string, unknown>; business_id: string };
    expect(stored.business_id).toBe(PIZZA);
    expect(Object.keys(stored.payload).sort()).toEqual(['paymentId', 'squareOrderId']);
    expect(JSON.stringify(stored.payload)).not.toMatch(/COMPLETED|amount/);
  });
});

describe('events out of order', () => {
  it('failed after completed: the paid order stays paid, no payment.failed, no second Sheets row', async () => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    w.square.addPayment({ id: 'PAY_OOO_OK', orderId: squareOrderId, amountMinor: totalMinor, status: 'COMPLETED' });
    w.square.addPayment({ id: 'PAY_OOO_DECLINED', orderId: squareOrderId, amountMinor: totalMinor, status: 'FAILED' });
    expect((await postSquare(w, paymentEvent('evt_adv_ooo_1', 'PAY_OOO_OK', squareOrderId))).statusCode).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_OOO_OK' });
    // The earlier, declined attempt is delivered late. Then a stale event for the paid payment claims FAILED.
    expect((await postSquare(w, paymentEvent('evt_adv_ooo_2', 'PAY_OOO_DECLINED', squareOrderId, { status: 'FAILED' }))).statusCode).toBe(200);
    expect((await postSquare(w, paymentEvent('evt_adv_ooo_3', 'PAY_OOO_OK', squareOrderId, { status: 'FAILED' }))).statusCode).toBe(200);
    await w.app.composed.webhooks!.reconcileNow();
    await w.settle();
    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_OOO_OK' });
    expect(await eventsFor(orderId, 'payment.failed')).toBe(0);
    expect(await eventsFor(orderId, 'payment.verified')).toBe(1);
    expect(await syncJobsFor(orderId)).toBe(1);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 1 });
  });

  it('completed after failed: PAYMENT_FAILED with no Sheets row, then the later completed payment verifies once', async () => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    w.square.addPayment({ id: 'PAY_DECLINED_FIRST', orderId: squareOrderId, amountMinor: totalMinor, status: 'FAILED' });
    // The body claims COMPLETED. Square says FAILED, and Square is what counts.
    expect((await postSquare(w, paymentEvent('evt_adv_caf_1', 'PAY_DECLINED_FIRST', squareOrderId, { status: 'COMPLETED' }))).statusCode).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_FAILED', square_payment_id: null });
    expect(await eventsFor(orderId, 'payment.failed')).toBe(1);
    expect(await eventsFor(orderId, 'payment.verified')).toBe(0);
    expect(await syncJobsFor(orderId)).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
    // The same failed payment again, under a new event ID: no second payment.failed.
    expect((await postSquare(w, paymentEvent('evt_adv_caf_2', 'PAY_DECLINED_FIRST', squareOrderId))).statusCode).toBe(200);
    expect(await eventsFor(orderId, 'payment.failed')).toBe(1);
    w.square.addPayment({ id: 'PAY_RETRY_OK', orderId: squareOrderId, amountMinor: totalMinor, status: 'COMPLETED' });
    expect((await postSquare(w, paymentEvent('evt_adv_caf_3', 'PAY_RETRY_OK', squareOrderId))).statusCode).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_RETRY_OK' });
    expect(await eventsFor(orderId, 'payment.verified')).toBe(1);
    expect(await syncJobsFor(orderId)).toBe(1);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 1 });
  });

  it('an event that arrives before the payment completes changes nothing; the completed one verifies', async () => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    w.square.addPayment({ id: 'PAY_EARLY', orderId: squareOrderId, amountMinor: totalMinor, status: 'APPROVED' });
    expect((await postSquare(w, paymentEvent('evt_adv_early_1', 'PAY_EARLY', squareOrderId, { status: 'COMPLETED' }))).statusCode).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(await eventsFor(orderId, 'payment.failed')).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
    w.square.payments.get('PAY_EARLY')!.status = 'COMPLETED';
    expect((await postSquare(w, paymentEvent('evt_adv_early_2', 'PAY_EARLY', squareOrderId))).statusCode).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_EARLY' });
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 1 });
  });
});

describe('a signed event that does not match the order', () => {
  // Each case: Square holds a COMPLETED payment for the order, but one field disagrees with what the
  // owner approved. The webhook and then the reconcile poll both see it; neither may mark the order paid.
  it.each([
    ['amount lower by one cent', { amountDelta: -1 }, 'payment_amount_mismatch'],
    ['amount higher', { amountDelta: 500 }, 'payment_amount_mismatch'],
    ['amount zero', { amountDelta: 'zero' as const }, 'payment_amount_mismatch'],
    ['currency CAD', { currency: 'CAD' }, 'payment_currency_mismatch'],
    ['another location', { locationId: 'LOC_SOMEWHERE_ELSE' }, 'payment_location_mismatch'],
  ] as const)('%s: stays PAYMENT_PENDING, guardrail.refused, no Sheets row', async (name, wrong, reasonCode) => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const refusedBefore = await count(w, "activity_events where type = 'guardrail.refused' and payload->>'reasonCode' = $1", [reasonCode]);
    const paymentId = `PAY_WRONG_${name.replace(/\W+/g, '_')}`;
    const amountDelta = 'amountDelta' in wrong ? wrong.amountDelta : 0;
    w.square.addPayment({ id: paymentId, orderId: squareOrderId, status: 'COMPLETED', amountMinor: amountDelta === 'zero' ? 0 : totalMinor + amountDelta,
      ...('currency' in wrong ? { currency: wrong.currency } : {}), ...('locationId' in wrong ? { locationId: wrong.locationId } : {}) });
    expect((await postSquare(w, paymentEvent(`evt_adv_${paymentId}`, paymentId, squareOrderId))).statusCode).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(await count(w, "activity_events where type = 'guardrail.refused' and payload->>'reasonCode' = $1", [reasonCode])).toBe(refusedBefore + 1);
    await w.app.composed.webhooks!.reconcileNow();
    await w.settle();
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(await eventsFor(orderId, 'payment.verified')).toBe(0);
    expect(await syncJobsFor(orderId)).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
    // Remove it so the poll in later tests is not held up by this order.
    w.square.payments.delete(paymentId);
  });

  it('a refunded payment, fully or in part, does not verify and is not a failed payment', async () => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    w.square.addPayment({ id: 'PAY_ADV_REFUNDED', orderId: squareOrderId, amountMinor: totalMinor, status: 'COMPLETED', refunded: true });
    expect((await postSquare(w, paymentEvent('evt_adv_refunded_1', 'PAY_ADV_REFUNDED', squareOrderId))).statusCode).toBe(200);
    await w.app.composed.webhooks!.reconcileNow();
    await w.settle();
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(await eventsFor(orderId, 'payment.verified')).toBe(0);
    expect(await eventsFor(orderId, 'payment.failed')).toBe(0);
    expect(await syncJobsFor(orderId)).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
    w.square.payments.delete('PAY_ADV_REFUNDED');
  });

  it('a payment that belongs to another Square order cannot pay this one', async () => {
    const victim = await pizzaToPaymentPending(w);
    const other = await pizzaToPaymentPending(w, { recipient: '+15555550133' });
    const before = counts(w);
    // A real completed payment, with the right amount, for the other order. The event points it at the victim.
    w.square.addPayment({ id: 'PAY_ADV_SWAPPED', orderId: other.squareOrderId, amountMinor: victim.totalMinor, status: 'COMPLETED' });
    expect((await postSquare(w, paymentEvent('evt_adv_swapped_1', 'PAY_ADV_SWAPPED', victim.squareOrderId))).statusCode).toBe(200);
    expect(await order(w, victim.orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(await eventsFor(victim.orderId, 'payment.verified')).toBe(0);
    expect(await syncJobsFor(victim.orderId)).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
    w.square.payments.delete('PAY_ADV_SWAPPED');
  });

  it('a payment for an unknown order: stored, no Square read, no state change', async () => {
    const before = counts(w);
    const state = await webhookState(w);
    const readsBefore = reads();
    const paid = await count(w, "orders where status in ('PAID_VERIFIED','FULFILLMENT_READY')");
    w.square.addPayment({ id: 'PAY_ADV_NOWHERE', orderId: 'SQ_ORDER_UNKNOWN', amountMinor: 2393, status: 'COMPLETED' });
    expect((await postSquare(w, paymentEvent('evt_adv_unknown_1', 'PAY_ADV_NOWHERE', 'SQ_ORDER_UNKNOWN'))).statusCode).toBe(200);
    // And an event with no order ID at all.
    const noOrder = JSON.stringify({ type: 'payment.updated', event_id: 'evt_adv_unknown_2', data: { type: 'payment', id: 'PAY_ADV_NOWHERE', object: { payment: { id: 'PAY_ADV_NOWHERE', status: 'COMPLETED' } } } });
    expect((await postSquare(w, noOrder)).statusCode).toBe(200);
    expect(await webhookState(w)).toEqual({ ...state, stored: state.stored + 2 });
    expect(reads()).toBe(readsBefore);
    expect(await count(w, "orders where status in ('PAID_VERIFIED','FULFILLMENT_READY')")).toBe(paid);
    expect(delta(w, before)).toEqual(NONE);
    w.square.payments.delete('PAY_ADV_NOWHERE');
  });

  it('a signed event for an order of another business: that order is not touched through the webhook', async () => {
    // The Square webhook belongs to the pizza business. An order of the barbershop with a Square order ID
    // exists only as an operator fixture here: the server itself never creates one.
    const template = await pizzaToPaymentPending(w);
    await w.t.admin(async (q) => {
      await q.query(`insert into public.calls (id, business_id, agent_id, agent_version_id, channel, status, stage, end_reason, ended_at)
        select 'call_adv_foreign', a.business_id, a.id, a.active_version_id, 'test_console', 'COMPLETED', 'INQUIRY', 'completed', now() from public.agents a where a.business_id = $1`, [BARBER]);
      await q.query(`insert into public.orders (id, business_id, call_id, status, cart, cart_hash, quote, total_minor, currency, contact, fulfillment, square_order_id, square_payment_link_id, checkout_url)
        select 'ord_adv_foreign', $1, 'call_adv_foreign', 'PAYMENT_PENDING', cart, cart_hash, quote, total_minor, currency, contact, fulfillment, 'SQ_ORDER_FOREIGN', 'SQ_LINK_FOREIGN', 'https://sandbox.square.link/u/foreign'
        from public.orders where id = $2`, [BARBER, template.orderId]);
    });
    const before = counts(w);
    const state = await webhookState(w);
    const readsBefore = reads();
    w.square.addPayment({ id: 'PAY_ADV_FOREIGN', orderId: 'SQ_ORDER_FOREIGN', amountMinor: template.totalMinor, status: 'COMPLETED' });
    expect((await postSquare(w, paymentEvent('evt_adv_foreign_1', 'PAY_ADV_FOREIGN', 'SQ_ORDER_FOREIGN'))).statusCode).toBe(200);
    expect(await order(w, 'ord_adv_foreign')).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(await order(w, template.orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect((await w.t.db.query("select business_id from webhook_events where provider_event_id = 'evt_adv_foreign_1'")).rows).toEqual([{ business_id: PIZZA }]);
    expect(await webhookState(w)).toEqual({ ...state, stored: state.stored + 1 });
    expect(await count(w, 'activity_events where business_id = $1 and type like $2', [BARBER, 'payment.%'])).toBe(0);
    expect(reads()).toBe(readsBefore);
    expect(delta(w, before)).toEqual(NONE);
    w.square.payments.delete('PAY_ADV_FOREIGN');
    await w.t.admin((q) => q.query("update public.orders set status = 'CANCELLED' where id = 'ord_adv_foreign'"));
  });
});

describe('huge and malformed bodies', () => {
  it('a body over the size limit is refused with a 4xx before anything is read or stored', async () => {
    const before = counts(w);
    const state = await webhookState(w);
    const huge = JSON.stringify({ type: 'payment.updated', event_id: 'evt_adv_huge_1', padding: 'x'.repeat(3 * 1024 * 1024), data: { id: 'PAY_HUGE' } });
    for (const signature of [w.squareSignature(huge), 'bogus', null]) {
      const res = await postSquare(w, huge, signature);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body.length).toBeLessThan(1000);
    }
    expect(await count(w, "webhook_events where provider_event_id = 'evt_adv_huge_1'")).toBe(0);
    expect((await webhookState(w)).stored).toBe(state.stored);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('a correctly signed body that is not a Square event: 400 VALIDATION_FAILED, nothing stored', async () => {
    const before = counts(w);
    const state = await webhookState(w);
    const bodies = [
      '', 'not json', '{"type":"payment.updated","event_id":', 'null', 'true', '42', '"payment.updated"', '[]', '[{"type":"payment.updated","event_id":"evt_adv_array"}]',
      '{}', '{"type":"payment.updated"}', '{"event_id":"evt_adv_no_type"}', '{"type":"payment.updated","event_id":""}', '{"type":"payment.updated","event_id":123}',
      '{"type":{"$gt":""},"event_id":"evt_adv_bad_type"}', '{"type":"payment.updated","event_id":["evt_adv_list"]}', '{"type":"payment.updated","event_id":null}',
      `\u0000\u0001${'�'.repeat(10)}`,
    ];
    for (const body of bodies) {
      const res = await postSquare(w, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json(), JSON.stringify(body)).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    // Signed binary that is not UTF-8 text.
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x7b, 0x22]);
    const res = await w.app.inject({ method: 'POST', url: '/webhooks/square', headers: { 'content-type': 'application/octet-stream', 'x-square-hmacsha256-signature': signWithBuffer(binary) }, payload: binary });
    expect(res.statusCode).toBe(400);
    await w.settle();
    expect(await webhookState(w)).toEqual(state);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('a signed event with hostile field types or an unrelated type: accepted, stored without them, no state change', async () => {
    const { orderId, squareOrderId } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const state = await webhookState(w);
    const readsBefore = reads();
    const bodies = [
      JSON.stringify({ type: 'payment.updated', event_id: 'evt_adv_types_1', data: { id: { $ne: null }, object: { payment: { id: ['PAY_X'], order_id: { toString: 'SQ_ORDER_1' }, status: 'COMPLETED' } } } }),
      JSON.stringify({ type: 'payment.updated', event_id: 'evt_adv_types_2', data: 'COMPLETED' }),
      JSON.stringify({ type: 'payment.updated', event_id: 'evt_adv_types_3', data: { object: { payment: null } } }),
      JSON.stringify({ type: 'payment.updated', event_id: 'evt_adv_types_4', __proto__: { paymentId: 'PAY_X' }, constructor: { prototype: { squareOrderId } }, data: { object: { payment: { order_id: squareOrderId } } } }),
      // Not a payment event: an order or refund event naming a real order and a status.
      JSON.stringify({ type: 'order.updated', event_id: 'evt_adv_types_5', data: { id: 'PAY_X', object: { payment: { id: 'PAY_X', order_id: squareOrderId, status: 'COMPLETED' } } } }),
      JSON.stringify({ type: 'refund.created', event_id: 'evt_adv_types_6', data: { id: 'PAY_X', object: { payment: { id: 'PAY_X', order_id: squareOrderId } } } }),
      JSON.stringify({ type: 'PAYMENT.UPDATED', event_id: 'evt_adv_types_7', data: { id: 'PAY_X', object: { payment: { id: 'PAY_X', order_id: squareOrderId } } } }),
    ];
    w.square.addPayment({ id: 'PAY_X', orderId: squareOrderId, amountMinor: 1, status: 'COMPLETED' });
    for (const body of bodies) expect((await postSquare(w, body)).statusCode, body).toBe(200);
    expect(await webhookState(w)).toEqual({ ...state, stored: state.stored + bodies.length });
    const rows = (await w.t.db.query("select provider_event_id, payload from webhook_events where provider_event_id like 'evt_adv_types_%' order by provider_event_id")).rows as { provider_event_id: string; payload: Record<string, unknown> }[];
    for (const r of rows) for (const v of Object.values(r.payload)) expect(typeof v, r.provider_event_id).toBe('string');
    expect(rows.slice(0, 3).map((r) => r.payload)).toEqual([{}, {}, {}]);
    expect(reads()).toBe(readsBefore);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(delta(w, before)).toEqual(NONE);
    w.square.payments.delete('PAY_X');
  });

  it('only POST is a webhook: GET, PUT and DELETE on the path are 404 and store nothing', async () => {
    const state = await webhookState(w);
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) expect((await w.app.inject({ method, url: '/webhooks/square' })).statusCode).toBe(404);
    expect(await webhookState(w)).toEqual(state);
  });
});

/** The same HMAC as Square's, over the URL bytes followed by the raw body bytes. */
function signWithBuffer(body: Buffer): string {
  return createHmac('sha256', SQUARE_SIGNATURE_KEY).update(Buffer.concat([Buffer.from(SQUARE_URL, 'utf8'), body])).digest('base64');
}
