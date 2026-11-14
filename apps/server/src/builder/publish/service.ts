import type { AgentSpec, PublishResponse } from '@abos/contracts';
import type { AgentService, AgentSummary } from '../agents';
import { assertContractEvent } from '../events';
import { assertNoOpenRequiredConflict, type ConflictStore } from '../extraction/index';
import { getCapability, toolsForCapabilities, TOOL_CAPABILITY, validateCapabilitySet } from '../registry';
import { BuilderAgentSpecSchema } from '../spec';
import type { BusinessKnowledge } from '../session/knowledge';
import type { AgentDraftStore, AgentRecord } from '../session/stores';
import { isoZ } from '../time';
import { apiError, canonicalJson, newId } from '../util';
import { runCatalogSync, type CatalogSync } from './catalog-sync';
import type { KeyedLock } from './lock';
import {
  toVersionView,
  type AgentVersionRecord,
  type AgentVersionStore,
  type KnowledgeSnapshotRef,
  type LiveAgentStore,
  type PublishActivityEvent,
  type PublishEventSink,
} from './stores';

// Publish, pause, versions and rollback (API.md 3.4, tasks B-17 and B-27).
//
// The agent state machine (CONTRACTS.md section 6): draft to live on publish,
// live to live on a published update, live to paused on pause, paused to live
// on publish. Nothing else. Every change for one agent runs under the agent's
// lock, so two requests can never interleave or write the same version number.

export interface PublishServiceDeps {
  agents: AgentDraftStore;
  versions: AgentVersionStore;
  liveAgents: LiveAgentStore;
  events: PublishEventSink;
  conflicts: ConflictStore;
  knowledge: BusinessKnowledge;
  syncCatalog: CatalogSync;
  agentService: AgentService;
  lock: KeyedLock;
  now: () => Date;
}

export interface Actor {
  businessId: string;
  ownerId: string;
  correlationId: string;
}

// The response of publish and rollback is the package's PublishResponse:
// `{ agent, version, phoneNumber }`, with `phoneNumber` always present. It is
// the number this server's live-agent pointer holds, whether or not this agent
// answers it; `agent.isLiveAgent` says whether it does.
export type { PublishResponse };

const LIVE_AGENT_LOCK = 'live_agent';

// What a version runs, without the fields the server sets per version.
function specContent(spec: AgentSpec): string {
  const { version: _v, status: _s, ...rest } = spec;
  return canonicalJson(rest);
}

export class PublishService {
  constructor(private readonly deps: PublishServiceDeps) {}

  async publish(actor: Actor, agentId: string, input: { makeLive: boolean }): Promise<PublishResponse> {
    return this.deps.lock.run(agentId, async () => {
      const agent = await this.getAgent(actor.businessId, agentId);
      const synced = await runCatalogSync(this.deps.syncCatalog, { businessId: agent.businessId, agentId: agent.id, correlationId: actor.correlationId });
      await assertNoOpenRequiredConflict(this.deps.conflicts, agent.businessId);

      const active = await this.activeVersion(agent);
      let version: AgentVersionRecord;
      if (agent.state === 'paused' && active && specContent(agent.draftSpec) === specContent(active.spec)) {
        // API.md 3.4: a paused agent whose draft has not changed since the
        // active version is reactivated. No new version is written.
        this.validateSpec(active.spec);
        version = active;
      } else {
        const next = (await this.deps.versions.maxVersion(agent.businessId, agent.id)) + 1;
        const spec = this.validateSpec({ ...agent.draftSpec, id: agent.id, businessId: agent.businessId, version: next, status: 'live' });
        version = await this.writeVersion(agent, actor, next, spec, await this.snapshot(agent.businessId, synced.syncedAt));
      }

      return this.goLive(agent, version, { moveNumber: input.makeLive });
    });
  }

