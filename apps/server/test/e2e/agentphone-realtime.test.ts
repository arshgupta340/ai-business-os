// D-12: AgentPhone calls on the realtime turn engine (AGENTPHONE_TURN_ENGINE=realtime, the default), through
// the composed app on the in-process Postgres with the real toolset and approval engine. The OpenAI Realtime
// socket is a fake (test/telephony/fake-realtime.ts) and AgentPhone is never called: webhooks are signed
// here with a test secret, as in agentphone.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Cart } from '@abos/contracts';
import { notWiredExecutor, type SeamDeps } from '../../src/compose/seams';
import type { HttpPort } from '../../src/telephony/agentphone/client';
import { agentPhoneSignature } from '../../src/telephony/agentphone/signature';
import { afterProposalLine } from '../../src/telephony/agentphone/speech';
import { fakeRealtime, type FakeRealtime } from '../telephony/fake-realtime';
import { PHONE, createWorld, nextLocalDate, zonedIso, type World } from './world';

/** Test-only webhook secret. Not a credential. */
const SECRET = 'whsec_e2e_test_only';
const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };
const AP_ENV = { TELEPHONY_PROVIDER: 'agentphone', AGENTPHONE_API_KEY: 'test-agentphone-key', AGENTPHONE_WEBHOOK_SECRET: SECRET,
  AGENTPHONE_NUMBER_ID: 'num_e2e', AGENTPHONE_PHONE_NUMBER: PHONE };
const GREETING = 'Thanks for calling Demo Pizza Co. This is an AI assistant. What can I get you?';
const LEAD = 'Thanks for calling Demo Pizza Co. This is an AI assistant.';

type Line = { level: string; data: Record<string, unknown>; msg: string };
function capturingLog(lines: Line[]): SeamDeps['log'] {
  const at = (level: string) => (data: Record<string, unknown>, msg: string) => { lines.push({ level, data, msg }); };
  return { info: at('info'), warn: at('warn'), error: at('error') } as SeamDeps['log'];
}

const http: HttpPort = async () => ({ status: 404, json: async () => ({}) });

