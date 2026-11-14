// D-13 demo mode in the voice webhook: a listed caller's call is pinned with the demo menu tool and its number
// is handed to demo mode; any other caller, or no demo option, pins the published spec unchanged.
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pizzaSpecV2 } from '@abos/contracts/fixtures';
import { voicePlugin } from '../../src/voice/plugin';
import type { LiveAgentResolution, PinnedCall, VoicePluginOptions } from '../../src/voice/types';
import type { StreamTokenStore } from '../../src/voice/logic';
import { FakeSocket, PIZZA_SNAPSHOT, fakeCalls, fakeEvents, fakeLogger, fakeToolset } from './helpers';

const LISTED = '+15555550142';
const live: LiveAgentResolution = { state: 'live', businessId: 'biz_pizza_01', businessName: 'Demo Pizza Co.', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', spec: pizzaSpecV2 };
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function build(demo: VoicePluginOptions['demo']) {
  let store: StreamTokenStore<PinnedCall> | undefined;
  const { logger, lines } = fakeLogger();
  app = Fastify();
  await app.register(websocket);
  await app.register(voicePlugin, {
    publicServerUrl: 'https://demo.example.test', liveAgent: { resolve: async () => live }, facts: { snapshot: async () => PIZZA_SNAPSHOT },
    calls: fakeCalls(), events: fakeEvents(), toolsetFactory: () => fakeToolset().toolset, twilioValidator: { validate: () => true },
    openaiSocketFactory: () => new FakeSocket(), messageChannel: 'qr_only', logger, inspectTokens: (s) => { store = s; }, ...(demo ? { demo } : {}),
  });
  await app.ready();
  const post = async (from: string, sid: string) => {
    const res = await app!.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'x' },
      payload: `CallSid=${sid}&From=${encodeURIComponent(from)}&To=%2B15555550199` });
    expect(res.statusCode).toBe(200);
    return store!.valueOf(sid);
  };
  return { post, lines };
}

describe('voice webhook in demo mode', () => {
  it('a listed caller gets the demo menu tool and is pinned for demo mode; the number is not logged or kept for the text step', async () => {
    const pin = vi.fn();
    const t = await build({ listedCaller: (from) => (from === LISTED ? LISTED : undefined), pin });
    const call = await t.post(LISTED, 'CAd1');
    expect(call?.spec.capabilities).toContain('menu.message.propose');
    expect(call?.callerNumber).toBeUndefined();
    expect(pin).toHaveBeenCalledWith(call!.callId, LISTED);
    expect(JSON.stringify(t.lines)).not.toContain(LISTED.slice(1));
  });

  it('an unlisted caller, or demo mode off, pins the published spec unchanged', async () => {
    const pin = vi.fn();
    const t = await build({ listedCaller: () => undefined, pin });
    expect((await t.post('+15555550177', 'CAd2'))?.spec).toEqual(pizzaSpecV2);
    expect(pin).not.toHaveBeenCalled();
    await app!.close(); app = undefined;
    const off = await build(undefined);
    expect((await off.post(LISTED, 'CAd3'))?.spec).toEqual(pizzaSpecV2);
  });
});
