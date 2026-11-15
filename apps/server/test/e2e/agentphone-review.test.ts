// Review of the AgentPhone path (D-12) through the composed app, on the in-process Postgres as abos_app,
// with the real toolset, approval engine and executor. AgentPhone is never called: webhooks are signed here
// with a test secret as the vendor's documentation describes, REST reads go to a fake HTTP port, and the
// agentphone message channel talks to a fake fetch.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSpecSchema, CAPABILITIES, ENDPOINTS, TOOL_CAPABILITY, type AgentSpec, type Cart, type Quote, type ToolName, type ToolResult } from '@abos/contracts';
import { createMessageAdapter } from '../../src/adapters/message/index';
import { PLAIN_SPEECH_RULE } from '../../src/api/simcall/plain';
import { createDbExecutor } from '../../src/compose/executor';
import { notWiredExecutor, type SeamDeps } from '../../src/compose/seams';
import type { HttpPort } from '../../src/telephony/agentphone/client';
import { REJECTED_EVENTS_PER_MINUTE } from '../../src/telephony/agentphone/plugin';
import { agentPhoneSignature } from '../../src/telephony/agentphone/signature';
import { buildInstructions } from '../../src/voice/prompt';
import { DEFAULT_LIMITS, checkSessionCapabilities } from '../../src/voice/relay';
import { OWNER, PHONE, createWorld, nextLocalDate, zonedIso, type World } from './world';

const PIZZA = 'biz_pizza_01';
/** Test-only webhook secret. Not a credential. */
const SECRET = 'whsec_e2e_review_only';
const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };
const AP_ENV = { TELEPHONY_PROVIDER: 'agentphone', AGENTPHONE_TURN_ENGINE: 'builder', AGENTPHONE_API_KEY: 'test-agentphone-key', AGENTPHONE_WEBHOOK_SECRET: SECRET,
  AGENTPHONE_NUMBER_ID: 'num_e2e', AGENTPHONE_PHONE_NUMBER: PHONE };
