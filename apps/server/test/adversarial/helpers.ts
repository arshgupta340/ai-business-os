// Drivers shared by the adversarial suite (B-23). They sit on the end-to-end world (../e2e/world.ts):
// the in-process Postgres used as abos_app, the real toolset, engine, routines, executor, REST and
// webhook routes, and the world's fake providers. Nothing here can decide an approval, run a step or
// reach a provider except through the server's own routes.
import { createHmac } from 'node:crypto';
import { expect, vi } from 'vitest';
import { ENDPOINTS, type AgentSpec, type ApprovalRequest, type Cart, type Quote, type ToolContext, type ToolInput, type ToolName, type ToolResult } from '@abos/contracts';
import { StreamTokenStore } from '../../src/voice/logic';
import { runPhoneRelay } from '../../src/voice/relay';
import type { PinnedCall, VoiceLogger } from '../../src/voice/types';
import { OWNER, PUBLIC_URL, nextLocalDate, zonedIso, type World } from '../e2e/world';
import { FakeSocket } from '../voice/helpers';

export const PIZZA = 'biz_pizza_01';
export const BARBER = 'biz_barber_01';
export const OTHER_BIZ = 'biz_other_01';
export const TZ = 'America/Los_Angeles';
export const RECIPIENT = '+15555550123';
export const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 2, modifierIds: [] }] };

/** The four kinds of external write. Every test asserts all four. */
export type Counts = { square: number; messages: number; calendar: number; sheets: number };
export const NONE: Counts = { square: 0, messages: 0, calendar: 0, sheets: 0 };
export const counts = (w: World): Counts => ({ square: w.squareWrites.length, messages: w.messageSends, calendar: w.calendarWrites.length, sheets: w.sheets.appended.length });
export const delta = (w: World, before: Counts): Counts => {
  const now = counts(w);
  return { square: now.square - before.square, messages: now.messages - before.messages, calendar: now.calendar - before.calendar, sheets: now.sheets - before.sheets };
};

type Headers = Record<string, string>;
export type SimBody = { callId: string; reply: string; toolTrace: { tool: string; input: unknown; output: Record<string, unknown>; mocked: boolean }[]; guardrail?: { refused: boolean; rule: string }; code?: string };

export async function sim(w: World, agentId: string, businessId: string, body: Record<string, unknown>, headers: Headers = OWNER) {
  const res = await w.app.inject({ method: 'POST', url: `/api/agents/${agentId}/sim-call?businessId=${businessId}`, headers, payload: body });
  return { status: res.statusCode, raw: res.body, body: res.json() as SimBody };
}

export const pickupAt = (hhmm = '18:00') => zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), hhmm, TZ);

export type OrderOptions = { consent?: boolean; recipient?: string; cart?: Cart; pickup?: string; name?: string };
export type Proposed = { callId: string; orderId: string; approvalId: string };

/**
 * A pizza order through a simulated call: read the catalog and quote through the real toolset.
 * Without consent the toolset proposes (qr_only). With consent the proposal is stored through the
 * composed engine on the same live call, as test/e2e/flows.test.ts does: since B-15 the deployed
 * toolset proposes every order as qr_only until server-owned consent evidence exists (voice NOTES 3).
 * (Adapted after the merge: the suite was written when the toolset still took consent with a read-back.)
 */
