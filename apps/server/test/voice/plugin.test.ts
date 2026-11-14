import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import twilio from 'twilio';
import WebSocket from 'ws';
import type { CatalogItem } from '@abos/contracts';
import { barberSpecV1, pizzaCatalog, pizzaSpecV2 } from '@abos/contracts/fixtures';
import { createTwilioRequestValidator, voicePlugin } from '../../src/voice/plugin';
import type { FactsSnapshot, LiveAgentResolution, VoicePluginOptions } from '../../src/voice/types';
import { FakeSocket, PIZZA_SNAPSHOT, fakeCalls, fakeEvents, fakeLogger, fakeToolset, specWith } from './helpers';

const PUBLIC_URL = 'https://demo.example.test';
const FORM = 'CallSid=CA123&From=%2B15555550123&To=%2B15555550199';
const live: LiveAgentResolution = { state: 'live', businessId: 'biz_pizza_01', businessName: 'Demo Pizza Co.', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', spec: pizzaSpecV2 };
const tokenOf = (body: string) => /name="streamToken" value="([^"]+)"/.exec(body)?.[1];

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(opts: { resolution?: LiveAgentResolution; facts?: () => Promise<FactsSnapshot>; menu?: () => Promise<CatalogItem[]>; menuTimeoutMs?: number; validator?: VoicePluginOptions['twilioValidator']; rootWebsocket?: boolean; tokenTtlMs?: number } = {}) {
  const calls = fakeCalls();
  let resolution = opts.resolution ?? live;
  const liveAgent = { resolve: vi.fn(async () => resolution) };
  const facts = { snapshot: vi.fn(opts.facts ?? (async () => PIZZA_SNAPSHOT)) };
  const menu = opts.menu === undefined ? undefined : { snapshot: vi.fn(opts.menu) };
  const events = fakeEvents();
  const validated: { url: string; params: Record<string, string> }[] = [];
  const twilioValidator = opts.validator ?? { validate: vi.fn((sig: string, url: string, params: Record<string, string>) => (validated.push({ url, params }), sig === 'good')) };
  const sockets: FakeSocket[] = [];
  const openaiSocketFactory = vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  const { toolset } = fakeToolset();
  const toolsetFactory = vi.fn((_ctx: Parameters<VoicePluginOptions['toolsetFactory']>[0]) => toolset);
  const { logger, lines } = fakeLogger();
  app = Fastify();
  // The app may register the WebSocket plugin at the root; the voice plugin then reuses it.
  if (opts.rootWebsocket !== false) await app.register(websocket);
  await app.register(voicePlugin, { publicServerUrl: `${PUBLIC_URL}/`, liveAgent, facts, ...(menu ? { menu } : {}), ...(opts.menuTimeoutMs !== undefined ? { menuTimeoutMs: opts.menuTimeoutMs } : {}), calls, events, toolsetFactory, twilioValidator, openaiSocketFactory, messageChannel: 'surge', logger, twilioBusinessId: 'biz_pizza_01', ...(opts.tokenTtlMs ? { tokenTtlMs: opts.tokenTtlMs } : {}) });
  await app.ready();
  const a = app;
  const post = (signature = 'good', form = FORM) =>
    a.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, payload: form });
  return { app: a, calls, liveAgent, facts, menu, events, validated, sockets, openaiSocketFactory, toolsetFactory, lines, post, switchAgent: (r: LiveAgentResolution) => (resolution = r) };
}

