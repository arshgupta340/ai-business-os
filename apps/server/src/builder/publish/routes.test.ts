import { ActivityEventSchema } from '@abos/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app';
import { parseEnv } from '../../env';
import { AppError } from '../../errors';
import { InMemoryConflictStore } from '../extraction/stores';
import { multipartBody, pdf, PIZZA_MENU_TEXT } from '../extraction/test-samples';
import type { BuilderPluginOptions } from '../index';
import { TEMPLATE_CAPABILITIES } from '../registry';
import { FixtureBusinessKnowledge, type BusinessContext, type BusinessKnowledge } from '../session/knowledge';
import { InMemoryAgentDraftStore, InMemoryDraftFactStore } from '../session/stores';
import type { IntegrationHealthReader } from './integrations';
import { RecordingCatalogSync, type CatalogSync } from './catalog-sync';
import { InMemoryAgentVersionStore, InMemoryLiveAgentStore, InMemoryPublishEventSink } from './stores';

// Route tests through buildApp and app.inject. buildApp registers the builder
// plugin with no options, so this file wraps the plugin module and adds the
// stores each test holds (the same defaults the plugin would make, kept here
// so the test can look at them). Recorded models, BUILDER_DEV_AUTH=1 and a
// fixed Date, as in builder/routes.test.ts.

const holder = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));
vi.mock('../index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index')>();
  const builderPlugin = async (app: never, opts: object) => actual.builderPlugin(app, { ...opts, ...holder.options } as never);
  return { ...actual, builderPlugin };
});

const AUTH = { authorization: 'Bearer test-token' };
const PIZZA = 'businessId=biz_pizza_01';
const BARBER = 'businessId=biz_barber_01';
const NUMBER = '+15555550142';

const PIZZA_SPEC = {
  template: 'restaurant_order_taker',
  name: 'Pizza Order Assistant',
  channel: 'phone',
  goal: 'Take pickup orders for the owner to approve.',
  knowledgeScopes: ['catalog', 'hours', 'order_policies'],
  capabilities: ['catalog.read', 'business.facts.read', 'order.quote', 'order.propose', 'order.status.read', 'order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append'],
  writePolicy: 'owner_approval_each_action_bundle',
  escalation: 'explain_unsupported_or_offer_callback',
  guardrailVersion: 'v1',
};
const FAQ_SPEC = { ...PIZZA_SPEC, template: 'custom', name: 'Opening Hours Line', goal: 'Answer questions about opening hours.', knowledgeScopes: ['hours', 'faq'], capabilities: ['business.facts.read'] };

interface Harness {
  app: FastifyInstance;
  agents: InMemoryAgentDraftStore;
  versions: InMemoryAgentVersionStore;
  liveAgents: InMemoryLiveAgentStore;
  events: InMemoryPublishEventSink;
  catalog: RecordingCatalogSync;
  conflicts: InMemoryConflictStore;
}

let open: FastifyInstance[] = [];

class SlowVersionStore extends InMemoryAgentVersionStore {
  override async maxVersion(businessId: string, agentId: string) {
    const max = await super.maxVersion(businessId, agentId);
    await new Promise((r) => setTimeout(r, 20));
    return max;
  }
}

// Every provider of SPEC 2.9 connected.
const ALL_UP: Awaited<ReturnType<IntegrationHealthReader['read']>> = {
  square: { state: 'connected' }, twilio: { state: 'connected' }, openai: { state: 'connected' },
  google_calendar: { state: 'connected' }, google_sheets: { state: 'connected' }, message_channel: { state: 'connected' },
};

const BOOKING_SPEC = {
  ...PIZZA_SPEC, template: 'appointment_booker', name: 'Booking Assistant', goal: 'Book appointments for the owner to approve.',
  knowledgeScopes: ['business_profile', 'hours', 'services'], capabilities: [...TEMPLATE_CAPABILITIES.appointment_booker],
};

// The fixture knowledge with one change made to the pizza business.
function pizzaKnowledge(change: (ctx: BusinessContext) => BusinessContext): BusinessKnowledge {
  const base = new FixtureBusinessKnowledge();
  return {
    async getContext(businessId) {
      const ctx = await base.getContext(businessId);
      return ctx && businessId === 'biz_pizza_01' ? change(ctx) : ctx;
    },
  };
}

async function harness(overrides: {
  syncCatalog?: CatalogSync;
  versions?: InMemoryAgentVersionStore;
  knowledge?: BusinessKnowledge;
  integrations?: IntegrationHealthReader;
  draftFacts?: InMemoryDraftFactStore;
} = {}): Promise<Harness> {
  const h = {
    agents: new InMemoryAgentDraftStore(),
    versions: overrides.versions ?? new InMemoryAgentVersionStore(),
    liveAgents: new InMemoryLiveAgentStore(NUMBER),
    events: new InMemoryPublishEventSink(),
    catalog: new RecordingCatalogSync(),
    conflicts: new InMemoryConflictStore(),
  };
  const options: Partial<BuilderPluginOptions> = {
    agents: h.agents,
    extraction: { conflicts: h.conflicts },
    publish: {
      versions: h.versions, liveAgents: h.liveAgents, events: h.events, syncCatalog: overrides.syncCatalog ?? h.catalog.sync,
      ...(overrides.integrations ? { integrations: overrides.integrations } : {}),
    },
    ...(overrides.knowledge ? { knowledge: overrides.knowledge } : {}),
    ...(overrides.draftFacts ? { draftFacts: overrides.draftFacts } : {}),
  };
  holder.options = options as Record<string, unknown>;
  const app = await buildApp(parseEnv({}));
  open.push(app);
  return { app, ...h };
}

