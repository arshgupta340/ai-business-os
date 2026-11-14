import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { parseEnv } from '../env';
import { AgentSpecSchema } from './pending-contracts';
import { AGENT_SCRIPTS } from './runner/recorded-agent-model';
import { RECORDED_SCRIPTS } from './session/recorded-builder-model';

// Route tests through buildApp and app.inject. The OpenAI key is blanked so the
// builder always runs on recorded responses here, even if a developer has a
// key in their shell. BUILDER_DEV_AUTH=1 opts in to the development auth
// stand-in (the fail-closed default is tested in auth.test.ts). Only Date is
// faked: Friday 2026-11-13, 10:00 in Los Angeles.

const AUTH = { authorization: 'Bearer test-token' };
const PIZZA = 'businessId=biz_pizza_01';
const BARBER = 'businessId=biz_barber_01';

let app: FastifyInstance;

beforeAll(async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('BUILDER_DEV_AUTH', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T18:00:00Z'));
  app = await buildApp(parseEnv({}));
});

afterAll(async () => {
  await app.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function post(url: string, payload: unknown = {}) {
  return app.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });
}

async function buildAgent(query: string, script: readonly string[]) {
  const session = (await post(`/api/builder/sessions?${query}`)).json();
  let last;
  for (const text of script) last = (await post(`/api/builder/sessions/${session.id}/messages?${query}`, { text })).json();
  const created = await post(`/api/agents?${query}`, { builderSessionId: session.id });
  return { session, last, created };
}

// Every approvalId anywhere in a value.
function approvalIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(approvalIds);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => (k === 'approvalId' && typeof v === 'string' ? [v] : approvalIds(v)));
  }
  return [];
}