  // `makeLive` is in the package's RollbackBodySchema. As on publish, it moves
  // the number to this agent; without it the number follows only if this
  // agent already answers it.
  async rollback(actor: Actor, agentId: string, input: { toVersionId: string; makeLive?: boolean }): Promise<PublishResponse> {
    return this.deps.lock.run(agentId, async () => {
      const agent = await this.getAgent(actor.businessId, agentId);
      if (agent.state === 'draft') throw apiError('INVALID_STATE', 'A draft agent has no version to roll back to.', { state: agent.state });
      const target = await this.deps.versions.get(agent.businessId, input.toVersionId);
      if (!target || target.agentId !== agent.id) throw apiError('NOT_FOUND', 'Agent version not found.');
      const active = await this.activeVersion(agent);
      if (!active) throw apiError('INTERNAL', 'The agent has no active version.');
      if (target.id === active.id) {
        throw apiError('INVALID_STATE', 'That version is already the active one.', { state: agent.state, activeVersionId: active.id });
      }
      await assertNoOpenRequiredConflict(this.deps.conflicts, agent.businessId);
      // The registry may have changed since the target was published.
      this.validateSpec(target.spec);

      // API.md 3.4 and DATA-MODEL.md 2.10: rollback points activeVersionId
      // back at the earlier version. No version row is written, edited or
      // deleted. The draft spec is left as it is.
      return this.goLive(agent, target, { moveNumber: input.makeLive ?? false, rolledBackFrom: active.id });
    });
  }

  // Returns the agent summary (the package's pauseAgent response is Agent).
  async pause(actor: Actor, agentId: string): Promise<AgentSummary> {
    return this.deps.lock.run(agentId, async () => {
      const agent = await this.getAgent(actor.businessId, agentId);
      if (agent.state !== 'live') throw apiError('INVALID_STATE', 'Only a live agent can be paused.', { state: agent.state });
      const at = this.timestamp();
      const updated: AgentRecord = { ...agent, state: 'paused', updatedAt: at };
      await this.deps.agents.update(updated);
      // API.md 3.4: the live_agent row does not change on pause.
      await this.event(updated.businessId, updated.id, at, { type: 'agent.paused', payload: { agentId: updated.id } });
      return this.deps.agentService.summary(updated);
    });
  }

