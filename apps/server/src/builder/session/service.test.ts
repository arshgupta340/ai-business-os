import { describe, expect, it } from 'vitest';
import { AgentService, noLiveAgent } from '../agents';
import { AgentSpecSchema } from '../pending-contracts';
import { isRegisteredCapability } from '../registry';
import { FixtureBusinessKnowledge } from './knowledge';
import type { BuilderModel } from './model';
import { RECORDED_SCRIPTS, RecordedBuilderModel } from './recorded-builder-model';
import { BuilderSessionService } from './service';
import { InMemoryAgentDraftStore, InMemoryBuilderSessionStore, InMemoryDraftFactStore } from './stores';

const now = () => new Date('2026-11-13T18:00:00Z');

function setup(model: BuilderModel = new RecordedBuilderModel()) {
  const sessions = new InMemoryBuilderSessionStore();
  const agents = new InMemoryAgentDraftStore();
  const draftFacts = new InMemoryDraftFactStore();
  const service = new BuilderSessionService({ sessions, agents, draftFacts, knowledge: new FixtureBusinessKnowledge(), model, now });
  const agentService = new AgentService({ agents, sessions, liveAgent: noLiveAgent, now });
  return { service, agentService, draftFacts };
}

async function interview(businessId: string, script: readonly string[]) {
  const ctx = setup();
  const session = await ctx.service.create({ businessId, ownerId: 'usr_owner_01' });
  const turns = [];
  for (const text of script) turns.push(await ctx.service.message(businessId, session.id, { text, inputMode: 'text' }));
  return { ...ctx, session, turns };
}