export async function pizzaOrder(w: World, o: OrderOptions = {}): Promise<Proposed> {
  const consent = o.consent ?? true;
  const cart = o.cart ?? CART;
  const name = o.name ?? 'Sam';
  const fulfillment = { type: 'pickup' as const, pickupAt: o.pickup ?? pickupAt() };
  let quote: Quote | undefined;
  w.model.push(
    async ({ executeTool }) => { await executeTool('read_catalog', { query: 'pepperoni' }); return 'We have pepperoni.'; },
    async ({ executeTool }) => {
      const r = await executeTool('quote_order', { cart }) as ToolResult<'quote_order'>;
      if (!r.ok) return `quote failed ${r.reason}`;
      quote = r.quote;
      return 'quoted';
    },
    consent ? async () => 'Thanks, the owner will review it.' : async ({ executeTool }) =>
      JSON.stringify(await executeTool('propose_order', { cart, contact: { name, messageConsent: false }, fulfillment, quoteId: quote!.quoteId })),
  );
  const first = await sim(w, 'agt_pizza_01', PIZZA, { message: 'What pizzas do you have?' });
  expect(first.status).toBe(200);
  const callId = first.body.callId;
  await sim(w, 'agt_pizza_01', PIZZA, { callId, message: 'Two large pepperoni' });
  expect(quote).toBeDefined();
  let ids: { orderId: string; approvalId: string } | undefined;
  if (consent) {
    const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [callId])).rows[0] as { agent_version_id: string };
    const { order, approval } = await w.app.composed.engine.createOrderProposal({ businessId: PIZZA, callId, agentVersionId: call.agent_version_id,
      cart, quote: quote!, contact: { name, messageRecipient: o.recipient ?? RECIPIENT, messageConsent: true, consentAt: new Date().toISOString() },
      fulfillment, messageChannel: w.app.composed.providers.messageChannel });
    ids = { orderId: order.id, approvalId: approval.id };
  }
  const proposed = await sim(w, 'agt_pizza_01', PIZZA, { callId, message: 'Sam, pickup at six', end: true });
  if (ids) return { callId, ...ids };
  const r = JSON.parse(proposed.body.reply) as { ok: boolean; proposalId: string; approvalId: string };
  expect(r).toMatchObject({ ok: true });
  return { callId, orderId: r.proposalId, approvalId: r.approvalId };
}

export type Booked = { callId: string; bookingId: string; approvalId: string; startUtc: string };

let bookingOps = 0;
/**
 * A haircut booking through a simulated call: availability through the real toolset, then the
 * proposal with consent through the composed proposal port on the live call (the toolset proposes
 * qr_only since B-15), as test/e2e/flows.test.ts does. Adapted after the merge, as pizzaOrder.
 */
export async function bookingProposal(w: World, o: { recipient?: string; minDays?: number } = {}): Promise<Booked> {
  const date = nextLocalDate([3, 4], o.minDays ?? 1); // Wednesday or Thursday, open 09:00 to 18:00
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
  expect(first.status).toBe(200);
  expect(slot).not.toBe('');
  const callId = first.body.callId;
  const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [callId])).rows[0] as { agent_version_id: string };
  const made = await w.app.composed.toolsetPorts.proposals.createBookingProposal({ businessId: BARBER, agentVersionId: call.agent_version_id, callId,
    correlationId: callId, operationId: `op-adversarial-booking-${++bookingOps}`, signal: new AbortController().signal, serviceId: 'svc_haircut', startUtc: slot,
    customer: { name: 'Ana', messageRecipient: o.recipient ?? '+15555550124', messageConsent: true }, messageChannel: w.app.composed.providers.messageChannel });
  if (!made.ok) throw new Error(`booking proposal failed: ${made.reason}`);
  await sim(w, 'agt_barber_01', BARBER, { callId, message: 'The first one, I am Ana', end: true });
  return { callId, bookingId: made.bookingId, approvalId: made.approvalId, startUtc: slot };
}

/** The approval as the owner sees it, through the API. */
export async function getApproval(w: World, businessId: string, approvalId: string): Promise<ApprovalRequest> {
  const res = await w.app.inject({ url: `/api/approvals/${approvalId}?businessId=${businessId}`, headers: OWNER });
  expect(res.statusCode).toBe(200);
  return ENDPOINTS.getApproval.response.parse(res.json());
}

