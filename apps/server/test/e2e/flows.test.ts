// Integration phase E: the order and booking bundles end to end with the executor and webhooks
// wired, on the in-process Postgres as abos_app, through the real toolset, engine, routines, REST
// API and webhook routes, with fake providers. Every test asserts how many external writes ran.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS, idempotencyKey, type Cart, type Quote, type ToolResult } from '@abos/contracts';
import { createSquareAdapterForTest } from '../../src/adapters/square/testing';
import { createDbExecutor } from '../../src/compose/executor';
import { notWiredExecutor, type SeamDeps } from '../../src/compose/seams';
import { currentRole } from '../support/db';
import { LOCATION_ID, OWNER, createWorld, fakeSquareClient, nextLocalDate, zonedIso, type World } from './world';

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 2, modifierIds: [] }] };
const silentLog: SeamDeps['log'] = { info() {}, warn() {}, error() {} };

type Counts = { square: number; messages: number; calendar: number; sheets: number };
const counts = (w: World): Counts => ({ square: w.squareWrites.length, messages: w.messageSends, calendar: w.calendarWrites.length, sheets: w.sheets.appended.length });
const delta = (w: World, before: Counts): Counts => {
  const now = counts(w);
  return { square: now.square - before.square, messages: now.messages - before.messages, calendar: now.calendar - before.calendar, sheets: now.sheets - before.sheets };
};

async function sim(w: World, agentId: string, businessId: string, body: Record<string, unknown>) {
  const res = await w.app.inject({ method: 'POST', url: `/api/agents/${agentId}/sim-call?businessId=${businessId}`, headers: OWNER, payload: body });
  return res.json() as { callId: string; reply: string };
}

/**
 * Read the catalog and quote through the real toolset. Without consent the toolset proposes (qr_only).
 * With consent the proposal is stored through the engine on the same live call: since B-15 the deployed
 * toolset proposes every order as qr_only until server-owned consent evidence exists (voice NOTES 3),
 * so the message path is reached only this way. It still needs the owner's approval of the exact payload.
 */
async function pizzaOrder(w: World, consent = true) {
  let quote: Quote | undefined;
  const fulfillment = { type: 'pickup' as const, pickupAt: zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles') };
  w.model.push(
    async ({ executeTool }) => { await executeTool('read_catalog', { query: 'pepperoni' }); return 'We have pepperoni.'; },
    async ({ executeTool }) => {
      const r = await executeTool('quote_order', { cart: CART }) as ToolResult<'quote_order'>;
      if (!r.ok) return `quote failed ${r.reason}`;
      quote = r.quote;
      return 'quoted';
    },
    consent ? async () => 'Thanks, the owner will review it.' : async ({ executeTool }) =>
      JSON.stringify(await executeTool('propose_order', { cart: CART, contact: { name: 'Sam', messageConsent: false }, fulfillment, quoteId: quote!.quoteId })),
  );
  const first = await sim(w, 'agt_pizza_01', PIZZA, { message: 'What pizzas do you have?' });
  await sim(w, 'agt_pizza_01', PIZZA, { callId: first.callId, message: 'Two large pepperoni' });
  let ids: { orderId: string; approvalId: string } | undefined;
  if (consent) {
    const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [first.callId])).rows[0] as { agent_version_id: string };
    const { order, approval } = await w.app.composed.engine.createOrderProposal({ businessId: PIZZA, callId: first.callId, agentVersionId: call.agent_version_id,
      cart: CART, quote: quote!, contact: { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: new Date().toISOString() },
      fulfillment, messageChannel: w.app.composed.providers.messageChannel });
    ids = { orderId: order.id, approvalId: approval.id };
  }
  const proposed = await sim(w, 'agt_pizza_01', PIZZA, { callId: first.callId, message: 'Sam, pickup at six', end: true });
  if (ids) return ids;
  const r = JSON.parse(proposed.reply) as { ok: boolean; proposalId: string; approvalId: string };
  expect(r).toMatchObject({ ok: true });
  return { orderId: r.proposalId, approvalId: r.approvalId };
}

