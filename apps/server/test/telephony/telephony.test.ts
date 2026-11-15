// D-12 unit tests with fakes only: the AgentPhone signature, event parsing, the agentphone message channel,
// the telephony switch, health under each provider and the thin Twilio wrapper. No network.
import { createHmac } from 'node:crypto';
import twilio from 'twilio';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_ENDPOINTS } from '@abos/contracts';
import { createMessageAdapter, sendOnce, type DispatchAttempt, type DispatchOutcome, type DispatchRecord, type MessageStore } from '../../src/adapters/message/index';
import { buildApp } from '../../src/app';
import { createHealthMonitor } from '../../src/compose/health';
import { buildProviders } from '../../src/compose/providers';
import { parseEnv } from '../../src/env';
import { createAgentPhoneClient, type HttpPort } from '../../src/telephony/agentphone/client';
import { parseAgentPhoneEvent } from '../../src/telephony/agentphone/events';
import { formatTurnChunks } from '../../src/telephony/agentphone/plugin';
import { agentPhoneSignature, verifyAgentPhoneSignature } from '../../src/telephony/agentphone/signature';
import { buildTelephony, createAgentPhoneProvider, createTwilioProvider } from '../../src/telephony/index';
import { createTwilioRequestValidator } from '../../src/voice/plugin';

const SECRET = 'whsec_unit_test_only';
const NOW_MS = Date.UTC(2026, 10, 14, 12, 0, 0);
const TS = String(Math.floor(NOW_MS / 1000));
const KEY = 'ab'.repeat(32);
const now = () => new Date(NOW_MS);
const noHttp: HttpPort = async () => { throw new Error('no network in tests'); };

function headers(body: Buffer, over: Record<string, string | undefined> = {}) {
  return { 'x-webhook-signature': agentPhoneSignature(SECRET, TS, body), 'x-webhook-timestamp': TS, 'x-webhook-id': 'whd_1', ...over };
}

describe('AgentPhone signature (docs: HMAC-SHA256 over "{timestamp}." + raw body, sha256=<hex>)', () => {
  const body = Buffer.from('{"event":"agent.message"}');
  it('matches the documented construction', () => {
    const expected = `sha256=${createHmac('sha256', SECRET).update(`${TS}.${body.toString('utf8')}`).digest('hex')}`;
    expect(agentPhoneSignature(SECRET, TS, body)).toBe(expected);
  });
  it('accepts a good signature and returns the delivery ID', () => {
    expect(verifyAgentPhoneSignature({ rawBody: body, headers: headers(body), secret: SECRET, nowMs: NOW_MS }))
      .toEqual({ ok: true, deliveryId: 'whd_1', replayKey: expect.stringMatching(/^signature\/[0-9a-f]{64}$/) });
  });
  it('names the signed content with a replay key that ignores the unsigned delivery ID (review F2)', () => {
    const key = (h: Record<string, string | undefined>, raw = body) => {
      const r = verifyAgentPhoneSignature({ rawBody: raw, headers: h, secret: SECRET, nowMs: NOW_MS });
      return r.ok ? r.replayKey : undefined;
    };
    const original = key(headers(body));
    // The same signed bytes under another delivery ID are the same content.
    expect(key(headers(body, { 'x-webhook-id': 'whd_other' }))).toBe(original);
    // Another timestamp or another body is other content.
    const later = String(Number(TS) + 5);
    expect(key({ 'x-webhook-signature': agentPhoneSignature(SECRET, later, body), 'x-webhook-timestamp': later, 'x-webhook-id': 'whd_1' })).not.toBe(original);
    const other = Buffer.from('{"event":"agent.call_ended"}');
    expect(key(headers(other), other)).not.toBe(original);
    // It is not the signature itself, cannot be mistaken for a delivery ID, and an unverified request has none.
    expect(original).not.toContain(agentPhoneSignature(SECRET, TS, body).slice(7));
    expect(original).toContain('/');
    expect(key(headers(body, { 'x-webhook-signature': 'sha256=00' }))).toBeUndefined();
  });
  it('refuses a bad signature, a changed body, a missing header or secret, and a stale or future timestamp', () => {
    const v = (h: Record<string, string | undefined>, raw = body, secret: string | undefined = SECRET, nowMs = NOW_MS) => verifyAgentPhoneSignature({ rawBody: raw, headers: h, secret, nowMs });
    expect(v(headers(body, { 'x-webhook-signature': agentPhoneSignature('other', TS, body) }))).toEqual({ ok: false, reason: 'mismatch' });
    expect(v(headers(body), Buffer.from('{"event":"agent.message" }'))).toEqual({ ok: false, reason: 'mismatch' });
    expect(v(headers(body, { 'x-webhook-signature': 'sha256=abc' }))).toEqual({ ok: false, reason: 'mismatch' });
    expect(v(headers(body, { 'x-webhook-signature': undefined }))).toEqual({ ok: false, reason: 'missing' });
    expect(v(headers(body, { 'x-webhook-id': undefined }))).toEqual({ ok: false, reason: 'missing' });
    // A header this build cannot read has its own reason, so the server log tells it from a wrong secret.
    expect(v(headers(body, { 'x-webhook-timestamp': 'yesterday' }))).toEqual({ ok: false, reason: 'timestamp_format' });
    expect(v(headers(body, { 'x-webhook-id': 'id with spaces' }))).toEqual({ ok: false, reason: 'id_format' });
    expect(v(headers(body, { 'x-webhook-id': 'a/b' }))).toEqual({ ok: false, reason: 'id_format' });
    expect(v(headers(body), body, '')).toEqual({ ok: false, reason: 'missing' });
    // A replay of a correctly signed delivery outside the 5 minute window.
    expect(v(headers(body), body, SECRET, NOW_MS + 301_000)).toEqual({ ok: false, reason: 'stale' });
    expect(v(headers(body), body, SECRET, NOW_MS - 301_000)).toEqual({ ok: false, reason: 'stale' });
    expect(v(headers(body), body, SECRET, NOW_MS + 299_000)).toMatchObject({ ok: true });
  });
});

