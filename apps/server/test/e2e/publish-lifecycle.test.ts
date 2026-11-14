// Issue #96 items 1 and 2: publish, pause and rollback through the composed app reach the database as
// abos_app, survive a restart, and pause stops the phone (the live agent port reads agents.state).
// Integration probes are faked: no provider is called.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '@abos/contracts';
import { buildApp } from '../../src/app';
import { dbLiveAgentPort } from '../../src/compose/ports';
import { parseEnv } from '../../src/env';
import type { Providers } from '../../src/compose/providers';
import { OWNER, PHONE, PUBLIC_URL, createWorld, verifier, type World } from './world';

const PIZZA = 'biz_pizza_01';
const AGENT = 'agt_pizza_01';
const up = async () => ({ ok: true as const, detail: 'fake probe' });
const configured = { configured: true, detail: 'configured' };
export const healthyProviders: Partial<Providers> = {
  status: { square: configured, twilio: configured, openai: configured, google_calendar: configured, google_sheets: configured, message_channel: configured },
  probes: { square: up, twilio: up, openai: up, google_calendar: up, google_sheets: up, message_channel: up },
};
const VOICE_ENV = { TWILIO_AUTH_TOKEN: 'test-twilio-token', TWILIO_ACCOUNT_SID: 'ACtest', OPENAI_API_KEY: 'test-openai-key' };

describe('publish, pause and rollback on the database', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld({}, VOICE_ENV);
    // Keep the world's fake Square and Calendar adapters; only health is replaced.
    Object.assign(w.app.composed.providers.status, healthyProviders.status);
    Object.assign(w.app.composed.providers.probes!, healthyProviders.probes);
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  const q = (sql: string, params: unknown[]) => w.t.db.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
  const call = (url: string, payload?: unknown) => w.app.inject({ method: payload === undefined ? 'GET' : 'POST', url: `${url}?businessId=${PIZZA}`, headers: OWNER, ...(payload === undefined ? {} : { payload }) });

  it('publish writes the version, the agent row and the phone pointer; pause and rollback too; a restart keeps them', async () => {
    const [before] = await q('select active_version_id from agents where id = $1', [AGENT]);
    const priorVersion = String(before!.active_version_id);

    const pub = await call(`/api/agents/${AGENT}/publish`, { confirm: true, makeLive: true });
    expect(pub.statusCode, pub.body).toBe(200);
    const published = ENDPOINTS.publishAgent.response.parse(pub.json());
    const newVersion = published.version.id;
    expect(await q('select state, active_version_id from agents where id = $1', [AGENT])).toEqual([{ state: 'live', active_version_id: newVersion }]);
    expect(await q('select count(*)::int as n from agent_versions where id = $1', [newVersion])).toEqual([{ n: 1 }]);
    expect(await q('select agent_version_id from live_agent where phone_number = $1', [PHONE])).toEqual([{ agent_version_id: newVersion }]);
    expect(await dbLiveAgentPort(w.t.db).resolve(PHONE)).toMatchObject({ state: 'live', agentVersionId: newVersion });

    const pause = await call(`/api/agents/${AGENT}/pause`, {});
    expect(pause.statusCode, pause.body).toBe(200);
    expect(await q('select state from agents where id = $1', [AGENT])).toEqual([{ state: 'paused' }]);
    // The phone plays the closed message: the live agent port reads the paused state.
    expect(await dbLiveAgentPort(w.t.db).resolve(PHONE)).toEqual({ state: 'paused' });

    const back = await call(`/api/agents/${AGENT}/rollback`, { toVersionId: priorVersion, confirm: true });
    expect(back.statusCode, back.body).toBe(200);
    // A rollback of a paused agent moves only the active version; the agent stays paused.
    expect(await q('select state, active_version_id from agents where id = $1', [AGENT])).toEqual([{ state: 'paused', active_version_id: priorVersion }]);
    expect(await dbLiveAgentPort(w.t.db).resolve(PHONE)).toEqual({ state: 'paused' });

    // A restart: a fresh app on the same database sees the same versions and the same agent row.
    const env = parseEnv({ TWILIO_PHONE_NUMBER: PHONE, PUBLIC_SERVER_URL: PUBLIC_URL, MESSAGE_CHANNEL: 'qr_only' });
    const again = await buildApp(env, { db: w.t.db, verifier });
    try {
      const versions = ENDPOINTS.listAgentVersions.response.parse((await again.inject({ url: `/api/agents/${AGENT}/versions?businessId=${PIZZA}`, headers: OWNER })).json());
      expect(versions.items.map((v) => v.id)).toEqual(expect.arrayContaining([newVersion, priorVersion]));
      const agent = (await again.inject({ url: `/api/agents/${AGENT}?businessId=${PIZZA}`, headers: OWNER })).json() as { activeVersionId?: string };
      expect(agent.activeVersionId).toBe(priorVersion);
    } finally { await again.close(); }
  });
});