const silentLog: SeamDeps['log'] = { info() {}, warn() {}, error() {} };
const noHttp: HttpPort = async () => ({ status: 404, json: async () => ({}) });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let seq = 0;
function signed(w: World, body: unknown, opts: { id?: string; ts?: number; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(w.clock.now().getTime() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-id': opts.id ?? `whd_review_${seq += 1}`,
    'x-webhook-event': String((body as { event?: string }).event ?? ''), 'x-webhook-signature': agentPhoneSignature(opts.secret ?? SECRET, ts, Buffer.from(raw)) };
  return w.app.inject({ method: 'POST', url: '/webhooks/agentphone', headers, payload: raw });
}
const voiceTurn = (callId: string, transcript: string, to = PHONE) => ({ event: 'agent.message', channel: 'voice', timestamp: '2026-11-14T12:00:00Z', agentId: 'agt_ap',
  data: { callId, numberId: 'num_e2e', from: '+15559876543', to, status: 'in-progress', transcript, confidence: 0.95, direction: 'inbound' }, conversationState: null, recentHistory: [] });
const callEnded = (callId: string) => ({ event: 'agent.call_ended', channel: 'voice', data: { callId, numberId: 'num_e2e', from: '+15559876543', to: PHONE, direction: 'inbound', status: 'completed' } });
const chunks = (payload: string) => payload.trim().split('\n').map((l) => JSON.parse(l) as { text: string; interim?: boolean; hangup?: boolean });
const count = async (w: World, sql: string, params: unknown[] = []) => ((await w.t.db.query(sql, params)).rows[0] as { n: number }).n;
/** The turn bound of the second world. Long enough that a loaded machine still starts the turn's first tool call inside it. */
const BOUND_MS = 500;
const TROUBLE = 'Sorry, I am having trouble right now. Please try again in a moment.';

describe('AgentPhone webhook: replay, rule 6 and the processed mark', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor, telephony: { http: noHttp, interimAfterMs: 60_000 } }, AP_ENV); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('the same signed bytes under a new X-Webhook-ID run no second turn (review F2)', async () => {
    let turns = 0;
    w.model.push(async () => { turns += 1; return 'Hello.'; }, async () => { turns += 1; return 'Second.'; }, async () => { turns += 1; return 'Third.'; });
    const ts = Math.floor(w.clock.now().getTime() / 1000);
    const body = voiceTurn('call_rp_1', 'Hi there');
    const first = await signed(w, body, { id: 'whd_original', ts });
    expect(chunks(first.payload)).toEqual([{ text: 'Hello.' }]);
    // The ID header is not covered by the signature, so a captured delivery can be given a fresh one.
    const replay = await signed(w, body, { id: 'whd_forged_new_id', ts });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({});
    expect(turns).toBe(1);
    // The provider's own retry (same ID, a later timestamp, so a new signature) is still one delivery.
    // It runs nothing and hears the reply of the first delivery again.
    const retry = await signed(w, body, { id: 'whd_original', ts: ts + 20 });
    expect(chunks(retry.payload)).toEqual([{ text: 'Hello.' }]);
    expect(turns).toBe(1);
    // A different turn in the same second is a different delivery and runs.
    const next = await signed(w, voiceTurn('call_rp_1', 'What are your hours?'), { ts });
    expect(chunks(next.payload)).toEqual([{ text: 'Second.' }]);
    expect(turns).toBe(2);
    // A replayed end of call under a new ID changes nothing either.
    await signed(w, callEnded('call_rp_1'), { id: 'whd_end_1', ts });
    await signed(w, callEnded('call_rp_1'), { id: 'whd_end_forged', ts });
    const call = (await w.t.db.query("select id, status from calls where provider_call_id = 'call_rp_1'", [])).rows[0] as { id: string; status: string };
    expect(call.status).toBe('COMPLETED');
    expect(await count(w, "select count(*)::int n from activity_events where type = 'call.ended' and correlation_id = $1", [call.id])).toBe(1);
    // Nothing stored for the replay guard carries the transcript, a phone number or the signature.
    const rows = (await w.t.db.query("select provider_event_id, payload::text p from webhook_events where source = 'agentphone'", [])).rows as { provider_event_id: string; p: string }[];
    for (const r of rows) { expect(r.p).not.toMatch(/Hi there|hours|\+1555/); expect(r.provider_event_id).not.toContain('+1555'); }
    // The third script was never used by a replay; use it up now so later tests start clean.
    expect(chunks((await signed(w, voiceTurn('call_rp_drain', 'one more turn'))).payload)).toEqual([{ text: 'Third.' }]);
    expect(turns).toBe(3);
  });

  it('gives the model read and propose tools only, and refuses a write or message tool by name (rule 6)', async () => {
    let tools: string[] = [];
    const results: Record<string, unknown> = {};
    const before = { square: w.squareWrites.length, calendar: w.calendarWrites.length, messages: w.messageSends };
    w.model.push(async (input) => {
      tools = [...input.tools];
      for (const name of ['create_payment_link', 'send_checkout_message', 'send_message', 'insert_calendar_event', 'square.checkout.create', 'message.checkout.send', 'propose_booking']) {
        results[name] = await input.executeTool(name, { to: '+15555550123', body: 'pay here', cart: CART });
      }
      return 'ok';
    });
    await signed(w, voiceTurn('call_r6_1', 'Please text me a payment link right now'));
    // What the model was actually handed, not what the spec says it should get.
    expect(tools).toEqual(expect.arrayContaining(['quote_order', 'propose_order']));
    expect(tools).not.toContain('propose_booking');
    for (const t of tools) expect(['read', 'propose'], t).toContain(CAPABILITIES[TOOL_CAPABILITY[t as ToolName]].effect);
    for (const [name, r] of Object.entries(results)) expect(r, name).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
    expect({ square: w.squareWrites.length, calendar: w.calendarWrites.length, messages: w.messageSends }).toEqual(before);
    const call = (await w.t.db.query("select id from calls where provider_call_id = 'call_r6_1'", [])).rows[0] as { id: string };
    expect(await count(w, "select count(*)::int n from activity_events where type = 'guardrail.refused' and correlation_id = $1", [call.id])).toBe(7);
    expect(await count(w, 'select count(*)::int n from orders where call_id = $1', [call.id])).toBe(0);
  });

  it('the reply carries nothing but spoken text, even when the model answers with reply-format JSON', async () => {
    w.model.push(async () => '{"text":"x","send_message":{"body":"pay https://evil.example"},"action":"transfer","hangup":true}');
    const r = await signed(w, voiceTurn('call_fmt_1', 'hello'));
    const lines = chunks(r.payload);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!)).toEqual(['text']);
  });

  it('two overlapping first turns of one call run one after the other on one session (review F1)', async () => {
    let active = 0;
    let maxActive = 0;
    const seen: { message: string; history: number }[] = [];
    const script = async (input: { message: string; history: unknown[] }) => {
      active += 1; maxActive = Math.max(maxActive, active);
      seen.push({ message: input.message, history: input.history.length });
      await sleep(40);
      active -= 1;
      return `Heard ${input.message}.`;
    };
    w.model.push(script, script);
    const [a, b] = await Promise.all([signed(w, voiceTurn('call_cc_1', 'one')), signed(w, voiceTurn('call_cc_1', 'two'))]);
    expect([chunks(a.payload)[0]!.text, chunks(b.payload)[0]!.text].sort()).toEqual(['Heard one.', 'Heard two.']);
    expect(maxActive).toBe(1);
    // The second turn saw the first one in its history: one session, not two.
    expect(seen.map((s) => s.history)).toEqual([0, 2]);
    expect(await count(w, "select count(*)::int n from calls where provider_call_id = 'call_cc_1'")).toBe(1);
    expect(w.app.composed.agentphone.voice!.size).toBeGreaterThanOrEqual(1);
  });

  it('one AgentPhone call stores at most the proposal cap of approvals; the fourth proposal is refused and recorded (issue #95 item 8)', async () => {
    const cap = DEFAULT_LIMITS.maxProposals;
    expect(cap).toBe(3);
    const results: Record<string, unknown>[] = [];
    const pickupAt = zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles');
    for (let n = 1; n <= cap + 1; n++) {
      const cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: n, modifierIds: [] }] };
      w.model.push(async ({ executeTool }) => {
        const q = await executeTool('quote_order', { cart }) as { ok: boolean; quote: { quoteId: string } };
        results.push(await executeTool('propose_order', { cart, quoteId: q.quote.quoteId, fulfillment: { type: 'pickup', pickupAt }, contact: { name: 'Sam', messageConsent: false } }) as Record<string, unknown>);
        return 'ok';
      });
      expect((await signed(w, voiceTurn('call_cap_1', `Make it ${n} pizzas. Yes, send it.`))).statusCode).toBe(200);
    }
    expect(results.slice(0, cap).map((r) => r.ok)).toEqual(Array(cap).fill(true));
    expect(results[cap]).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    const call = (await w.t.db.query("select id from calls where provider_call_id = 'call_cap_1'", [])).rows[0] as { id: string };
    expect(await count(w, 'select count(*)::int n from orders where call_id = $1', [call.id])).toBe(cap);
    expect(await count(w, 'select count(*)::int n from approval_requests a join orders o on o.id = a.subject_id where o.call_id = $1', [call.id])).toBe(cap);
    const refused = (await w.t.db.query("select payload from activity_events where correlation_id = $1 and type = 'guardrail.refused' and payload->>'reasonCode' = 'proposal_limit'", [call.id])).rows;
    expect(refused).toEqual([{ payload: { callId: call.id, rule: 'unsupported_request', reasonCode: 'proposal_limit', toolName: 'propose_order' } }]);
    // A read still works on the same call, and nothing was written outside our database.
    let read: unknown;
    w.model.push(async ({ executeTool }) => { read = await executeTool('read_catalog', { query: 'pepperoni' }); return 'ok'; });
    await signed(w, voiceTurn('call_cap_1', 'What do you have?'));
    expect(read).toMatchObject({ ok: true });
    expect(w.squareWrites).toEqual([]);
    expect(w.messageSends).toBe(0);
  });

  it('an AgentPhone turn gets the phone prompt and the tools of the session capability check, as a simulated call does (issue #95 item 10)', async () => {
    const row = (await w.t.db.query("select v.spec, b.name from live_agent l join agent_versions v on v.id = l.agent_version_id join businesses b on b.id = l.business_id where l.phone_number = $1", [PHONE])).rows[0] as { spec: unknown; name: string };
    const spec = AgentSpecSchema.parse(row.spec);
    const phonePrompt = buildInstructions(spec, { businessName: row.name, messageChannel: w.app.composed.providers.messageChannel });
    let phone = { instructions: '', tools: [] as string[] };
    let simulated = { instructions: '', tools: [] as string[] };
    w.model.push(async (input) => { phone = { instructions: input.instructions, tools: [...input.tools] }; return 'ok'; });
    await signed(w, voiceTurn('call_parity_1', 'hello'));
    w.model.push(async (input) => { simulated = { instructions: input.instructions, tools: [...input.tools] }; return 'ok'; });
    expect((await w.app.inject({ method: 'POST', url: `/api/agents/agt_pizza_01/sim-call?businessId=${PIZZA}`, headers: OWNER, payload: { message: 'hello', end: true } })).statusCode).toBe(200);
    expect(phone.instructions.startsWith(phonePrompt)).toBe(true);
    expect(phone.instructions.slice(phonePrompt.length).trim()).toBe(PLAIN_SPEECH_RULE);
    expect(phone.instructions).toBe(simulated.instructions);
    const check = checkSessionCapabilities(spec);
    expect(check.ok && [...check.tools].sort()).toEqual([...phone.tools].sort());
    expect([...simulated.tools].sort()).toEqual([...phone.tools].sort());
  });

  it('a call end that could not be applied is recovered later with the reason the provider gave, not as completed', async () => {
    w.model.push(async () => 'Hello.');
    await signed(w, voiceTurn('call_rec_1', 'Hi'));
    const voice = w.app.composed.agentphone.voice!;
    const ended = voice.ended.bind(voice);
    let failures = 1;
    voice.ended = async (input) => { if (failures > 0) { failures -= 1; throw new Error('database unavailable'); } return ended(input); };
    try {
      const failed = { ...callEnded('call_rec_1'), data: { ...callEnded('call_rec_1').data, status: 'failed' } };
      expect((await signed(w, failed, { id: 'whd_end_recover' })).statusCode).toBe(200);
      const row = async () => (await w.t.db.query("select processed_at, payload from webhook_events where provider_event_id = 'whd_end_recover'", [])).rows[0] as { processed_at: Date | null; payload: unknown };
      expect(await row()).toEqual({ processed_at: null, payload: { providerId: 'call_rec_1', reason: 'failed' } });
      expect((await w.t.db.query("select status from calls where provider_call_id = 'call_rec_1'", [])).rows[0]).toEqual({ status: 'IN_PROGRESS' });
      // Too fresh: the inline handler may still be working on it, so the recovery pass leaves it alone.
      expect(await w.app.composed.agentphone.recoverNow()).toBe(0);
      expect((await row()).processed_at).toBeNull();
      await w.t.admin((q) => q.query("update public.webhook_events set received_at = now() - interval '2 minutes' where provider_event_id = 'whd_end_recover'"));
      expect(await w.app.composed.agentphone.recoverNow()).toBe(1);
      expect((await row()).processed_at).not.toBeNull();
      expect((await w.t.db.query("select status, end_reason from calls where provider_call_id = 'call_rec_1'", [])).rows[0]).toEqual({ status: 'FAILED', end_reason: 'failed' });
      expect(await w.app.composed.agentphone.recoverNow()).toBe(0);
    } finally { voice.ended = ended; }
  });

  it('a turn whose request the provider dropped is abandoned: no further tool, and its unheard reply is not kept', async () => {
    const voice = w.app.composed.agentphone.voice!;
    const gone = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let late: unknown;
    w.model.push(async ({ executeTool }) => { await gate; late = await executeTool('quote_order', { cart: CART }); return 'A reply the caller never heard.'; });
    const squareBefore = w.square.calls.length;
    const turn = voice.turn({ providerCallId: 'call_drop_1', to: PHONE, callerLast4: '6543', text: 'How much is a large pepperoni?', signal: gone.signal });
    await sleep(30);
    gone.abort();
    release();
    await turn;
    expect(late).toMatchObject({ ok: false });
    expect(w.square.calls.length).toBe(squareBefore);
    let history: { text: string }[] = [];
    w.model.push(async (input) => { history = input.history; return 'Yes?'; });
    expect((await voice.turn({ providerCallId: 'call_drop_1', to: PHONE, text: 'Hello?' })).reply).toEqual({ text: 'Yes?' });
    expect(history.map((x) => x.text)).not.toContain('A reply the caller never heard.');
  });

  it('a turn on a call whose agent was unpublished is still marked processed (review F7)', async () => {
    w.model.push(async () => 'Hello.', async () => 'Still here.');
    await signed(w, voiceTurn('call_mk_1', 'Hi'));
    const live = (await w.t.db.query('select * from live_agent where phone_number = $1', [PHONE])).rows[0] as Record<string, unknown>;
    await w.t.admin((q) => q.query('delete from public.live_agent where phone_number = $1', [PHONE]));
    try {
      const r = await signed(w, voiceTurn('call_mk_1', 'Are you there?'), { id: 'whd_unpublished_turn' });
      expect(chunks(r.payload)).toEqual([{ text: 'Still here.' }]);
      const row = (await w.t.db.query("select processed_at, business_id from webhook_events where provider_event_id = 'whd_unpublished_turn'", [])).rows[0] as { processed_at: Date | null };
      expect(row.processed_at).not.toBeNull();
    } finally {
      const cols = Object.keys(live);
      await w.t.admin((q) => q.query(`insert into public.live_agent (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => live[c])));
    }
  });

  it('a flood of bad signatures is refused every time but writes a bounded number of activity rows (review F5)', async () => {
    const rejected = () => count(w, "select count(*)::int n from activity_events where type = 'webhook.rejected' and payload->>'provider' = 'agentphone'");
    const stored = () => count(w, "select count(*)::int n from webhook_events where source = 'agentphone'");
    w.clock.advance(120_000);
    const [before, storedBefore] = [await rejected(), await stored()];
    const total = REJECTED_EVENTS_PER_MINUTE + 25;
    for (let i = 0; i < total; i++) expect((await signed(w, voiceTurn('call_flood', 'hi'), { secret: 'wrong-secret' })).statusCode).toBe(401);
    expect(await rejected()).toBe(before + REJECTED_EVENTS_PER_MINUTE);
    expect(await stored()).toBe(storedBefore);
    expect(await count(w, "select count(*)::int n from calls where provider_call_id = 'call_flood'")).toBe(0);
    // A minute later a rejected delivery is recorded again.
    w.clock.advance(61_000);
    expect((await signed(w, voiceTurn('call_flood', 'hi'), { secret: 'wrong-secret' })).statusCode).toBe(401);
    expect(await rejected()).toBe(before + REJECTED_EVENTS_PER_MINUTE + 1);
  });
  it('a live version that lists a capability an agent may not hold takes no AgentPhone call; a call already on it ends as failed', async () => {
    // A call that started on the good version, before the version below is pinned.
    w.clock.advance(120_000);
    w.model.push(async () => 'Hello.');
    await signed(w, voiceTurn('call_capcheck_old', 'Hi'));
    const good = (await w.t.db.query('select agent_version_id from live_agent where phone_number = $1', [PHONE])).rows[0] as { agent_version_id: string };
    await w.t.admin(async (q) => {
      const row = (await q.query('select v.spec from public.agent_versions v where v.id = $1', [good.agent_version_id])).rows[0] as { spec: AgentSpec };
      const version = Number(((await q.query("select max(version) as v from public.agent_versions where agent_id = 'agt_pizza_01'")).rows[0] as { v: number }).v) + 1;
      await q.query("insert into public.agent_versions (id, business_id, agent_id, version, spec, published_at) values ('agv_pizza_ap_write', $1, 'agt_pizza_01', $2, $3::jsonb, now())",
        [PIZZA, version, JSON.stringify({ ...row.spec, capabilities: [...row.spec.capabilities, 'catalog.price.update'] })]);
      await q.query("update public.agents set active_version_id = 'agv_pizza_ap_write' where id = 'agt_pizza_01'");
      await q.query("update public.live_agent set agent_version_id = 'agv_pizza_ap_write' where phone_number = $1", [PHONE]);
    });
    try {
      const before = await count(w, 'select count(*)::int n from calls');
      let reached = false;
      w.model.push(async () => { reached = true; return 'ok'; });
      const r = await signed(w, voiceTurn('call_capcheck_new', 'hello'));
      expect(chunks(r.payload)).toEqual([{ text: 'Sorry, this number is not taking calls right now. Goodbye.', hangup: true }]);
      expect(r.payload).not.toContain('catalog.price.update');
      expect(reached).toBe(false);
      expect(await count(w, 'select count(*)::int n from calls')).toBe(before);
      // A call pinned to the refused version by another process: its next turn ends it as failed.
      await w.t.admin((q) => q.query("update public.calls set agent_version_id = 'agv_pizza_ap_write' where provider_call_id = 'call_capcheck_old'"));
      w.app.composed.agentphone.voice!.dispose();
      const old = await signed(w, voiceTurn('call_capcheck_old', 'Are you there?'));
      expect(chunks(old.payload)).toEqual([{ text: 'Sorry, this number is not taking calls right now. Goodbye.', hangup: true }]);
      expect(reached).toBe(false);
      expect((await w.t.db.query("select status, end_reason from calls where provider_call_id = 'call_capcheck_old'", [])).rows[0]).toEqual({ status: 'FAILED', end_reason: 'failed' });
    } finally {
      await w.t.admin(async (q) => {
        await q.query('update public.agents set active_version_id = $1 where id = \'agt_pizza_01\'', [good.agent_version_id]);
        await q.query('update public.live_agent set agent_version_id = $1 where phone_number = $2', [good.agent_version_id, PHONE]);
      });
    }
  });
});

describe('AgentPhone voice turn past its bound (review F1)', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor, telephony: { http: noHttp, interimAfterMs: 60_000, turnTimeoutMs: BOUND_MS } }, AP_ENV); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('after the bound the abandoned turn starts no tool, stores no proposal and leaves no unheard reply in the history', async () => {
    let late: unknown;
    let finished!: () => void;
    const done = new Promise<void>((r) => { finished = r; });
    w.model.push(async ({ executeTool }) => {
      await sleep(BOUND_MS + 300);
      late = await executeTool('quote_order', { cart: CART });
      finished();
      return 'A late reply nobody heard.';
    });
    const squareBefore = w.square.calls.length;
    const first = await signed(w, voiceTurn('call_late_1', 'How much is a large pepperoni?'));
    expect(chunks(first.payload)).toEqual([{ text: TROUBLE }]);
    await done;
    await sleep(20);
    expect(late).toMatchObject({ ok: false });
    expect(w.square.calls.length).toBe(squareBefore);
    let history: { role: string; text: string }[] = [];
    w.model.push(async (input) => { history = input.history; return 'Yes, I am here.'; });
    const next = await signed(w, voiceTurn('call_late_1', 'Hello?'));
    expect(chunks(next.payload)).toEqual([{ text: 'Yes, I am here.' }]);
    expect(history.map((h) => h.text)).not.toContain('A late reply nobody heard.');
  });

  it('a new turn does not start while the abandoned turn still has a tool running; it is asked to try again', async () => {
    // The quote read is slow: the first turn passes its bound with that tool call still in flight.
    const calculate = w.square.client.orders.calculate.bind(w.square.client.orders);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let inFlight = false;
    w.square.client.orders.calculate = async (req) => { inFlight = true; await gate; inFlight = false; return calculate(req); };
    let secondStartedDuringTool = false;
    let secondRan = false;
    let firstFinished!: () => void;
    const firstDone = new Promise<void>((r) => { firstFinished = r; });
    try {
      w.model.push(
        async ({ executeTool }) => { try { await executeTool('quote_order', { cart: CART }); return 'late'; } finally { firstFinished(); } },
        async () => { secondRan = true; secondStartedDuringTool = inFlight; return 'Second turn.'; },
      );
      const first = await signed(w, voiceTurn('call_late_2', 'How much is a large pepperoni?'));
      expect(chunks(first.payload)).toEqual([{ text: TROUBLE }]);
      expect(inFlight).toBe(true);
      const second = await signed(w, voiceTurn('call_late_2', 'Hello?'));
      // The call's earlier work is still running, so this turn ran nothing.
      expect(chunks(second.payload)).toEqual([{ text: TROUBLE }]);
      expect(secondRan).toBe(false);
      release();
      await firstDone;
      await sleep(20);
      const third = await signed(w, voiceTurn('call_late_2', 'Hello again?'));
      expect(chunks(third.payload)).toEqual([{ text: 'Second turn.' }]);
      expect(secondStartedDuringTool).toBe(false);
    } finally { release(); w.square.client.orders.calculate = calculate; }
  });

  it('a call that ends during a turn: the turn stores no proposal afterwards', async () => {
    let quote: Quote | undefined;
    let proposed: unknown;
    let quoted!: () => void;
    const afterQuote = new Promise<void>((r) => { quoted = r; });
    let ended!: () => void;
    const callHasEnded = new Promise<void>((r) => { ended = r; });
    let finished!: () => void;
    const done = new Promise<void>((r) => { finished = r; });
    w.model.push(async ({ executeTool }) => {
      const q = await executeTool('quote_order', { cart: CART }) as ToolResult<'quote_order'>;
      if (q.ok) quote = q.quote;
      quoted();
      await callHasEnded;
      const pickupAt = zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles');
      proposed = await executeTool('propose_order', { cart: CART, contact: { name: 'Sam', messageConsent: false }, fulfillment: { type: 'pickup', pickupAt }, quoteId: quote?.quoteId ?? 'none' });
      finished();
      return 'Sent.';
    });
    const turn = signed(w, voiceTurn('call_end_mid', 'One large pepperoni for Sam at six'));
    await afterQuote;
    expect(quote).toBeDefined();
    expect((await signed(w, callEnded('call_end_mid'))).statusCode).toBe(200);
    ended();
    await turn;
    await done;
    expect(proposed).toMatchObject({ ok: false });
    const call = (await w.t.db.query("select id, status from calls where provider_call_id = 'call_end_mid'", [])).rows[0] as { id: string; status: string };
    expect(call.status).toBe('COMPLETED');
    expect(await count(w, 'select count(*)::int n from orders where call_id = $1', [call.id])).toBe(0);
    const after = await signed(w, voiceTurn('call_end_mid', 'Hello?'));
    expect(chunks(after.payload)).toEqual([{ text: 'This call has ended. Goodbye.', hangup: true }]);
  });
});

describe('an agentphone send that times out is UNKNOWN and is never sent again (no provider idempotency key)', () => {
  let w: World;
  const posts: { url: string; body: string }[] = [];
  beforeAll(async () => {
    w = await createWorld({ executor: notWiredExecutor, telephony: { http: noHttp } }, { MESSAGE_CHANNEL: 'agentphone', AGENTPHONE_API_KEY: 'test-agentphone-key', AGENTPHONE_NUMBER_ID: 'num_e2e' });
    // The real agentphone channel over a fetch that never answers: the adapter's own timeout decides.
    const real = createMessageAdapter({ channel: 'agentphone', timeoutMs: 30, agentphone: { apiKey: 'test-agentphone-key', numberId: 'num_e2e' },
      fetch: (url, init) => { posts.push({ url, body: String(init.body) }); return new Promise<Response>(() => undefined); } });
    const fake = w.messages.adapter as { channel: string; send: typeof real.send };
    fake.channel = 'agentphone';
    fake.send = (input) => { w.messages.sent.push(input); return real.send(input); };
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('one POST, dispatch UNKNOWN, step NEEDS_REVIEW; a second worker, another pass and the owner retry do not send again', async () => {
    let quote: Quote | undefined;
    w.model.push(async ({ executeTool }) => { const r = await executeTool('quote_order', { cart: CART }) as ToolResult<'quote_order'>; if (r.ok) quote = r.quote; return 'quoted'; });
    const first = (await w.app.inject({ method: 'POST', url: `/api/agents/agt_pizza_01/sim-call?businessId=${PIZZA}`, headers: OWNER, payload: { message: 'One large pepperoni' } })).json() as { callId: string };
    const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [first.callId])).rows[0] as { agent_version_id: string };
    const c = w.app.composed;
    const { approval } = await c.engine.createOrderProposal({ businessId: PIZZA, callId: first.callId, agentVersionId: call.agent_version_id, cart: CART, quote: quote!,
      contact: { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: new Date().toISOString() },
      fulfillment: { type: 'pickup', pickupAt: zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles') }, messageChannel: 'agentphone' });
    // Rule 1: nothing is sent before the owner approves.
    expect(posts).toHaveLength(0);
    const list = ENDPOINTS.listApprovals.response.parse((await w.app.inject({ url: `/api/approvals?businessId=${PIZZA}`, headers: OWNER })).json());
    const a = list.items.find((x) => x.id === approval.id)!;
    expect((await w.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash: a.payloadHash } })).statusCode).toBe(200);

    const worker = (workerId: string) => createDbExecutor({ env: c.env, db: c.db, engine: c.engine, providers: c.providers, now: c.now, newId: c.newId, log: silentLog }, { workerId });
    const one = worker('worker-ap-1');
    try { await one.drain(); } finally { await one.stop(); }

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://api.agentphone.ai/v1/messages');
    expect(JSON.parse(posts[0]!.body)).toMatchObject({ to_number: '+15555550123', number_id: 'num_e2e' });
    const dispatch = async () => (await w.t.db.query('select status, channel, provider_message_id from message_dispatches where approval_id = $1', [approval.id])).rows;
    expect(await dispatch()).toEqual([{ status: 'UNKNOWN', channel: 'agentphone', provider_message_id: null }]);
    const step = async () => (await w.t.db.query("select id, status, attempts from action_executions where approval_id = $1 and action_type = 'message.checkout.send'", [approval.id])).rows[0] as { id: string; status: string; attempts: number };
    const stepBefore = await step();
    expect(stepBefore.status).toBe('NEEDS_REVIEW');
    // The order was not marked as messaged, and it keeps its link for the counter.
    const order = (await w.t.db.query('select o.status, o.checkout_url from orders o join approval_requests a on a.subject_id = o.id where a.id = $1', [approval.id])).rows[0] as { status: string; checkout_url: string };
    expect(order.status).toBe('PAYMENT_PENDING');
    expect(order.checkout_url).toBeTruthy();

    // 1. Another worker and another pass find nothing to send.
    const two = worker('worker-ap-2');
    try { await two.drain(); await two.drain(); } finally { await two.stop(); }
    expect(posts).toHaveLength(1);

    // 2. The owner's "retry" on the reviewed step continues the bundle; it never resends the text.
    const retry = await w.app.inject({ method: 'POST', url: `/api/executions/${stepBefore.id}/resolve?businessId=${PIZZA}`, headers: OWNER, payload: { action: 'retry' } });
    expect([200, 409]).toContain(retry.statusCode);
    const three = worker('worker-ap-3');
    try { await three.drain(); } finally { await three.stop(); }
    expect(posts).toHaveLength(1);
    expect(w.messages.sent).toHaveLength(1);
    expect((await dispatch())[0]).toMatchObject({ channel: 'agentphone' });
    expect(['UNKNOWN', 'FAILED']).toContain(((await dispatch())[0] as { status: string }).status);

    // 3. The status poll never touches a dispatch that has no provider message ID.
    expect(await c.agentphone.pollReceipts()).toEqual({ checked: 0, applied: 0, deferred: 0 });
  });
});