function signed(w: World, body: unknown, opts: { id?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(w.clock.now().getTime() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-id': opts.id ?? `whd_${Math.random().toString(36).slice(2)}`,
    'x-webhook-event': String((body as { event?: string }).event ?? ''), 'x-webhook-signature': agentPhoneSignature(SECRET, ts, Buffer.from(raw)) };
  return w.app.inject({ method: 'POST', url: '/webhooks/agentphone', headers, payload: raw });
}
const voiceTurn = (callId: string, transcript: string) => ({ event: 'agent.message', channel: 'voice', timestamp: new Date().toISOString(), agentId: 'agt_ap',
  data: { callId, numberId: 'num_e2e', from: '+15559876543', to: PHONE, status: 'in-progress', transcript, confidence: 0.95, direction: 'inbound' }, conversationState: null, recentHistory: [] });
const callEnded = (callId: string) => ({ event: 'agent.call_ended', channel: 'voice', timestamp: new Date().toISOString(), agentId: 'agt_ap',
  data: { callId, numberId: 'num_e2e', from: '+15559876543', to: PHONE, status: 'completed' } });
const chunks = (payload: string) => payload.trim().split('\n').map((l) => JSON.parse(l) as { text: string; interim?: boolean; hangup?: boolean });
const finalChunk = (payload: string) => chunks(payload).filter((c) => !c.interim).at(-1)!;

describe('AgentPhone on the realtime turn engine', () => {
  let w: World;
  let fake: FakeRealtime;
  const lines: Line[] = [];
  beforeAll(async () => {
    fake = fakeRealtime();
    w = await createWorld({ executor: notWiredExecutor, log: capturingLog(lines), telephony: { http, interimAfterMs: 60_000, openaiSocketFactory: fake.factory } }, AP_ENV);
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('orders a pizza in a few turns: greeting first, one approval, the closing line with hangup, and no external write', async () => {
    const pickupAt = zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles');
    fake.push(
      () => ({ text: 'We close at ten tonight.' }),
      () => ({ text: 'A large pepperoni is fifteen dollars.' }),
      () => ({ calls: [{ name: 'quote_order', args: { cart: CART } }] }),
      () => ({ text: 'One large pepperoni for Sam at six. Shall I send this to the shop for approval?' }),
      ({ outputs }) => ({ calls: [{ name: 'propose_order', args: { cart: CART, contact: { name: 'Sam', messageConsent: false }, fulfillment: { type: 'pickup', pickupAt },
        quoteId: (outputs.at(-1)!.quote as { quoteId: string }).quoteId } }] }),
      () => ({ text: 'Done.' }),
    );
    const t1 = await signed(w, voiceTurn('call_rt_1', 'What time do you close tonight?'));
    expect(t1.statusCode).toBe(200);
    // The first event of the call carried a request: the shop name and the AI disclosure, then the answer.
    expect(finalChunk(t1.payload)).toEqual({ text: `${LEAD} We close at ten tonight.` });
    expect(w.app.composed.agentphone.voice!.engineOf('call_rt_1')).toBe('realtime');
    // One session, opened with the phone prompt, the shop data and this channel's lines.
    const session = fake.session()!.session as { instructions: string; output_modalities: string[] };
    expect(session.output_modalities).toEqual(['text']);
    expect(session.instructions).toContain('Shop data, pinned when this call started');
    expect(session.instructions).toContain(`The call was already opened for you with this greeting: "${GREETING}"`);
    expect(session.instructions).toContain('Never write a dollar sign');

    const t2 = await signed(w, voiceTurn('call_rt_1', 'How much is a large pepperoni?'));
    expect(finalChunk(t2.payload)).toEqual({ text: 'A large pepperoni is fifteen dollars.' });
    const t3 = await signed(w, voiceTurn('call_rt_1', 'One large pepperoni for Sam, pickup at six.'));
    expect(finalChunk(t3.payload).text).toContain('Shall I send this to the shop for approval?');
    const t4 = await signed(w, voiceTurn('call_rt_1', 'Yes.'));
    expect(finalChunk(t4.payload)).toEqual({
      text: 'Thanks, Sam. Your order is with the shop for approval. The payment link will be shown to you at the counter. Your order is not placed until you pay on that link. Thanks for calling Demo Pizza Co. Goodbye.',
      hangup: true,
    });
    expect(fake.sockets).toBe(1);

    const call = (await w.t.db.query("select id, stage, status from calls where provider_call_id = 'call_rt_1'", [])).rows[0] as Record<string, unknown>;
    expect(call).toMatchObject({ stage: 'CUSTOMER_CONFIRMED', status: 'IN_PROGRESS' });
    const approvals = (await w.t.db.query('select a.state from approval_requests a join orders o on o.id = a.subject_id where o.call_id = $1', [call.id])).rows;
    expect(approvals).toEqual([{ state: 'PENDING' }]);
    // Rule 1: nothing was sent to any provider before the owner approves.
    expect(w.squareWrites).toEqual([]);
    expect(w.calendarWrites).toEqual([]);
    expect(w.messageSends).toBe(0);

    // A later turn (the hangup did not land): one short line and hangup, and the model is not asked.
    const asked = fake.userTexts.length;
    const t5 = await signed(w, voiceTurn('call_rt_1', 'Hello? Are you there?'));
    expect(finalChunk(t5.payload)).toEqual({ text: afterProposalLine('restaurant_order_taker'), hangup: true });
    expect(fake.userTexts.length).toBe(asked);

    // One line per turn with the engine, the time and the tool count; never the words or a number.
    const turnLines = lines.filter((l) => l.msg === 'agentphone: turn' && l.data.callId === call.id);
    expect(turnLines.map((l) => [l.data.engine, l.data.toolCalls])).toEqual([['realtime', 0], ['realtime', 0], ['realtime', 1], ['realtime', 1]]);
    for (const l of turnLines) expect(typeof l.data.turnMs).toBe('number');
    // The call end closes the session and logs the turn times.
    await signed(w, callEnded('call_rt_1'));
    expect(w.app.composed.agentphone.voice!.engineOf('call_rt_1')).toBeUndefined();
    const end = lines.find((l) => l.msg === 'agentphone: call ended' && l.data.callId === call.id);
    expect(end?.data).toMatchObject({ engine: 'realtime', turns: 4, toolCalls: 2, fallbackTurns: 0 });
    const all = JSON.stringify(lines);
    expect(all).not.toMatch(/pepperoni|close tonight|\+1555|Sam|fifteen dollars/);
  });

  it('a call whose first event has no words hears the greeting alone, and the next reply does not greet again', async () => {
    fake.push(() => ({ text: 'Sure, what size?' }));
    const first = await signed(w, voiceTurn('call_rt_2', ''));
    expect(finalChunk(first.payload)).toEqual({ text: GREETING });
    const second = await signed(w, voiceTurn('call_rt_2', 'I want a pizza.'));
    expect(finalChunk(second.payload)).toEqual({ text: 'Sure, what size?' });
    // A second empty turn is not a second greeting.
    const third = await signed(w, voiceTurn('call_rt_2', ''));
    expect(finalChunk(third.payload).text).toBe('Sorry, I did not catch that. Could you say it again?');
  });

  it('a caller who only says hello hears the greeting alone, with no model turn, and the next reply does not greet again', async () => {
    const before = fake.userTexts.length;
    for (const [id, hello] of [['call_rt_h1', 'Hello?'], ['call_rt_h2', 'Hi, is anyone there?'], ['call_rt_h3', 'Hello. Hello?']] as const) {
      const first = await signed(w, voiceTurn(id, hello));
      expect(chunks(first.payload)).toEqual([{ text: GREETING }]);
    }
    expect(fake.userTexts.length).toBe(before);
    fake.push(() => ({ text: 'Sure, what size?' }));
    const second = await signed(w, voiceTurn('call_rt_h1', 'Hello, I want a pizza.'));
    expect(finalChunk(second.payload)).toEqual({ text: 'Sure, what size?' });
    expect(fake.userTexts.slice(before)).toEqual(['Hello, I want a pizza.']);
  });

  it('a repeated delivery of a turn runs once and hears the same reply', async () => {
    fake.push(() => ({ text: 'Hello there.' }));
    const before = fake.userTexts.length;
    const a = await signed(w, voiceTurn('call_rt_3', 'Do you have pizza?'), { id: 'whd_rt_retry' });
    const b = await signed(w, voiceTurn('call_rt_3', 'Do you have pizza?'), { id: 'whd_rt_retry' });
    expect(finalChunk(a.payload)).toEqual({ text: `${LEAD} Hello there.` });
    expect(finalChunk(b.payload)).toEqual(finalChunk(a.payload));
    expect(fake.userTexts.length).toBe(before + 1);
  });

  it('two turns of one call sent at once run one after the other', async () => {
    fake.push(() => ({ text: 'Answer one.' }), () => ({ text: 'Answer two.' }));
    await signed(w, voiceTurn('call_rt_4', '')); // greeting
    const start = fake.userTexts.length;
    const [a, b] = await Promise.all([signed(w, voiceTurn('call_rt_4', 'first question')), signed(w, voiceTurn('call_rt_4', 'second question'))]);
    expect([finalChunk(a.payload).text, finalChunk(b.payload).text]).toEqual(['Answer one.', 'Answer two.']);
    expect(fake.userTexts.slice(start)).toEqual(['first question', 'second question']);
  });

  it('an answer with no words is asked for once more, and only once', async () => {
    fake.push(() => ({ text: '' }), () => ({ text: 'Anything else?' }));
    await signed(w, voiceTurn('call_rt_e', '')); // greeting
    const again = await signed(w, voiceTurn('call_rt_e', 'One large pepperoni.'));
    expect(finalChunk(again.payload)).toEqual({ text: 'Anything else?' });
    fake.push(() => ({ text: '' }), () => ({ text: '' }));
    const nothing = await signed(w, voiceTurn('call_rt_e', 'No.'));
    expect(finalChunk(nothing.payload).text).toBe('Sorry, I did not catch that. Could you say it again?');
  });

  it('a session error mid-call falls back to the builder runner for that call, and the log names the engine', async () => {
    fake.push(() => ({ text: 'Hi, what can I get you?' }), () => 'error');
    await signed(w, voiceTurn('call_rt_5', 'Do you sell pizza?'));
    let instructions = '';
    w.model.push(async ({ instructions: i }) => { instructions = i; return 'We close at ten.'; }, async () => 'Anything else?');
    const failed = await signed(w, voiceTurn('call_rt_5', 'When do you close?'));
    expect(finalChunk(failed.payload)).toEqual({ text: 'We close at ten.' });
    expect(w.app.composed.agentphone.voice!.engineOf('call_rt_5')).toBe('builder');
    expect(instructions).toContain('The call was already opened for you with this greeting');
    const next = await signed(w, voiceTurn('call_rt_5', 'No thanks.'));
    expect(finalChunk(next.payload)).toEqual({ text: 'Anything else?' });
    const call = (await w.t.db.query("select id from calls where provider_call_id = 'call_rt_5'", [])).rows[0] as { id: string };
    const engines = lines.filter((l) => l.msg === 'agentphone: turn' && l.data.callId === call.id).map((l) => l.data.engine);
    expect(engines).toEqual(['realtime', 'builder', 'builder']);
    expect(lines.some((l) => l.msg.startsWith('agentphone: realtime turn failed') && l.data.callId === call.id)).toBe(true);
  });
});

describe('AgentPhone realtime engine: session cannot open, idle close, and begin_message', () => {
  it('a session that cannot open sends the call to the builder runner from the first turn', async () => {
    const broken = fakeRealtime({ refuseOpen: true });
    const w = await createWorld({ executor: notWiredExecutor, telephony: { http, interimAfterMs: 60_000, openaiSocketFactory: broken.factory } }, AP_ENV);
    try {
      w.model.push(async () => 'Hello from the builder.');
      const r = await signed(w, voiceTurn('call_rt_open', 'Do you deliver?'));
      expect(finalChunk(r.payload)).toEqual({ text: `${LEAD} Hello from the builder.` });
      expect(w.app.composed.agentphone.voice!.engineOf('call_rt_open')).toBe('builder');
    } finally { await w.close(); }
  }, 120_000);

  it('the session closes after the idle limit; with begin_message no greeting is added by the server', async () => {
    const fake = fakeRealtime();
    const w = await createWorld({ executor: notWiredExecutor, telephony: { http, interimAfterMs: 60_000, openaiSocketFactory: fake.factory, realtimeLimits: { idleMs: 30 } } },
      { ...AP_ENV, AGENTPHONE_GREETING_MODE: 'begin_message' });
    try {
      fake.push(() => ({ text: 'Hi, what can I get you?' }));
      const r = await signed(w, voiceTurn('call_rt_idle', 'Hello'));
      expect(finalChunk(r.payload)).toEqual({ text: 'Hi, what can I get you?' });
      await new Promise((res) => setTimeout(res, 80));
      // The idle session is gone: the next turn is answered by the builder runner.
      w.model.push(async () => 'Still here.');
      const later = await signed(w, voiceTurn('call_rt_idle', 'Are you there?'));
      expect(finalChunk(later.payload)).toEqual({ text: 'Still here.' });
      expect(w.app.composed.agentphone.voice!.engineOf('call_rt_idle')).toBe('builder');
    } finally { await w.close(); }
  }, 120_000);
});