describe('voice plugin: POST /webhooks/twilio/voice', () => {
  it('starts the call and returns TwiML with a stream token', async () => {
    const t = await build();
    const res = await t.post();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('<Stream url="wss://demo.example.test/ws/phone">');
    expect(tokenOf(res.body)).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(t.validated[0]).toEqual({ url: 'https://demo.example.test/webhooks/twilio/voice', params: { CallSid: 'CA123', From: '+15555550123', To: '+15555550199' } });
    expect(t.calls.startCall).toHaveBeenCalledWith({ businessId: 'biz_pizza_01', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', providerCallId: 'CA123', callerLast4: '0123' });
    expect(JSON.stringify(t.lines)).not.toContain('+15555550123');
  });

  it('a bad signature gets 403 and nothing starts', async () => {
    const t = await build();
    expect((await t.post('forged')).statusCode).toBe(403);
    expect(t.liveAgent.resolve).not.toHaveBeenCalled();
    expect(t.calls.startCall).not.toHaveBeenCalled();
  });

  it('S13: a bad signature writes webhook.rejected with the trusted business and nothing from the body', async () => {
    const t = await build();
    await t.post('forged');
    expect(t.events.webhookRejected).toHaveBeenCalledWith({ businessId: 'biz_pizza_01', payload: { provider: 'twilio', reason: 'signature_invalid' } });
    expect(JSON.stringify(t.events.webhookRejected.mock.calls)).not.toMatch(/CA123|5555550/);
    await t.post('good', 'From=%2B15555550123');
    expect(t.events.webhookRejected).toHaveBeenLastCalledWith({ businessId: 'biz_pizza_01', payload: { provider: 'twilio', reason: 'malformed' } });
  });

  it('a missing signature gets 403', async () => {
    const t = await build();
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: FORM });
    expect(res.statusCode).toBe(403);
  });

  it('no live agent gets the spoken refusal and starts no call or session', async () => {
    const t = await build({ resolution: { state: 'none' } });
    const res = await t.post();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Say>Sorry, this line is not taking calls right now.');
    expect(res.body).not.toContain('<Stream');
    expect(t.calls.startCall).not.toHaveBeenCalled();
    expect(t.openaiSocketFactory).not.toHaveBeenCalled();
  });

  it('a paused agent gets the spoken refusal', async () => {
    for (const r of [{ state: 'paused' } as const, { ...live, spec: specWith(pizzaSpecV2, { status: 'paused' }) }]) {
      const t = await build({ resolution: r });
      const res = await t.post();
      expect(res.body).toContain('<Say>');
      expect(res.body).not.toContain('<Stream');
      expect(t.openaiSocketFactory).not.toHaveBeenCalled();
      await t.app.close();
      app = undefined;
    }
  });

  // Issue #95 item 6 and API.md section 4: the paused path records the call as started and ended.
  it('a paused agent: the call is recorded as started and then ended completed, with no stream credential', async () => {
    const ids = { businessId: 'biz_pizza_01', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2' };
    for (const r of [{ state: 'paused', ...ids } as const, { ...live, spec: specWith(pizzaSpecV2, { status: 'paused' }) }]) {
      const t = await build({ resolution: r });
      const res = await t.post();
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<Say>Sorry, this line is not taking calls right now.');
      expect(tokenOf(res.body)).toBeUndefined();
      expect(t.calls.startCall).toHaveBeenCalledTimes(1);
      expect(t.calls.startCall).toHaveBeenCalledWith({ ...ids, providerCallId: 'CA123', callerLast4: '0123' });
      expect(t.calls.endCall).toHaveBeenCalledTimes(1);
      expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'completed');
      // No fact snapshot, toolset or model session exists for a call that only hears the closed message.
      expect(t.facts.snapshot).not.toHaveBeenCalled();
      expect(t.toolsetFactory).not.toHaveBeenCalled();
      await t.app.close();
      app = undefined;
    }
  });

  it('a paused agent whose identity is unknown, and a number with no agent, record no call: there is nothing to end', async () => {
    for (const r of [{ state: 'paused' } as const, { state: 'none' } as const]) {
      const t = await build({ resolution: r });
      expect((await t.post()).body).toContain('<Say>');
      expect(t.calls.startCall).not.toHaveBeenCalled();
      expect(t.calls.endCall).not.toHaveBeenCalled();
      await t.app.close();
      app = undefined;
    }
  });

  it('a paused call still answers the caller when the call cannot be recorded', async () => {
    const t = await build({ resolution: { state: 'paused', businessId: 'biz_pizza_01', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2' } });
    t.calls.startCall.mockRejectedValueOnce(new Error('db down'));
    const res = await t.post();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Say>Sorry, this line is not taking calls right now.');
  });

  it('a live spec with a write capability outside its bundle is refused before the call starts', async () => {
    const t = await build({ resolution: { ...live, spec: specWith(pizzaSpecV2, { capabilities: [...pizzaSpecV2.capabilities, 'catalog.price.update'] }) } });
    expect((await t.post()).body).toContain('<Say>');
    expect(t.calls.startCall).not.toHaveBeenCalled();
  });
});

describe('voice plugin: replayed webhooks (B1)', () => {
  it('B1: an identical signed retry gets the same pending token, never a second one', async () => {
    const authToken = 'test_auth_token_value';
    const validator = createTwilioRequestValidator(authToken);
    const params = { CallSid: 'CA123', From: '+15555550123', To: '+15555550199' };
    const sig = twilio.getExpectedTwilioSignature(authToken, `${PUBLIC_URL}/webhooks/twilio/voice`, params);
    const t = await build({ validator });
    const first = await t.post(sig);
    const second = await t.post(sig);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(tokenOf(second.body)).toBe(tokenOf(first.body));
    expect(t.calls.startCall).toHaveBeenCalledTimes(1);
  });

  it('B1: simultaneous retries share one credential', async () => {
    const t = await build();
    const [a, b] = await Promise.all([t.post(), t.post()]);
    expect(tokenOf(a.body)).toBe(tokenOf(b.body));
    expect(t.calls.startCall).toHaveBeenCalledTimes(1);
    expect(t.liveAgent.resolve).toHaveBeenCalledTimes(1);
  });

  it('B1: a live-agent switch between retries does not change the pinned call', async () => {
    const t = await build();
    const first = await t.post();
    t.switchAgent({ state: 'live', businessId: 'biz_barber_01', businessName: 'Demo Barbershop', agentId: 'agt_barber_01', agentVersionId: 'agv_barber_01_v1', spec: barberSpecV1 });
    const second = await t.post();
    expect(tokenOf(second.body)).toBe(tokenOf(first.body));
    expect(t.liveAgent.resolve).toHaveBeenCalledTimes(1);
  });

  it('B1: a retry after the stream claimed the token is refused', async () => {
    const t = await build();
    const token = tokenOf((await t.post()).body);
    const ws = await t.app.injectWS('/ws/phone');
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(t.openaiSocketFactory).toHaveBeenCalledTimes(1));
    const retry = await t.post();
    expect(retry.statusCode).toBe(409);
    expect(tokenOf(retry.body)).toBeUndefined();
    expect(t.calls.startCall).toHaveBeenCalledTimes(1);
    ws.terminate();
  });

  it('B1: a call already stored for the CallSid gets no new credential', async () => {
    const t = await build();
    t.calls.findByProviderCallId.mockResolvedValueOnce({ callId: 'call_test_01', status: 'IN_PROGRESS' });
    const res = await t.post();
    expect(res.statusCode).toBe(409);
    expect(t.calls.startCall).not.toHaveBeenCalled();
  });
});

describe('voice plugin: fact snapshot (S9, S10)', () => {
  it('S9: the snapshot is taken at the webhook and that exact snapshot reaches the toolset', async () => {
    let current: FactsSnapshot = PIZZA_SNAPSHOT;
    const t = await build({ facts: async () => current });
    const token = tokenOf((await t.post()).body);
    expect(t.facts.snapshot).toHaveBeenCalledWith('biz_pizza_01');
    // The owner edits hours between the webhook and the stream.
    current = { ...PIZZA_SNAPSHOT, facts: PIZZA_SNAPSHOT.facts.map((f) => (f.key === 'fri' ? { ...f, value: { open: '11:00', close: '23:00' }, version: 2 } : f)) };
    const ws = await t.app.injectWS('/ws/phone');
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(t.toolsetFactory).toHaveBeenCalled());
    expect(t.toolsetFactory.mock.calls[0]?.[0]).toMatchObject({ facts: PIZZA_SNAPSHOT });
    expect(t.facts.snapshot).toHaveBeenCalledTimes(1);
    ws.terminate();
  });

  it('S9: a failed snapshot read refuses the call politely', async () => {
    const t = await build({ facts: async () => Promise.reject(new Error('db down')) });
    const res = await t.post();
    expect(res.body).toContain('cannot take orders or bookings by phone right now');
    expect(t.calls.startCall).not.toHaveBeenCalled();
  });

  it('S10: a snapshot with no readable opening hours refuses the call politely', async () => {
    const noHours: FactsSnapshot = { ...PIZZA_SNAPSHOT, facts: PIZZA_SNAPSHOT.facts.map((f) => (f.kind === 'hours' ? { ...f, value: { open: 'noon' } } : f)) };
    const t = await build({ facts: async () => noHours });
    expect((await t.post()).body).toContain('cannot take orders or bookings by phone right now');
    expect(t.calls.startCall).not.toHaveBeenCalled();
  });
});

// Issue #95 item 6: a call row was left IN_PROGRESS for ever when its stream credential was rejected
// or never used. Every started call now ends with call.ended.
describe('voice plugin: every started call ends (issue #95 item 6)', () => {
  it('a credential that is never used: the call ends dropped when the credential expires', async () => {
    const t = await build({ tokenTtlMs: 40 });
    expect(tokenOf((await t.post()).body)).toBeDefined();
    expect(t.calls.endCall).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'dropped'), { timeout: 2000 });
    expect(t.calls.endCall).toHaveBeenCalledTimes(1);
    expect(t.openaiSocketFactory).not.toHaveBeenCalled();
  });

  it('a socket that never sends start: the call ends dropped when the credential expires', async () => {
    const t = await build({ tokenTtlMs: 40 });
    await t.post();
    const ws = await t.app.injectWS('/ws/phone');
    await vi.waitFor(() => expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'dropped'), { timeout: 2000 });
    ws.terminate();
  });

  it('the right token with the wrong CallSid: the stream is refused and the call ends failed', async () => {
    const t = await build();
    const token = tokenOf((await t.post()).body);
    const ws = await t.app.injectWS('/ws/phone');
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA999', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await closed;
    await vi.waitFor(() => expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'failed'));
    expect(t.calls.endCall).toHaveBeenCalledTimes(1);
    expect(t.openaiSocketFactory).not.toHaveBeenCalled();
  });

  it('the right token with no stream ID: the stream is refused and the call ends failed', async () => {
    const t = await build();
    const token = tokenOf((await t.post()).body);
    const ws = await t.app.injectWS('/ws/phone');
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', customParameters: { streamToken: token } } }));
    await closed;
    await vi.waitFor(() => expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'failed'));
  });

  it('a token nobody minted, or a CallSid alone, ends no call: only the holder of a call\'s token can end it', async () => {
    const t = await build();
    const token = tokenOf((await t.post()).body);
    for (const streamToken of ['not-a-token', undefined]) {
      const ws = await t.app.injectWS('/ws/phone');
      const closed = new Promise<void>((r) => ws.on('close', () => r()));
      ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken } } }));
      await closed;
    }
    expect(t.calls.endCall).not.toHaveBeenCalled();
    // The real stream still connects afterwards.
    const ws = await t.app.injectWS('/ws/phone');
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(t.openaiSocketFactory).toHaveBeenCalledTimes(1));
    ws.send(JSON.stringify({ event: 'stop' }));
    await vi.waitFor(() => expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'completed'));
    expect(t.calls.endCall).toHaveBeenCalledTimes(1);
    ws.terminate();
  });

  it('a call whose stream connected in time is not ended by the expiry of its credential', async () => {
    // A life long enough for the stream to connect on a slow machine, then a wait past its end.
    const t = await build({ tokenTtlMs: 500 });
    const token = tokenOf((await t.post()).body);
    const ws = await t.app.injectWS('/ws/phone');
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(t.openaiSocketFactory).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 700));
    expect(t.calls.endCall).not.toHaveBeenCalled();
    ws.send(JSON.stringify({ event: 'stop' }));
    await vi.waitFor(() => expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'completed'));
    ws.terminate();
  });
});

