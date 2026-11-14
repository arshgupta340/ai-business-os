import type { AgentRunRequest, AgentRunResponse, AgentTemplate, ToolContext, ToolTraceEntry } from '../pending-contracts';
import { permissionSummary, validateCapabilitySet, type PermissionSummary } from '../registry';
import type { BusinessKnowledge } from '../session/knowledge';
import type { AgentDraftStore, AgentRecord } from '../session/stores';
import { apiError, newId } from '../util';
import type { MockToolset } from './mock-toolset';
import { AGENT_SCRIPTS } from './recorded-agent-model';
import { RunnerModelUnavailable, type MockTextRunner } from './text-runner';

// Test console and preview (API.md 3.4). Both run the agent's draft spec with
// the mock toolset only. Neither writes a row, an approval or an event. Test
// console sessions live in server memory (SPEC 2.9 "Not persisted").

const MAX_TEST_SESSIONS = 500;
const MAX_HISTORY = 40;

interface TestSession {
  id: string;
  businessId: string;
  agentId: string;
  history: { role: 'caller' | 'agent'; text: string }[];
}

// Scenario names: "happy_path" and "price_injection" are from API.md; the
// others are the builder's own.
export const PREVIEW_SCENARIOS: Record<AgentTemplate, Record<string, string[]>> = {
  restaurant_order_taker: {
    happy_path: [AGENT_SCRIPTS.pizzaBrowse, AGENT_SCRIPTS.pizzaOrder],
    price_injection: [AGENT_SCRIPTS.pizzaPriceInjection],
  },
  appointment_booker: {
    happy_path: [AGENT_SCRIPTS.barberAvailability, AGENT_SCRIPTS.barberBook],
    approval_bypass: [AGENT_SCRIPTS.barberBypass],
  },
  // A custom agent has any valid subset (P-13). These scenarios show the FAQ
  // case: two questions, an order it must refuse, and an injection.
  custom: {
    happy_path: [AGENT_SCRIPTS.faqHours, AGENT_SCRIPTS.faqMenu],
    unsupported_order: [AGENT_SCRIPTS.faqOrder],
    order_injection: [AGENT_SCRIPTS.faqInjection],
  },
};

export interface PreviewExample {
  scenario: string;
  transcript: { role: 'caller' | 'agent'; text: string }[];
  toolTrace: ToolTraceEntry[];
  guardrail?: AgentRunResponse['guardrail'];
}

export interface PreviewResponse {
  agentId: string;
  specRevision: number;
  permissions: PermissionSummary;
  examples: PreviewExample[];
}

export interface AgentRunServiceDeps {
  agents: AgentDraftStore;
  knowledge: BusinessKnowledge;
  runner: MockTextRunner;
  // Only used to drop a finished test session's mock state.
  toolset: Partial<Pick<MockToolset, 'reset'>>;
}

export class AgentRunService {
  private readonly sessions = new Map<string, TestSession>();

  constructor(private readonly deps: AgentRunServiceDeps) {}

  async test(businessId: string, agentId: string, body: AgentRunRequest, correlationId: string): Promise<AgentRunResponse> {
    if (body.callId !== undefined) {
      throw apiError('VALIDATION_FAILED', 'The test console takes testSessionId, not callId.', { issues: [{ path: 'callId', message: 'not accepted here' }] });
    }
    const agent = await this.loadAgent(businessId, agentId);
    let session: TestSession;
    if (body.testSessionId) {
      const found = this.sessions.get(body.testSessionId);
      if (!found || found.businessId !== businessId || found.agentId !== agentId) throw apiError('NOT_FOUND', 'Test session not found.');
      session = found;
    } else {
      session = { id: newId('tst_'), businessId, agentId, history: [] };
      this.remember(session);
    }

    const result = await this.run(agent, session.history, body.message, {
      businessId,
      agentVersionId: draftVersionRef(agent),
      testSessionId: session.id,
      correlationId,
    });
    session.history.push({ role: 'caller', text: body.message }, { role: 'agent', text: result.reply });
    if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
    if (body.end) this.forget(session.id);

    return { testSessionId: session.id, reply: result.reply, toolTrace: result.toolTrace, ...(result.guardrail ? { guardrail: result.guardrail } : {}) };
  }

  async preview(businessId: string, agentId: string, scenarios: string[] | undefined, correlationId: string): Promise<PreviewResponse> {
    const agent = await this.loadAgent(businessId, agentId);
    const available = PREVIEW_SCENARIOS[agent.draftSpec.template];
    const names = scenarios && scenarios.length > 0 ? scenarios : Object.keys(available);
    const unknown = names.filter((n) => !(n in available));
    if (unknown.length > 0) {
      throw apiError('VALIDATION_FAILED', 'Unknown preview scenario.', {
        issues: unknown.map((n) => ({ path: 'scenarios', message: `unknown scenario ${n.slice(0, 40)}` })),
      });
    }

    const examples: PreviewExample[] = [];
    for (const scenario of names) {
      const key = newId('tst_preview_');
      const transcript: PreviewExample['transcript'] = [];
      const toolTrace: ToolTraceEntry[] = [];
      let guardrail: PreviewExample['guardrail'];
      try {
        for (const message of available[scenario]!) {
          const result = await this.run(agent, transcript, message, {
            businessId,
            agentVersionId: draftVersionRef(agent),
            testSessionId: key,
            correlationId,
          });
          transcript.push({ role: 'caller', text: message }, { role: 'agent', text: result.reply });
          toolTrace.push(...result.toolTrace);
          if (result.guardrail) guardrail = result.guardrail;
        }
      } finally {
        this.deps.toolset.reset?.(key);
      }
      examples.push({ scenario, transcript, toolTrace, ...(guardrail ? { guardrail } : {}) });
    }

    return { agentId: agent.id, specRevision: agent.specRevision, permissions: permissionSummary(agent.draftSpec.capabilities), examples };
  }

  private async run(agent: AgentRecord, history: TestSession['history'], message: string, ctx: ToolContext) {
    const context = await this.deps.knowledge.getContext(agent.businessId);
    try {
      return await this.deps.runner.runTurn({
        spec: agent.draftSpec,
        businessName: context?.profile.name ?? agent.businessId,
        history: [...history],
        message,
        ctx,
      });
    } catch (error) {
      if (error instanceof RunnerModelUnavailable) {
        throw apiError('INTEGRATION_UNAVAILABLE', 'The agent model is not available right now. Try again.', { provider: 'openai' });
      }
      throw error;
    }
  }

  private async loadAgent(businessId: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.deps.agents.get(businessId, agentId);
    if (!agent) throw apiError('NOT_FOUND', 'Agent not found.');
    const issues = validateCapabilitySet(agent.draftSpec.capabilities).map(({ path, message }) => ({ path, message }));
    if (issues.length > 0) {
      throw apiError('CAPABILITY_NOT_ALLOWED', 'The draft names a capability that is not registered or a set that does not fit together.', { issues });
    }
    return agent;
  }

  private remember(session: TestSession) {
    if (this.sessions.size >= MAX_TEST_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.forget(oldest);
    }
    this.sessions.set(session.id, session);
  }

  private forget(id: string) {
    this.sessions.delete(id);
    this.deps.toolset.reset?.(id);
  }
}

// A draft has no agent_versions row yet. The ToolContext still needs a value,
// so a test run uses this marker, which is never a real agv_ ID.
function draftVersionRef(agent: AgentRecord): string {
  return `draft:${agent.id}`;
}