describe('builder interview on recorded responses', () => {
  it('starts with the opening question and no draft', async () => {
    const { service } = setup();
    const s = await service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01' });
    expect(s.messages[0]).toMatchObject({ role: 'assistant', text: 'What would you like an agent to do for your business?' });
    expect(s).toMatchObject({ status: 'active', draftSpec: {}, missingFields: [], progress: { answered: 0, required: 0 } });
  });

  it('pizza: classifies, asks for the consent policy, then reaches a valid draft spec', async () => {
    const { turns, session, agentService, draftFacts } = await interview('biz_pizza_01', RECORDED_SCRIPTS.pizza);
    const [first, second] = turns;
    expect(first!.draftSpec.template).toBe('restaurant_order_taker');
    expect(first!.missingFields).toEqual(['policy.message_consent']);
    expect(first!.reply.text).toContain('?');
    expect(first!.stopConditions).toEqual([{ code: 'missing_message_consent_policy' }]);
    expect(first!.unsupportedRequests).toEqual([]);

    expect(second!.missingFields).toEqual([]);
    expect(second!.progress.answered).toBe(second!.progress.required);
    expect(second!.stopConditions).toEqual([]);
    const facts = await draftFacts.listBySession('biz_pizza_01', session.id);
    expect(facts).toEqual([expect.objectContaining({ kind: 'policy', key: 'message_consent', status: 'draft', sourceType: 'owner_chat', sourceRef: session.id })]);

    const agent = await agentService.create('biz_pizza_01', { builderSessionId: session.id });
    expect(AgentSpecSchema.safeParse(agent.draftSpec).success).toBe(true);
    expect(agent.draftSpec.capabilities).toEqual([
      'catalog.read',
      'business.facts.read',
      'order.quote',
      'order.propose',
      'order.status.read',
      'order.checkout.prepare',
      'message.checkout.send',
      'sheets.rows.append',
    ]);
    expect(agent.draftSpec.greeting).toMatch(/AI assistant/);
  });

  it('barbershop: asks two questions, takes both answers, reaches a valid draft spec', async () => {
    const { turns, session, agentService } = await interview('biz_barber_01', RECORDED_SCRIPTS.barbershop);
    expect(turns[0]!.draftSpec.template).toBe('appointment_booker');
    expect(turns[0]!.missingFields).toEqual(['policy.minimum_notice', 'policy.message_consent']);
    expect(turns[1]!.missingFields).toEqual([]);
    const agent = await agentService.create('biz_barber_01', { builderSessionId: session.id });
    expect(AgentSpecSchema.parse(agent.draftSpec).template).toBe('appointment_booker');
    expect(agent.draftSpec.capabilities).toContain('booking.propose');
  });

  it('unsupported request: strips the unregistered capability, reports it and says so in the reply', async () => {
    const { turns } = await interview('biz_pizza_01', [RECORDED_SCRIPTS.pizza[0], RECORDED_SCRIPTS.unsupported[0]]);
    const turn = turns[1]!;
    expect(turn.unsupportedRequests).toEqual(['send marketing texts', 'marketing.sms.broadcast']);
    expect(turn.draftSpec.capabilities!.every((c) => isRegisteredCapability(c))).toBe(true);
    expect(turn.draftSpec.capabilities).not.toContain('marketing.sms.broadcast');
    expect(turn.draftSpec.template).toBe('restaurant_order_taker');
    expect(turn.reply.text).toContain('Not available, so it is not part of this agent: send marketing texts');
  });

  it('never trusts model output: unknown IDs, foreign answers and a greeting without disclosure are dropped', async () => {
    const hostile: BuilderModel = {
      kind: 'recorded',
      turn: async () => ({
        reply: 'Done, I added refunds and price changes for callers.',
        template: 'restaurant_order_taker',
        capabilityIds: ['refund.issue', 'read_credentials', 'catalog.read'],
        unsupportedRequests: [],
        confidence: 1,
        name: 'X'.repeat(500),
        goal: 'Take orders',
        greeting: 'Hello there!',
        knowledgeScopes: null,
        answers: [
          { field: 'policy.pickup_window', value: '0 minutes' },
          { field: 'catalog.items', value: 'free pizza' },
          { field: 'policy.message_consent', value: 'Ask first.' },
        ],
      }),
    };
    const { service, draftFacts } = setup(hostile);
    const s = await service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01' });
    const turn = await service.message('biz_pizza_01', s.id, { text: 'hi', inputMode: 'text' });
    expect(turn.unsupportedRequests).toEqual(['refund.issue', 'read_credentials']);
    expect(turn.draftSpec.name).toHaveLength(80);
    expect(turn.draftSpec.greeting).toMatch(/AI assistant/);
    // An answer is kept only for a field that was missing before the turn and
    // can be answered in chat. Before this first turn nothing was required.
    const facts = await draftFacts.listBySession('biz_pizza_01', s.id);
    expect(facts.map((f) => `${f.kind}.${f.key}`)).toEqual([]);
  });

  it('maps a malformed model answer to INTEGRATION_UNAVAILABLE', async () => {
    const broken: BuilderModel = { kind: 'recorded', turn: async () => ({ reply: 3 }) };
    const { service } = setup(broken);
    const s = await service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01' });
    await expect(service.message('biz_pizza_01', s.id, { text: 'hi', inputMode: 'text' })).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', status: 503 });
  });

  it('does not find a session from another business', async () => {
    const { service } = setup();
    const s = await service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01' });
    await expect(service.get('biz_barber_01', s.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a revise session writes its draft to the agent', async () => {
    const { session, agentService, service } = await interview('biz_pizza_01', RECORDED_SCRIPTS.pizza);
    const agent = await agentService.create('biz_pizza_01', { builderSessionId: session.id });
    const revise = await service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01', agentId: agent.id });
    expect(revise.draftSpec.template).toBe('restaurant_order_taker');
    await service.message('biz_pizza_01', revise.id, { text: RECORDED_SCRIPTS.pizza[0], inputMode: 'voice' });
    const after = await agentService.get('biz_pizza_01', agent.id);
    expect(after.specRevision).toBe(2);
  });
});