beforeAll(() => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('BUILDER_DEV_AUTH', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('TWILIO_PHONE_NUMBER', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T19:30:00Z'));
});

afterEach(async () => {
  await Promise.all(open.map((a) => a.close()));
  open = [];
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function post(app: FastifyInstance, url: string, payload: unknown = {}) {
  return app.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });
}
function get(app: FastifyInstance, url: string) {
  return app.inject({ method: 'GET', url, headers: AUTH });
}

async function createAgent(h: Harness, spec: object = PIZZA_SPEC, query = PIZZA): Promise<string> {
  const res = await post(h.app, `/api/agents?${query}`, { spec });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function publish(h: Harness, id: string, body: object = { confirm: true, makeLive: true }, query = PIZZA) {
  return post(h.app, `/api/agents/${id}/publish?${query}`, body);
}

// Changes the draft as the builder interview would, through the store.
async function editDraft(h: Harness, id: string, goal: string, businessId = 'biz_pizza_01') {
  const agent = (await h.agents.get(businessId, id))!;
  agent.draftSpec = { ...agent.draftSpec, goal };
  agent.specRevision += 1;
  await h.agents.update(agent);
}

describe('publish: confirm and validation', () => {
  it('refuses without confirm: true, and changes nothing', async () => {
    const h = await harness();
    const id = await createAgent(h);
    for (const body of [{}, { confirm: false }, { confirm: 'true' }, { makeLive: true }, { confirm: true, extra: 1 }]) {
      const res = await publish(h, id, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
    }
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json()).toMatchObject({ state: 'draft', isLiveAgent: false });
    expect(await h.versions.listByAgent('biz_pizza_01', id)).toHaveLength(0);
    expect(h.events.events).toHaveLength(0);
    expect(h.catalog.calls).toHaveLength(0);
    expect(await h.liveAgents.get()).toBeUndefined();
  });

  it('is blocked by an open required conflict from an upload, and goes through once it is resolved', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const body = multipartBody({ fileName: 'menu.pdf', mime: 'application/pdf', bytes: pdf(PIZZA_MENU_TEXT) });
    const up = await h.app.inject({ method: 'POST', url: '/api/businesses/biz_pizza_01/files', headers: { ...AUTH, 'content-type': body.contentType }, payload: body.payload });
    expect(up.statusCode).toBe(202);
    let file;
    for (let i = 0; i < 200; i++) {
      file = (await get(h.app, `/api/files/${up.json().file.id}?${PIZZA}`)).json();
      if (file.extractionState === 'EXTRACTED' || file.extractionState === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(file.extractionState).toBe('EXTRACTED');
    expect(file.conflictIds).toHaveLength(1);
    const conflictId = file.conflictIds[0];

    const blocked = await publish(h, id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'CONFLICT_UNRESOLVED', details: { conflictIds: [conflictId] } });
    expect(await h.versions.listByAgent('biz_pizza_01', id)).toHaveLength(0);
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().state).toBe('draft');

    const resolved = await post(h.app, `/api/conflicts/${conflictId}/resolve?${PIZZA}`, { resolution: 'keep_authoritative' });
    expect(resolved.statusCode).toBe(200);
    const ok = await publish(h, id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ agent: { id, state: 'live', isLiveAgent: true }, version: { agentId: id, version: 1 } });
  });

  it('refuses a capability set that breaks a rule, or names a write capability on its own, with CAPABILITY_NOT_ALLOWED', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const bad = [
      [...PIZZA_SPEC.capabilities, 'catalog.price.update'],
      ['business.facts.read', 'order.checkout.prepare'],
      ['catalog.read', 'publish_agent'],
    ];
    for (const capabilities of bad) {
      const agent = (await h.agents.get('biz_pizza_01', id))!;
      agent.draftSpec = { ...agent.draftSpec, capabilities: capabilities as never };
      await h.agents.update(agent);
      const res = await publish(h, id);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('CAPABILITY_NOT_ALLOWED');
      expect(res.json().details.issues.length).toBeGreaterThan(0);
    }
    expect(await h.versions.listByAgent('biz_pizza_01', id)).toHaveLength(0);
    expect(h.events.events).toHaveLength(0);
  });

  it('syncs the catalog through the injected function, and maps its failure to the documented errors', async () => {
    const ok = await harness();
    const id = await createAgent(ok);
    expect((await publish(ok, id)).statusCode).toBe(200);
    expect(ok.catalog.calls).toEqual([expect.objectContaining({ businessId: 'biz_pizza_01', agentId: id })]);

    const failing = await harness({ syncCatalog: async () => Promise.reject(new Error('square said: token sq0atp-secret is wrong')) });
    const id2 = await createAgent(failing);
    const res = await publish(failing, id2);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', retryable: true, details: { provider: 'square' } });
    expect(res.body).not.toContain('sq0atp');
    expect(await failing.versions.listByAgent('biz_pizza_01', id2)).toHaveLength(0);

    const notSandbox = await harness({ syncCatalog: async () => Promise.reject(new AppError('ENVIRONMENT_MISMATCH', 'x', 503)) });
    const id3 = await createAgent(notSandbox);
    expect((await publish(notSandbox, id3)).json()).toMatchObject({ code: 'ENVIRONMENT_MISMATCH', retryable: false });

    const synced = await harness({ syncCatalog: async () => ({ syncedAt: '2026-11-13T19:29:00Z' }) });
    const id4 = await createAgent(synced);
    const v = (await publish(synced, id4)).json().version;
    expect(v.knowledgeSnapshotRef.catalogSyncedAt).toBe('2026-11-13T19:29:00Z');
    expect(v.knowledgeSnapshotRef.facts.length).toBeGreaterThan(0);
  });
});

