// D-13 DEMO MODE end to end: the real engine, the in-process Postgres as abos_app, fake providers. A demo call
// from a listed number gets one pay link; the demo pay records only demo_paid_at; nothing else happens until
// the owner approves; then the normal executor makes one Square link, the demo worker makes one UpdateOrder
// and one CreatePayment in the fake sandbox, the real reconcile path moves the order to FULFILLMENT_READY,
// and exactly one confirmation with a track link goes out. The same call from an unlisted number sends nothing.
// With demo mode off, no demo route answers, the tool is not offered and no demo table is written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS, type AgentSpec, type Cart, type ToolContext } from '@abos/contracts';
import type { MessageAdapter, SendInput } from '../../src/adapters/message/index';
import { DEMO_MENU_CAPABILITY, demoCallSpec } from '../../src/demo/index';
import { createDemoMode } from '../../src/demo/service';
import { demoConfig, type DemoConfig } from '../../src/demo/config';
import { parseEnv } from '../../src/env';
import { currentRole } from '../support/db';
import { OWNER, createWorld, nextLocalDate, zonedIso, type World } from './world';

const PIZZA = 'biz_pizza_01';
const LISTED = '+15555550142';
const UNLISTED = '+15555550177';
const SECRET = 'e2e-demo-link-secret-not-a-credential-0001';
const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };
const DEMO_ENV = { DEMO_PAY_FIRST: '1', DEMO_TEXT_NUMBERS: LISTED, DEMO_LINK_SECRET: SECRET, TWILIO_ACCOUNT_SID: 'ACe2e', TWILIO_AUTH_TOKEN: 'e2e-twilio-token', MESSAGE_CHANNEL: 'qr_only' };

function fakeWhatsApp() {
  const sent: SendInput[] = [];
  const adapter: MessageAdapter = { channel: 'whatsapp_sandbox', async send(input) { sent.push(input); return { status: 'SENT', providerMessageId: `SM_demo_${sent.length}` }; } };
  return { adapter, sent };
}

/** The Square sandbox HTTP the shared sandbox payment talks to, backed by the world's fake Square. */
function fakeSquareHttp(w: () => World) {
  const log: string[] = [];
  const state = new Map<string, { state: string; version: number }>();
  const paidKeys = new Map<string, string>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.host !== 'connect.squareupsandbox.com') throw new Error('not the sandbox host');
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const orderMatch = /^\/v2\/orders\/(.+)$/.exec(u.pathname);
    if (orderMatch && init.method === 'GET') {
      log.push('RetrieveOrder');
      const id = decodeURIComponent(orderMatch[1]!);
      const order = w().square.orders.get(id);
      if (!order) return json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
      const s = state.get(id) ?? { state: 'DRAFT', version: 1 };
      return json({ order: { id, state: s.state, version: s.version, total_money: { amount: Number(order.totalMoney?.amount ?? 0) } } });
    }
    if (orderMatch && init.method === 'PUT') {
      log.push('UpdateOrder');
      const id = decodeURIComponent(orderMatch[1]!);
      const s = { state: 'OPEN', version: (state.get(id)?.version ?? 1) + 1 };
      state.set(id, s);
      return json({ order: { id, state: s.state, version: s.version } });
    }
    if (u.pathname === '/v2/payments' && init.method === 'POST') {
      log.push('CreatePayment');
      const body = JSON.parse(String(init.body)) as { idempotency_key: string; order_id: string; amount_money: { amount: number }; source_id: string };
      expect(body.source_id).toBe('cnon:card-nonce-ok');
      const id = paidKeys.get(body.idempotency_key) ?? `PAY_DEMO_${paidKeys.size + 1}`;
      paidKeys.set(body.idempotency_key, id);
      w().square.addPayment({ id, orderId: body.order_id, amountMinor: body.amount_money.amount, status: 'COMPLETED' });
      return json({ payment: { id, status: 'COMPLETED', order_id: body.order_id, amount_money: { amount: body.amount_money.amount, currency: 'USD' } } });
    }
    return json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  };
  return { fetch, log };
}

