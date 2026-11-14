// Issue #95 item 6: every call that is started ends with call.ended. These run the voice plugin's real
// database ports (the calls table as abos_app, live_agent, the activity feed) through the composed app.
// Twilio is the signed webhook only; no stream and no model is opened.
import Fastify, { type FastifyInstance } from 'fastify';
import twilio from 'twilio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbLiveAgentPort } from '../../src/compose/ports';
import { voicePlugin } from '../../src/voice/plugin';
import { OWNER, PHONE, PUBLIC_URL, createWorld, type World } from './world';

const PIZZA = 'biz_pizza_01';
const AGENT = 'agt_pizza_01';
const AUTH_TOKEN = 'test-twilio-token';
const VOICE_ENV = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_ACCOUNT_SID: 'ACtest', OPENAI_API_KEY: 'test-openai-key' };
const form = (params: Record<string, string>) => new URLSearchParams(params).toString();

describe('every started call ends with call.ended', () => {
  let w: World;
  let short: FastifyInstance | undefined;
  beforeAll(async () => { w = await createWorld({}, VOICE_ENV); }, 120_000);
  afterAll(async () => { await short?.close(); await w?.close(); });

  const callRow = async (sid: string) => (await w.t.db.query('select id, status, end_reason, ended_at is not null as ended, agent_id, agent_version_id, channel from calls where provider_call_id = $1', [sid])).rows[0] as
    { id: string; status: string; end_reason: string | null; ended: boolean; agent_id: string; agent_version_id: string; channel: string } | undefined;
  const eventsOf = async (callId: string) => (await w.t.db.query("select type, payload from activity_events where correlation_id = $1 and type in ('call.started','call.ended') order by occurred_at, id", [callId])).rows as { type: string; payload: Record<string, unknown> }[];
  const ring = (app: FastifyInstance, sid: string) => {
    const params = { CallSid: sid, To: PHONE, From: '+15555550142', CallStatus: 'ringing' };
    return app.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_URL}/webhooks/twilio/voice`, params) }, payload: form(params) });
  };

  it('a credential that is never used: the call row ends DROPPED with call.ended', async () => {
    const voice = w.app.composed.voice;
    if (!voice.ok) throw new Error('phone voice is off in this world');
    // The composed voice options, with a short credential life so the test does not wait a minute.
    short = Fastify();
    await short.register(voicePlugin, { ...voice.options, tokenTtlMs: 60 });
    await short.ready();
    const res = await ring(short, 'CA_e2e_unused');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('<Stream');
    expect(await callRow('CA_e2e_unused')).toMatchObject({ status: 'IN_PROGRESS', ended: false });
    await vi.waitFor(async () => expect(await callRow('CA_e2e_unused')).toMatchObject({ status: 'DROPPED', end_reason: 'dropped', ended: true }), { timeout: 5000, interval: 50 });
    const row = (await callRow('CA_e2e_unused'))!;
    const events = await eventsOf(row.id);
    expect(events.map((e) => e.type)).toEqual(['call.started', 'call.ended']);
    expect(events[1]!.payload).toMatchObject({ callId: row.id, status: 'DROPPED', reason: 'dropped' });
    // An ended call cannot be proposed on (the engine requires IN_PROGRESS), and its end is written once.
    await new Promise((r) => setTimeout(r, 150));
    expect(await eventsOf(row.id)).toHaveLength(2);
  });

  it('a paused agent: the caller hears the closed message and the call is recorded started then ended completed', async () => {
    const pause = await w.app.inject({ method: 'POST', url: `/api/agents/${AGENT}/pause?businessId=${PIZZA}`, headers: OWNER, payload: {} });
    expect(pause.statusCode, pause.body).toBe(200);
    const version = ((await w.t.db.query('select agent_version_id from live_agent where phone_number = $1', [PHONE])).rows[0] as { agent_version_id: string }).agent_version_id;
    expect(await dbLiveAgentPort(w.t.db).resolve(PHONE)).toEqual({ state: 'paused', businessId: PIZZA, agentId: AGENT, agentVersionId: version });

    const res = await ring(w.app, 'CA_e2e_paused');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('<Say>Sorry, this line is not taking calls right now.');
    expect(res.body).not.toContain('<Stream');
    const row = await callRow('CA_e2e_paused');
    expect(row).toMatchObject({ status: 'COMPLETED', end_reason: 'completed', ended: true, agent_id: AGENT, agent_version_id: version, channel: 'phone' });
    // Both events are written in the same instant here, so their order by time is not fixed.
    const events = await eventsOf(row!.id);
    expect(events.map((e) => e.type).sort()).toEqual(['call.ended', 'call.started']);
    const started = events.find((e) => e.type === 'call.started');
    const ended = events.find((e) => e.type === 'call.ended');
    expect(started!.payload).toMatchObject({ callId: row!.id, agentId: AGENT, agentVersionId: version, channel: 'phone', callerLast4: '0142' });
    expect(ended!.payload).toMatchObject({ callId: row!.id, status: 'COMPLETED', reason: 'completed' });
    // The calls list shows it as ended, and nothing was proposed or sent.
    const list = await w.app.inject({ url: `/api/calls/${row!.id}?businessId=${PIZZA}`, headers: OWNER });
    expect(list.json()).toMatchObject({ id: row!.id, status: 'COMPLETED' });
    expect((await w.t.db.query('select count(*)::int as n from orders where call_id = $1', [row!.id])).rows[0]).toEqual({ n: 0 });
    expect(w.squareWrites).toEqual([]);
    expect(w.messageSends).toBe(0);
  });

  it('no call is left IN_PROGRESS by these paths', async () => {
    expect((await w.t.db.query("select provider_call_id from calls where status = 'IN_PROGRESS' and channel = 'phone'")).rows).toEqual([]);
  });
});