describe('publish: versions are immutable and numbered', () => {
  it('stores a deep frozen copy that later draft edits never change', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const first = (await publish(h, id)).json();
    expect(first.version).toMatchObject({ version: 1, createdBy: 'usr_owner_01', publishedAt: '2026-11-13T19:30:00Z' });
    expect(first.version.spec).toMatchObject({ id, businessId: 'biz_pizza_01', version: 1, status: 'live', goal: PIZZA_SPEC.goal });

    await editDraft(h, id, 'A different goal.');
    const stored = (await h.versions.get('biz_pizza_01', first.version.id))!;
    expect(stored.spec.goal).toBe(PIZZA_SPEC.goal);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.spec)).toBe(true);
    expect(Object.isFrozen(stored.spec.capabilities)).toBe(true);
    expect(() => {
      (stored.spec as { goal: string }).goal = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (stored.spec.capabilities as string[]).push('catalog.price.update');
    }).toThrow(TypeError);

    const second = (await publish(h, id)).json();
    expect(second.version).toMatchObject({ version: 2, spec: { goal: 'A different goal.', version: 2 } });
    const list = (await get(h.app, `/api/agents/${id}/versions?${PIZZA}`)).json();
    expect(list.items.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(list.items[1]).toEqual(first.version);
  });

  it('two publishes at the same time get versions 1 and 2, never the same number', async () => {
    // A version store that waits between reading the highest number and
    // returning it, so the second publish runs while the first is half way.
    // Without the per-agent lock both would read 0 and write version 1.
    const h = await harness({ versions: new SlowVersionStore() });
    const id = await createAgent(h);
    const [a, b] = await Promise.all([publish(h, id), publish(h, id)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().version.version, b.json().version.version].sort()).toEqual([1, 2]);
    const versions = await h.versions.listByAgent('biz_pizza_01', id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    const agent = (await get(h.app, `/api/agents/${id}?${PIZZA}`)).json();
    expect(agent).toMatchObject({ state: 'live', activeVersionId: versions[0]!.id, activeVersion: { id: versions[0]!.id, version: 2 } });
    expect((await h.liveAgents.get())?.agentVersionId).toBe(versions[0]!.id);
    expect(h.events.events.filter((e) => e.type === 'agent.published')).toHaveLength(2);
  });

  it('publishing a live agent with an unchanged draft writes a new version', async () => {
    const h = await harness();
    const id = await createAgent(h);
    await publish(h, id);
    const again = (await publish(h, id)).json();
    expect(again.version.version).toBe(2);
  });
});

describe('publish: makeLive and events', () => {
  it('makeLive true moves the number and writes live_agent.changed; false leaves it', async () => {
    const h = await harness();
    const pizza = await createAgent(h);
    const res = await publish(h, pizza, { confirm: true, makeLive: true });
    expect(res.json()).toMatchObject({ agent: { state: 'live', isLiveAgent: true }, phoneNumber: NUMBER });
    const v1 = res.json().version.id;
    expect(await h.liveAgents.get()).toEqual({ phoneNumber: NUMBER, businessId: 'biz_pizza_01', agentId: pizza, agentVersionId: v1, updatedAt: '2026-11-13T19:30:00Z' });
    expect(h.events.events.map((e) => [e.type, e.payload])).toEqual([
      ['live_agent.changed', { phoneNumberLast4: '0142', agentId: pizza, agentVersionId: v1 }],
      ['agent.published', { agentId: pizza, agentVersionId: v1, version: 1, phoneNumberLast4: '0142' }],
    ]);
    expect(h.events.events[0]).toMatchObject({ businessId: 'biz_pizza_01', actorType: 'owner', correlationId: pizza });

    // makeLive false on another agent: live, but the number stays where it was.
    const faq = await createAgent(h, FAQ_SPEC, BARBER);
    h.events.events.length = 0;
    const quiet = await publish(h, faq, { confirm: true, makeLive: false }, BARBER);
    expect(quiet.statusCode).toBe(200);
    // The package's PublishResponse always carries the number; isLiveAgent says this agent does not answer it.
    expect(quiet.json().phoneNumber).toBe(NUMBER);
    expect(quiet.json().agent).toMatchObject({ state: 'live', isLiveAgent: false });
    expect(h.events.events.map((e) => e.type)).toEqual(['agent.published']);
    expect(h.events.events[0]!.payload).toEqual({ agentId: faq, agentVersionId: quiet.json().version.id, version: 1 });
    expect((await h.liveAgents.get())?.agentId).toBe(pizza);

    // makeLive false on the agent that answers: the number follows its new version.
    h.events.events.length = 0;
    const follow = (await publish(h, pizza, { confirm: true, makeLive: false })).json();
    expect(follow.phoneNumber).toBe(NUMBER);
    expect((await h.liveAgents.get())?.agentVersionId).toBe(follow.version.id);
    expect(h.events.events.map((e) => e.type)).toEqual(['live_agent.changed', 'agent.published']);

    // makeLive true on the other agent: the number moves, previousAgentId names the old one.
    h.events.events.length = 0;
    const moved = (await publish(h, faq, { confirm: true, makeLive: true }, BARBER)).json();
    expect(h.events.events[0]).toMatchObject({ type: 'live_agent.changed', businessId: 'biz_barber_01', payload: { agentId: faq, agentVersionId: moved.version.id, previousAgentId: pizza } });
    expect((await get(h.app, `/api/agents/${pizza}?${PIZZA}`)).json().isLiveAgent).toBe(false);
    expect((await get(h.app, `/api/agents/${faq}?${BARBER}`)).json().isLiveAgent).toBe(true);
  });

  it('events carry IDs and the last four digits only', async () => {
    const h = await harness();
    const id = await createAgent(h);
    await publish(h, id);
    await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    const text = JSON.stringify(h.events.events);
    expect(text).not.toContain(NUMBER);
    expect(text).not.toContain(PIZZA_SPEC.goal);
    const allowed: Record<string, string[]> = {
      'agent.published': ['agentId', 'agentVersionId', 'version', 'phoneNumberLast4', 'rolledBackFrom'],
      'agent.paused': ['agentId'],
      'live_agent.changed': ['phoneNumberLast4', 'agentId', 'agentVersionId', 'previousAgentId'],
    };
    for (const e of h.events.events) for (const key of Object.keys(e.payload)) expect(allowed[e.type]).toContain(key);
    // And each one matches the package's ActivityEventSchema.
    for (const e of h.events.events) expect(ActivityEventSchema.safeParse(e).success).toBe(true);
  });
});

