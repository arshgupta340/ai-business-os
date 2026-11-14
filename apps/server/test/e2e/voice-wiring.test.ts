// Phase D: the voice plugin and telemetry as composed. The deployed agent gets only read and propose
// tools (AGENTS rule 6), and the phone path stays off when its settings are missing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITY_LIST, CAPABILITIES, ENDPOINTS, ToolNameSchema, capabilityForTool, type CapabilityId, type ToolName } from '@abos/contracts';
import { OWNER, PHONE, PUBLIC_URL, createWorld, type World } from './world';

const PIZZA = 'biz_pizza_01';

describe('voice on (Twilio, OpenAI and PUBLIC_SERVER_URL set)', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld({}, { TWILIO_AUTH_TOKEN: 'test-twilio-token', TWILIO_ACCOUNT_SID: 'ACtest', OPENAI_API_KEY: 'test-openai-key' }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('registers the voice webhook, which refuses an unsigned request', async () => {
    expect(w.app.composed.voice.ok).toBe(true);
    const res = await w.app.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `CallSid=CAtest&To=${encodeURIComponent(PHONE)}` });
    expect(res.statusCode).not.toBe(503);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await w.t.db.query('select count(*)::int as n from calls where channel = $1', ['phone'])).rows[0]).toEqual({ n: 0 });
  });

  it('the toolset given to the voice worker has no write or external_message tool', async () => {
    const voice = w.app.composed.voice;
    if (!voice.ok) throw new Error('voice is off');
    const live = (await w.t.db.query('select agent_version_id from live_agent where business_id = $1', [PIZZA])).rows[0] as { agent_version_id: string };
    const facts = await w.app.composed.toolsetPorts.facts!.readVerified({ businessId: PIZZA });
    // Even a spec that lists every capability, write ones included, yields no write tool.
    const all = CAPABILITY_LIST.map((c) => c.id as CapabilityId);
    const toolset = voice.options.toolsetFactory({ businessId: PIZZA, agentVersionId: live.agent_version_id, callId: 'call_voice_test', capabilities: all, facts });
    try {
      for (const name of ToolNameSchema.options) expect(['read', 'propose']).toContain(CAPABILITIES[capabilityForTool(name)].effect);
      const writes = CAPABILITY_LIST.filter((c) => c.effect === 'write' || c.effect === 'external_message');
      expect(writes.length).toBeGreaterThan(0);
      const ctx = { businessId: PIZZA, agentVersionId: live.agent_version_id, callId: 'call_voice_test', correlationId: 'call_voice_test' };
      for (const c of writes) {
        expect((ToolNameSchema.options as readonly string[]).includes(c.id)).toBe(false);
        // A name outside the seven tools is refused or throws; it never reaches a port.
        const r = await toolset.handler.call(c.id as unknown as ToolName, {} as never, ctx).catch(() => ({ ok: false }));
        expect(r).toMatchObject({ ok: false });
      }
      expect(w.squareWrites).toEqual([]);
      expect(w.messageSends).toBe(0);
    } finally { toolset.dispose(); }
  });
});

describe('voice off (no Twilio auth token)', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('answers the voice webhook 503, has no phone socket, and health says so', async () => {
    expect(w.app.composed.voice).toMatchObject({ ok: false, missing: expect.arrayContaining(['TWILIO_AUTH_TOKEN', 'OPENAI_API_KEY']) });
    const res = await w.app.inject({ method: 'POST', url: '/webhooks/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'CallSid=CAtest' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    expect((await w.app.inject({ url: '/ws/phone' })).statusCode).toBe(404);
    const health = ENDPOINTS.getIntegrationsHealth.response.parse((await w.app.inject({ url: `/api/integrations/health?businessId=${PIZZA}`, headers: OWNER })).json());
    expect(health.twilio.state).toBe('disconnected');
    expect(w.app.composed.providers.status.twilio.detail).toMatch(/phone voice off/);
    expect(PUBLIC_URL).toMatch(/^https:/);
  });

  it('serves GET /api/telemetry to the owner only', async () => {
    const ok = await w.app.inject({ url: `/api/telemetry?businessId=${PIZZA}`, headers: OWNER });
    expect(ok.statusCode).toBe(200);
    ENDPOINTS.getTelemetry.response.parse(ok.json());
    expect((await w.app.inject({ url: `/api/telemetry?businessId=${PIZZA}` })).statusCode).toBe(401);
    expect((await w.app.inject({ url: `/api/telemetry?businessId=${PIZZA}`, headers: { authorization: 'Bearer other' } })).statusCode).toBe(403);
  });
});
