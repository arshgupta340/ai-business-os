import { z } from 'zod';
import { AgentSpecSchema, type AgentSpec, type AgentStatus } from './pending-contracts';
import { validateCapabilitiesAgainstRegistry } from './registry';
import type { AgentDraftStore, AgentRecord, BuilderSessionStore } from './session/stores';
import { apiError, newId } from './util';

// Agent drafts (API.md 3.4, the B-16 part: create, read, list). Publish, pause,
// versions and rollback are task B-17. The seams it needs are here:
// AgentRecord.state and activeVersionId, AgentDraftStore.update, and the
// LiveAgentReader below.

// Reads whether an agent answers the phone number. The live_agent table and
// its route are Arsh's (SPEC 2.9). Until that exists nothing is live.
export interface LiveAgentReader {
  isLiveAgent(businessId: string, agentId: string): Promise<boolean>;
}
export const noLiveAgent: LiveAgentReader = { isLiveAgent: async () => false };

export interface AgentSummary {
  id: string;
  businessId: string;
  name: string;
  template: AgentRecord['template'];
  state: AgentStatus;
  activeVersionId?: string;
  draftSpec: AgentSpec;
  isLiveAgent: boolean;
  createdAt: string;
  updatedAt: string;
}

export const CreateAgentBodySchema = z.union([
  z.strictObject({ builderSessionId: z.string().min(1) }),
  z.strictObject({ spec: z.record(z.string(), z.unknown()) }),
]);
export type CreateAgentBody = z.infer<typeof CreateAgentBodySchema>;

export interface AgentServiceDeps {
  agents: AgentDraftStore;
  sessions: BuilderSessionStore;
  liveAgent: LiveAgentReader;
  now: () => Date;
}

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  async create(businessId: string, body: CreateAgentBody): Promise<AgentSummary> {
    const id = newId('agt_');
    let draft: Record<string, unknown>;
    let sessionToClose: Awaited<ReturnType<BuilderSessionStore['get']>> = undefined;
    if ('builderSessionId' in body) {
      sessionToClose = await this.deps.sessions.get(businessId, body.builderSessionId);
      if (!sessionToClose) throw apiError('NOT_FOUND', 'Builder session not found.');
      if (sessionToClose.agentId) throw apiError('INVALID_STATE', 'This session already has an agent.', { state: sessionToClose.status });
      draft = { ...sessionToClose.draftSpec };
    } else {
      draft = { ...body.spec };
    }

    // Registry first, so an unknown capability is CAPABILITY_NOT_ALLOWED and not
    // a generic validation error (API.md 2).
    const capabilityIssues = validateCapabilitiesAgainstRegistry(Array.isArray(draft.capabilities) ? draft.capabilities : []);
    if (capabilityIssues.length > 0) {
      throw apiError('CAPABILITY_NOT_ALLOWED', 'The spec names a capability that is not registered.', { issues: capabilityIssues });
    }

    // The server owns id, businessId, version and status. A client cannot set them.
    // version 1 is the version this draft would publish as; B-17 owns versions.
    const candidate = { ...draft, id, businessId, version: 1, status: 'draft' };
    const parsed = AgentSpecSchema.safeParse(candidate);
    if (!parsed.success) {
      throw apiError('VALIDATION_FAILED', 'The draft is not complete enough to create an agent.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const now = this.timestamp();
    const record: AgentRecord = {
      id,
      businessId,
      name: parsed.data.name,
      template: parsed.data.template,
      channel: 'phone',
      state: 'draft',
      draftSpec: parsed.data,
      seeded: false,
      specRevision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.agents.insert(record);
    if (sessionToClose) {
      sessionToClose.agentId = id;
      sessionToClose.status = 'completed';
      sessionToClose.updatedAt = now;
      await this.deps.sessions.update(sessionToClose);
    }
    return this.summary(record);
  }

  async get(businessId: string, id: string): Promise<AgentRecord> {
    const agent = await this.deps.agents.get(businessId, id);
    if (!agent) throw apiError('NOT_FOUND', 'Agent not found.');
    return agent;
  }

  async list(businessId: string, query: { state?: AgentStatus; limit: number; cursor?: string }) {
    const all = (await this.deps.agents.list(businessId)).filter((a) => !query.state || a.state === query.state);
    const start = query.cursor ? decodeCursor(query.cursor) : 0;
    const page = all.slice(start, start + query.limit);
    const items = await Promise.all(page.map((a) => this.summary(a)));
    const next = start + query.limit;
    return { items, ...(next < all.length ? { nextCursor: encodeCursor(next) } : {}) };
  }

  async summary(agent: AgentRecord): Promise<AgentSummary> {
    return {
      id: agent.id,
      businessId: agent.businessId,
      name: agent.name,
      template: agent.template,
      state: agent.state,
      ...(agent.activeVersionId ? { activeVersionId: agent.activeVersionId } : {}),
      draftSpec: agent.draftSpec,
      isLiveAgent: await this.deps.liveAgent.isLiveAgent(agent.businessId, agent.id),
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }

  private timestamp(): string {
    return this.deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const o = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }).o;
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw apiError('VALIDATION_FAILED', 'The cursor is not valid.', { issues: [{ path: 'cursor', message: 'invalid cursor' }] });
}