function capturingLog() {
  const lines: string[] = [];
  const at = (level: string) => (data: Record<string, unknown>, msg: string) => { lines.push(`${level} ${msg} ${JSON.stringify(data)}`); };
  return { log: { info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

async function liveAgent(w: World) {
  const row = (await w.t.db.query(`select a.id as agent_id, v.id as version_id, v.spec from agents a join agent_versions v on v.id = a.active_version_id where a.id = 'agt_pizza_01'`, [])).rows[0] as
    { agent_id: string; version_id: string; spec: AgentSpec };
  return row;
}

/** What the voice webhook does for a call (plugin.ts admit), then the agent's tool calls through the real toolset. */
async function demoCall(w: World, from: string, providerCallId: string, opts: { askMenu: boolean }) {
  const agent = await liveAgent(w);
  const demo = w.app.composed.demo;
  const listed = demo?.listedCaller(from);
  const spec = demoCallSpec(agent.spec, listed !== undefined);
  const { callId } = await w.app.composed.calls.startCall({ businessId: PIZZA, agentId: agent.agent_id, agentVersionId: agent.version_id, providerCallId, callerLast4: from.slice(-4) });
  if (listed !== undefined) demo?.pinCaller(callId, listed);
  const facts = await w.app.composed.toolsetPorts.facts!.readVerified({ businessId: PIZZA, signal: new AbortController().signal });
  const ts = w.app.composed.toolsetFor({ businessId: PIZZA, agentVersionId: agent.version_id, callId, capabilities: spec.capabilities, facts });
  const ctx: ToolContext = { businessId: PIZZA, agentVersionId: agent.version_id, callId, correlationId: callId };
  const menu = opts.askMenu ? await ts.handler.call('propose_menu_message', {}, ctx) : undefined;
  const quote = await ts.handler.call('quote_order', { cart: CART }, ctx);
  if (!quote.ok) throw new Error(`quote failed ${quote.reason}`);
  const pickupAt = zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles');
  const proposed = await ts.handler.call('propose_order', { cart: CART, contact: { name: 'Sam', messageConsent: false }, fulfillment: { type: 'pickup', pickupAt }, quoteId: quote.quote.quoteId }, ctx);
  if (!proposed.ok || !proposed.proposalId || !proposed.approvalId) throw new Error('propose failed');
  await demo?.idle();
  return { callId, spec, menu, orderId: proposed.proposalId, approvalId: proposed.approvalId, ts, ctx };
}

const orderRow = async (w: World, id: string) => (await w.t.db.query('select * from orders where id = $1', [id])).rows[0] as Record<string, unknown>;
const demoRow = async (w: World, id: string) => (await w.t.db.query('select * from demo_orders where order_id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
const count = async (w: World, sql: string) => ((await w.t.db.query(sql, [])).rows[0] as { n: number }).n;
const tokenOf = (body: string, kind: 'pay' | 'track') => new RegExp(`/demo/${kind}/(ord_[A-Za-z0-9_]+\\.[A-Za-z0-9_-]{43})$`).exec(body)?.[1];

describe('demo mode on: a call from a listed number', () => {
  let w: World;
  const wa = fakeWhatsApp();
  const sq = fakeSquareHttp(() => w);
  const cap = capturingLog();
  beforeAll(async () => {
    w = await createWorld({ demo: { message: wa.adapter, square: { fetch: sq.fetch, accessToken: 'e2e-square-token' } }, log: cap.log }, DEMO_ENV);
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  let call: Awaited<ReturnType<typeof demoCall>>;
  let payToken = '';

  it('runs as abos_app with demo mode on, and the approval bundle message step stays qr_only', async () => {
    expect(await currentRole(w.t.db)).toBe('abos_app');
    expect(w.app.composed.demo).toBeDefined();
    expect(cap.lines.some((l) => l.includes('DEMO MODE IS ON'))).toBe(true);
  });

  it('sends the menu once and one pay link to the listed number, and nothing else happens', async () => {
    call = await demoCall(w, LISTED, 'CAdemo1', { askMenu: true });
    expect(call.menu).toEqual({ ok: true, sent: true });
    // At most once per call: asking again sends nothing more.
    expect(await call.ts.handler.call('propose_menu_message', {}, call.ctx)).toEqual({ ok: true, sent: true });
    expect(wa.sent.map((m) => m.to)).toEqual([LISTED, LISTED]);
    const [menu, pay] = wa.sent;
    expect(menu!.body).toContain('Demo Pizza Co. menu:');
    expect(menu!.body.endsWith('Demo message.')).toBe(true);
    expect(pay!.body).toMatch(/^Demo Pizza Co\.: your order total is \$\d+\.\d\d\. Demo: no real money moves\. Pay here: https:\/\/abos-e2e\.example\.test\/demo\/pay\//);
    payToken = tokenOf(pay!.body, 'pay')!;
    expect(payToken).toBeDefined();
    // The real proposal is the normal qr_only one; nothing external happened.
    expect(await orderRow(w, call.orderId)).toMatchObject({ status: 'AWAITING_OWNER_APPROVAL' });
    const approval = (await w.app.inject({ url: `/api/approvals/${call.approvalId}?businessId=${PIZZA}`, headers: OWNER })).json() as { payload: Record<string, unknown> };
    expect(approval.payload.messageChannel).toBe('qr_only');
    expect(approval.payload).not.toHaveProperty('messageRecipient');
    expect(w.squareWrites).toEqual([]);
    expect(w.messageSends).toBe(0);
    expect(await demoRow(w, call.orderId)).toMatchObject({ recipient: LISTED, demo_paid_at: null, confirmation_sent_at: null });
    expect(await count(w, 'select count(*)::int n from demo_messages')).toBe(2);
  });

  it('the pay page is demo labelled and its card fields are never sent', async () => {
    const page = await w.app.inject({ url: `/demo/pay/${payToken}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(page.headers['content-security-policy']).toContain("form-action 'none'");
    expect(page.body).toContain('Demo: no real money moves');
    expect(page.body).toContain('Demo Pizza Co.');
    expect(page.body).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//);
    for (const input of page.body.match(/<input[^>]*>/g) ?? []) expect(input).not.toMatch(/\sname=/);
    expect(page.body).not.toContain('<form');
    const status = (await w.app.inject({ url: `/demo/status/${payToken}` })).json() as Record<string, unknown>;
    expect(Object.keys(status).sort()).toEqual(['demo', 'items', 'name', 'readyTime', 'stage', 'total']);
    expect(status).toMatchObject({ demo: true, stage: 'awaiting_payment', name: 'Sam', readyTime: null });
  });

  it('the pay POST records the demo payment only, idempotently, and cannot change a real order field', async () => {
    const before = await orderRow(w, call.orderId);
    const res = await w.app.inject({ method: 'POST', url: `/demo/pay/${payToken}`, headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'PAID_VERIFIED', square_payment_id: 'PAY_FORGED', cardNumber: '4111111111111111' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stage: 'reviewing' });
    const paidAt = (await demoRow(w, call.orderId))!.demo_paid_at;
    expect(paidAt).not.toBeNull();
    await w.app.inject({ method: 'POST', url: `/demo/pay/${payToken}` });
    expect((await demoRow(w, call.orderId))!.demo_paid_at).toEqual(paidAt);
    expect(await orderRow(w, call.orderId)).toEqual(before);
    // Nothing is paid in the sandbox before the owner approves, however often the worker runs.
    await w.app.composed.demo!.tick();
    await w.app.composed.demo!.tick();
    expect(sq.log).toEqual([]);
    expect(w.squareWrites).toEqual([]);
    expect(wa.sent).toHaveLength(2);
  });

  it('a tampered or missing token is 404 with no detail on every demo route', async () => {
    const flipped = payToken.slice(0, -2) + (payToken.at(-2) === 'A' ? 'B' : 'A') + payToken.at(-1);
    for (const t of [flipped, 'nothing', `${call.orderId}.`, `${call.orderId}`]) {
      for (const [method, path] of [['GET', 'pay'], ['POST', 'pay'], ['GET', 'track'], ['GET', 'status']] as const) {
        const r = await w.app.inject({ method, url: `/demo/${path}/${t}` });
        expect(r.statusCode, `${method} ${path} ${t}`).toBe(404);
        expect(r.body).toBe('Not found.');
      }
    }
    expect((await demoRow(w, call.orderId))!.demo_paid_at).not.toBeNull();
  });

  it('after the owner approves: one Square link, one UpdateOrder, one CreatePayment, FULFILLMENT_READY, one confirmation', async () => {
    const list = ENDPOINTS.listApprovals.response.parse((await w.app.inject({ url: `/api/approvals?businessId=${PIZZA}`, headers: OWNER })).json());
    const a = list.items.find((x) => x.id === call.approvalId)!;
    const res = await w.app.inject({ method: 'POST', url: `/api/approvals/${call.approvalId}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash: a.payloadHash } });
    expect(res.statusCode).toBe(200);
    await w.settle();
    expect(await orderRow(w, call.orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(w.squareWrites).toEqual(['checkout.paymentLinks.create']);
    // The demo worker pays the sandbox order, then the real reconcile path verifies it with Square.
    await w.app.composed.demo!.tick();
    expect(sq.log).toEqual(['RetrieveOrder', 'UpdateOrder', 'CreatePayment']);
    await w.app.composed.executor.idle?.();
    w.app.composed.executor.kick(PIZZA);
    await w.settle();
    expect(await orderRow(w, call.orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_DEMO_1' });
    const types = (await w.t.db.query("select type, actor_type from activity_events where payload->>'orderId' = $1", [call.orderId])).rows as { type: string }[];
    expect(types.some((e) => e.type === 'payment.verified')).toBe(true);
    // The worker never pays twice: the payment ID is stored.
    expect(wa.sent).toHaveLength(2);
    await w.app.composed.demo!.tick();
    await w.app.composed.demo!.tick();
    expect(sq.log).toEqual(['RetrieveOrder', 'UpdateOrder', 'CreatePayment']);
    expect(w.squareWrites).toEqual(['checkout.paymentLinks.create']);
    expect(wa.sent).toHaveLength(3);
    const confirmation = wa.sent[2]!;
    expect(confirmation.to).toBe(LISTED);
    expect(confirmation.body).toMatch(/^Demo Pizza Co\.: your order is placed and will be ready by \d{1,2}:\d\d [AP]M\. Demo message\. Track it: https:\/\/abos-e2e\.example\.test\/demo\/track\//);
    expect(tokenOf(confirmation.body, 'track')).toBe(payToken);
    expect((await demoRow(w, call.orderId))!.confirmation_sent_at).not.toBeNull();
    // The executor's own message adapter sent nothing: the bundle's message step is SKIPPED (qr_only).
    expect(w.messageSends).toBe(0);
    const steps = (await w.t.db.query('select action_type, status from action_executions where approval_id = $1 order by step_index', [call.approvalId])).rows;
    expect(steps).toContainEqual({ action_type: 'message.checkout.send', status: 'SKIPPED' });
  });

  it('the tracker moves placed, being made, ready, by computed stage', async () => {
    const page = await w.app.inject({ url: `/demo/track/${payToken}` });
    expect(page.statusCode).toBe(200);
    for (const label of ['Order placed', 'Being made', 'Ready for pickup', 'Demo: no real money moves', 'Sam']) expect(page.body).toContain(label);
    const stage = async () => ((await w.app.inject({ url: `/demo/status/${payToken}` })).json() as { stage: string; readyTime: string | null });
    expect(await stage()).toMatchObject({ stage: 'placed' });
    expect((await stage()).readyTime).toMatch(/^\d{1,2}:\d\d [AP]M$/);
    w.clock.advance(31_000);
    expect((await stage()).stage).toBe('making');
    // The pickup is tomorrow, further than 10 minutes away, so the demo shows it ready 3 minutes after the confirmation.
    w.clock.advance(150_000);
    expect((await stage()).stage).toBe('ready');
    // The pay page now goes to the tracker.
    expect((await w.app.inject({ url: `/demo/pay/${payToken}` })).body).toContain('location.replace(trackUrl)');
  });

  it('every demo message goes out at most once, across a restart', async () => {
    const config = demoConfig(parseEnv({ ...DEMO_ENV, PUBLIC_SERVER_URL: 'https://abos-e2e.example.test' })) as DemoConfig;
    const again = fakeWhatsApp();
    const restarted = createDemoMode({ config, db: w.t.db, message: again.adapter, catalog: w.app.composed.toolsetPorts.catalog, now: w.clock.now, log: cap.log });
    restarted.pinCaller(call.callId, LISTED);
    restarted.orderProposed({ callId: call.callId, businessId: PIZZA, orderId: call.orderId });
    expect(await restarted.menuPort(PIZZA).send({ callId: call.callId, signal: new AbortController().signal })).toEqual({ sent: true });
    await restarted.tick();
    await restarted.idle();
    expect(again.sent).toEqual([]);
    expect(await count(w, 'select count(*)::int n from demo_messages')).toBe(3);
  });

  it('the same call from an unlisted number sends nothing and writes no demo row', async () => {
    const sends = wa.sent.length;
    const rows = await count(w, 'select count(*)::int n from demo_orders');
    expect(w.app.composed.demo!.listedCaller(UNLISTED)).toBeUndefined();
    const other = await demoCall(w, UNLISTED, 'CAdemo2', { askMenu: false });
    expect(other.spec.capabilities).not.toContain(DEMO_MENU_CAPABILITY);
    // Even with the capability forced into the spec, the toolset does not offer the tool to this call.
    const agent = await liveAgent(w);
    const forced = w.app.composed.toolsetFor({ businessId: PIZZA, agentVersionId: agent.version_id, callId: other.callId, capabilities: [...agent.spec.capabilities, DEMO_MENU_CAPABILITY] });
    expect(await forced.handler.call('propose_menu_message', {}, other.ctx)).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
    await w.app.composed.demo!.idle();
    expect(wa.sent).toHaveLength(sends);
    expect(await count(w, 'select count(*)::int n from demo_orders')).toBe(rows);
    expect(await demoRow(w, other.orderId)).toBeUndefined();
    expect((await w.app.inject({ url: `/demo/status/${(await import('../../src/demo/links')).signOrderToken(other.orderId, SECRET)}` })).statusCode).toBe(404);
  });

  it('no phone number appears in a log line or an activity event', async () => {
    const events = JSON.stringify((await w.t.db.query('select * from activity_events', [])).rows);
    for (const n of [LISTED, UNLISTED]) {
      const digits = n.slice(1);
      expect(events).not.toContain(digits);
      for (const line of cap.lines) expect(line).not.toContain(digits);
    }
    expect(cap.lines.length).toBeGreaterThan(0);
  });
});

describe('demo mode off (the default)', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld({}, { MESSAGE_CHANNEL: 'qr_only' }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('no demo route answers anything but 404, the tool is not offered and no demo table is written', async () => {
    expect(w.app.composed.demo).toBeUndefined();
    expect(w.app.routeInventory().some((r) => r.url.startsWith('/demo'))).toBe(false);
    for (const [method, url] of [['GET', '/demo/pay/x'], ['POST', '/demo/pay/x'], ['GET', '/demo/track/x'], ['GET', '/demo/status/x']] as const) {
      expect((await w.app.inject({ method, url })).statusCode).toBe(404);
    }
    const call = await demoCall(w, LISTED, 'CAoff1', { askMenu: false });
    expect(call.spec.capabilities).not.toContain(DEMO_MENU_CAPABILITY);
    const agent = await liveAgent(w);
    const forced = w.app.composed.toolsetFor({ businessId: PIZZA, agentVersionId: agent.version_id, callId: call.callId, capabilities: [...agent.spec.capabilities, DEMO_MENU_CAPABILITY] });
    expect(await forced.handler.call('propose_menu_message', {}, call.ctx)).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
    expect(await count(w, 'select count(*)::int n from demo_orders')).toBe(0);
    expect(await count(w, 'select count(*)::int n from demo_messages')).toBe(0);
    expect(w.messageSends).toBe(0);
  });
});
