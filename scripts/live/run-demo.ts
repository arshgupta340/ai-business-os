// Live verification of the two demo flows against the REAL demo backend (Supabase, Square SANDBOX,
// OpenAI, Google Calendar and Sheets). It drives a running server over HTTP exactly as the owner's
// browser would; every external write follows an owner approval made through the API.
//
// Run (server already listening):
//   npx tsx scripts/live/run-demo.ts [all|pizza|pay|negative|booking|hours|health, comma list] [--order ord_...] [--base http://127.0.0.1:4010]
// `pay` pays the order from `pizza` (or --order) in the Square sandbox and waits for reconciliation.
//
// It reads credentials from the environment (.env.local is found by walking up). It prints steps and
// results only: never a token, key, password, email, full phone number or payment link token. IDs are
// shortened to their last 6 characters.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../apps/server/src/db/index';
import { parseEnv } from '../../apps/server/src/env';
import { sheets } from '@googleapis/sheets';
import { calendar } from '@googleapis/calendar';
import { JWT } from 'google-auth-library';

function loadEnv() {
  let dir = process.cwd();
  for (;;) {
    const f = join(dir, '.env.local');
    if (existsSync(f)) { process.loadEnvFile(f); return; }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}
loadEnv();

const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith('--')) ?? 'all';
const baseIdx = args.indexOf('--base');
const BASE = baseIdx >= 0 ? args[baseIdx + 1]! : 'http://127.0.0.1:4010';
const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const SQUARE_SANDBOX = 'https://connect.squareupsandbox.com';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing setting ${k}`); return v; };
const short = (id: unknown) => (typeof id === 'string' && id.length > 6 ? `…${id.slice(-6)}` : String(id));
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { flow: string; ok: boolean; evidence: string }[] = [];
function record(flow: string, ok: boolean, evidence: string) { results.push({ flow, ok, evidence }); log(`${ok ? 'PASS' : 'FAIL'} ${flow}: ${evidence}`); }
function check(cond: unknown, what: string): asserts cond { if (!cond) throw new Error(`check failed: ${what}`); }

// ---------- owner session ----------
let token = '';
async function signIn() {
  const url = new URL('/auth/v1/token?grant_type=password', env('SUPABASE_URL'));
  const r = await fetch(url, { method: 'POST', redirect: 'error', headers: { apikey: env('SUPABASE_ANON_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env('SEED_OWNER_EMAIL'), password: env('SEED_OWNER_PASSWORD') }) });
  check(r.ok, `owner sign-in (HTTP ${r.status})`);
  token = ((await r.json()) as { access_token: string }).access_token;
  log('owner signed in');
}
type Json = Record<string, any>;
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const r = await fetch(new URL(path, BASE), { method, redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: r.status, body: parsed };
}

// ---------- read-only database checks (the restricted runtime role) ----------
// The server's own pool: verified TLS, the restricted runtime role.
const pool = createPool(parseEnv());
async function q<T = Json>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!/^\s*select\b/i.test(text)) throw new Error('this script only reads the database');
  return (await pool.query(text, params)).rows as T[];
}
const steps = (approvalId: string) => q<{ action_type: string; status: string; attempts: number; idempotency_key: string }>(
  'select action_type, status, attempts, idempotency_key from public.action_executions where approval_id = $1 order by step_index', [approvalId]);

// ---------- simulated call with the real model ----------
type Turn = { callId: string; reply: string; toolTrace: { tool: string; output: Json; mocked: boolean }[]; guardrail?: Json };
async function simTurn(agentId: string, businessId: string, body: Json): Promise<Turn> {
  const r = await api('POST', `/api/agents/${agentId}/sim-call?businessId=${businessId}`, body);
  check(r.status === 200, `sim-call turn HTTP ${r.status} ${r.body.code ?? ''}`);
  const t = r.body as Turn;
  log(`  caller: ${String(body.message).slice(0, 90)}`);
  log(`  agent:  ${t.reply.replace(/\s+/g, ' ').slice(0, 160)}`);
  for (const e of t.toolTrace) log(`    tool ${e.tool} ok=${e.output?.ok} ${e.output?.ok === false ? e.output.reason : ''} mocked=${e.mocked}`);
  return t;
}
/** Plays caller lines until a propose tool succeeds, then hangs up. Returns the proposal IDs. */
async function simulatedCall(agentId: string, businessId: string, proposeTool: 'propose_order' | 'propose_booking', lines: string[]) {
  let callId: string | undefined;
  for (const [i, line] of lines.entries()) {
    const t = await simTurn(agentId, businessId, { message: line, ...(callId ? { callId } : {}) });
    callId = t.callId;
    for (const e of t.toolTrace) check(e.mocked === false, 'sim-call tools are real');
    const p = t.toolTrace.find((e) => e.tool === proposeTool && e.output?.ok === true);
    if (p) {
      const bye = await simTurn(agentId, businessId, { callId, message: 'Thanks, bye.', end: true });
      return { callId: callId!, proposalId: String(p.output.proposalId), approvalId: String(p.output.approvalId), turns: i + 1, bye: bye.reply };
    }
    if (i === lines.length - 1) await simTurn(agentId, businessId, { callId, message: 'Bye.', end: true });
  }
  throw new Error(`${proposeTool} did not succeed within ${lines.length} caller turns`);
}

const pizzaLines = (name: string) => [
  'Hi, I would like to order one large Margherita pizza for pickup.',
  `That is right, just one large Margherita. My name is ${name}. I would like to pick it up today at 6 PM. My phone number is 555-555-0142, but please do not send me any text messages; I will pay with the QR code at the counter.`,
  'Yes, that is all correct: one large Margherita, pickup today at 6 PM, no text messages. Please send it for approval.',
  'Yes, I confirm. No text messages please. Go ahead and send it for approval.',
  'Yes. Confirmed.',
  'Yes, please submit it now.',
];

async function approvalFor(businessId: string, approvalId: string) {
  const r = await api('GET', `/api/approvals/${approvalId}?businessId=${businessId}`);
  check(r.status === 200, `approval readable (HTTP ${r.status})`);
  return r.body;
}
const decide = (businessId: string, approvalId: string, decision: 'approve' | 'reject', payloadHash: string) =>
  api('POST', `/api/approvals/${approvalId}/decision?businessId=${businessId}`, { decision, payloadHash });

async function waitFor<T>(what: string, timeoutMs: number, fn: () => Promise<T | undefined>, everyMs = 1000): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return { value: v, ms: Date.now() - started };
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}
const order = async (id: string) => (await api('GET', `/api/orders/${id}?businessId=${PIZZA}`)).body;
const squareWrites = async (approvalId: string) => (await q<{ n: number }>(
  "select count(*)::int as n from public.action_executions where approval_id = $1 and action_type like 'square.%' and status in ('SUCCEEDED','RUNNING','NEEDS_REVIEW')", [approvalId]))[0]!.n;

// ---------- Sheets read back (read only) ----------
async function sheetHasRecord(tab: string, recordId: string): Promise<boolean> {
  const sa = JSON.parse(env('GOOGLE_SERVICE_ACCOUNT_JSON')) as { client_email: string; private_key: string };
  const client = sheets({ version: 'v4', auth: new JWT({ email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] }) });
  const r = await client.spreadsheets.values.get({ spreadsheetId: env('GOOGLE_SHEET_ID'), range: `'${tab}'!A:A`, majorDimension: 'COLUMNS' });
  return (r.data.values?.[0] ?? []).some((v) => String(v) === recordId);
}
/** Reads one event back from the demo calendar (read only). */
async function calendarEvent(eventId: string) {
  const sa = JSON.parse(env('GOOGLE_SERVICE_ACCOUNT_JSON')) as { client_email: string; private_key: string };
  const client = calendar({ version: 'v3', auth: new JWT({ email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/calendar.events'] }) });
  const r = await client.events.get({ calendarId: env('GOOGLE_CALENDAR_ID'), eventId });
  return { status: r.data.status, start: r.data.start?.dateTime, end: r.data.end?.dateTime };
}
async function sheetsRecordId(recordType: 'order' | 'booking', recordId: string) {
  const job = (await q<{ id: string; state: string; attempts: number; external_ref: string | null }>(
    "select id, state, attempts, external_ref from public.sync_jobs where record_type = $1 and record_id = $2", [recordType, recordId]))[0];
  return job ? { ...job, status: job.state === 'DONE' ? 'SUCCEEDED' : job.state, idempotency_key: job.external_ref } : undefined;
}

// ---------- flows ----------
const state: { pizza?: { orderId: string; approvalId: string; payloadHash: string; squareOrderId: string; totalMinor: number; currency: string } } = {};

async function flowPizza() {
  log('FLOW 1 pizza order: simulated call with the real model');
  const call = await simulatedCall('agt_pizza_01', PIZZA, 'propose_order', pizzaLines('Testy McFake'));
  log(`proposal ${short(call.proposalId)} approval ${short(call.approvalId)} after ${call.turns} caller turns`);
  const byeOk = /approv/i.test(call.bye) && /payment link|link/i.test(call.bye) && !/(haven.t|not) (been )?(submitted|sent)/i.test(call.bye);
  log(`closing line mentions approval and the payment link, no denial: ${byeOk}`);
  const a = await approvalFor(PIZZA, call.approvalId);
  check(a.state === 'PENDING' && a.bundleType === 'order_bundle' && a.subjectId === call.proposalId, 'pending order_bundle approval for the order');
  check(a.payload.messageChannel === 'qr_only' && !('messageRecipient' in a.payload), 'qr_only, no recipient');
  const o0 = await order(call.proposalId);
  const lines = (o0.cart?.lines ?? []) as Json[];
  log(`order ${o0.status} total ${o0.totalMinor} ${o0.currency}; ${lines.length} line(s), qty ${lines.map((l) => l.quantity).join(',')}; payload keys ${Object.keys(a.payload).sort().join(',')}`);
  check(o0.status === 'AWAITING_OWNER_APPROVAL', 'order awaits approval');
  check(lines.length === 1 && lines[0]!.quantity === 1, 'one line, quantity 1');
  const catalog = (await api('GET', `/api/businesses/${PIZZA}/catalog`)).body.items as Json[];
  const item = catalog.find((i) => i.variations?.some((v: Json) => v.id === lines[0]!.variationId));
  const variation = item?.variations.find((v: Json) => v.id === lines[0]!.variationId);
  log(`line is ${item?.name} / ${variation?.name}`);
  check(/margherita/i.test(String(item?.name)) && /large/i.test(String(variation?.name)), 'the line is a Large Margherita');
  check(a.payload.totalMinor === o0.totalMinor, 'payload total equals the order total');
  check(await squareWrites(call.approvalId) === 0, 'no Square write before approval');

  const tApprove = Date.now();
  const d = await decide(PIZZA, call.approvalId, 'approve', a.payloadHash);
  check(d.status === 200 && d.body.approval?.state === 'APPROVED', `approve accepted (HTTP ${d.status} ${d.body.code ?? ''})`);
  log(`approved in ${Date.now() - tApprove} ms (response does not wait for providers)`);
  const seen = new Set<string>();
  let linkAt: number | undefined;
  const ready = await waitFor('PAYMENT_PENDING', 90_000, async () => {
    const o = await order(call.proposalId);
    if (!seen.has(o.status)) { seen.add(o.status); log(`  order status ${o.status}`); }
    if (o.status === 'PAYMENT_LINK_READY' && linkAt === undefined) linkAt = Date.now() - tApprove;
    if (o.status === 'PAYMENT_PENDING' && o.checkoutUrl) return o;
    if (['RECOVERY_REQUIRED', 'FAILED', 'CHECKOUT_FAILED'].includes(o.status)) throw new Error(`order reached ${o.status}`);
    return undefined;
  }, 500);
  const timeToLink = `approve->PAYMENT_LINK_READY ${linkAt ?? '?'} ms, ->PAYMENT_PENDING ${ready.ms} ms`;
  const st = await steps(call.approvalId);
  log(`steps: ${st.map((s) => `${s.action_type}=${s.status}/attempts ${s.attempts}`).join('; ')}`);
  const sq = st.find((s) => s.action_type === 'square.checkout.create');
  check(sq?.status === 'SUCCEEDED', 'Square step succeeded');
  check((await q("select 1 from public.activity_events where business_id = $1 and type = 'order.status_changed' and payload->>'orderId' = $2 and payload->>'to' = 'PAYMENT_LINK_READY'", [PIZZA, call.proposalId])).length === 1, 'PAYMENT_LINK_READY recorded');
  const co = await api('GET', `/api/orders/${call.proposalId}/checkout?businessId=${PIZZA}`);
  check(co.status === 200 && co.body.ready === true && co.body.environment === 'sandbox', 'checkout ready, sandbox');
  const host = new URL(co.body.qrText).host;
  check(host === 'sandbox.square.link' && co.body.qrText === co.body.checkoutUrl, `QR host ${host}`);
  check(!co.body.message, 'no message dispatch under qr_only');
  const final = await order(call.proposalId);
  log(`Square idempotency key equals the database key: ${short(sq.idempotency_key)} (link ${short(final.squarePaymentLinkId)}, Square order ${short(final.squareOrderId)})`);
  state.pizza = { orderId: call.proposalId, approvalId: call.approvalId, payloadHash: a.payloadHash, squareOrderId: final.squareOrderId, totalMinor: final.totalMinor, currency: final.currency };
  const feed = (await q<{ t: string }>("select payload->>'to' as t from public.activity_events where business_id = $1 and type = 'order.status_changed' and payload->>'orderId' = $2 order by occurred_at, id", [PIZZA, call.proposalId])).map((r) => r.t);
  const feedOk = feed.join(',') === 'AWAITING_OWNER_APPROVAL,APPROVED,CREATING_CHECKOUT,PAYMENT_LINK_READY,PAYMENT_PENDING';
  log(`feed order by occurred_at: ${feed.join(' > ')} (in order: ${feedOk})`);
  record('1 pizza order', final.status === 'PAYMENT_PENDING' && byeOk && feedOk,
    `closing line ok=${byeOk}, feed in order=${feedOk}; order ${short(call.proposalId)} AWAITING_OWNER_APPROVAL -> ${[...seen].join(' -> ')}; 1 Square link (${short(final.squarePaymentLinkId)}), QR host ${host}; ${timeToLink}`);
}

async function loadPizzaState() {
  const i = args.indexOf('--order');
  if (state.pizza || i < 0) return;
  const o = await order(args[i + 1]!);
  const a = await approvalFor(PIZZA, o.approvalId);
  state.pizza = { orderId: o.id, approvalId: o.approvalId, payloadHash: a.payloadHash, squareOrderId: o.squareOrderId, totalMinor: o.totalMinor, currency: o.currency };
}

async function flowPay() {
  await loadPizzaState();
  check(state.pizza, 'a pizza order from flow 1 or --order <id>');

  // ----- FLOW 2: SIMULATED customer payment in the sandbox, without a card form -----
  // Decision by the lead (2026-11-14): open the payment link's DRAFT order through UpdateOrder, then pay
  // it with Square's published sandbox nonce. Sandbox only; every line is labelled SIMULATED.
  const sim = (m: string) => log(`SIMULATED ${m}`);
  sim('FLOW 2 sandbox payment with the published test nonce');
  if (process.env.SQUARE_ENVIRONMENT !== 'sandbox' || new URL(SQUARE_SANDBOX).host !== 'connect.squareupsandbox.com') {
    sim('refused: SQUARE_ENVIRONMENT must be exactly sandbox and the host the sandbox host');
    record('2 sandbox payment', false, 'SIMULATED refused: not sandbox');
    return;
  }
  const p = state.pizza;
  const sqHeaders = { Authorization: `Bearer ${env('SQUARE_ACCESS_TOKEN')}`, 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' };
  const errs = (b: Json) => (b.errors as Json[] | undefined)?.map((e) => `${e.code} ${e.field ?? ''} ${String(e.detail ?? '').slice(0, 160)}`).join(' | ') ?? '';
  const sqOrder = (await (await fetch(`${SQUARE_SANDBOX}/v2/orders/${p.squareOrderId}`, { headers: sqHeaders, redirect: 'error' })).json() as Json).order as Json;
  sim(`Square order ${short(p.squareOrderId)} state ${sqOrder?.state} version ${sqOrder?.version} total ${sqOrder?.total_money?.amount}`);
  // Stable keys per order (and attempt): a rerun cannot open or pay twice. --pay-attempt N only after a declined attempt.
  const ai = args.indexOf('--pay-attempt');
  const attempt = ai >= 0 ? args[ai + 1] : '1';
  if (sqOrder?.state === 'DRAFT') {
    const up = await fetch(`${SQUARE_SANDBOX}/v2/orders/${p.squareOrderId}`, { method: 'PUT', redirect: 'error', headers: sqHeaders,
      body: JSON.stringify({ idempotency_key: `open-${p.orderId.slice(-24)}-${attempt}`, order: { location_id: env('SQUARE_LOCATION_ID'), version: sqOrder.version, state: 'OPEN' } }) });
    const upBody = (await up.json()) as Json;
    sim(`UpdateOrder state OPEN: HTTP ${up.status} ${up.ok ? `state ${upBody.order?.state} version ${upBody.order?.version}` : errs(upBody)}`);
    if (!up.ok || upBody.order?.state !== 'OPEN') { record('2 sandbox payment', false, `SIMULATED UpdateOrder refused: HTTP ${up.status} ${errs(upBody)}`); return; }
  } else if (sqOrder?.state !== 'OPEN') { record('2 sandbox payment', false, `SIMULATED Square order is ${sqOrder?.state}, not payable`); return; }
  const payKey = `pay-${p.orderId.slice(-24)}-${attempt}`;
  const tPay = Date.now();
  const payRes = await fetch(`${SQUARE_SANDBOX}/v2/payments`, { method: 'POST', redirect: 'error', headers: sqHeaders,
    body: JSON.stringify({ source_id: 'cnon:card-nonce-ok', idempotency_key: payKey.slice(0, 45), order_id: p.squareOrderId,
      amount_money: { amount: p.totalMinor, currency: p.currency }, location_id: env('SQUARE_LOCATION_ID'), autocomplete: true }) });
  const payBody = (await payRes.json()) as Json;
  const payment = payBody.payment as Json | undefined;
  sim(`CreatePayment: HTTP ${payRes.status} ${payRes.ok ? `payment ${short(payment?.id)} ${payment?.status} ${payment?.amount_money?.amount} ${payment?.amount_money?.currency}` : errs(payBody)}`);
  record('2 sandbox payment', payRes.ok && payment?.status === 'COMPLETED',
    payRes.ok ? `SIMULATED UpdateOrder OPEN + CreatePayment ${short(payment?.id)} ${payment?.status} ${payment?.amount_money?.amount} ${payment?.amount_money?.currency}, order ${short(payment?.order_id)}`
      : `SIMULATED HTTP ${payRes.status} ${errs(payBody)}`);
  if (!payRes.ok) return;

  // ----- FLOW 3: reconciliation (poll or the owner's recovery route) -----
  log('FLOW 3 reconciliation: waiting for the reconcile poll (every 30 s)');
  const pollWait = await waitFor('PAID_VERIFIED by the poll', 75_000, async () => {
    const o = await order(p.orderId);
    return ['PAID_VERIFIED', 'FULFILLMENT_READY'].includes(o.status) ? o.status : undefined;
  }, 1000).catch(() => undefined);
  const payToPaid = pollWait ? Date.now() - tPay : undefined;
  let via = 'reconcile poll';
  if (!pollWait) {
    via = 'owner recovery route (orders/:id/cancel, which reconciles and refuses)';
    log('poll did not verify the payment in 75 s; trying the owner recovery route');
    const c = await api('POST', `/api/orders/${p.orderId}/cancel?businessId=${PIZZA}`, {});
    log(`  cancel route HTTP ${c.status} ${c.body.code ?? c.body.order?.status ?? ''}`);
  }
  const paid = await waitFor('FULFILLMENT_READY', 30_000, async () => {
    const o = await order(p.orderId);
    return o.status === 'FULFILLMENT_READY' ? o : undefined;
  }, 1000).catch(() => undefined);
  const payToVerified = Date.now() - tPay;
  const receipts = await q("select payment_id, amount_minor, currency, environment from public.payment_receipts where order_id = $1", [p.orderId]);
  const events = (await q<{ type: string }>("select type from public.activity_events where business_id = $1 and (payload->>'orderId' = $2 or correlation_id = $2) order by occurred_at", [PIZZA, p.orderId])).map((e) => e.type);
  log(`receipts: ${receipts.length} (${receipts.map((r) => `${short(r.payment_id)} ${r.amount_minor} ${r.currency} ${r.environment}`).join(', ')}); events: ${events.join(', ')}`);
  let sheetOk = false;
  let sheetDetail = 'no sync job';
  if (paid) {
    const job = await waitFor('Sheets job SUCCEEDED', 60_000, async () => {
      const j = await sheetsRecordId('order', p.orderId);
      return j && ['SUCCEEDED', 'FAILED', 'DEAD'].includes(j.status) ? j : undefined;
    }, 2000).then((r) => r.value).catch(async () => sheetsRecordId('order', p.orderId));
    sheetDetail = `sync job ${job?.status ?? 'absent'}`;
    if (job?.status === 'SUCCEEDED') {
      sheetOk = await sheetHasRecord('Orders', p.orderId) || (job.idempotency_key ? await sheetHasRecord('Orders', job.idempotency_key) : false);
      sheetDetail += sheetOk ? ', row found in the Orders tab' : ', row NOT found in the Orders tab';
    }
  }
  record('3 reconciliation', !!paid && receipts.length === 1 && sheetOk,
    `${paid ? 'PAID_VERIFIED -> FULFILLMENT_READY' : 'not verified'} via ${via}; payment->PAID_VERIFIED ${payToPaid ?? '?'} ms (poll every 30 s), ->FULFILLMENT_READY ${payToVerified} ms; ${receipts.length} payment_receipts row; ${sheetDetail}`);
}

async function flowNegative() {
  log('FLOW 4 negative checks');
  const parts: string[] = [];
  let ok = true;
  if (state.pizza) {
    const before = await steps(state.pizza.approvalId);
    const linkBefore = (await order(state.pizza.orderId)).squarePaymentLinkId;
    const again = await decide(PIZZA, state.pizza.approvalId, 'approve', state.pizza.payloadHash);
    await sleep(3000);
    const after = await steps(state.pizza.approvalId);
    const linkAfter = (await order(state.pizza.orderId)).squarePaymentLinkId;
    const same = again.status === 200 && JSON.stringify(before.map((s) => [s.status, s.attempts])) === JSON.stringify(after.map((s) => [s.status, s.attempts])) && linkBefore === linkAfter;
    ok &&= same;
    parts.push(`re-approve HTTP ${again.status}, steps unchanged=${same}, same link ${short(linkAfter)}`);
  } else { ok = false; parts.push('re-approve not run: no pizza order in this run'); }

  const call = await simulatedCall('agt_pizza_01', PIZZA, 'propose_order', pizzaLines('Rejecta Fakename'));
  const a = await approvalFor(PIZZA, call.approvalId);
  const wrong = await decide(PIZZA, call.approvalId, 'approve', `sha256:${'0'.repeat(64)}`);
  const wrongOk = wrong.status === 409 && wrong.body.code === 'PAYLOAD_HASH_MISMATCH' && (await steps(call.approvalId)).length === 0;
  parts.push(`wrong hash HTTP ${wrong.status} ${wrong.body.code}, 0 steps=${wrongOk}`);
  const rej = await decide(PIZZA, call.approvalId, 'reject', a.payloadHash);
  await sleep(3000);
  const o = await order(call.proposalId);
  const rejOk = rej.status === 200 && o.status === 'REJECTED' && (await steps(call.approvalId)).length === 0 && !o.squareOrderId;
  parts.push(`reject: order ${short(call.proposalId)} ${o.status}, 0 steps, 0 Square writes=${rejOk}`);
  record('4 negative checks', ok && wrongOk && rejOk, parts.join('; '));
}

async function flowBooking() {
  log('FLOW 5 barbershop booking');
  // A weekday a few days out, so the slot is in the future and inside opening hours.
  const day = new Date(Date.now() + 3 * 86400_000);
  while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
  const date = day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
  const lines = [
    `Hi, I would like to book a haircut on ${date}. What times are free?`,
    'The first available time works for me. My name is Faux Customer and my phone number is 555-555-0143, but please do not send me any text messages.',
    'Yes, that is all correct: a haircut at that time, name Faux Customer, no texts. Please book it.',
    'Yes, I confirm. Please send it for approval.',
    'Yes. Confirmed.',
  ];
  const call = await simulatedCall('agt_barber_01', BARBER, 'propose_booking', lines);
  const a = await approvalFor(BARBER, call.approvalId);
  check(a.state === 'PENDING' && a.bundleType === 'booking_bundle', 'pending booking_bundle');
  log(`booking ${short(call.proposalId)} slot ${a.payload.startUtc} service ${a.payload.serviceId}`);
  const tApprove = Date.now();
  const d = await decide(BARBER, call.approvalId, 'approve', a.payloadHash);
  const tDecided = Date.now();
  check(d.status === 200, `approve HTTP ${d.status} ${d.body.code ?? ''}`);
  const seen = new Set<string>();
  const done = await waitFor('BOOKED_VERIFIED', 90_000, async () => {
    const b = (await api('GET', `/api/bookings/${call.proposalId}?businessId=${BARBER}`)).body;
    if (!seen.has(b.status)) { seen.add(b.status); log(`  booking status ${b.status}`); }
    if (b.status === 'BOOKED_VERIFIED') return b;
    if (['SLOT_CONFLICT', 'FAILED', 'RETRY_REQUIRED', 'REJECTED'].includes(b.status)) throw new Error(`booking reached ${b.status}`);
    return undefined;
  }, 1000);
  const st = await steps(call.approvalId);
  log(`steps: ${st.map((s) => `${s.action_type}=${s.status}`).join('; ')}`);
  const job = await waitFor('Sheets job', 60_000, async () => {
    const j = await sheetsRecordId('booking', call.proposalId);
    return j && ['SUCCEEDED', 'FAILED', 'DEAD'].includes(j.status) ? j : undefined;
  }, 2000).then((r) => r.value).catch(async () => sheetsRecordId('booking', call.proposalId));
  const inSheet = job?.status === 'SUCCEEDED' ? await sheetHasRecord('Bookings', call.proposalId) || (job.idempotency_key ? await sheetHasRecord('Bookings', job.idempotency_key) : false) : false;
  const ev = done.value.googleEventId as string | undefined;
  const onCal = ev ? await calendarEvent(ev).catch(() => undefined) : undefined;
  const calOk = onCal?.status === 'confirmed' && Date.parse(String(onCal.start)) === Date.parse(String(a.payload.startUtc));
  log(`calendar read back: ${onCal ? `${onCal.status} ${onCal.start} to ${onCal.end}` : 'not found'}`);
  record('5 barbershop booking', !!ev && calOk && inSheet,
    `booking ${short(call.proposalId)} ${[...seen].join(' -> ')}; calendar event ${short(ev)} read back ${calOk ? 'at the approved slot' : 'FAILED'}; approve->BOOKED_VERIFIED ${done.ms} ms after the decision returned (decision ${tDecided - tApprove} ms); sync job ${job?.status ?? 'absent'} (attempts ${job?.attempts ?? '-'}), sheet row ${inSheet}`);
}

async function flowHours() {
  log('FLOW 6 hours edit');
  const facts = (await api('GET', `/api/businesses/${PIZZA}/facts?kind=hours&status=verified`)).body.items as Json[];
  const sat = facts.find((f) => f.key === 'sat' && f.status === 'verified');
  check(sat, 'a verified Saturday hours fact');
  const next = { ...sat.value, close: sat.value.close === '22:00' ? '23:00' : '22:00' };
  const p = await api('POST', `/api/businesses/${PIZZA}/facts/propose`, { kind: 'hours', key: 'sat', value: next, reason: 'Live verification' });
  check(p.status === 201, `propose HTTP ${p.status} ${p.body.code ?? ''}`);
  const ap = p.body.approval;
  const d = await decide(PIZZA, ap.id, 'approve', ap.payloadHash);
  check(d.status === 200, `confirm HTTP ${d.status} ${d.body.code ?? ''}`);
  const after = await waitFor('new Saturday version', 15_000, async () => {
    const f = ((await api('GET', `/api/businesses/${PIZZA}/facts?kind=hours&status=verified`)).body.items as Json[]).find((x) => x.key === 'sat');
    return f && f.version === sat.version + 1 ? f : undefined;
  });
  const edited = JSON.stringify(after.value.value) === JSON.stringify(next);
  const parts = [`sat v${sat.version} -> v${after.value.version} close ${after.value.value.close} verified=${after.value.status === 'verified' && edited}`];

  // A new key: fromVersion 0, before null.
  const key = `live_${randomUUID().slice(0, 8)}`;
  const n = await api('POST', `/api/businesses/${PIZZA}/facts/propose`, { kind: 'faq', key, value: { question: 'Is this a live check?', answer: 'Yes.' }, reason: 'Live verification new key' });
  let newOk = false;
  if (n.status === 201) {
    const na = n.body.approval;
    const shape = na.payload.fromVersion === 0 && na.payload.before === null;
    const nd = await decide(PIZZA, na.id, 'approve', na.payloadHash);
    const nf = await waitFor('new key verified', 15_000, async () => {
      const f = ((await api('GET', `/api/businesses/${PIZZA}/facts?kind=faq&status=verified`)).body.items as Json[]).find((x) => x.key === key);
      return f ?? undefined;
    }).catch(() => undefined);
    newOk = shape && nd.status === 200 && nf?.value.version === 1;
    parts.push(`new key faq/${key}: fromVersion ${na.payload.fromVersion}, before ${JSON.stringify(na.payload.before)}, confirm HTTP ${nd.status}, verified v${nf?.value.version ?? '-'}`);
  } else parts.push(`new key propose HTTP ${n.status} ${n.body.code ?? ''}`);
  record('6 hours edit', after.value.status === 'verified' && edited && newOk, parts.join('; '));
}

async function flowHealth() {
  log('FLOW 7 integration health');
  const r = await api('GET', `/api/integrations/health?businessId=${PIZZA}&refresh=1`);
  check(r.status === 200, `health HTTP ${r.status}`);
  const s = Object.entries(r.body).filter(([, v]) => v && typeof v === "object").map(([k, v]) => `${k}=${(v as Json).state}${(v as Json).detail ? ` (${String((v as Json).detail).slice(0, 60)})` : ''}`);
  record('7 integration health', r.body.square?.environment === 'sandbox', s.join('; '));
}

const FLOWS: Record<string, () => Promise<void>> = { pizza: flowPizza, pay: flowPay, negative: flowNegative, booking: flowBooking, hours: flowHours, health: flowHealth };

async function main() {
  const health = await (await fetch(new URL('/health', BASE))).json() as Json;
  check(health.squareEnvironment === 'sandbox', 'server reports Square sandbox');
  await signIn();
  await loadPizzaState();
  const order = which === 'all' ? ['pizza', 'pay', 'negative', 'booking', 'hours', 'health'] : which.split(',');
  for (const name of order) {
    const fn = FLOWS[name];
    if (!fn) throw new Error(`unknown flow ${name}`);
    try { await fn(); } catch (error) { record(name, false, error instanceof Error ? error.message : 'error'); }
  }
  console.log('\nSummary');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.flow} | ${r.evidence}`);
  await pool.end();
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
void main();
