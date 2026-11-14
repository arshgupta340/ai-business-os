import { describe, expect, it } from 'vitest';
import type { AgentSpec, ToolContext, ToolHandler } from '../pending-contracts';
import { TEMPLATE_CAPABILITIES } from '../registry';
import type { AgentModel } from './agent-model';
import { MockToolset } from './mock-toolset';
import { OpenAiAgentModel, toolDefinitions, type ResponsesCreateClient } from './openai-agent-model';
import { AGENT_SCRIPTS, RecordedAgentModel } from './recorded-agent-model';
import { MockTextRunner } from './text-runner';

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
