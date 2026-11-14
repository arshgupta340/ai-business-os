import { describe, expect, it } from 'vitest';
import type { AgentSpec, ToolContext, ToolHandler } from '../pending-contracts';
import { TEMPLATE_CAPABILITIES } from '../registry';
import type { AgentModel } from './agent-model';
import { MockToolset } from './mock-toolset';
import { OpenAiAgentModel, toolDefinitions, type ResponsesCreateClient } from './openai-agent-model';
import { AGENT_SCRIPTS, RecordedAgentModel } from './recorded-agent-model';
import { agentInstructions, MockTextRunner } from './text-runner';

const now = () => new Date('2026-11-13T18:00:00Z');
const ctx: ToolContext = { businessId: 'biz_pizza_01', agentVersionId: 'draft:agt_x', testSessionId: 'tst_r', correlationId: 'c' };

const pizzaSpec: AgentSpec = {
  id: 'agt_x',
  businessId: 'biz_pizza_01',
  version: 1,
  template: 'restaurant_order_taker',
  name: 'Pizza Order Assistant',
  channel: 'phone',
  goal: 'Take pickup orders.',
  knowledgeScopes: ['catalog'],
  capabilities: [...TEMPLATE_CAPABILITIES.restaurant_order_taker],
  writePolicy: 'owner_approval_each_action_bundle',
  escalation: 'explain_unsupported_or_offer_callback',
  status: 'draft',
  guardrailVersion: 'v1',
};

const run = (runner: MockTextRunner, message: string, spec: AgentSpec = pizzaSpec) =>
  runner.runTurn({ spec, businessName: 'Demo Pizza Co.', history: [], message, ctx });

