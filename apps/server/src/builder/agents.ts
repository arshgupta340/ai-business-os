import { BuilderSessionIdSchema, type Agent, type AgentStatus } from '@abos/contracts';
import { z } from 'zod';
import { validateCapabilitySet } from './registry';
import { toVersionView, type AgentVersionRecord } from './publish/stores';
import { BuilderAgentSpecSchema } from './spec';
import type { AgentDraftStore, AgentRecord, BuilderSessionStore } from './session/stores';
import { apiError, newId } from './util';

// Agent drafts (API.md 3.4, the B-16 part: create, read, list). Publish, pause,
// versions and rollback are in publish/ (B-17, B-27). This file only reads
// what they write: the live-agent pointer through LiveAgentReader, and the
// active version through ActiveVersionReader.

// Reads whether an agent answers the phone number. The live_agent table and
// its route are Arsh's (SPEC 2.9). The plugin wires this to the publish
// module's LiveAgentStore.
export interface LiveAgentReader {
  isLiveAgent(businessId: string, agentId: string): Promise<boolean>;
}
export const noLiveAgent: LiveAgentReader = { isLiveAgent: async () => false };

// Reads one published version (agent_versions). The publish module's
// AgentVersionStore fits this.
export interface ActiveVersionReader {
  get(businessId: string, id: string): Promise<AgentVersionRecord | undefined>;
}

// The agent summary of API.md 3.4 (the package's Agent).
export type AgentSummary = Agent;

// The body of POST /api/agents. The package's CreateAgentBodySchema is
// `{ builderSessionId } | { spec: AgentSpec }`. The `spec` form is read here as
// an object and checked in `create`: first against the registry and the set
// rules (an unknown capability is CAPABILITY_NOT_ALLOWED, API.md 3.4, which a
// schema error would turn into VALIDATION_FAILED), then against the package's
// AgentSpecSchema after the server sets id, businessId, version and status.
// The contract's spec form requires those four fields, which the server owns;
// this route does not require the client to send them (see docs/notes-saina.md).
export const CreateAgentEnvelopeSchema = z.union([
  z.strictObject({ builderSessionId: BuilderSessionIdSchema }),
  z.strictObject({ spec: z.record(z.string(), z.unknown()) }),
]);
export type CreateAgentBody = z.infer<typeof CreateAgentEnvelopeSchema>;

export interface AgentServiceDeps {
  agents: AgentDraftStore;
  sessions: BuilderSessionStore;
  liveAgent: LiveAgentReader;
  activeVersions?: ActiveVersionReader;
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

    // Registry and set rules first, so an unknown capability or a set that
    // breaks a rule (registry.ts CAPABILITY_RULES) is CAPABILITY_NOT_ALLOWED
    // and not a generic validation error (API.md 2). An empty or missing list
    // is left to the schema below.
    const listed = Array.isArray(draft.capabilities) ? draft.capabilities : [];
    const capabilityIssues = listed.length === 0 ? [] : validateCapabilitySet(listed);
    if (capabilityIssues.length > 0) {
      throw apiError('CAPABILITY_NOT_ALLOWED', 'The spec names a capability that is not registered or a set of capabilities that does not fit together.', {
        issues: capabilityIssues.map(({ path, message }) => ({ path, message })),
      });
    }

    // The server owns id, businessId, version and status. A client cannot set them.
    // version 1 is the version this draft would publish as; B-17 owns versions.
    const candidate = { ...draft, id, businessId, version: 1, status: 'draft' };
    const parsed = BuilderAgentSpecSchema.safeParse(candidate);
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
    const active = agent.activeVersionId && this.deps.activeVersions ? await this.deps.activeVersions.get(agent.businessId, agent.activeVersionId) : undefined;
    return {
      id: agent.id,
      businessId: agent.businessId,
      name: agent.name,
      template: agent.template,
      state: agent.state,
      ...(agent.activeVersionId ? { activeVersionId: agent.activeVersionId } : {}),
      ...(active ? { activeVersion: toVersionView(active) } : {}),
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