describe('AgentPhone events to provider-neutral events', () => {
  const parse = (o: unknown) => parseAgentPhoneEvent(Buffer.from(JSON.stringify(o)));
  it('a voice agent.message is a call turn with the dialed number and only the caller last four', () => {
    expect(parse({ event: 'agent.message', channel: 'voice', data: { callId: 'call_1', from: '+15559876543', to: '+15551234567', transcript: 'hi' } })).toEqual({
      eventType: 'agent.message', test: false, event: { kind: 'incoming_call', providerCallId: 'call_1', to: '+15551234567', callerLast4: '6543', text: 'hi' } });
  });
  it('an sms agent.message is an incoming text without its body', () => {
    const r = parse({ event: 'agent.message', channel: 'sms', data: { messageId: 'msg_1', to: '+15551234567', from: '+15559876543', message: 'body text' } });
    expect(r).toEqual({ eventType: 'agent.message', test: false, event: { kind: 'incoming_text', providerMessageId: 'msg_1', to: '+15551234567' } });
    expect(JSON.stringify(r)).not.toContain('body text');
  });
  it('agent.call_ended maps the status to an end reason', () => {
    const ended = (status?: string) => parse({ event: 'agent.call_ended', channel: 'voice', data: { callId: 'call_1', ...(status ? { status } : {}) } })?.event;
    expect(ended('completed')).toEqual({ kind: 'call_status', providerCallId: 'call_1', reason: 'completed' });
    expect(ended('failed')).toEqual({ kind: 'call_status', providerCallId: 'call_1', reason: 'failed' });
    expect(ended()).toEqual({ kind: 'call_status', providerCallId: 'call_1', reason: 'dropped' });
  });
  it('unknown and unused event types are ignored safely; test deliveries are flagged', () => {
    for (const event of ['agent.reaction', 'agent.contact_shared', 'number.released', 'something.new']) expect(parse({ event, data: {} })?.event).toEqual({ kind: 'ignored', eventType: event });
    expect(parse({ event: 'agent.reaction', test: true, data: {} })?.test).toBe(true);
  });
  it('malformed bodies are refused', () => {
    expect(parseAgentPhoneEvent(Buffer.from('not json'))).toBeUndefined();
    expect(parse({ data: {} })).toBeUndefined();
    expect(parse({ event: 'agent.message', channel: 'voice', data: { callId: 'call_1', to: 'not-e164' } })).toBeUndefined();
    expect(parse({ event: 'agent.message', channel: 'voice', data: { callId: 'bad id with spaces', to: '+15551234567' } })).toBeUndefined();
  });
  it('a turn reply is one JSON object per line with the documented fields', () => {
    expect(formatTurnChunks([{ text: 'One moment.', interim: true }, { text: 'Bye.', hangup: true }])).toBe('{"text":"One moment.","interim":true}\n{"text":"Bye.","hangup":true}\n');
  });
});