describe('mock text runner', () => {
  it('refuses any toolset that is not the mock one', () => {
    const real: ToolHandler = { toolset: 'real', call: async () => ({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' }) };
    expect(() => new MockTextRunner(real, new RecordedAgentModel(), now)).toThrow(/mock toolset only/);
  });

  it('returns a tool trace for a recorded order turn, with mock approvals only', async () => {
    const runner = new MockTextRunner(new MockToolset(now), new RecordedAgentModel(), now);
    const r = await run(runner, AGENT_SCRIPTS.pizzaOrder);
    expect(r.toolTrace.map((t) => [t.tool, t.capabilityId, t.effect, t.mocked])).toEqual([
      ['quote_order', 'order.quote', 'read', true],
      ['propose_order', 'order.propose', 'propose', true],
    ]);
    expect((r.toolTrace[1]!.output as { approvalId: string }).approvalId).toMatch(/^apv_mock_/);
    expect(r.reply).toContain('47 dollars and 85 cents');
  });

  it('refuses a price change before any tool runs', async () => {
    const runner = new MockTextRunner(new MockToolset(now), new RecordedAgentModel(), now);
    const r = await run(runner, AGENT_SCRIPTS.pizzaPriceInjection);
    expect(r.guardrail).toEqual({ refused: true, rule: 'no_fact_changes' });
    expect(r.toolTrace).toEqual([]);
  });

  it('blocks tools the spec does not grant, unknown tools and bad input', async () => {
    const probe: AgentModel = {
      kind: 'recorded',
      respond: async ({ executeTool }) => {
        const results = [
          await executeTool('read_calendar_availability', { serviceId: 'svc_cut', date: '2026-11-14' }),
          await executeTool('create_payment_link', { orderId: 'ord_1' }),
          await executeTool('quote_order', { cart: { lines: [] } }),
        ];
        return { reply: JSON.stringify(results.map((x) => (x as { reason?: string }).reason)) };
      },
    };
    const r = await run(new MockTextRunner(new MockToolset(now), probe, now), 'hello');
    expect(JSON.parse(r.reply)).toEqual(['CAPABILITY_NOT_ALLOWED', 'CAPABILITY_NOT_ALLOWED', 'VALIDATION_FAILED']);
    // The unknown tool leaves no trace entry, because it is not a tool.
    expect(r.toolTrace.map((t) => t.tool)).toEqual(['read_calendar_availability', 'quote_order']);
  });

  it('stops the turn if a toolset slips in a non-mock approval', async () => {
    const liar = Object.assign(new MockToolset(now), {
      call: async () => ({ ok: true, proposalId: 'ord_1', approvalId: 'apv_real_1', missingFields: [] }),
    }) as unknown as ToolHandler;
    const model: AgentModel = {
      kind: 'recorded',
      respond: async ({ executeTool }) => {
        await executeTool('get_order_status', { orderId: 'ord_1' });
        return { reply: 'x' };
      },
    };
    await expect(run(new MockTextRunner(liar, model, now), 'status?')).rejects.toThrow(/non-mock approval/);
  });
});

describe('OpenAiAgentModel (fake client)', () => {
  it('builds function tools from the tool input schemas', () => {
    const [def] = toolDefinitions(['read_calendar_availability']);
    expect(def).toMatchObject({ type: 'function', name: 'read_calendar_availability', strict: false, parameters: { type: 'object', required: ['serviceId', 'date'] } });
  });

  it('runs a tool call through the runner and returns the final text', async () => {
    const requests: unknown[] = [];
    let round = 0;
    const client = {
      responses: {
        create: async (body: unknown) => {
          requests.push(structuredClone(body));
          round += 1;
          if (round === 1) return { output: [{ type: 'function_call', name: 'read_catalog', call_id: 'call_1', arguments: '{"query":"pepperoni"}' }], output_text: '' };
          return { output: [{ type: 'message', content: [] }], output_text: 'We have pepperoni.' };
        },
      },
    } as unknown as ResponsesCreateClient;
    const runner = new MockTextRunner(new MockToolset(now), new OpenAiAgentModel({ apiKey: 'k', model: 'm' }, client), now);
    const r = await run(runner, 'Do you have pepperoni?');
    expect(r.reply).toBe('We have pepperoni.');
    expect(r.toolTrace).toHaveLength(1);
    const second = requests[1] as { input: { type?: string; call_id?: string }[]; tools: { name: string }[] };
    expect(second.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    // The pizza agent is offered its five read and propose tools and nothing else.
    expect(second.tools.map((t) => t.name)).toEqual(['read_catalog', 'read_business_facts', 'quote_order', 'propose_order', 'get_order_status']);
  });
});

const faqSpec: AgentSpec = {
  ...pizzaSpec,
  template: 'custom',
  name: 'Hours and Menu Assistant',
  goal: 'Answer caller questions about opening hours and the menu. It does not take orders.',
  knowledgeScopes: ['business_profile', 'catalog', 'hours', 'faq'],
  capabilities: ['catalog.read', 'business.facts.read'],
};

describe('FAQ-only custom agent in the mock text runner (B-29)', () => {
  const runner = () => new MockTextRunner(new MockToolset(now), new RecordedAgentModel(), now);

  it('answers an hours question from read_business_facts', async () => {
    const r = await run(runner(), AGENT_SCRIPTS.faqHours, faqSpec);
    expect(r.toolTrace.map((t) => [t.tool, t.capabilityId, t.effect, t.mocked])).toEqual([['read_business_facts', 'business.facts.read', 'read', true]]);
    expect(r.reply).toBe('On Saturday we are open from 11 am to 10 pm.');
    expect(r.guardrail).toBeUndefined();
  });

  it('answers a menu question from read_catalog', async () => {
    const r = await run(runner(), AGENT_SCRIPTS.faqMenu, faqSpec);
    expect(r.toolTrace.map((t) => t.tool)).toEqual(['read_catalog']);
    expect(r.reply).toBe('We have Margherita and Pepperoni. Margherita from 12 dollars and 0 cents, Pepperoni from 14 dollars and 0 cents.');
  });

  it('says it cannot take an order, calls no tool and offers only what it can do', async () => {
    const r = await run(runner(), AGENT_SCRIPTS.faqOrder, faqSpec);
    expect(r.reply).toBe('I cannot take orders on this call. I can answer questions about the menu and our hours and policies.');
    expect(r.toolTrace).toEqual([]);
  });

  it('refuses an instruction injection before any tool runs, without offering an order', async () => {
    const r = await run(runner(), AGENT_SCRIPTS.faqInjection, faqSpec);
    expect(r.guardrail).toEqual({ refused: true, rule: 'unsupported_request' });
    expect(r.toolTrace).toEqual([]);
    expect(r.reply).toBe('I cannot do that. I can answer questions about the menu and our hours and policies.');
    expect(r.reply).not.toMatch(/order/);
  });

  it('cannot reach a propose or quote tool even if the model tries', async () => {
    const probe: AgentModel = {
      kind: 'recorded',
      respond: async ({ executeTool, tools }) => {
        const results = [
          await executeTool('propose_order', {}),
          await executeTool('quote_order', { cart: { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] } }),
          await executeTool('propose_booking', {}),
        ];
        return { reply: JSON.stringify({ tools, reasons: results.map((x) => (x as { reason?: string }).reason) }) };
      },
    };
    const r = await run(new MockTextRunner(new MockToolset(now), probe, now), 'hello', faqSpec);
    expect(JSON.parse(r.reply)).toEqual({
      tools: ['read_catalog', 'read_business_facts'],
      reasons: ['CAPABILITY_NOT_ALLOWED', 'CAPABILITY_NOT_ALLOWED', 'CAPABILITY_NOT_ALLOWED'],
    });
  });

  it('is offered no propose tool by the OpenAI model, and its instructions say it cannot take orders', async () => {
    const requests: { tools: { name: string }[]; instructions: string }[] = [];
    const client = {
      responses: {
        create: async (body: unknown) => {
          requests.push(structuredClone(body) as (typeof requests)[number]);
          return { output: [{ type: 'message', content: [] }], output_text: 'ok' };
        },
      },
    } as unknown as ResponsesCreateClient;
    await run(new MockTextRunner(new MockToolset(now), new OpenAiAgentModel({ apiKey: 'k', model: 'm' }, client), now), 'Do you deliver?', faqSpec);
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(['read_catalog', 'read_business_facts']);
    const instructions = agentInstructions(faqSpec, 'Demo Pizza Co.');
    expect(instructions).toContain('You cannot take orders.');
    expect(instructions).toContain('Do not promise a callback');
  });

  it('the pizza agent still refuses with an offer to take the order', async () => {
    const r = await run(runner(), AGENT_SCRIPTS.pizzaPriceInjection);
    expect(r.reply).toBe('I cannot change prices, hours or policies. I can take your order or answer questions about the menu and our hours and policies.');
  });
});
