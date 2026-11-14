import { describe, expect, it } from 'vitest';
import { AgentService, noLiveAgent } from '../agents';
import { AgentSpecSchema } from '../pending-contracts';
import { isRegisteredCapability, toolsForCapabilities, validateCapabilitySet } from '../registry';
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

describe('custom FAQ-only agent (B-29) on recorded responses', () => {
  it('classifies as custom and reaches a valid draft with exactly catalog.read and business.facts.read', async () => {
    const { turns, session, agentService } = await interview('biz_pizza_01', [RECORDED_SCRIPTS.faq[0]]);
    const first = turns[0]!;
    expect(first.draftSpec).toMatchObject({
      template: 'custom',
      capabilities: ['catalog.read', 'business.facts.read'],
      escalation: 'explain_unsupported_or_offer_callback',
      writePolicy: 'owner_approval_each_action_bundle',
    });
    expect(first.missingFields).toEqual([]);
    expect(first.stopConditions).toEqual([]);
    expect(first.unsupportedRequests).toEqual([]);
    expect(first.progress).toEqual({ answered: 10, required: 10 });

    const agent = await agentService.create('biz_pizza_01', { builderSessionId: session.id });
    const spec = AgentSpecSchema.parse(agent.draftSpec);
    expect(spec.template).toBe('custom');
    expect(spec.capabilities).toEqual(['catalog.read', 'business.facts.read']);
    expect(spec.greeting).toMatch(/AI assistant/);
    expect(validateCapabilitySet(spec.capabilities)).toEqual([]);
    expect(toolsForCapabilities(spec.capabilities)).toEqual(['read_catalog', 'read_business_facts']);
  });

  it('asks only for what the subset needs: the barbershop has no menu yet', async () => {
    const { turns } = await interview('biz_barber_01', [RECORDED_SCRIPTS.faq[0]]);
    expect(turns[0]!.missingFields).toEqual(['catalog.items']);
    expect(turns[0]!.suggestions).toEqual(['Upload menu', 'Use Square catalog']);
    expect(turns[0]!.reply.text).toContain('Should the agent use your Square catalog, or will you upload a menu?');
  });

  it('explains a tool that does not exist and leaves the draft as it was', async () => {
    const { turns } = await interview('biz_pizza_01', RECORDED_SCRIPTS.faq);
    const turn = turns[1]!;
    expect(turn.unsupportedRequests).toEqual(['give refunds', 'payment.refund.issue']);
    expect(turn.draftSpec.capabilities).toEqual(['catalog.read', 'business.facts.read']);
    expect(turn.draftSpec.template).toBe('custom');
    expect(turn.reply.text).toContain('Not available, so it is not part of this agent: give refunds');
  });

  it('keeps the supported half of a mixed request and reports the other half', async () => {
    const { turns, session, agentService } = await interview('biz_pizza_01', [RECORDED_SCRIPTS.faq[0], RECORDED_SCRIPTS.faqMixed[0]]);
    const turn = turns[1]!;
    expect(turn.draftSpec.capabilities).toEqual(['catalog.read', 'business.facts.read', 'order.quote']);
    expect(turn.unsupportedRequests).toEqual(['text customers promotions', 'marketing.sms.promotions']);
    expect(turn.reply.text).toContain('Not available, so it is not part of this agent: text customers promotions');
    expect(turn.missingFields).toEqual([]);
    const agent = await agentService.create('biz_pizza_01', { builderSessionId: session.id });
    expect(toolsForCapabilities(agent.draftSpec.capabilities)).toEqual(['read_catalog', 'read_business_facts', 'quote_order']);
  });

  it('removes a write capability the model picked on its own and says why', async () => {
    const model: BuilderModel = {
      kind: 'recorded',
      turn: async () => ({
        reply: 'Here is your agent.',
        template: 'custom',
        capabilityIds: ['business.facts.read', 'message.checkout.send', 'order.propose'],
        unsupportedRequests: [],
        confidence: 0.9,
        name: 'Q',
        goal: 'Answer questions.',
        greeting: null,
        knowledgeScopes: null,
        answers: [],
      }),
    };
    const { service } = setup(model);
    const s = await service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01' });
    const turn = await service.message('biz_pizza_01', s.id, { text: 'hi', inputMode: 'text' });
    expect(turn.draftSpec.capabilities).toEqual(['business.facts.read']);
    expect(turn.draftSpec.knowledgeScopes).toEqual(['business_profile', 'hours', 'faq']);
    expect(turn.reply.text).toContain('Left out of this agent: order.propose needs catalog.read and order.quote.');
    expect(turn.reply.text).toContain('Left out of this agent: message.checkout.send runs only inside an approved bundle that order.propose opens.');
    // A registered capability that breaks a rule is not an unsupported request.
    expect(turn.unsupportedRequests).toEqual([]);
  });
});