describe('the agentphone message channel', () => {
  type Call = { url: string; init: RequestInit };
  const fetchWith = (status: number, json: unknown, calls: Call[]) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(json), { status }); };
  const memoryStore = () => {
    const rows = new Map<string, DispatchRecord>();
    const store: MessageStore = {
      async findByKey(key) { return rows.get(key); },
      async recordAttempt(a: DispatchAttempt) { if (rows.has(a.idempotencyKey)) return false; rows.set(a.idempotencyKey, { idempotencyKey: a.idempotencyKey, channel: a.channel, status: 'QUEUED' }); return true; },
      async recordOutcome(key, o: DispatchOutcome) { const r = rows.get(key)!; rows.set(key, { ...r, status: o.status, providerMessageId: o.providerMessageId, errorCode: o.errorCode }); },
    };
    return { store, rows };
  };

  it('sends once per dispatch key with to_number, body and number_id, and a repeat with the same key does not send', async () => {
    const calls: Call[] = [];
    const adapter = createMessageAdapter({ channel: 'agentphone', fetch: fetchWith(200, { id: 'msg_ap_1', status: 'sent', channel: 'sms' }, calls), agentphone: { apiKey: 'k', numberId: 'num_1' } });
    const { store } = memoryStore();
    const first = await sendOnce(store, adapter, { dispatchKey: KEY, to: '+15555550123', body: 'Your link' });
    const again = await sendOnce(store, adapter, { dispatchKey: KEY, to: '+15555550123', body: 'Your link' });
    expect(first).toMatchObject({ status: 'SENT', providerMessageId: 'msg_ap_1', needsReview: false });
    expect(again).toMatchObject({ status: 'SENT', providerMessageId: 'msg_ap_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.agentphone.ai/v1/messages');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ to_number: '+15555550123', body: 'Your link', number_id: 'num_1' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('passes the caller-supplied key through unchanged and makes exactly one request per send', async () => {
    const calls: Call[] = [];
    const adapter = createMessageAdapter({ channel: 'agentphone', fetch: fetchWith(200, { id: 'msg_ap_2', status: 'sent' }, calls), agentphone: { apiKey: 'k', numberId: 'num_1' } });
    const seen: string[] = [];
    const spy = { channel: adapter.channel, send: (input: Parameters<typeof adapter.send>[0]) => { seen.push(input.idempotencyKey); return adapter.send(input); } };
    await sendOnce(memoryStore().store, spy, { dispatchKey: KEY, to: '+15555550123', body: 'x' });
    expect(seen).toEqual([KEY]);
    expect(calls).toHaveLength(1);
  });

  it('an ambiguous outcome is UNKNOWN and never resent; a refusal is FAILED', async () => {
    for (const [status, expected] of [[500, 'UNKNOWN'], [503, 'UNKNOWN'], [409, 'UNKNOWN'], [408, 'UNKNOWN'], [403, 'FAILED'], [402, 'FAILED'], [422, 'FAILED']] as const) {
      const calls: Call[] = [];
      const adapter = createMessageAdapter({ channel: 'agentphone', fetch: fetchWith(status, { error: { code: 'X' } }, calls), agentphone: { apiKey: 'k', numberId: 'num_1' } });
      const { store, rows } = memoryStore();
      expect((await sendOnce(store, adapter, { dispatchKey: KEY, to: '+15555550123', body: 'x' })).status, String(status)).toBe(expected);
      await sendOnce(store, adapter, { dispatchKey: KEY, to: '+15555550123', body: 'x' });
      expect(calls).toHaveLength(1);
      expect(rows.get(KEY)!.status).toBe(expected);
    }
    const hang = createMessageAdapter({ channel: 'agentphone', timeoutMs: 5, fetch: () => new Promise(() => undefined), agentphone: { apiKey: 'k', numberId: 'num_1' } });
    expect(await hang.send({ to: '+15555550123', body: 'x', idempotencyKey: KEY })).toEqual({ status: 'UNKNOWN', errorCode: 'INTEGRATION_UNAVAILABLE' });
    const odd = createMessageAdapter({ channel: 'agentphone', fetch: fetchWith(200, { id: 'm', status: 'mystery' }, []), agentphone: { apiKey: 'k', numberId: 'num_1' } });
    expect((await odd.send({ to: '+15555550123', body: 'x', idempotencyKey: KEY })).status).toBe('UNKNOWN');
  });

  it('names a missing setting without its value', () => {
    expect(() => createMessageAdapter({ channel: 'agentphone', fetch: fetchWith(200, {}, []), agentphone: { numberId: 'n' } })).toThrow('Missing setting: AGENTPHONE_API_KEY');
    expect(() => createMessageAdapter({ channel: 'agentphone', fetch: fetchWith(200, {}, []), agentphone: { apiKey: 'k' } })).toThrow('Missing setting: AGENTPHONE_NUMBER_ID');
    const p = buildProviders(parseEnv({ MESSAGE_CHANNEL: 'agentphone', AGENTPHONE_API_KEY: 'k' }), now);
    expect(p.message).toBeUndefined();
    expect(p.status.message_channel).toMatchObject({ configured: false, detail: 'missing AGENTPHONE_NUMBER_ID' });
    expect(buildProviders(parseEnv({ MESSAGE_CHANNEL: 'agentphone', AGENTPHONE_API_KEY: 'k', AGENTPHONE_NUMBER_ID: 'n' }), now).message?.channel).toBe('agentphone');
  });
});

describe('the TELEPHONY_PROVIDER switch', () => {
  const twilioPorts = { validator: undefined, probe: undefined, missing: [] };
  it('defaults to twilio and refuses an unknown value', () => {
    expect(parseEnv({}).TELEPHONY_PROVIDER).toBe('twilio');
    expect(parseEnv({ TELEPHONY_PROVIDER: '' }).TELEPHONY_PROVIDER).toBe('twilio');
    expect(() => parseEnv({ TELEPHONY_PROVIDER: 'telnyx' })).toThrow(/TELEPHONY_PROVIDER/);
    const t = buildTelephony(parseEnv({}), { now, twilio: twilioPorts, http: noHttp });
    expect(t.name).toBe('twilio');
    expect(t.active.name).toBe('twilio');
    expect(t.agentphone).toBeUndefined();
    expect(t.active.answering).toEqual({ kind: 'media_stream', voiceWebhookPath: WEBHOOK_ENDPOINTS.twilioVoice.path });
  });
  it('agentphone selected with missing settings reports them by name and never falls back to twilio', () => {
    const t = buildTelephony(parseEnv({ TELEPHONY_PROVIDER: 'agentphone', TWILIO_AUTH_TOKEN: 't', TWILIO_PHONE_NUMBER: '+15555550199' }), { now, twilio: twilioPorts, http: noHttp });
    expect(t.active.name).toBe('agentphone');
    expect(t.active.missing).toEqual(['AGENTPHONE_API_KEY', 'AGENTPHONE_WEBHOOK_SECRET', 'AGENTPHONE_NUMBER_ID', 'AGENTPHONE_PHONE_NUMBER', 'PUBLIC_SERVER_URL']);
    expect(t.active.phoneNumber).toBeUndefined();
  });
  it('agentphone selected and complete: turn webhook answering on its own number', () => {
    const t = buildTelephony(parseEnv({ TELEPHONY_PROVIDER: 'agentphone', AGENTPHONE_API_KEY: 'k', AGENTPHONE_WEBHOOK_SECRET: SECRET, AGENTPHONE_NUMBER_ID: 'n',
      AGENTPHONE_PHONE_NUMBER: '+15555550111', PUBLIC_SERVER_URL: 'https://x.example.test' }), { now, twilio: twilioPorts, http: noHttp });
    expect(t.active.missing).toEqual([]);
    expect(t.active.phoneNumber).toBe('+15555550111');
    expect(t.active.answering).toMatchObject({ kind: 'turn_webhook', webhookPath: '/webhooks/agentphone', contentType: 'application/x-ndjson' });
  });

  it('with twilio (default) the composed app keeps the Twilio routes and refuses /webhooks/agentphone without reading it', async () => {
    const app = await buildApp(parseEnv({ AGENTPHONE_API_KEY: 'k', AGENTPHONE_WEBHOOK_SECRET: SECRET }));
    try {
      const r = await app.inject({ method: 'POST', url: '/webhooks/agentphone', headers: { 'content-type': 'application/json' }, payload: '{"event":"agent.message"}' });
      expect(r.statusCode).toBe(503);
      expect(app.composed.telephony.name).toBe('twilio');
      expect(app.composed.agentphone.enabled).toBe(false);
      const health = await app.composed.health.read({ refresh: false });
      expect(health.twilio.detail).not.toContain('agentphone');
    } finally { await app.close(); }
  });

  it('with agentphone selected, Twilio voice answers 503 and health shows AgentPhone on the phone line', async () => {
    const app = await buildApp(parseEnv({ TELEPHONY_PROVIDER: 'agentphone', AGENTPHONE_API_KEY: 'k', TWILIO_AUTH_TOKEN: 't', OPENAI_API_KEY: 'o', PUBLIC_SERVER_URL: 'https://x.example.test' }));
    try {
      const v = await app.inject({ method: 'POST', url: WEBHOOK_ENDPOINTS.twilioVoice.path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'CallSid=CA1' });
      expect(v.statusCode).toBe(503);
      const a = await app.inject({ method: 'POST', url: '/webhooks/agentphone', headers: { 'content-type': 'application/json' }, payload: '{}' });
      expect(a.statusCode).toBe(503);
      const health = await app.composed.health.read({ refresh: true });
      expect(health.twilio).toMatchObject({ state: 'disconnected', detail: expect.stringContaining('telephony provider agentphone: missing AGENTPHONE_WEBHOOK_SECRET, AGENTPHONE_NUMBER_ID, AGENTPHONE_PHONE_NUMBER') });
      // The realtime turn engine (the default) needs only OPENAI_API_KEY, which is set here.
      expect(health.twilio.detail).not.toContain('OPENAI_BUILDER_MODEL');
      expect(app.composed.agentphone.enabled).toBe(false);
    } finally { await app.close(); }
  });

  it('with the builder turn engine, the AgentPhone line also needs OPENAI_BUILDER_MODEL', async () => {
    const app = await buildApp(parseEnv({ TELEPHONY_PROVIDER: 'agentphone', AGENTPHONE_TURN_ENGINE: 'builder', AGENTPHONE_API_KEY: 'k', TWILIO_AUTH_TOKEN: 't', OPENAI_API_KEY: 'o', PUBLIC_SERVER_URL: 'https://x.example.test' }));
    try {
      const health = await app.composed.health.read({ refresh: true });
      expect(health.twilio.detail).toContain('OPENAI_BUILDER_MODEL');
    } finally { await app.close(); }
  });

  it('AGENTPHONE_TURN_ENGINE and AGENTPHONE_GREETING_MODE are validated, with realtime and first_reply as defaults', () => {
    expect(parseEnv({}).AGENTPHONE_TURN_ENGINE).toBe('realtime');
    expect(parseEnv({}).AGENTPHONE_GREETING_MODE).toBe('first_reply');
    expect(parseEnv({ AGENTPHONE_TURN_ENGINE: 'builder' }).AGENTPHONE_TURN_ENGINE).toBe('builder');
    expect(() => parseEnv({ AGENTPHONE_TURN_ENGINE: 'fast' })).toThrow(/AGENTPHONE_TURN_ENGINE/);
    expect(() => parseEnv({ AGENTPHONE_GREETING_MODE: 'never' })).toThrow(/AGENTPHONE_GREETING_MODE/);
    expect(() => parseEnv({ AGENTPHONE_INTERRUPTION_SENSITIVITY: '1.5' })).toThrow(/AGENTPHONE_INTERRUPTION_SENSITIVITY/);
  });
});

describe('AgentPhone health probe (read only, bounded)', () => {
  const settings = { apiKey: 'k', webhookSecret: SECRET, numberId: 'num_1', phoneNumber: '+15555550111' };
  const provider = (http: HttpPort) => createAgentPhoneProvider(settings, { http, nowMs: () => NOW_MS, publicServerUrl: 'https://x.example.test' });
  it('reads the number with GET only and reports outbound SMS readiness', async () => {
    const seen: { url: string; method: string }[] = [];
    const p = provider(async (url, init) => { seen.push({ url, method: init.method }); return { status: 200, json: async () => ({ id: 'num_1', outboundSms: 'registration_required' }) }; });
    const health = createHealthMonitor({ status: { square: { configured: false, detail: '' }, twilio: { configured: true, detail: 'telephony provider agentphone' }, openai: { configured: false, detail: '' },
      google_calendar: { configured: false, detail: '' }, google_sheets: { configured: false, detail: '' }, message_channel: { configured: false, detail: '' } }, probes: { twilio: p.probe! }, now });
    expect((await health.read({ refresh: true })).twilio).toMatchObject({ state: 'connected', detail: 'agentphone number readable; outbound SMS registration_required' });
    expect(seen).toEqual([{ url: 'https://api.agentphone.ai/v1/numbers/num_1', method: 'GET' }]);
  });
  it('a refused or hanging read is disconnected', async () => {
    expect(await provider(async () => ({ status: 401, json: async () => ({}) })).probe!()).toEqual({ ok: false, detail: 'AgentPhone refused the number read' });
    const health = createHealthMonitor({ status: { square: { configured: false, detail: '' }, twilio: { configured: true, detail: 'x' }, openai: { configured: false, detail: '' },
      google_calendar: { configured: false, detail: '' }, google_sheets: { configured: false, detail: '' }, message_channel: { configured: false, detail: '' } },
    probes: { twilio: provider(() => new Promise(() => undefined)).probe! }, now, timeoutMs: 10 });
    expect((await health.read({ refresh: true })).twilio).toMatchObject({ state: 'disconnected', detail: 'check timed out' });
  });
  it('the message-history read parses ids and statuses and pages by cursor', async () => {
    const client = createAgentPhoneClient({ apiKey: 'k', numberId: 'num_1', http: async (url) => ({ status: 200,
      json: async () => (url.includes('cursor=c2') ? { data: [{ id: 'm3', status: 'failed' }], hasMore: false } : { data: [{ id: 'm1', status: 'delivered' }, { bad: 1 }], hasMore: true, nextCursor: 'c2' }) }) });
    expect(await client.listMessages({ limit: 100 })).toEqual({ messages: [{ id: 'm1', status: 'delivered' }], nextCursor: 'c2' });
    expect(await client.listMessages({ limit: 100, cursor: 'c2' })).toEqual({ messages: [{ id: 'm3', status: 'failed' }], nextCursor: undefined });
  });
});

describe('the Twilio provider is a thin wrapper with unchanged behavior', () => {
  const TOKEN = 'test-twilio-token';
  const URL_BASE = 'https://x.example.test';
  const p = createTwilioProvider({ phoneNumber: '+15555550199', publicServerUrl: URL_BASE, validator: createTwilioRequestValidator(TOKEN), probe: undefined, missing: [] });
  const req = (params: Record<string, string>, token = TOKEN) => ({
    rawBody: Buffer.from(new URLSearchParams(params).toString()),
    headers: { 'x-twilio-signature': twilio.getExpectedTwilioSignature(token, `${URL_BASE}/webhooks/twilio/status`, params) },
  });
  it('verifies the status webhook with the existing validator and parses it to neutral events', async () => {
    expect(await p.verifyWebhook(req({ CallSid: 'CA1', CallStatus: 'completed' }))).toMatchObject({ ok: true, event: { kind: 'call_status', providerCallId: 'CA1', reason: 'completed' } });
    expect(await p.verifyWebhook(req({ MessageSid: 'SM1', MessageStatus: 'delivered' }))).toMatchObject({ ok: true, event: { kind: 'delivery_receipt', providerMessageId: 'SM1', status: 'DELIVERED' } });
    expect(await p.verifyWebhook(req({ MessageSid: 'SM1', MessageStatus: 'sent' }))).toMatchObject({ ok: true, event: { kind: 'ignored' } });
    expect(await p.verifyWebhook(req({ CallSid: 'CA1', CallStatus: 'completed' }, 'other-token'))).toEqual({ ok: false, reason: 'signature_invalid' });
    // A verified body with no call or message ID has no event ID to dedupe on: refused, never given a constant one.
    expect(await p.verifyWebhook(req({ Foo: 'bar' }))).toEqual({ ok: false, reason: 'malformed' });
  });
  it('has no texting at all: a text is sent only by the approved message step (agentphone-review.test.ts)', () => {
    expect('sendText' in p).toBe(false);
  });
});