async function approve(w: World, businessId: string, approvalId: string) {
  const list = ENDPOINTS.listApprovals.response.parse((await w.app.inject({ url: `/api/approvals?businessId=${businessId}`, headers: OWNER })).json());
  const a = list.items.find((x) => x.id === approvalId)!;
  const res = await w.app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decision?businessId=${businessId}`, headers: OWNER, payload: { decision: 'approve', payloadHash: a.payloadHash } });
  expect(res.statusCode).toBe(200);
  return { res, payloadHash: a.payloadHash };
}

async function steps(w: World, approvalId: string) {
  return (await w.t.db.query('select id, action_type, status, idempotency_key, external_ref, attempts from action_executions where approval_id = $1 order by step_index', [approvalId])).rows as
    { id: string; action_type: string; status: string; idempotency_key: string; external_ref: string | null; attempts: number }[];
}
async function order(w: World, id: string) {
  return (await w.t.db.query('select status, square_order_id, checkout_url, square_payment_id from orders where id = $1', [id])).rows[0] as
    { status: string; square_order_id: string | null; checkout_url: string | null; square_payment_id: string | null };
}
async function countRows(w: World, sql: string, params: unknown[]) {
  return ((await w.t.db.query(sql, params)).rows[0] as { n: number }).n;
}

/** Pizza order through approval and the executor, to PAYMENT_PENDING with a sent link. */
async function pizzaToPaymentPending(w: World) {
  const ids = await pizzaOrder(w);
  await approve(w, PIZZA, ids.approvalId);
  await w.settle();
  expect((await order(w, ids.orderId)).status).toBe('PAYMENT_PENDING');
  return ids;
}

function paymentEvent(eventId: string, paymentId: string, squareOrderId: string) {
  // Status and amount in the body are decoys: the server must read them from Square.
  return JSON.stringify({ merchant_id: 'M_E2E', type: 'payment.updated', event_id: eventId, created_at: new Date().toISOString(),
    data: { type: 'payment', id: paymentId, object: { payment: { id: paymentId, order_id: squareOrderId, status: 'COMPLETED', amount_money: { amount: 1, currency: 'USD' } } } } });
}
async function postSquare(w: World, body: string, signature = w.squareSignature(body)) {
  const res = await w.app.inject({ method: 'POST', url: '/webhooks/square', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature }, payload: body });
  await w.settle();
  return res;
}
async function orderTotal(w: World, id: string) {
  return ((await w.t.db.query('select total_minor from orders where id = $1', [id])).rows[0] as { total_minor: number }).total_minor;
}

describe('pizza order bundle with the executor and webhooks', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('runs as abos_app', async () => { expect(await currentRole(w.t.db)).toBe('abos_app'); });

  let paid: { orderId: string; approvalId: string; squareOrderId: string; body: string } | undefined;

  it('paid path: approve, checkout with the database key, one message, webhook, PAID_VERIFIED, Sheets job run', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    await approve(w, PIZZA, approvalId);
    await w.settle();

    const s = await steps(w, approvalId);
    expect(s.map((x) => [x.action_type, x.status])).toEqual([['square.checkout.create', 'SUCCEEDED'], ['message.checkout.send', 'SUCCEEDED'], ['local.order.record', 'SUCCEEDED']]);
    // The key Square received is the one the database derived for the step, unchanged.
    expect(w.square.createKeys.at(-1)).toBe(s[0]!.idempotency_key);
    expect(s[0]!.idempotency_key).toBe(await idempotencyKey({ businessId: PIZZA, subjectId: orderId, actionType: 'square.checkout.create', approvalId }));
    const o = await order(w, orderId);
    expect(o).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(s[0]!.external_ref).toBe(o.square_order_id);
    // One message, with the link as the last line, recorded as SENT with the provider ID.
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
    expect(w.messages.sent.at(-1)!.body.split('\n').at(-1)).toBe(o.checkout_url);
    expect(w.messages.sent.at(-1)!.idempotencyKey).toBe(s[1]!.idempotency_key);
    expect((await w.t.db.query('select status, provider_message_id from message_dispatches where execution_id = $1', [s[1]!.id])).rows[0]).toEqual({ status: 'SENT', provider_message_id: s[1]!.external_ref });
    expect(await countRows(w, "select count(*)::int as n from sync_jobs where record_id = $1", [orderId])).toBe(0);

    // The customer pays; Square sends a signed webhook. Square's own record is what verifies it.
    w.square.addPayment({ id: 'PAY_OK_1', orderId: o.square_order_id!, amountMinor: await orderTotal(w, orderId), status: 'COMPLETED' });
    const body = paymentEvent('evt_sq_paid_1', 'PAY_OK_1', o.square_order_id!);
    expect((await postSquare(w, body)).statusCode).toBe(200);

    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_OK_1' });
    const types = (await w.t.db.query("select type, payload from activity_events where business_id = $1 and payload->>'orderId' = $2 order by occurred_at, id", [PIZZA, orderId])).rows as { type: string; payload: { to?: string } }[];
    expect(types.some((e) => e.type === 'order.status_changed' && e.payload.to === 'PAID_VERIFIED')).toBe(true);
    expect(types.some((e) => e.type === 'payment.verified')).toBe(true);
    // The transition into PAID_VERIFIED enqueued the one Sheets job, and the executor ran it.
    expect((await w.t.db.query('select state, external_ref from sync_jobs where record_type = $1 and record_id = $2', ['order', orderId])).rows).toEqual([{ state: 'DONE', external_ref: orderId }]);
    expect(w.sheets.appended.at(-1)).toMatchObject({ recordId: orderId, tab: 'Orders' });
    expect(w.sheets.appended.at(-1)!.row[0]).toBe(orderId);
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 1 });
    paid = { orderId, approvalId, squareOrderId: o.square_order_id!, body };
  });

  it('a duplicate webhook delivery changes nothing', async () => {
    expect(paid).toBeDefined();
    const before = counts(w);
    const reads = w.square.calls.length;
    const stored = await countRows(w, 'select count(*)::int as n from webhook_events', []);
    const events = await countRows(w, 'select count(*)::int as n from activity_events', []);
    expect((await postSquare(w, paid!.body)).statusCode).toBe(200);
    expect(await countRows(w, 'select count(*)::int as n from webhook_events', [])).toBe(stored);
    expect(await countRows(w, 'select count(*)::int as n from activity_events', [])).toBe(events);
    expect(w.square.calls.length).toBe(reads);
    expect(await order(w, paid!.orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_OK_1' });
    expect(await countRows(w, 'select count(*)::int as n from sync_jobs where record_id = $1', [paid!.orderId])).toBe(1);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 0 });
  });

  it('a bad signature is rejected with 401, writes webhook.rejected and stores nothing', async () => {
    const before = counts(w);
    const stored = await countRows(w, 'select count(*)::int as n from webhook_events', []);
    const rejected = await countRows(w, "select count(*)::int as n from activity_events where business_id = $1 and type = 'webhook.rejected'", [PIZZA]);
    const body = paymentEvent('evt_sq_forged', 'PAY_FORGED', 'SQ_ORDER_X');
    const res = await postSquare(w, body, w.squareSignature(body, 'https://attacker.example.test/webhooks/square'));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    expect((await postSquare(w, body, '')).statusCode).toBe(401);
    expect(await countRows(w, 'select count(*)::int as n from webhook_events', [])).toBe(stored);
    expect(await countRows(w, "select count(*)::int as n from activity_events where business_id = $1 and type = 'webhook.rejected'", [PIZZA])).toBe(rejected + 2);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 0 });
  });

  it('a payment amount mismatch does not reach PAID_VERIFIED', async () => {
    const { orderId } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const o = await order(w, orderId);
    w.square.addPayment({ id: 'PAY_SHORT', orderId: o.square_order_id!, amountMinor: (await orderTotal(w, orderId)) - 1, status: 'COMPLETED' });
    expect((await postSquare(w, paymentEvent('evt_sq_short', 'PAY_SHORT', o.square_order_id!))).statusCode).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(await countRows(w, "select count(*)::int as n from activity_events where business_id = $1 and type = 'guardrail.refused' and payload->>'reasonCode' = 'payment_amount_mismatch'", [PIZZA])).toBeGreaterThan(0);
    expect(await countRows(w, 'select count(*)::int as n from sync_jobs where record_id = $1', [orderId])).toBe(0);
    // The reconcile poll sees the same payment and also refuses it.
    await w.app.composed.webhooks!.reconcileNow();
    expect((await order(w, orderId)).status).toBe('PAYMENT_PENDING');
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 0 });
  });

  it('a refunded payment does not verify', async () => {
    const { orderId } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const o = await order(w, orderId);
    w.square.addPayment({ id: 'PAY_REFUNDED', orderId: o.square_order_id!, amountMinor: await orderTotal(w, orderId), status: 'COMPLETED', refunded: true });
    expect((await postSquare(w, paymentEvent('evt_sq_refunded', 'PAY_REFUNDED', o.square_order_id!))).statusCode).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(await countRows(w, 'select count(*)::int as n from sync_jobs where record_id = $1', [orderId])).toBe(0);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 0 });
  });

  it('a missed webhook is recovered by the reconcile poll', async () => {
    const { orderId } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const o = await order(w, orderId);
    w.square.addPayment({ id: 'PAY_POLLED', orderId: o.square_order_id!, amountMinor: await orderTotal(w, orderId), status: 'COMPLETED' });
    await w.app.composed.webhooks!.reconcileNow();
    await w.app.composed.executor.idle?.();
    w.app.composed.executor.kick(PIZZA);
    await w.settle();
    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_POLLED' });
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 1 });
  });

  it('Square create timeout: NEEDS_REVIEW, order RECOVERY_REQUIRED, no link sent, no second create', async () => {
    const before = counts(w);
    w.square.mode.create = 'timeout';
    try {
      const { orderId, approvalId } = await pizzaOrder(w);
      await approve(w, PIZZA, approvalId);
      await w.settle();
      w.app.composed.executor.kick(PIZZA);
      await w.settle();
      expect((await steps(w, approvalId)).map((x) => x.status)).toEqual(['NEEDS_REVIEW', 'QUEUED', 'QUEUED']);
      expect(await order(w, orderId)).toMatchObject({ status: 'RECOVERY_REQUIRED', checkout_url: null });
      expect(await countRows(w, 'select count(*)::int as n from message_dispatches where approval_id = $1', [approvalId])).toBe(0);
      expect(delta(w, before)).toEqual({ square: 1, messages: 0, calendar: 0, sheets: 0 });
    } finally { w.square.mode.create = 'ok'; }
  });

  it('message send failure: the bundle goes on and the order keeps its link for the QR fallback', async () => {
    const before = counts(w);
    w.messages.mode.send = 'fail';
    try {
      const { orderId, approvalId } = await pizzaOrder(w);
      await approve(w, PIZZA, approvalId);
      await w.settle();
      expect((await steps(w, approvalId)).map((x) => x.status)).toEqual(['SUCCEEDED', 'FAILED', 'SUCCEEDED']);
      const o = await order(w, orderId);
      expect(o.status).toBe('PAYMENT_PENDING');
      expect(o.checkout_url).toMatch(/^https:\/\/sandbox\.square\.link\//);
      expect((await w.t.db.query('select status from message_dispatches where approval_id = $1', [approvalId])).rows).toEqual([{ status: 'FAILED' }]);
      // A failed send is never retried: the key is consumed.
      w.app.composed.executor.kick(PIZZA);
      await w.settle();
      expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
    } finally { w.messages.mode.send = 'ok'; }
  });

  it('a caller who declined messages: message step SKIPPED, nothing sent, order recorded', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w, false);
    await approve(w, PIZZA, approvalId);
    await w.settle();
    expect((await steps(w, approvalId)).map((x) => x.status)).toEqual(['SUCCEEDED', 'SKIPPED', 'SUCCEEDED']);
    expect((await order(w, orderId)).status).toBe('PAYMENT_PENDING');
    expect(delta(w, before)).toEqual({ square: 1, messages: 0, calendar: 0, sheets: 0 });
  });

  it('approving twice runs the steps once', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const { payloadHash } = await approve(w, PIZZA, approvalId);
    const again = await w.app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash } });
    expect(again.statusCode).toBe(200);
    await w.settle();
    w.app.composed.executor.kick(PIZZA);
    await w.settle();
    const s = await steps(w, approvalId);
    expect(s.map((x) => [x.status, x.attempts])).toEqual([['SUCCEEDED', 1], ['SUCCEEDED', 1], ['SUCCEEDED', 1]]);
    expect((await order(w, orderId)).status).toBe('PAYMENT_PENDING');
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });
});

describe('barbershop booking bundle with the executor', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('availability, propose, approve: Calendar event with the step key, one confirmation, BOOKED_VERIFIED, Sheets job run', async () => {
    const before = counts(w);
    const date = nextLocalDate([3, 4]); // Wednesday or Thursday, open 09:00 to 18:00
    let slot = '';
    w.model.push(
      async ({ executeTool }) => {
        const r = await executeTool('read_calendar_availability', { serviceId: 'svc_haircut', date }) as ToolResult<'read_calendar_availability'>;
        if (!r.ok) return `no slots ${r.reason}`;
        slot = r.slots[0]!.startUtc;
        return 'slots';
      },
      async () => 'Thanks, the owner will confirm.',
    );
    const first = await sim(w, 'agt_barber_01', BARBER, { message: 'Can I get a haircut?' });
    // With consent, through the composed proposal port on the live call (the toolset proposes qr_only since B-15).
    const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [first.callId])).rows[0] as { agent_version_id: string };
    const made = await w.app.composed.toolsetPorts.proposals.createBookingProposal({ businessId: BARBER, agentVersionId: call.agent_version_id, callId: first.callId,
      correlationId: first.callId, operationId: 'op-booking-1', signal: new AbortController().signal, serviceId: 'svc_haircut', startUtc: slot,
      customer: { name: 'Ana', messageRecipient: '+15555550124', messageConsent: true }, messageChannel: w.app.composed.providers.messageChannel });
    if (!made.ok) throw new Error(`booking proposal failed: ${made.reason}`);
    await sim(w, 'agt_barber_01', BARBER, { callId: first.callId, message: 'The first one, I am Ana', end: true });
    const r = { ok: true, proposalId: made.bookingId, approvalId: made.approvalId };
    await approve(w, BARBER, r.approvalId);
    await w.settle();

    const s = await steps(w, r.approvalId);
    expect(s.map((x) => [x.action_type, x.status])).toEqual([['calendar.event.create', 'SUCCEEDED'], ['message.booking.confirm', 'SUCCEEDED'], ['local.booking.record', 'SUCCEEDED']]);
    const booking = (await w.t.db.query('select status, google_event_id from bookings where id = $1', [r.proposalId])).rows[0] as { status: string; google_event_id: string };
    // The Google event ID is the step's stored key, so a retry finds the event instead of inserting again.
    expect(booking).toEqual({ status: 'BOOKED_VERIFIED', google_event_id: s[0]!.idempotency_key });
    expect(w.messages.sent.at(-1)!.body).toMatch(/appointment is confirmed/);
    expect((await w.t.db.query('select state from sync_jobs where record_type = $1 and record_id = $2', ['booking', r.proposalId])).rows).toEqual([{ state: 'DONE' }]);
    expect(w.sheets.appended.at(-1)).toMatchObject({ recordId: r.proposalId, tab: 'Bookings' });
    expect(delta(w, before)).toEqual({ square: 0, messages: 1, calendar: 1, sheets: 1 });
    // A booking is listed as verified through the API.
    const api = ENDPOINTS.getBooking.response.parse((await w.app.inject({ url: `/api/bookings/${r.proposalId}?businessId=${BARBER}`, headers: OWNER })).json());
    expect(api.status).toBe('BOOKED_VERIFIED');
  });
});

describe('an executor that crashes between claim and finish', () => {
  let w: World;
  // The app's own executor stays off here, so the test controls which worker claims the step.
  beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('is recovered to NEEDS_REVIEW without a second provider write', async () => {
    const { orderId, approvalId } = await pizzaOrder(w);
    await approve(w, PIZZA, approvalId);
    const c = w.app.composed;
    const deps: SeamDeps = { env: c.env, db: c.db, engine: c.engine, providers: c.providers, now: c.now, newId: c.newId, log: silentLog };

    // Worker A claims the checkout step, sends CreatePaymentLink, and never returns (the process died).
    const hanging = fakeSquareClient();
    let created!: () => void;
    const sent = new Promise<void>((resolve) => { created = resolve; });
    hanging.client.checkout.paymentLinks.create = async () => { hanging.writes.push('checkout.paymentLinks.create'); created(); return new Promise(() => {}); };
    const crashed = createDbExecutor({ ...deps, providers: { ...c.providers, square: createSquareAdapterForTest(hanging.client, { locationId: LOCATION_ID, environment: 'sandbox', now: () => new Date() }) } },
      { workerId: 'worker-crashed' });
    void crashed.tick();
    await sent;
    expect((await steps(w, approvalId)).map((x) => x.status)).toEqual(['RUNNING', 'QUEUED', 'QUEUED']);
    expect((await order(w, orderId)).status).toBe('CREATING_CHECKOUT');

    // Worker B starts later. Before the lease is stale it leaves the step alone.
    const healthy = createDbExecutor(deps, { workerId: 'worker-b' });
    await healthy.drain();
    expect((await steps(w, approvalId))[0]!.status).toBe('RUNNING');
    // Past the stale window the step goes to review, never back to QUEUED, and the order to RECOVERY_REQUIRED.
    // Test-only time travel on the database clock: the lease was claimed 16 minutes ago.
    await w.t.admin((q) => q.query("update public.action_executions set locked_at = locked_at - interval '16 minutes', lease_deadline = lease_deadline - interval '16 minutes' where approval_id = $1 and status = 'RUNNING'", [approvalId]));
    await healthy.drain();
    expect((await steps(w, approvalId)).map((x) => x.status)).toEqual(['NEEDS_REVIEW', 'QUEUED', 'QUEUED']);
    expect((await order(w, orderId)).status).toBe('RECOVERY_REQUIRED');
    await healthy.drain();
    expect(hanging.writes).toEqual(['checkout.paymentLinks.create']);
    expect(w.squareWrites).toEqual([]);
    expect(w.messageSends).toBe(0);
    // recover_stale_executions writes the one execution.failed event (correlated to the call, like every routine event).
    expect(await countRows(w, "select count(*)::int as n from activity_events where type = 'execution.failed' and payload->>'nextStatus' = 'NEEDS_REVIEW' and payload->>'executionId' = $1", [(await steps(w, approvalId))[0]!.id])).toBe(1);
  });
});