describe('builder routes: auth and scope seam', () => {
  it('needs a bearer token', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/builder/sessions?${PIZZA}`, payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
  });

  it('needs a businessId the owner owns', async () => {
    expect((await post('/api/builder/sessions')).json().code).toBe('VALIDATION_FAILED');
    const res = await post('/api/builder/sessions?businessId=biz_other_01');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN_BUSINESS');
  });

  it('never confirms a resource from another business', async () => {
    const session = (await post(`/api/builder/sessions?${PIZZA}`)).json();
    const res = await app.inject({ method: 'GET', url: `/api/builder/sessions/${session.id}?${BARBER}`, headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

describe('builder routes: Flow A on recorded responses', () => {
  it('pizza: interview, draft agent, preview and test console', async () => {
    const { session, last, created } = await buildAgent(PIZZA, RECORDED_SCRIPTS.pizza);
    expect(session).toMatchObject({ status: 'active', draftSpec: {}, missingFields: [], progress: { answered: 0, required: 0 } });
    expect(last).toMatchObject({ missingFields: [], unsupportedRequests: [], stopConditions: [], reply: { role: 'assistant' } });
    expect(last.proposedChange).toBeUndefined();
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent).toMatchObject({ state: 'draft', template: 'restaurant_order_taker', isLiveAgent: false });
    expect(AgentSpecSchema.safeParse(agent.draftSpec).success).toBe(true);

    const read = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}?${PIZZA}`, headers: AUTH });
    expect(read.json().id).toBe(agent.id);
    const list = await app.inject({ method: 'GET', url: `/api/agents?${PIZZA}&state=draft`, headers: AUTH });
    expect(list.json().items.map((a: { id: string }) => a.id)).toContain(agent.id);

    const reread = await app.inject({ method: 'GET', url: `/api/builder/sessions/${session.id}?${PIZZA}`, headers: AUTH });
    expect(reread.json()).toMatchObject({ status: 'completed', agentId: agent.id });

    const preview = await post(`/api/agents/${agent.id}/preview?${PIZZA}`);
    expect(preview.statusCode).toBe(200);
    const p = preview.json();
    expect(p.permissions.approvalRequired).toEqual(['order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append']);
    expect(p.examples.map((e: { scenario: string }) => e.scenario)).toEqual(['happy_path', 'price_injection']);
    expect(p.examples[0].toolTrace.map((t: { tool: string }) => t.tool)).toEqual(['read_catalog', 'quote_order', 'propose_order']);
    expect(p.examples[1].guardrail).toEqual({ refused: true, rule: 'no_fact_changes' });

    const t1 = (await post(`/api/agents/${agent.id}/test?${PIZZA}`, { message: AGENT_SCRIPTS.pizzaBrowse })).json();
    expect(t1.testSessionId).toMatch(/^tst_/);
    expect(t1.reply).toBe('Two large pepperoni. Any extra toppings?');
    expect(t1.toolTrace[0]).toMatchObject({ tool: 'read_catalog', capabilityId: 'catalog.read', effect: 'read', mocked: true });
    const t2 = (await post(`/api/agents/${agent.id}/test?${PIZZA}`, { message: AGENT_SCRIPTS.pizzaOrder, testSessionId: t1.testSessionId })).json();
    expect(t2.testSessionId).toBe(t1.testSessionId);
    expect(approvalIds(t2)).toHaveLength(1);
  });

  it('barbershop: interview, draft agent and a mock booking', async () => {
    const { last, created } = await buildAgent(BARBER, RECORDED_SCRIPTS.barbershop);
    expect(last.missingFields).toEqual([]);
    const agent = created.json();
    expect(agent.template).toBe('appointment_booker');
    const t = (await post(`/api/agents/${agent.id}/test?${BARBER}`, { message: AGENT_SCRIPTS.barberBook })).json();
    expect(t.toolTrace.map((x: { tool: string }) => x.tool)).toEqual(['read_calendar_availability', 'propose_booking']);
    expect(t.reply).toContain('9:00');
  });

  it('unsupported request is answered, reported and kept out of the spec', async () => {
    const session = (await post(`/api/builder/sessions?${PIZZA}`)).json();
    await post(`/api/builder/sessions/${session.id}/messages?${PIZZA}`, { text: RECORDED_SCRIPTS.pizza[0] });
    const turn = (await post(`/api/builder/sessions/${session.id}/messages?${PIZZA}`, { text: RECORDED_SCRIPTS.unsupported[0], inputMode: 'voice' })).json();
    expect(turn.unsupportedRequests).toContain('send marketing texts');
    expect(turn.draftSpec.capabilities).not.toContain('marketing.sms.broadcast');
    expect(turn.reply).toMatchObject({ inputMode: 'voice' });
    expect(turn.reply.text).toMatch(/cannot send marketing texts/);
  });

  it('rejects a spec with an unregistered capability with CAPABILITY_NOT_ALLOWED', async () => {
    const res = await post(`/api/agents?${PIZZA}`, {
      spec: { template: 'custom', name: 'X', channel: 'phone', goal: 'Y', knowledgeScopes: [], capabilities: ['catalog.read', 'publish_agent'], writePolicy: 'owner_approval_each_action_bundle', escalation: 'explain_unsupported_or_offer_callback', guardrailVersion: 'v1' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('CAPABILITY_NOT_ALLOWED');
  });

  it('the test endpoint can only ever produce apv_mock_ approvals', async () => {
    const pizza = (await buildAgent(PIZZA, RECORDED_SCRIPTS.pizza)).created.json();
    const barber = (await buildAgent(BARBER, RECORDED_SCRIPTS.barbershop)).created.json();
    const seen: string[] = [];
    for (const [agent, query] of [
      [pizza, PIZZA],
      [barber, BARBER],
    ] as const) {
      for (const message of Object.values(AGENT_SCRIPTS)) {
        const res = await post(`/api/agents/${agent.id}/test?${query}`, { message });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        for (const step of body.toolTrace) {
          expect(step.mocked).toBe(true);
          expect(['read', 'propose']).toContain(step.effect);
        }
        seen.push(...approvalIds(body));
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const id of seen) expect(id).toMatch(/^apv_mock_/);
  });

  it('a test session belongs to one agent', async () => {
    const a = (await buildAgent(PIZZA, RECORDED_SCRIPTS.pizza)).created.json();
    const b = (await buildAgent(PIZZA, RECORDED_SCRIPTS.pizza)).created.json();
    const t = (await post(`/api/agents/${a.id}/test?${PIZZA}`, { message: 'hi' })).json();
    const res = await post(`/api/agents/${b.id}/test?${PIZZA}`, { message: 'hi', testSessionId: t.testSessionId });
    expect(res.json().code).toBe('NOT_FOUND');
  });
});