describe('voice plugin: /ws/phone', () => {
  const instructionsOf = async (t: Awaited<ReturnType<typeof build>>) => {
    const token = tokenOf((await t.post()).body);
    const ws = await t.app.injectWS('/ws/phone');
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
    t.sockets[0]?.open();
    const update = t.sockets[0]?.ofType('session.update')[0] as { session: { instructions: string } };
    ws.terminate();
    return update.session.instructions;
  };

  it('pins the menu at the webhook and writes it, the hours and the time into the prompt', async () => {
    const t = await build({ menu: async () => pizzaCatalog });
    const text = await instructionsOf(t);
    expect(t.menu?.snapshot).toHaveBeenCalledWith('biz_pizza_01');
    expect(t.menu?.snapshot).toHaveBeenCalledTimes(1);
    expect(text).toContain('Menu, prices before tax:');
    expect(text).toContain('Opening hours: Monday 11 AM to 9 PM.');
    expect(text).toContain('Now: ');
    expect(text).toContain('Never say you are checking');
  });

  it('a failed menu read does not stop the call; the agent keeps the read_catalog path', async () => {
    const t = await build({ menu: async () => Promise.reject(new Error('db down')) });
    const text = await instructionsOf(t);
    expect(t.calls.startCall).toHaveBeenCalledTimes(1);
    expect(text).not.toContain('Menu, prices before tax:');
    expect(text).toContain('Build the cart only from IDs returned by read_catalog');
    expect(text).toContain('Opening hours: Monday 11 AM to 9 PM.');
  });

  it('a menu read that never answers does not hold the call: it starts without the menu', async () => {
    const t = await build({ menu: () => new Promise<CatalogItem[]>(() => undefined), menuTimeoutMs: 20 });
    const res = await t.post();
    expect(res.statusCode).toBe(200);
    expect(tokenOf(res.body)).toBeDefined();
    expect(t.calls.startCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(t.lines)).toContain('the menu was not read for the prompt');
  });

  it('B1: a retried webhook with a menu port gets the same token and reads the menu once', async () => {
    const t = await build({ menu: async () => pizzaCatalog });
    const first = tokenOf((await t.post()).body);
    const second = tokenOf((await t.post()).body);
    expect(second).toBe(first);
    expect(t.menu?.snapshot).toHaveBeenCalledTimes(1);
  });

  it('never puts menu rows of another business in the prompt', async () => {
    const foreign: CatalogItem[] = [{ ...pizzaCatalog[0]!, businessId: 'biz_barber_01', name: 'Foreign Pie' }, pizzaCatalog[1]!];
    const text = await instructionsOf(await build({ menu: async () => foreign }));
    expect(text).not.toContain('Foreign Pie');
    expect(text).toContain('Pepperoni');
  });

  it('does not read a menu for an agent without the catalog capability', async () => {
    const t = await build({ resolution: { ...live, businessId: 'biz_barber_01', spec: barberSpecV1 }, menu: async () => pizzaCatalog });
    await t.post();
    expect(t.menu?.snapshot).not.toHaveBeenCalled();
  });

  it('accepts the minted token over the socket and opens the model session', async () => {
    const t = await build();
    const token = tokenOf((await t.post()).body);
    const ws = await t.app.injectWS('/ws/phone');
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(t.openaiSocketFactory).toHaveBeenCalledWith({ model: 'gpt-realtime-2.1' }));
    t.sockets[0]?.open();
    expect(t.sockets[0]?.ofType('session.update')).toHaveLength(1);
    ws.send(JSON.stringify({ event: 'stop' }));
    await vi.waitFor(() => expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'completed'));
    ws.terminate();
  });

  it('works when the plugin registers the WebSocket support itself (localhost socket)', async () => {
    const t = await build({ rootWebsocket: false });
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const token = tokenOf((await t.post()).body);
    const ws = new WebSocket(`${address.replace('http', 'ws')}/ws/phone`);
    await new Promise<void>((r, j) => {
      ws.on('open', () => r());
      ws.on('error', j);
    });
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
    ws.close();
    await vi.waitFor(() => expect(t.calls.endCall).toHaveBeenCalledWith('call_test_01', 'dropped'));
  });

  it('a token is single use across connections', async () => {
    const t = await build();
    const token = tokenOf((await t.post()).body);
    const first = await t.app.injectWS('/ws/phone');
    first.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(t.openaiSocketFactory).toHaveBeenCalledTimes(1));
    const second = await t.app.injectWS('/ws/phone');
    const closed = new Promise<void>((r) => second.on('close', () => r()));
    second.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ2', customParameters: { streamToken: token } } }));
    await closed;
    expect(t.openaiSocketFactory).toHaveBeenCalledTimes(1);
    first.terminate();
  });
});