export function decide(w: World, businessId: string, approvalId: string, decision: 'approve' | 'reject', payloadHash: string, headers: Headers = OWNER) {
  return w.app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decision?businessId=${businessId}`, headers, payload: { decision, payloadHash } });
}

/** Approve with the hash the API shows, then let the executor and webhook jobs settle. */
export async function approve(w: World, businessId: string, approvalId: string) {
  const a = await getApproval(w, businessId, approvalId);
  const res = await decide(w, businessId, approvalId, 'approve', a.payloadHash);
  expect(res.statusCode).toBe(200);
  await w.settle();
  return a;
}

export type Step = { id: string; action_type: string; status: string; idempotency_key: string; external_ref: string | null; attempts: number };
export async function steps(w: World, approvalId: string): Promise<Step[]> {
  return (await w.t.db.query('select id, action_type, status, idempotency_key, external_ref, attempts from action_executions where approval_id = $1 order by step_index', [approvalId])).rows as Step[];
}
export type OrderRow = { status: string; square_order_id: string | null; square_payment_link_id: string | null; checkout_url: string | null; square_payment_id: string | null; total_minor: number };
export async function order(w: World, id: string): Promise<OrderRow> {
  return (await w.t.db.query('select status, square_order_id, square_payment_link_id, checkout_url, square_payment_id, total_minor from orders where id = $1', [id])).rows[0] as OrderRow;
}
export async function statusOf(w: World, table: 'orders' | 'bookings' | 'approval_requests', id: string): Promise<string> {
  const column = table === 'approval_requests' ? 'state' : 'status';
  return ((await w.t.db.query(`select ${column} as s from ${table} where id = $1`, [id])).rows[0] as { s: string }).s;
}
export async function count(w: World, sql: string, params: unknown[] = []): Promise<number> {
  return ((await w.t.db.query(`select count(*)::int as n from ${sql}`, params)).rows[0] as { n: number }).n;
}

/** Pizza order through approval and the executor, to PAYMENT_PENDING with a sent link. */
export async function pizzaToPaymentPending(w: World, o: OrderOptions = {}) {
  const ids = await pizzaOrder(w, o);
  await approve(w, PIZZA, ids.approvalId);
  const row = await order(w, ids.orderId);
  expect(row.status).toBe('PAYMENT_PENDING');
  return { ...ids, squareOrderId: row.square_order_id!, totalMinor: row.total_minor };
}

/** A Square payment event. Status and amount in the body are decoys: the server must read them from Square. */
export function paymentEvent(eventId: string, paymentId: string, squareOrderId: string, extra: { status?: string; type?: string } = {}) {
  return JSON.stringify({ merchant_id: 'M_E2E', type: extra.type ?? 'payment.updated', event_id: eventId, created_at: new Date().toISOString(),
    data: { type: 'payment', id: paymentId, object: { payment: { id: paymentId, order_id: squareOrderId, status: extra.status ?? 'COMPLETED', amount_money: { amount: 1, currency: 'USD' } } } } });
}
export const SQUARE_URL = `${PUBLIC_URL}/webhooks/square`;
export const signWith = (key: string, body: string, url = SQUARE_URL) => createHmac('sha256', key).update(url + body).digest('base64');

/** POST /webhooks/square. `signature: null` sends no signature header at all. */
export async function postSquare(w: World, body: string | Buffer, signature: string | null = w.squareSignature(String(body))) {
  const res = await w.app.inject({ method: 'POST', url: '/webhooks/square',
    headers: { 'content-type': 'application/json', ...(signature === null ? {} : { 'x-square-hmacsha256-signature': signature }) }, payload: body });
  await w.settle();
  return res;
}

/** Everything a webhook could change, for "nothing changed" assertions. */
export async function webhookState(w: World) {
  return {
    stored: await count(w, 'webhook_events'),
    rejected: await count(w, "activity_events where type = 'webhook.rejected'"),
    verified: await count(w, "activity_events where type = 'payment.verified'"),
    failed: await count(w, "activity_events where type = 'payment.failed'"),
    syncJobs: await count(w, 'sync_jobs'),
  };
}

/** A logger that keeps every line, for the secret scans. It fits SeamDeps['log'] and the voice logger. */
export function captureLog() {
  const lines: string[] = [];
  const write = (level: string) => (data: unknown, msg?: unknown) => { lines.push(`${level} ${safeJson(data)} ${typeof msg === 'string' ? msg : safeJson(msg)}`); };
  const log = { info: write('info'), warn: write('warn'), error: write('error') };
  return { log, lines, text: () => lines.join('\n') };
}
function safeJson(value: unknown): string {
  if (value === undefined) return '';
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try { return JSON.stringify(value, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : typeof v === 'bigint' ? String(v) : v)) ?? ''; }
  catch { return String(value); }
}

/** Settings that turn the phone path on. The values are test markers, not credentials. */
export const VOICE_ENV = { TWILIO_AUTH_TOKEN: 'test-twilio-token', TWILIO_ACCOUNT_SID: 'ACtest', OPENAI_API_KEY: 'test-openai-key' };

/**
 * A phone call as the voice worker sets it up (FLOWS B2 to B4): a `calls` row with channel `phone`,
 * the fact snapshot, and the toolset from the composed factory that the voice plugin was given.
 */
export async function phoneCall(w: World, businessId: string, providerCallId: string) {
  const voice = w.app.composed.voice;
  if (!voice.ok) throw new Error('phone voice is off in this world');
  const agent = (await w.t.db.query(`select a.id, a.active_version_id, v.spec from agents a join agent_versions v on v.id = a.active_version_id
    where a.business_id = $1 and a.state = 'live' order by a.id limit 1`, [businessId])).rows[0] as { id: string; active_version_id: string; spec: AgentSpec };
  const facts = await voice.options.facts.snapshot(businessId);
  const { callId } = await voice.options.calls.startCall({ businessId, agentId: agent.id, agentVersionId: agent.active_version_id, providerCallId, callerLast4: '0123' });
  const toolset = voice.options.toolsetFactory({ businessId, agentVersionId: agent.active_version_id, callId, capabilities: agent.spec.capabilities, facts });
  const ctx: ToolContext = { businessId, agentVersionId: agent.active_version_id, callId, correlationId: callId };
  const call = <N extends ToolName>(name: N, input: unknown) => toolset.handler.call(name, input as ToolInput[N], ctx);
  const businessName = ((await w.t.db.query('select name from businesses where id = $1', [businessId])).rows[0] as { name: string }).name;
  return { callId, providerCallId, businessId, businessName, agentId: agent.id, agentVersionId: agent.active_version_id, spec: agent.spec, facts, toolset, ctx, call, options: voice.options };
}

export type PhoneCall = Awaited<ReturnType<typeof phoneCall>>;

/**
 * The phone relay for one call (FLOWS B4), run as the voice plugin runs it: the composed calls,
 * events and toolset factory, with fake sockets in place of Twilio and OpenAI. `model` is the socket
 * the relay opened to the model; what the relay sends on it is what the model is given.
 */
export async function phoneRelay(call: PhoneCall, o: { logger: VoiceLogger; spec?: AgentSpec; redactSecrets?: readonly string[]; callerNumber?: string }) {
  const tokens = new StreamTokenStore<PinnedCall>();
  const token = tokens.mint({ callId: call.callId, providerCallId: call.providerCallId, businessId: call.businessId, businessName: call.businessName,
    agentId: call.agentId, agentVersionId: call.agentVersionId, spec: o.spec ?? call.spec, facts: call.facts, ...(o.callerNumber ? { callerNumber: o.callerNumber } : {}) }) ?? '';
  const phone = new FakeSocket();
  // Twilio echoes outstanding marks after a clear.
  phone.echoMarksOnClear = true;
  const models: FakeSocket[] = [];
  const relay = runPhoneRelay({ phone, tokens, calls: call.options.calls, events: call.options.events, toolsetFactory: call.options.toolsetFactory,
    openaiSocketFactory: () => { const s = new FakeSocket(); models.push(s); return s; }, messageChannel: call.options.messageChannel, logger: o.logger,
    redactSecrets: o.redactSecrets ?? call.options.redactSecrets });
  phone.emit({ event: 'start', start: { callSid: call.providerCallId, streamSid: 'MZadversarial', customParameters: { streamToken: token } } });
  const model = () => models[0];
  return {
    phone, relay, token, models,
    /** Brings the model session to ready. Throws if the relay refused to open one. */
    async connect() {
      await vi.waitFor(() => expect(models).toHaveLength(1));
      model()!.open();
      model()!.emit({ type: 'session.updated' });
    },
    /** The tools in the session the model was given. */
    sessionTools(): string[] {
      const update = model()!.ofType('session.update')[0] as { session: { tools: { name: string }[] } };
      return update.session.tools.map((t) => t.name);
    },
    /** The model asks for a tool; resolves with what the relay answered. */
    async toolCall(name: string, args: string, callId: string): Promise<Record<string, unknown>> {
      model()!.emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name, arguments: args, call_id: callId }] } });
      const find = () => model()!.ofType('conversation.item.create').map((m) => (m as { item: { type: string; call_id: string; output: string } }).item)
        .find((i) => i.type === 'function_call_output' && i.call_id === callId);
      await vi.waitFor(() => expect(find()).toBeDefined(), { timeout: 5000 });
      return JSON.parse(find()!.output) as Record<string, unknown>;
    },
    async hangUp() { phone.emit({ event: 'stop' }); await relay.done; },
  };
}