describe('pause', () => {
  it('pauses a live agent, keeps the live_agent row, and answers INVALID_STATE for transitions the state machine does not list', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const draftPause = await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    expect(draftPause.statusCode).toBe(409);
    expect(draftPause.json()).toMatchObject({ code: 'INVALID_STATE', details: { state: 'draft' } });

    const v1 = (await publish(h, id)).json().version.id;
    const pointer = await h.liveAgents.get();
    h.events.events.length = 0;
    const paused = await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    expect(paused.statusCode).toBe(200);
    // The package's pauseAgent response is the Agent itself, not { agent }.
    expect(paused.json()).toMatchObject({ id, state: 'paused', activeVersionId: v1, isLiveAgent: true });
    expect(h.events.events.map((e) => [e.type, e.payload])).toEqual([['agent.paused', { agentId: id }]]);
    expect(await h.liveAgents.get()).toEqual(pointer);

    const again = await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    expect(again.json()).toMatchObject({ code: 'INVALID_STATE', details: { state: 'paused' } });
    expect((await post(h.app, `/api/agents/${id}/pause?${PIZZA}`, { reason: 'x' })).json().code).toBe('VALIDATION_FAILED');
  });

  it('publishing a paused agent with an unchanged draft reactivates the same version; a changed draft writes a new one', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id)).json().version;
    await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    const resumed = (await publish(h, id)).json();
    expect(resumed.agent).toMatchObject({ state: 'live', activeVersionId: v1.id });
    expect(resumed.version).toEqual(v1);
    expect(await h.versions.listByAgent('biz_pizza_01', id)).toHaveLength(1);

    await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    await editDraft(h, id, 'New goal after a pause.');
    const changed = (await publish(h, id)).json();
    expect(changed.version.version).toBe(2);
    expect(changed.agent.state).toBe('live');
  });
});

describe('business scope', () => {
  it('another business sees NOT_FOUND on every route, and no token is UNAUTHENTICATED', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id)).json().version.id;
    const calls = [
      post(h.app, `/api/agents/${id}/publish?${BARBER}`, { confirm: true, makeLive: true }),
      post(h.app, `/api/agents/${id}/pause?${BARBER}`),
      get(h.app, `/api/agents/${id}/versions?${BARBER}`),
      post(h.app, `/api/agents/${id}/rollback?${BARBER}`, { toVersionId: v1, confirm: true }),
      post(h.app, `/api/agents/agt_doesnotexist/publish?${PIZZA}`, { confirm: true }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    }
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().state).toBe('live');
    const anon = await h.app.inject({ method: 'POST', url: `/api/agents/${id}/publish?${PIZZA}`, payload: { confirm: true } });
    expect(anon.statusCode).toBe(401);
  });
});

describe('versions list', () => {
  it('lists full specs newest first, with paging', async () => {
    const h = await harness();
    const id = await createAgent(h);
    for (const goal of ['Goal one.', 'Goal two.', 'Goal three.']) {
      await editDraft(h, id, goal);
      await publish(h, id);
    }
    const page1 = (await get(h.app, `/api/agents/${id}/versions?${PIZZA}&limit=2`)).json();
    expect(page1.items.map((v: { version: number }) => v.version)).toEqual([3, 2]);
    expect(page1.items[0].spec).toMatchObject({ goal: 'Goal three.', capabilities: PIZZA_SPEC.capabilities });
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (await get(h.app, `/api/agents/${id}/versions?${PIZZA}&limit=2&cursor=${page1.nextCursor}`)).json();
    expect(page2.items.map((v: { version: number; spec: { goal: string } }) => [v.version, v.spec.goal])).toEqual([[1, 'Goal one.']]);
    expect(page2.nextCursor).toBeUndefined();
    expect((await get(h.app, `/api/agents/${id}/versions?${PIZZA}&cursor=nope`)).json().code).toBe('VALIDATION_FAILED');
    const draft = await createAgent(h);
    expect((await get(h.app, `/api/agents/${draft}/versions?${PIZZA}`)).json()).toEqual({ items: [] });
  });
});

