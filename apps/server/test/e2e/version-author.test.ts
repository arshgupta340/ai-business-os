// The version history names its author: the database version store joins users.display_name on
// created_by, as abos_app, and sets createdByName only for the owner of the version's business.
// Integration probes are faked: no provider is called.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '@abos/contracts';
import { dbAgentVersionStore } from '../../src/compose/builder-publish';
import { currentRole } from '../support/db';
import type { Providers } from '../../src/compose/providers';
import { OWNER, createWorld, type World } from './world';

// The same healthy fakes as publish-lifecycle.test.ts (not imported: that would register its tests here).
const up = async () => ({ ok: true as const, detail: 'fake probe' });
const configured = { configured: true, detail: 'configured' };
const healthyProviders: Partial<Providers> = {
  status: { square: configured, twilio: configured, openai: configured, google_calendar: configured, google_sheets: configured, message_channel: configured },
  probes: { square: up, twilio: up, openai: up, google_calendar: up, google_sheets: up, message_channel: up },
};
const PIZZA = 'biz_pizza_01';
const AGENT = 'agt_pizza_01';
const VOICE_ENV = { TWILIO_AUTH_TOKEN: 'test-twilio-token', TWILIO_ACCOUNT_SID: 'ACtest', OPENAI_API_KEY: 'test-openai-key' };

describe('version author name on the database', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld({}, VOICE_ENV);
    Object.assign(w.app.composed.providers.status, healthyProviders.status);
    Object.assign(w.app.composed.providers.probes!, healthyProviders.probes);
    await w.t.admin((q) => q.query("update public.users set display_name = 'Demo Owner' where id = 'usr_owner_01'"));
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  const versions = async () => ENDPOINTS.listAgentVersions.response.parse(
    (await w.app.inject({ url: `/api/agents/${AGENT}/versions?businessId=${PIZZA}`, headers: OWNER })).json()).items;

  it('a published version carries the owner display name in the list and in get', async () => {
    expect(await currentRole(w.t.db)).toBe('abos_app');
    const pub = await w.app.inject({ method: 'POST', url: `/api/agents/${AGENT}/publish?businessId=${PIZZA}`, headers: OWNER, payload: { confirm: true, makeLive: true } });
    expect(pub.statusCode, pub.body).toBe(200);
    const published = ENDPOINTS.publishAgent.response.parse(pub.json());
    expect(published.version).toMatchObject({ createdBy: 'usr_owner_01' });

    const listed = (await versions()).find((v) => v.id === published.version.id);
    expect(listed).toMatchObject({ createdBy: 'usr_owner_01', createdByName: 'Demo Owner' });
    expect(await dbAgentVersionStore(w.t.db).get(PIZZA, published.version.id)).toMatchObject({ createdByName: 'Demo Owner' });
    // Business scope holds: the same version is not found under another business.
    expect(await dbAgentVersionStore(w.t.db).get('biz_other_01', published.version.id)).toBeUndefined();
  });

  // created_by references users, so "no matching user" can only be a null created_by.
  const copyVersion = (id: string, version: number, createdBy: string | null) => w.t.admin((q) => q.query(
    `insert into public.agent_versions (id, business_id, agent_id, version, spec, knowledge_snapshot_ref, guardrail_version, created_by, created_at, published_at)
      select $1, business_id, agent_id, $2, spec, knowledge_snapshot_ref, guardrail_version, $3, now(), now()
      from public.agent_versions where business_id = $4 and agent_id = $5 order by version desc limit 1`, [id, version, createdBy, PIZZA, AGENT]));

  it('a version whose author is not the business owner reads without the field', async () => {
    const store = dbAgentVersionStore(w.t.db);
    await copyVersion('agv_stranger_01', (await store.maxVersion(PIZZA, AGENT)) + 1, 'usr_other_01');
    expect(await currentRole(w.t.db)).toBe('abos_app');

    const items = await versions();
    const stranger = items.find((v) => v.id === 'agv_stranger_01');
    expect(stranger).toMatchObject({ createdBy: 'usr_other_01' });
    expect('createdByName' in stranger!).toBe(false);
    expect(items.some((v) => v.createdByName === 'Demo Owner')).toBe(true);
    expect('createdByName' in (await store.get(PIZZA, 'agv_stranger_01'))!).toBe(false);
  });

  it('a version with no matching user (null created_by) reads from the store without the field', async () => {
    const store = dbAgentVersionStore(w.t.db);
    const next = (await store.maxVersion(PIZZA, AGENT)) + 1;
    await copyVersion('agv_noauthor_01', next, null);
    expect(await currentRole(w.t.db)).toBe('abos_app');

    const got = await store.get(PIZZA, 'agv_noauthor_01');
    expect(got).toMatchObject({ id: 'agv_noauthor_01', version: next });
    expect('createdByName' in got!).toBe(false);
    const listed = (await store.listByAgent(PIZZA, AGENT)).find((v) => v.id === 'agv_noauthor_01');
    expect(listed).toBeDefined();
    expect('createdByName' in listed!).toBe(false);
    // Not asserted through the HTTP list: a null created_by becomes createdBy "null" in the record,
    // which fails the contract (UserIdSchema) and the list answers 500. That predates this change and
    // needs AgentVersionRecord.createdBy to be optional in apps/server/src/builder/publish/stores.ts.
  });
});