  async listVersions(businessId: string, agentId: string, query: { limit: number; cursor?: string }) {
    const agent = await this.getAgent(businessId, agentId);
    const before = query.cursor ? decodeCursor(query.cursor) : Number.POSITIVE_INFINITY;
    const all = (await this.deps.versions.listByAgent(agent.businessId, agent.id)).filter((v) => v.version < before);
    const page = all.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toVersionView),
      ...(all.length > query.limit && last ? { nextCursor: encodeCursor(last.version) } : {}),
    };
  }

  // ---------------------------------------------------------------------------

  private async getAgent(businessId: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.deps.agents.get(businessId, agentId);
    if (!agent) throw apiError('NOT_FOUND', 'Agent not found.');
    return agent;
  }

  private async activeVersion(agent: AgentRecord): Promise<AgentVersionRecord | undefined> {
    return agent.activeVersionId ? this.deps.versions.get(agent.businessId, agent.activeVersionId) : undefined;
  }

  // The registry check first, so a set that breaks a rule is
  // CAPABILITY_NOT_ALLOWED with the issues (as on POST /api/agents). Then the
  // full AgentSpec schema. Then the rule that a deployed agent has read and
  // propose tools only (AGENTS.md rule 6).
  private validateSpec(candidate: Record<string, unknown>): AgentSpec {
    const listed = Array.isArray(candidate.capabilities) ? candidate.capabilities : [];
    const issues = validateCapabilitySet(listed);
    if (issues.length > 0) {
      throw apiError('CAPABILITY_NOT_ALLOWED', 'The spec names a capability that is not registered or a set of capabilities that does not fit together.', {
        issues: issues.map(({ path, message }) => ({ path, message })),
      });
    }
    const parsed = BuilderAgentSpecSchema.safeParse(candidate);
    if (!parsed.success) {
      throw apiError('VALIDATION_FAILED', 'The agent spec is not complete.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    for (const tool of toolsForCapabilities(parsed.data.capabilities)) {
      const effect = getCapability(TOOL_CAPABILITY[tool])?.effect;
      if (effect !== 'read' && effect !== 'propose') {
        throw apiError('CAPABILITY_NOT_ALLOWED', 'A deployed agent can only have read and propose tools.', { issues: [{ path: 'capabilities', message: `${tool} is not a read or propose tool.` }] });
      }
    }
    return parsed.data;
  }

  private async snapshot(businessId: string, catalogSyncedAt: string | undefined): Promise<KnowledgeSnapshotRef> {
    const context = await this.deps.knowledge.getContext(businessId);
    const facts = (context?.verifiedFacts ?? []).filter((f) => f.status === 'verified').map((f) => ({ id: f.id, version: f.version }));
    return { facts, ...(catalogSyncedAt ? { catalogSyncedAt } : {}) };
  }

  private async writeVersion(agent: AgentRecord, actor: Actor, version: number, spec: AgentSpec, knowledgeSnapshotRef: KnowledgeSnapshotRef) {
    const at = this.timestamp();
    const record: AgentVersionRecord = {
      id: newId('agv_'),
      businessId: agent.businessId,
      agentId: agent.id,
      version,
      spec,
      knowledgeSnapshotRef,
      guardrailVersion: 'v1',
      createdBy: actor.ownerId,
      createdAt: at,
      publishedAt: at,
    };
    await this.deps.versions.insert(record);
    // The store keeps a frozen copy. Read it back so the response is that copy.
    const stored = await this.deps.versions.get(agent.businessId, record.id);
    if (!stored) throw apiError('INTERNAL', 'The new version was not stored.');
    return stored;
  }

  // Sets the agent live on this version, moves or follows the phone number,
  // and writes the events. Called under the agent's lock.
  private async goLive(agent: AgentRecord, version: AgentVersionRecord, opts: { moveNumber: boolean; rolledBackFrom?: string }): Promise<PublishResponse> {
    const at = this.timestamp();
    const updated: AgentRecord = { ...agent, state: 'live', activeVersionId: version.id, updatedAt: at };
    await this.deps.agents.update(updated);

    const answers = await this.deps.lock.run(LIVE_AGENT_LOCK, async () => {
      const current = await this.deps.liveAgents.get();
      const isThisAgent = current?.agentId === agent.id && current.businessId === agent.businessId;
      // makeLive moves the number to this agent. If this agent already answers
      // the number, the number follows its new active version either way.
      if (!opts.moveNumber && !isThisAgent) return false;
      if (current && isThisAgent && current.agentVersionId === version.id) return true;
      const previous = await this.deps.liveAgents.set({
        phoneNumber: this.deps.liveAgents.phoneNumber,
        businessId: agent.businessId,
        agentId: agent.id,
        agentVersionId: version.id,
        updatedAt: at,
      });
      await this.event(agent.businessId, agent.id, at, {
        type: 'live_agent.changed',
        payload: {
          phoneNumberLast4: last4(this.deps.liveAgents.phoneNumber),
          agentId: agent.id,
          agentVersionId: version.id,
          ...(previous ? { previousAgentId: previous.agentId } : {}),
        },
      });
      return true;
    });

    await this.event(agent.businessId, agent.id, at, {
      type: 'agent.published',
      payload: {
        agentId: agent.id,
        agentVersionId: version.id,
        version: version.version,
        ...(answers ? { phoneNumberLast4: last4(this.deps.liveAgents.phoneNumber) } : {}),
        ...(opts.rolledBackFrom ? { rolledBackFrom: opts.rolledBackFrom } : {}),
      },
    });

    return {
      agent: await this.deps.agentService.summary(updated),
      version: toVersionView(version),
      phoneNumber: this.deps.liveAgents.phoneNumber,
    };
  }

  // correlationId is the agt_ ID, so the agent's own activity can be
  // filtered by it.
  // Every event is checked against the contract before it reaches the sink.
  private async event(businessId: string, agentId: string, at: string, body: Pick<PublishActivityEvent, 'type' | 'payload'>) {
    const event = { id: newId('evt_'), businessId, correlationId: agentId, actorType: 'owner', occurredAt: at, ...body } as PublishActivityEvent;
    await this.deps.events.write(assertContractEvent(event));
  }

  private timestamp(): string {
    return isoZ(this.deps.now());
  }
}

function last4(phone: string): string {
  return phone.slice(-4);
}

// The cursor is the version number of the last item on the page. Versions are
// only ever added at the top, so a page never repeats or skips an item.
function encodeCursor(version: number): string {
  return Buffer.from(JSON.stringify({ v: version })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const v = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown }).v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
  } catch {
    // fall through
  }
  throw apiError('VALIDATION_FAILED', 'The cursor is not valid.', { issues: [{ path: 'cursor', message: 'invalid cursor' }] });
}