it('never reflects private URLs or malformed bodies through HTTP errors on voice paths', async () => {
  const logs: string[] = [];
  app = Fastify({ logger: { stream: { write: (line: string) => { logs.push(line); } } } });
  await app.register(voicePlugin, { publicServerUrl: PUBLIC_URL, liveAgent: { resolve: async () => live }, facts: { snapshot: async () => PIZZA_SNAPSHOT }, calls: fakeCalls(), events: fakeEvents(), toolsetFactory: () => fakeToolset().toolset, twilioValidator: { validate: () => false }, openaiSocketFactory: () => new FakeSocket(), messageChannel: 'qr_only' });
  await app.ready();
  const secret = 'OpaqueStreamCredentialAbcdef12345';
  const privateQuery = `?token=${secret}&phone=+15555550123&bill=https://bill.example/private`;
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS'] as const) {
    const response = await app.inject({ method, url: '/webhooks/twilio/voice' + privateQuery, headers: { authorization: 'Bearer private-bearer-value' } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toMatch(/OpaqueStream|15555550123|bill.example|private-bearer/);
  }
  for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
    const response = await app.inject({ method, url: '/ws/phone' + privateQuery });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toMatch(/OpaqueStream|15555550123|bill.example/);
  }
  const malformed = await app.inject({ method: 'POST', url: '/webhooks/twilio/voice' + privateQuery, headers: { 'content-type': 'application/json' }, payload: `{"private":"${secret}"` });
  expect(malformed.statusCode).toBeGreaterThanOrEqual(400);
  expect(malformed.body).not.toContain(secret);
  expect(logs.join('')).not.toMatch(/OpaqueStream|15555550123|bill.example|private-bearer/);
});
