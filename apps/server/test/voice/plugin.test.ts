import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { pizzaSpecV2 } from '@abos/contracts/fixtures';
import { voicePlugin } from '../../src/voice/plugin';
import type { LiveAgentResolution } from '../../src/voice/types';
import { FakeSocket, fakeCalls, fakeHandler, fakeLogger, specWith } from './helpers';

const PUBLIC_URL = 'https://demo.example.test';
const FORM = 'CallSid=CA123&From=%2B15555550123&To=%2B15555550199';
const live: LiveAgentResolution = { state: 'live', businessId: 'biz_pizza_01', businessName: 'Demo Pizza Co.', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', spec: pizzaSpecV2 };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(resolution: LiveAgentResolution = live) {
  const calls = fakeCalls();
  const liveAgent = { resolve: vi.fn(async () => resolution) };
  const validated: { url: string; params: Record<string, string> }[] = [];
  const twilioValidator = { validate: vi.fn((sig: string, url: string, params: Record<string, string>) => (validated.push({ url, params }), sig === 'good')) };
  const sockets: FakeSocket[] = [];
  const openaiSocketFactory = vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  const { handler } = fakeHandler();
  const { logger, lines } = fakeLogger();
  app = Fastify();
  // The app registers the WebSocket plugin at the root; the voice plugin then reuses it.
  await app.register(websocket);
  await app.register(voicePlugin, { publicServerUrl: `${PUBLIC_URL}/`, liveAgent, calls, toolsetFactory: () => handler, twilioValidator, openaiSocketFactory, messageChannel: 'surge', logger });
  await app.ready();
  const post = (signature = 'good') =>
    app!.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, payload: FORM });
  return { app, calls, liveAgent, twilioValidator, validated, sockets, openaiSocketFactory, lines, post };
}

describe('voice plugin: POST /webhooks/twilio/voice', () => {
  it('starts the call and returns TwiML with a stream token', async () => {
    const t = await build();
    const res = await t.post();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('<Stream url="wss://demo.example.test/ws/phone">');
    expect(res.body).toMatch(/<Parameter name="streamToken" value="[A-Za-z0-9_-]{20,}" \/>/);
    expect(t.validated[0]).toEqual({ url: 'https://demo.example.test/webhooks/twilio/voice', params: { CallSid: 'CA123', From: '+15555550123', To: '+15555550199' } });
    expect(t.liveAgent.resolve).toHaveBeenCalledWith('+15555550199');
    expect(t.calls.startCall).toHaveBeenCalledWith({ businessId: 'biz_pizza_01', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', providerCallId: 'CA123', callerLast4: '0123' });
    expect(JSON.stringify(t.lines)).not.toContain('+15555550123');
  });

  it('a bad signature gets 403 and nothing starts', async () => {
    const t = await build();
    const res = await t.post('forged');
    expect(res.statusCode).toBe(403);
    expect(t.liveAgent.resolve).not.toHaveBeenCalled();
    expect(t.calls.startCall).not.toHaveBeenCalled();
  });

  it('a missing signature gets 403', async () => {
    const t = await build();
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: FORM });
    expect(res.statusCode).toBe(403);
  });

  it('no live agent gets the spoken refusal and starts no call or session', async () => {
    const t = await build({ state: 'none' });
    const res = await t.post();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Say>Sorry, this line is not taking calls right now.');
    expect(res.body).toContain('<Hangup />');
    expect(res.body).not.toContain('<Stream');
    expect(t.calls.startCall).not.toHaveBeenCalled();
    expect(t.openaiSocketFactory).not.toHaveBeenCalled();
  });

  it('a paused agent gets the spoken refusal', async () => {
    for (const r of [{ state: 'paused' } as const, { ...live, spec: specWith(pizzaSpecV2, { status: 'paused' }) }]) {
      const t = await build(r);
      const res = await t.post();
      expect(res.body).toContain('<Say>');
      expect(t.calls.startCall).not.toHaveBeenCalled();
      await t.app.close();
      app = undefined;
    }
  });

  it('a live spec with a write capability outside its bundle is refused before the call starts', async () => {
    const t = await build({ ...live, spec: specWith(pizzaSpecV2, { capabilities: [...pizzaSpecV2.capabilities, 'catalog.price.update'] }) });
    const res = await t.post();
    expect(res.body).toContain('<Say>');
    expect(t.calls.startCall).not.toHaveBeenCalled();
  });
});

describe('voice plugin: /ws/phone', () => {
  it('accepts the minted token over the socket and opens the model session', async () => {
    const t = await build();
    const token = /value="([^"]+)"/.exec((await t.post()).body)?.[1];
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
    const calls = fakeCalls();
    const sockets: FakeSocket[] = [];
    const { handler } = fakeHandler();
    app = Fastify();
    await app.register(voicePlugin, {
      publicServerUrl: PUBLIC_URL, liveAgent: { resolve: async () => live }, calls, toolsetFactory: () => handler,
      twilioValidator: { validate: () => true }, openaiSocketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      messageChannel: 'surge', logger: fakeLogger().logger,
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await app.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'x' }, payload: FORM });
    const token = /value="([^"]+)"/.exec(res.body)?.[1];
    const ws = new WebSocket(`${address.replace('http', 'ws')}/ws/phone`);
    await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
    ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } }));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    ws.close();
    await vi.waitFor(() => expect(calls.endCall).toHaveBeenCalledWith('call_test_01', 'dropped'));
  });

  it('a token is single use', async () => {
    const t = await build();
    const token = /value="([^"]+)"/.exec((await t.post()).body)?.[1];
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
