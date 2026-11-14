// Issue #65: the builder's seams on the in-process Postgres as abos_app.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPolicyEngine } from '../../src/policy/engine';
import { createProposeFactFromChat, dbAgentDraftStore, dbBuilderSessionStore, dbBusinessKnowledge, dbDraftFactStore, dbLiveAgentReader } from '../../src/compose/builder';
import { currentRole } from '../support/db';
import { createHarness } from '../api/harness';

let h: Awaited<ReturnType<typeof createHarness>>;
beforeAll(async () => { h = await createHarness(); }, 60_000);
afterAll(async () => { await h?.close(); });
const NOW = new Date().toISOString();

describe('builder stores on Postgres', () => {
  it('runs as abos_app', async () => { expect(await currentRole(h.db)).toBe('abos_app'); });

  it('sessions round-trip and never cross businesses', async () => {
    const store = dbBuilderSessionStore(h.db);
    const s = { id: 'bld_t1', businessId: 'biz_a', ownerId: 'usr_a', status: 'active' as const, messages: [], draftSpec: {}, missingFields: ['goal'], createdAt: NOW, updatedAt: NOW };
    await store.insert(s);
    expect(await store.get('biz_b', 'bld_t1')).toBeUndefined();
    const read = await store.get('biz_a', 'bld_t1');
    expect(read).toMatchObject({ id: 'bld_t1', ownerId: 'usr_a', missingFields: ['goal'] });
    await store.update({ ...read!, missingFields: [], draftSpec: { name: 'Pizza' } });
    expect((await store.get('biz_a', 'bld_t1'))?.draftSpec).toEqual({ name: 'Pizza' });
    await expect(store.update({ ...read!, businessId: 'biz_b' })).rejects.toThrow();
  });

  it('agents: insert, list, update the draft and keep the spec revision the builder wrote', async () => {
    const store = dbAgentDraftStore(h.db);
    const spec = { id: 'agt_t1', businessId: 'biz_a', version: 1, template: 'custom' as const, name: 'FAQ', channel: 'phone' as const, goal: 'Answer questions',
      knowledgeScopes: [], capabilities: ['business.facts.read' as const], writePolicy: 'owner_approval_each_action_bundle' as const,
      escalation: 'explain_unsupported_or_offer_callback' as const, status: 'draft' as const, guardrailVersion: 'v1' as const };
    await store.insert({ id: 'agt_t1', businessId: 'biz_a', name: 'FAQ', template: 'custom', channel: 'phone', state: 'draft', draftSpec: spec, seeded: false, specRevision: 1, createdAt: NOW, updatedAt: NOW });
    expect((await store.list('biz_a')).map((a) => a.id)).toContain('agt_t1');
    expect(await store.get('biz_b', 'agt_t1')).toBeUndefined();
    const a = (await store.get('biz_a', 'agt_t1'))!;
    await store.update({ ...a, draftSpec: { ...spec, goal: 'Answer more' }, specRevision: 2 });
    expect(await store.get('biz_a', 'agt_t1')).toMatchObject({ specRevision: 2, draftSpec: { goal: 'Answer more' }, state: 'draft' });
  });

  // Review finding 6: the template column follows the draft, so the summary and call stage agree with it.
  it('agents: an update that changes the template persists the template column', async () => {
    const store = dbAgentDraftStore(h.db);
    const spec = { id: 'agt_t2', businessId: 'biz_a', version: 1, template: 'restaurant_order_taker' as const, name: 'Pizza', channel: 'phone' as const, goal: 'Take orders',
      knowledgeScopes: [], capabilities: ['business.facts.read' as const], writePolicy: 'owner_approval_each_action_bundle' as const,
      escalation: 'explain_unsupported_or_offer_callback' as const, status: 'draft' as const, guardrailVersion: 'v1' as const };
    await store.insert({ id: 'agt_t2', businessId: 'biz_a', name: 'Pizza', template: 'restaurant_order_taker', channel: 'phone', state: 'draft', draftSpec: spec, seeded: false, specRevision: 1, createdAt: NOW, updatedAt: NOW });
    const a = (await store.get('biz_a', 'agt_t2'))!;
    await store.update({ ...a, template: 'appointment_booker', draftSpec: { ...spec, template: 'appointment_booker' }, specRevision: 2 });
    const read = (await store.get('biz_a', 'agt_t2'))!;
    expect(read.template).toBe('appointment_booker');
    expect(read.template).toBe((read.draftSpec as { template?: string }).template);
    expect((await h.db.query('select template from agents where id = $1', ['agt_t2'])).rows[0]).toEqual({ template: 'appointment_booker' });
    await expect(store.update({ ...read, businessId: 'biz_b' })).rejects.toThrow();
  });

  it('draft facts from chat are stored as drafts and listed by session', async () => {
    const store = dbDraftFactStore(h.db);
    await store.insertDraft({ id: 'fact_chat_1', businessId: 'biz_a', kind: 'policy', key: 'pickup_window', value: { minutes: 20 }, sourceType: 'owner_chat',
      sourceRef: 'bld_t1', status: 'draft', confidence: 0.9, version: 1, createdAt: NOW, updatedAt: NOW });
    await expect(store.insertDraft({ id: 'fact_chat_2', businessId: 'biz_a', kind: 'policy', key: 'x', value: 1, sourceType: 'owner_chat', status: 'verified', confidence: 1, version: 1, createdAt: NOW, updatedAt: NOW })).rejects.toThrow();
    expect((await store.listBySession('biz_a', 'bld_t1')).map((f) => [f.id, f.status, f.value])).toEqual([['fact_chat_1', 'draft', { minutes: 20 }]]);
    expect(await store.listBySession('biz_b', 'bld_t1')).toEqual([]);
  });

  it('knowledge reads the profile, verified facts, catalog count and open required conflicts', async () => {
    const ctx = await dbBusinessKnowledge(h.db).getContext('biz_a');
    expect(ctx).toMatchObject({ profile: { id: 'biz_a', category: 'restaurant', timezone: 'America/Los_Angeles' }, catalogItemCount: 3, openRequiredConflictIds: [] });
    expect(await dbBusinessKnowledge(h.db).getContext('biz_missing')).toBeUndefined();
  });

  it('live agent reader follows the live_agent table', async () => {
    const reader = dbLiveAgentReader(h.db);
    expect(await reader.isLiveAgent('biz_a', 'agt_a')).toBe(false);
    await h.db.query("insert into live_agent (phone_number, business_id, agent_id, agent_version_id) values ('+15555550188', 'biz_a', 'agt_a', 'agv_a')");
    expect(await reader.isLiveAgent('biz_a', 'agt_a')).toBe(true);
  });

  it('a chat answer becomes a fact_edit approval and nothing changes before confirmation', async () => {
    await h.insert('business_facts', { id: 'fact_hours_a', business_id: 'biz_a', kind: 'hours', key: 'fri', value: { open: '11:00', close: '22:00' }, source_type: 'seed', status: 'verified', verified_at: NOW });
    const newId = (p: string) => `${p}${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const propose = createProposeFactFromChat(createPolicyEngine(h.db, { now: () => new Date(), newId }));
    const change = await propose({ businessId: 'biz_a', ownerUserId: 'usr_a', kind: 'hours', key: 'fri', value: { open: '11:00', close: '23:00' } });
    expect(change).toMatchObject({ bundleType: 'fact_edit', approvalId: expect.stringMatching(/^apv_/) });
    expect((await h.db.query('select state, actor_type from approval_requests where id = $1', [change.approvalId])).rows[0]).toEqual({ state: 'PENDING', actor_type: 'owner' });
    expect((await h.db.query("select value from business_facts where id = 'fact_hours_a'")).rows[0]).toEqual({ value: { open: '11:00', close: '22:00' } });
  });
});
