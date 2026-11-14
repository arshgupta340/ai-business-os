import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { parseEnv } from '../env';
import { AgentService, noLiveAgent } from './agents';
import { RECORDED_SCRIPTS, RecordedBuilderModel } from './session/recorded-builder-model';
import { BuilderSessionService } from './session/service';
import { FixtureBusinessKnowledge } from './session/knowledge';
import { InMemoryAgentDraftStore, InMemoryBuilderSessionStore, InMemoryDraftFactStore } from './session/stores';

// Two POST /api/agents with the same builderSessionId at the same time. Both
// read the session before either wrote it, so without a lock each made an
// agent. Create now runs under the session's lock, and the second request
// returns the agent the first one made.

const now = () => new Date('2026-11-13T18:00:00Z');

// A session store whose reads wait a little, so two creates that start
// together are sure to overlap.
class SlowSessionStore extends InMemoryBuilderSessionStore {
  override async get(businessId: string, id: string) {
    const row = await super.get(businessId, id);
    await new Promise((r) => setTimeout(r, 20));
    return row;
  }
}

async function interviewed() {
  const sessions = new SlowSessionStore();
  const agents = new InMemoryAgentDraftStore();
  const service = new BuilderSessionService({
    sessions, agents, draftFacts: new InMemoryDraftFactStore(), knowledge: new FixtureBusinessKnowledge(), model: new RecordedBuilderModel(), now,
  });
  const session = await service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01' });
  for (const text of RECORDED_SCRIPTS.pizza) await service.message('biz_pizza_01', session.id, { text, inputMode: 'text' });
  return { sessions, agents, session };
}

describe('AgentService.create from a builder session', () => {
  it('two creates at once make one agent, and both return it', async () => {
    const { sessions, agents, session } = await interviewed();
    const agentService = new AgentService({ agents, sessions, liveAgent: noLiveAgent, now });
    const [a, b] = await Promise.all([
      agentService.create('biz_pizza_01', { builderSessionId: session.id }),
      agentService.create('biz_pizza_01', { builderSessionId: session.id }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await agents.list('biz_pizza_01')).toHaveLength(1);
    expect(await sessions.get('biz_pizza_01', session.id)).toMatchObject({ status: 'completed', agentId: a.id });
  });

  it('a later create from the same session returns the same agent', async () => {
    const { sessions, agents, session } = await interviewed();
    const agentService = new AgentService({ agents, sessions, liveAgent: noLiveAgent, now });
    const first = await agentService.create('biz_pizza_01', { builderSessionId: session.id });
    const again = await agentService.create('biz_pizza_01', { builderSessionId: session.id });
    expect(again.id).toBe(first.id);
    expect(await agents.list('biz_pizza_01')).toHaveLength(1);
  });

  it('a session that names an agent the store does not have is INVALID_STATE', async () => {
    const { sessions, agents, session } = await interviewed();
    const stored = (await sessions.get('biz_pizza_01', session.id))!;
    await sessions.update({ ...stored, agentId: 'agt_missing_01' });
    const agentService = new AgentService({ agents, sessions, liveAgent: noLiveAgent, now });
    await expect(agentService.create('biz_pizza_01', { builderSessionId: session.id })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await agents.list('biz_pizza_01')).toHaveLength(0);
  });
});

describe('POST /api/agents: two requests at once with the same builderSessionId', () => {
  const AUTH = { authorization: 'Bearer test-token' };
  const PIZZA = 'businessId=biz_pizza_01';
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('BUILDER_DEV_AUTH', '1');
    vi.stubEnv('NODE_ENV', 'test');
    app = await buildApp(parseEnv({}));
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  function post(url: string, payload: unknown = {}) {
    return app.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });
  }

  it('creates one agent and answers both with it', async () => {
    const session = (await post(`/api/builder/sessions?${PIZZA}`)).json();
    for (const text of RECORDED_SCRIPTS.pizza) {
      expect((await post(`/api/builder/sessions/${session.id}/messages?${PIZZA}`, { text, inputMode: 'text' })).statusCode).toBe(200);
    }
    const before = (await app.inject({ method: 'GET', url: `/api/agents?${PIZZA}&limit=100`, headers: AUTH })).json().items.length;
    const [a, b] = await Promise.all([
      post(`/api/agents?${PIZZA}`, { builderSessionId: session.id }),
      post(`/api/agents?${PIZZA}`, { builderSessionId: session.id }),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).toBe(b.json().id);
    const after = (await app.inject({ method: 'GET', url: `/api/agents?${PIZZA}&limit=100`, headers: AUTH })).json().items;
    expect(after).toHaveLength(before + 1);
    expect((await app.inject({ method: 'GET', url: `/api/builder/sessions/${session.id}?${PIZZA}`, headers: AUTH })).json()).toMatchObject({ status: 'completed', agentId: a.json().id });
  });
});
