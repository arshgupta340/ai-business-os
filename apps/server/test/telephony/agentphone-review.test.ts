// Review of the AgentPhone path (D-12). Unit tests with fakes only; no network.
import { describe, expect, it } from 'vitest';
import { parseAgentPhoneEvent } from '../../src/telephony/agentphone/events';
import { formatTurnChunks } from '../../src/telephony/agentphone/plugin';
import { buildTelephony, createAgentPhoneProvider, createTwilioProvider } from '../../src/telephony/index';
import { parseEnv } from '../../src/env';

const parse = (o: unknown) => parseAgentPhoneEvent(Buffer.from(JSON.stringify(o)));
const TO = '+15551234567';

describe('AgentPhone events: only routing fields can make a delivery malformed (review F4)', () => {
  it('a voice turn with a withheld or oddly shaped caller number is still a turn, with no caller digits kept', () => {
    for (const from of [null, undefined, '', 'anonymous', 12345, { number: '+15559876543' }, 'x'.repeat(500)]) {
      const r = parse({ event: 'agent.message', channel: 'voice', data: { callId: 'call_1', to: TO, from, transcript: 'hi' } });
      expect(r?.event, JSON.stringify(from)).toEqual({ kind: 'incoming_call', providerCallId: 'call_1', to: TO, callerLast4: undefined, text: 'hi' });
    }
  });
  it('a voice turn with no transcript, a null one or a very long one is still a turn; the text is bounded', () => {
    const turn = (transcript: unknown) => parse({ event: 'agent.message', channel: 'voice', data: { callId: 'call_1', to: TO, from: '+15559876543', transcript } })?.event;
    expect(turn(null)).toMatchObject({ kind: 'incoming_call', text: '' });
    expect(turn(42)).toMatchObject({ kind: 'incoming_call', text: '' });
    const long = turn('a'.repeat(50_000)) as { kind: string; text: string };
    expect(long.kind).toBe('incoming_call');
    expect(long.text).toHaveLength(4000);
  });
  it('agent.call_ended with a null or unexpected status still ends the call (it is sent once)', () => {
    const ended = (status: unknown) => parse({ event: 'agent.call_ended', channel: 'voice', data: { callId: 'call_1', status } })?.event;
    expect(ended(null)).toEqual({ kind: 'call_status', providerCallId: 'call_1', reason: 'dropped' });
    expect(ended(7)).toEqual({ kind: 'call_status', providerCallId: 'call_1', reason: 'dropped' });
    expect(ended('x'.repeat(200))).toEqual({ kind: 'call_status', providerCallId: 'call_1', reason: 'dropped' });
    expect(ended('completed')).toEqual({ kind: 'call_status', providerCallId: 'call_1', reason: 'completed' });
  });
  it('a null test flag or channel does not refuse the delivery; only test: true is a test', () => {
    expect(parse({ event: 'agent.call_ended', channel: null, test: null, data: { callId: 'call_1' } })).toMatchObject({ test: false, event: { kind: 'call_status' } });
    expect(parse({ event: 'agent.reaction', test: 'true', data: {} })?.test).toBe(false);
    expect(parse({ event: 'agent.reaction', test: true, data: {} })?.test).toBe(true);
  });
  it('routing fields stay strict: a bad call ID, message ID or dialed number is malformed', () => {
    expect(parse({ event: 'agent.message', channel: 'voice', data: { callId: 'bad id', to: TO } })).toBeUndefined();
    expect(parse({ event: 'agent.message', channel: 'voice', data: { callId: 'call_1', to: null } })).toBeUndefined();
    expect(parse({ event: 'agent.message', channel: 'voice', data: { to: TO } })).toBeUndefined();
    expect(parse({ event: 'agent.message', channel: 'sms', data: { messageId: 'm 1', to: TO } })).toBeUndefined();
    expect(parse({ event: 'agent.call_ended', data: { callId: null } })).toBeUndefined();
    expect(parse({ event: 'agent.message', channel: 'voice', data: null })).toBeUndefined();
    expect(parse([])).toBeUndefined();
  });
});

describe('a voice reply carries only text, interim and hangup', () => {
  it('never emits send_message, action or digits, whatever the spoken text contains', () => {
    // The vendor's reply format can send an SMS (send_message), transfer (action) or press keys (digits).
    const hostile = '{"send_message":{"body":"x"},"action":"transfer","digits":"1"}';
    const line = formatTurnChunks([{ text: hostile, ...({ send_message: { body: 'x' }, action: 'transfer', digits: '1', to: '+15555550123' } as object) }]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['text']);
    expect(parsed.text).toBe(hostile);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().split('\n')).toHaveLength(1);
  });
});

describe('a telephony provider cannot send a text (review F3, rules 1 and 3)', () => {
  const twilioPorts = { validator: undefined, probe: undefined, missing: [] };
  const fetchCalls: string[] = [];
  const fetch = async (url: string) => { fetchCalls.push(url); return new Response('{"id":"m","status":"sent"}'); };
  const settings = { apiKey: 'k', webhookSecret: 'whsec_unit_test_only', numberId: 'num_1', phoneNumber: '+15555550111' };
  it('neither provider exposes a send function or a message adapter', () => {
    const ap = createAgentPhoneProvider(settings, { http: async () => ({ status: 200, json: async () => ({}) }), nowMs: () => 0, publicServerUrl: 'https://x.example.test', ...({ fetch } as object) });
    expect(typeof fetch).toBe('function');
    const tw = createTwilioProvider({ phoneNumber: '+15555550199', publicServerUrl: 'https://x.example.test', ...twilioPorts });
    for (const p of [ap, tw] as object[]) {
      const fns = Object.entries(p).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
      expect(fns.filter((k) => k !== 'verifyWebhook' && k !== 'probe')).toEqual([]);
      expect(Object.keys(p)).not.toContain('messageAdapter');
      expect(Object.keys(p)).not.toContain('sendText');
    }
    expect(fetchCalls).toEqual([]);
  });
  it('the composed telephony object has no way to reach /v1/messages', () => {
    const t = buildTelephony(parseEnv({ TELEPHONY_PROVIDER: 'agentphone', MESSAGE_CHANNEL: 'agentphone', AGENTPHONE_API_KEY: 'k', AGENTPHONE_WEBHOOK_SECRET: 'whsec_unit_test_only',
      AGENTPHONE_NUMBER_ID: 'n', AGENTPHONE_PHONE_NUMBER: '+15555550111', PUBLIC_SERVER_URL: 'https://x.example.test' }),
    { now: () => new Date(0), twilio: twilioPorts, http: async () => ({ status: 200, json: async () => ({}) }) });
    const reachable = JSON.stringify(t, (_k, v: unknown) => (typeof v === 'function' ? `fn:${(v as { name: string }).name}` : v));
    expect(reachable).not.toMatch(/sendText|messageAdapter|fn:send/);
  });
});