describe('rollback', () => {
  it('points the active version back at the earlier one, writes no row, and writes agent.published with rolledBackFrom', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id)).json().version;
    await editDraft(h, id, 'Second goal.');
    const v2 = (await publish(h, id)).json().version;
    const before = (await get(h.app, `/api/agents/${id}/versions?${PIZZA}`)).json().items;
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().activeVersionId).toBe(v2.id);
    h.events.events.length = 0;

    const res = await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true });
    expect(res.statusCode).toBe(200);
    // Same shape as publish. The version is the earlier one, unchanged.
    expect(res.json().version).toEqual(v1);
    expect(res.json()).toMatchObject({ agent: { state: 'live', activeVersionId: v1.id, activeVersion: v1, isLiveAgent: true }, phoneNumber: NUMBER });
    expect(h.events.events.map((e) => [e.type, e.payload])).toEqual([
      ['live_agent.changed', { phoneNumberLast4: '0142', agentId: id, agentVersionId: v1.id, previousAgentId: id }],
      ['agent.published', { agentId: id, agentVersionId: v1.id, version: 1, phoneNumberLast4: '0142', rolledBackFrom: v2.id }],
    ]);
    expect((await h.liveAgents.get())?.agentVersionId).toBe(v1.id);

    // History is exactly as it was: same length, same rows. Only the active marker moved.
    const after = (await get(h.app, `/api/agents/${id}/versions?${PIZZA}`)).json().items;
    expect(after).toHaveLength(before.length);
    expect(after).toEqual(before);
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().activeVersionId).toBe(v1.id);
    // The draft spec is not touched by a rollback.
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().draftSpec.goal).toBe('Second goal.');
  });

  it('a publish after a rollback gets the next unused number', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id)).json().version;
    await editDraft(h, id, 'Second goal.');
    const v2 = (await publish(h, id)).json().version;
    await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true });
    await editDraft(h, id, 'Third goal.');
    const v3 = (await publish(h, id)).json().version;
    expect(v3.version).toBe(3);
    const list = (await get(h.app, `/api/agents/${id}/versions?${PIZZA}`)).json().items;
    expect(list.map((v: { id: string; version: number }) => [v.id, v.version])).toEqual([
      [v3.id, 3],
      [v2.id, 2],
      [v1.id, 1],
    ]);
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().activeVersionId).toBe(v3.id);
  });

  it('refuses the active version by ID, a draft agent, a missing confirm, another agent version and an open required conflict', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id)).json().version;
    const active = await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ code: 'INVALID_STATE', details: { state: 'live', activeVersionId: v1.id } });

    // An unchanged republish makes v2 with the same spec as v1. Only the ID decides
    // "already active", so rolling back from v2 to v1 is allowed.
    const v2 = (await publish(h, id)).json().version;
    expect((await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id })).json().code).toBe('VALIDATION_FAILED');
    expect((await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: false })).json().code).toBe('VALIDATION_FAILED');
    expect((await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true })).statusCode).toBe(200);
    expect((await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true })).json().code).toBe('INVALID_STATE');

    const draft = await createAgent(h);
    expect((await post(h.app, `/api/agents/${draft}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true })).json()).toMatchObject({ code: 'INVALID_STATE', details: { state: 'draft' } });

    const other = await createAgent(h);
    const otherV1 = (await publish(h, other, { confirm: true, makeLive: false })).json().version;
    expect((await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: otherV1.id, confirm: true })).json().code).toBe('NOT_FOUND');

    await h.conflicts.insert({
      id: 'cfl_test_01',
      businessId: 'biz_pizza_01',
      kind: 'menu_item',
      key: 'margherita:large',
      required: true,
      state: 'open',
      candidates: [
        { sourceType: 'upload', value: { priceMinor: 100 } },
        { sourceType: 'square', value: { priceMinor: 2100 } },
      ],
      createdAt: '2026-11-13T19:30:00Z',
    } as never);
    const blocked = await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v2.id, confirm: true });
    expect(blocked.json()).toMatchObject({ code: 'CONFLICT_UNRESOLVED', details: { conflictIds: ['cfl_test_01'] } });
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().activeVersionId).toBe(v1.id);
  });

  // SPEC 2.9 (proposed row): rollback moves only the active version. This
  // replaces the earlier test in which a paused agent went live on rollback.
  it('a paused agent stays paused on rollback: only the active version moves, and the number does not move to it', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id, { confirm: true, makeLive: false })).json().version;
    await editDraft(h, id, 'Second goal.');
    const v2 = (await publish(h, id, { confirm: true, makeLive: false })).json().version;
    await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    h.events.events.length = 0;
    const res = (await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true })).json();
    expect(res.agent).toMatchObject({ state: 'paused', activeVersionId: v1.id, isLiveAgent: false });
    expect(res.phoneNumber).toBe(NUMBER);
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json()).toMatchObject({ state: 'paused', activeVersionId: v1.id });
    expect(h.events.events.map((e) => e.type)).toEqual(['agent.published']);
    expect(await h.liveAgents.get()).toBeUndefined();

    // makeLive would move the number to a paused agent: refused, and nothing changes.
    const moved = await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v2.id, confirm: true, makeLive: true });
    expect(moved.json()).toMatchObject({ code: 'INVALID_STATE' });
    expect(await h.liveAgents.get()).toBeUndefined();
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json()).toMatchObject({ state: 'paused', activeVersionId: v1.id });
  });

  // API.md 3.4: a paused agent stays paused, and the number follows only if
  // the agent is live. This replaces the test in which the number followed a
  // paused agent's rollback.
  it('a paused agent that answers the number stays paused on rollback, and the number does not move', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id, { confirm: true, makeLive: true })).json().version;
    await editDraft(h, id, 'Second goal.');
    const v2 = (await publish(h, id, { confirm: true, makeLive: true })).json().version;
    await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    const pointer = await h.liveAgents.get();
    expect(pointer).toMatchObject({ agentId: id, agentVersionId: v2.id });
    h.events.events.length = 0;
    const res = (await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true })).json();
    expect(res.agent).toMatchObject({ state: 'paused', activeVersionId: v1.id, isLiveAgent: true });
    expect(await h.liveAgents.get()).toEqual(pointer);
    expect(h.events.events.map((e) => [e.type, e.payload])).toEqual([
      ['agent.published', { agentId: id, agentVersionId: v1.id, version: 1, rolledBackFrom: v2.id }],
    ]);
  });

  it('after a paused rollback, the next publish moves the number to the version active then', async () => {
    // Reactivation: the draft is set back to v1's content, so publish reuses v1.
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id, { confirm: true, makeLive: true })).json().version;
    await editDraft(h, id, 'Second goal.');
    const v2 = (await publish(h, id, { confirm: true, makeLive: true })).json().version;
    await post(h.app, `/api/agents/${id}/pause?${PIZZA}`);
    await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true });
    await editDraft(h, id, PIZZA_SPEC.goal);
    h.events.events.length = 0;
    const resumed = (await publish(h, id, { confirm: true, makeLive: false })).json();
    expect(resumed.version.id).toBe(v1.id);
    expect(resumed.agent).toMatchObject({ state: 'live', activeVersionId: v1.id, isLiveAgent: true });
    expect(await h.liveAgents.get()).toMatchObject({ agentId: id, agentVersionId: v1.id });
    expect(h.events.events.map((e) => [e.type, e.payload])).toEqual([
      ['live_agent.changed', { phoneNumberLast4: '0142', agentId: id, agentVersionId: v1.id, previousAgentId: id }],
      ['agent.published', { agentId: id, agentVersionId: v1.id, version: 1, phoneNumberLast4: '0142' }],
    ]);

    // A changed draft: publish writes v3 and the number follows it.
    const h2 = await harness();
    const id2 = await createAgent(h2);
    const w1 = (await publish(h2, id2, { confirm: true, makeLive: true })).json().version;
    await editDraft(h2, id2, 'Second goal.');
    const w2 = (await publish(h2, id2, { confirm: true, makeLive: true })).json().version;
    await post(h2.app, `/api/agents/${id2}/pause?${PIZZA}`);
    await post(h2.app, `/api/agents/${id2}/rollback?${PIZZA}`, { toVersionId: w1.id, confirm: true });
    expect((await h2.liveAgents.get())?.agentVersionId).toBe(w2.id);
    const w3 = (await publish(h2, id2, { confirm: true, makeLive: false })).json().version;
    expect(w3.version).toBe(3);
    expect(await h2.liveAgents.get()).toMatchObject({ agentId: id2, agentVersionId: w3.id });
  });

  it('an open required conflict that only the database knowledge reports blocks a rollback, as it blocks a publish', async () => {
    let conflicts: string[] = [];
    const h = await harness({ knowledge: pizzaKnowledge((ctx) => ({ ...ctx, openRequiredConflictIds: conflicts })) });
    const id = await createAgent(h);
    const v1 = (await publish(h, id)).json().version;
    await editDraft(h, id, 'Second goal.');
    const v2 = (await publish(h, id)).json().version;
    conflicts = ['cfl_db_02'];
    h.events.events.length = 0;
    const blocked = await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'CONFLICT_UNRESOLVED', details: { conflictIds: ['cfl_db_02'] } });
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().activeVersionId).toBe(v2.id);
    expect((await h.liveAgents.get())?.agentVersionId).toBe(v2.id);
    expect(h.events.events).toHaveLength(0);
    conflicts = [];
    expect((await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true })).statusCode).toBe(200);
  });

  it('rollback with makeLive true (in the package RollbackBodySchema) moves the number to the agent', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const v1 = (await publish(h, id, { confirm: true, makeLive: false })).json().version;
    await editDraft(h, id, 'Second goal.');
    const v2 = (await publish(h, id, { confirm: true, makeLive: false })).json().version;
    h.events.events.length = 0;
    const res = (await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v1.id, confirm: true, makeLive: true })).json();
    expect(res).toMatchObject({ agent: { state: 'live', activeVersionId: v1.id, isLiveAgent: true }, phoneNumber: NUMBER });
    expect(h.events.events.map((e) => [e.type, e.payload])).toEqual([
      ['live_agent.changed', { phoneNumberLast4: '0142', agentId: id, agentVersionId: v1.id }],
      ['agent.published', { agentId: id, agentVersionId: v1.id, version: 1, phoneNumberLast4: '0142', rolledBackFrom: v2.id }],
    ]);
  });
});

describe('a published version is immutable (no call is run here)', () => {
  it('a version read before a publish and a rollback is unchanged after them', async () => {
    const h = await harness();
    const id = await createAgent(h);
    const pinnedId = (await publish(h, id)).json().version.id;
    // What a call that started now would hold: the version by its ID.
    const pinned = (await h.versions.get('biz_pizza_01', pinnedId))!;
    const before = JSON.stringify(pinned);

    await editDraft(h, id, 'Changed while a call is in progress.');
    const v2 = (await publish(h, id)).json().version;
    await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: pinnedId, confirm: true });
    await post(h.app, `/api/agents/${id}/rollback?${PIZZA}`, { toVersionId: v2.id, confirm: true });

    expect(JSON.stringify(pinned)).toBe(before);
    expect(JSON.stringify(await h.versions.get('biz_pizza_01', pinnedId))).toBe(before);
    expect((await h.versions.listByAgent('biz_pizza_01', id)).map((v) => v.version)).toEqual([2, 1]);
  });
});

describe('publish: stop conditions (FLOWS.md, Builder stop conditions)', () => {
  it('a missing time zone, a missing consent policy and an empty catalog are VALIDATION_FAILED with one issue per stop condition code', async () => {
    const knowledge = pizzaKnowledge((ctx) => ({
      ...ctx,
      profile: { id: ctx.profile.id, name: ctx.profile.name, category: ctx.profile.category },
      catalogItemCount: 0,
      verifiedFacts: ctx.verifiedFacts.filter((f) => !(f.kind === 'policy' && f.key === 'message_consent')),
    }));
    const h = await harness({ knowledge });
    const id = await createAgent(h);
    const res = await publish(h, id);
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.issues.map((i: { code: string }) => i.code).sort()).toEqual(['empty_catalog', 'missing_message_consent_policy', 'missing_timezone']);
    for (const issue of body.details.issues) expect(issue).toMatchObject({ path: issue.code, message: expect.any(String) });
    expect(await h.versions.listByAgent('biz_pizza_01', id)).toHaveLength(0);
    expect((await get(h.app, `/api/agents/${id}?${PIZZA}`)).json().state).toBe('draft');
    expect(h.events.events).toHaveLength(0);
  });

  it('each of the three alone is reported with its own code', async () => {
    const cases: [string, (ctx: BusinessContext) => BusinessContext][] = [
      ['missing_timezone', (ctx) => ({ ...ctx, profile: { id: ctx.profile.id, name: ctx.profile.name, category: ctx.profile.category } })],
      ['missing_message_consent_policy', (ctx) => ({ ...ctx, verifiedFacts: ctx.verifiedFacts.filter((f) => f.key !== 'message_consent') })],
      ['empty_catalog', (ctx) => ({ ...ctx, catalogItemCount: 0 })],
    ];
    for (const [code, change] of cases) {
      const h = await harness({ knowledge: pizzaKnowledge(change) });
      const id = await createAgent(h);
      const res = await publish(h, id);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ code }] } });
      expect(res.json().details.issues).toHaveLength(1);
    }
  });

  it('a required fact that is not verified (the pickup window) is VALIDATION_FAILED with missing_required_fact; with it verified, the agent publishes', async () => {
    const h = await harness({ knowledge: pizzaKnowledge((ctx) => ({ ...ctx, verifiedFacts: ctx.verifiedFacts.filter((f) => f.key !== 'pickup_window') })) });
    const id = await createAgent(h);
    const res = await publish(h, id);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(res.json().details.issues).toEqual([
      { path: 'policy.pickup_window', code: 'missing_required_fact', message: 'The agent needs a confirmed answer for the pickup window.' },
    ]);
    expect(await h.versions.listByAgent('biz_pizza_01', id)).toHaveLength(0);
    expect(h.events.events).toHaveLength(0);

    const full = await harness();
    const ok = await publish(full, await createAgent(full));
    expect(ok.statusCode).toBe(200);
  });

  it('every missing required fact is reported, next to the other codes, and name and goal are left to spec validation', async () => {
    const knowledge = pizzaKnowledge((ctx) => ({
      ...ctx,
      profile: { id: ctx.profile.id, name: ctx.profile.name, category: ctx.profile.category },
      verifiedFacts: ctx.verifiedFacts.filter((f) => !(f.kind === 'hours' && (f.key === 'mon' || f.key === 'sun')) && f.key !== 'special_requests'),
    }));
    const h = await harness({ knowledge });
    const id = await createAgent(h);
    const issues = (await publish(h, id)).json().details.issues as { path: string; code: string }[];
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ['missing_timezone', 'missing_timezone'],
      ['missing_required_fact', 'hours.mon'],
      ['missing_required_fact', 'hours.sun'],
      ['missing_required_fact', 'policy.special_requests'],
    ]);
  });

  it('a booking agent without verified services or notice is refused with both fields', async () => {
    const knowledge: BusinessKnowledge = {
      async getContext(businessId) {
        const ctx = await new FixtureBusinessKnowledge().getContext(businessId);
        return ctx && { ...ctx, verifiedFacts: ctx.verifiedFacts.filter((f) => f.kind !== 'service' && f.key !== 'min_notice') };
      },
    };
    const h = await harness({ knowledge });
    const id = await createAgent(h, BOOKING_SPEC, BARBER);
    const res = await publish(h, id, { confirm: true, makeLive: false }, BARBER);
    expect(res.json().details.issues.map((i: { path: string }) => i.path)).toEqual(['services', 'policy.min_notice']);
  });

  it('a consent policy is not needed by an agent that sends no messages', async () => {
    const h = await harness({ knowledge: pizzaKnowledge((ctx) => ({ ...ctx, verifiedFacts: ctx.verifiedFacts.filter((f) => f.key !== 'message_consent') })) });
    const id = await createAgent(h, FAQ_SPEC);
    expect((await publish(h, id)).statusCode).toBe(200);
  });

  it('a required integration that is down is INTEGRATION_UNAVAILABLE; degraded or unrelated providers do not stop it', async () => {
    let health: Awaited<ReturnType<IntegrationHealthReader['read']>> = { ...ALL_UP, square: { state: 'disconnected' } };
    const integrations: IntegrationHealthReader = { read: async () => health };
    const h = await harness({ integrations });
    const id = await createAgent(h);
    const down = await publish(h, id);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', retryable: true, details: { provider: 'square', providers: ['square'] } });
    expect(await h.versions.listByAgent('biz_pizza_01', id)).toHaveLength(0);

    // The FAQ agent needs no provider, so a disconnected Square does not stop it.
    const faq = await createAgent(h, FAQ_SPEC);
    expect((await publish(h, faq, { confirm: true, makeLive: false })).statusCode).toBe(200);

    health = { ...ALL_UP, square: { state: 'degraded' }, google_calendar: { state: 'disconnected' } };
    expect((await publish(h, id)).statusCode).toBe(200);
  });

  it('without an integration reader, publish does not check integrations', async () => {
    const h = await harness();
    const id = await createAgent(h);
    expect((await publish(h, id)).statusCode).toBe(200);
  });

  it('an open required conflict the knowledge reports stays CONFLICT_UNRESOLVED', async () => {
    const h = await harness({ knowledge: pizzaKnowledge((ctx) => ({ ...ctx, openRequiredConflictIds: ['cfl_db_01'] })) });
    const id = await createAgent(h);
    const res = await publish(h, id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'CONFLICT_UNRESOLVED', details: { conflictIds: ['cfl_db_01'] } });
  });

  it('an unrelated unconfirmed chat draft (pickup window, already verified) does not stop a publish', async () => {
    const draftFacts = new InMemoryDraftFactStore();
    await draftFacts.insertDraft({
      id: 'fact_chat_draft_01', businessId: 'biz_pizza_01', kind: 'policy', key: 'pickup_window', value: { text: '30 minutes' },
      sourceType: 'owner_chat', sourceRef: 'bld_test_01', status: 'draft', confidence: 0.8, version: 1,
      createdAt: '2026-11-13T19:00:00Z', updatedAt: '2026-11-13T19:00:00Z',
    });
    const h = await harness({ draftFacts });
    const id = await createAgent(h);
    expect((await publish(h, id)).statusCode).toBe(200);
    expect(await draftFacts.listBySession('biz_pizza_01', 'bld_test_01')).toHaveLength(1);
  });
});

describe('review of 07389a0: publish stop conditions', () => {
  it('finding 5: a phone agent needs the voice provider and the model, even with no capability that names them', async () => {
    const h = await harness({ integrations: { read: async () => ({ ...ALL_UP, twilio: { state: 'disconnected' }, openai: { state: 'disconnected' } }) } });
    const id = await createAgent(h, FAQ_SPEC);
    const res = await publish(h, id);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', details: { providers: ['twilio', 'openai'] } });
    expect(await h.versions.listByAgent('biz_pizza_01', id)).toHaveLength(0);
  });

  it('finding 5: an ordering agent needs Square and a booking agent needs Calendar', async () => {
    const h = await harness({ integrations: { read: async () => ({ ...ALL_UP, square: { state: 'disconnected' }, google_calendar: { state: 'disconnected' } }) } });
    const pizza = await createAgent(h);
    expect((await publish(h, pizza)).json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', details: { providers: ['square'] } });
    const booking = await createAgent(h, BOOKING_SPEC, BARBER);
    expect((await publish(h, booking, { confirm: true, makeLive: false }, BARBER)).json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', details: { providers: ['google_calendar'] } });
  });

  it('finding 5: a health result that leaves out a required provider is INTEGRATION_UNAVAILABLE', async () => {
    const { square: _square, ...withoutSquare } = ALL_UP;
    const h = await harness({ integrations: { read: async () => withoutSquare } });
    const id = await createAgent(h);
    expect((await publish(h, id)).json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', details: { providers: ['square'] } });
  });

  it('finding 6: a non-empty catalog passes; the builder does not claim a mandatory-price check', async () => {
    const h = await harness({ knowledge: pizzaKnowledge((ctx) => ({ ...ctx, catalogItemCount: 1 })) });
    const id = await createAgent(h);
    expect((await publish(h, id)).statusCode).toBe(200);
  });

  it('finding 7: a malformed stored draft is the contract error, with no version, state change or event', async () => {
    const bad: [string, (spec: Record<string, unknown>) => Record<string, unknown>][] = [
      ['object capabilities', (spec) => ({ ...spec, capabilities: {} })],
      ['string capabilities', (spec) => ({ ...spec, capabilities: 'catalog.read' })],
      ['null capabilities', (spec) => ({ ...spec, capabilities: null })],
      ['no template', ({ template: _t, ...spec }) => spec],
    ];
    for (const [label, change] of bad) {
      const h = await harness();
      const id = await createAgent(h);
      const agent = (await h.agents.get('biz_pizza_01', id))!;
      await h.agents.update({ ...agent, draftSpec: change(agent.draftSpec as unknown as Record<string, unknown>) as unknown as typeof agent.draftSpec });
      const res = await publish(h, id);
      expect(res.statusCode, label).toBeLessThan(500);
      expect(['VALIDATION_FAILED', 'CAPABILITY_NOT_ALLOWED'], label).toContain(res.json().code);
      expect(await h.versions.listByAgent('biz_pizza_01', id), label).toHaveLength(0);
      expect((await h.agents.get('biz_pizza_01', id))!.state, label).toBe('draft');
      expect(h.events.events, label).toHaveLength(0);
    }
  });

  it('finding 8: a consent draft from the chat does not count as the verified consent policy', async () => {
    const draftFacts = new InMemoryDraftFactStore();
    await draftFacts.insertDraft({
      id: 'fact_chat_draft_02', businessId: 'biz_pizza_01', kind: 'policy', key: 'message_consent', value: { required: true, wording: 'May we text you?' },
      sourceType: 'owner_chat', sourceRef: 'bld_test_02', status: 'draft', confidence: 0.8, version: 1,
      createdAt: '2026-11-13T19:00:00Z', updatedAt: '2026-11-13T19:00:00Z',
    });
    const knowledge = pizzaKnowledge((ctx) => ({ ...ctx, verifiedFacts: ctx.verifiedFacts.filter((f) => f.key !== 'message_consent') }));
    const h = await harness({ knowledge, draftFacts });
    const id = await createAgent(h);
    const res = await publish(h, id);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ code: 'missing_message_consent_policy' }] } });
  });
});
