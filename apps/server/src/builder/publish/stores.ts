import type { AgentSpec } from '../pending-contracts';

// Persistence for publish, pause, versions and rollback (tasks B-17, B-27),
// behind small interfaces. The in-memory versions below run until the
// database lands (task B-06). Each record is shaped after its table in
// docs/DATA-MODEL.md, so a database version can be passed in through the
// plugin options without changing any caller.

// ---------------------------------------------------------------------------
// agent_versions (DATA-MODEL.md 2.10)

// API.md 3.4 names the two keys. `catalogSyncedAt` is absent when the catalog
// sync reported no time.
export interface KnowledgeSnapshotRef {
  facts: { id: string; version: number }[];
  catalogSyncedAt?: string;
}

export interface AgentVersionRecord {
  id: string; // agv_
  businessId: string;
  agentId: string;
  version: number;
  spec: AgentSpec;
  knowledgeSnapshotRef: KnowledgeSnapshotRef;
  guardrailVersion: 'v1';
  createdBy: string; // usr_
  createdAt: string;
  publishedAt: string;
}

// AgentVersion as the API returns it (API.md 3.4).
export interface AgentVersionView {
  id: string;
  agentId: string;
  version: number;
  spec: AgentSpec;
  knowledgeSnapshotRef: KnowledgeSnapshotRef;
  createdBy: string;
  publishedAt: string;
}

export function toVersionView(v: AgentVersionRecord): AgentVersionView {
  return {
    id: v.id,
    agentId: v.agentId,
    version: v.version,
    spec: v.spec,
    knowledgeSnapshotRef: v.knowledgeSnapshotRef,
    createdBy: v.createdBy,
    publishedAt: v.publishedAt,
  };
}

// A published version is immutable (DATA-MODEL.md 2.10 trigger). This
// interface has no update and no delete on purpose. `insert` must refuse a
// second row with the same id or the same (agentId, version).
export interface AgentVersionStore {
  insert(version: AgentVersionRecord): Promise<void>;
  get(businessId: string, id: string): Promise<AgentVersionRecord | undefined>;
  // Newest first (highest version number first).
  listByAgent(businessId: string, agentId: string): Promise<AgentVersionRecord[]>;
  // The highest version number written for this agent, or 0 if none.
  maxVersion(businessId: string, agentId: string): Promise<number>;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export class InMemoryAgentVersionStore implements AgentVersionStore {
  private readonly rows = new Map<string, AgentVersionRecord>();

  async insert(version: AgentVersionRecord) {
    if (this.rows.has(version.id)) throw new Error(`duplicate agent version ${version.id}`);
    for (const row of this.rows.values()) {
      if (row.agentId === version.agentId && row.version === version.version) {
        throw new Error(`agent ${version.agentId} already has version ${version.version}`);
      }
    }
    // A deep frozen copy: the caller's object can change afterwards, the stored one cannot.
    this.rows.set(version.id, deepFreeze(structuredClone(version)));
  }

  // Rows are frozen, so they are returned as they are.
  async get(businessId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.businessId === businessId ? row : undefined;
  }

  async listByAgent(businessId: string, agentId: string) {
    return [...this.rows.values()].filter((r) => r.businessId === businessId && r.agentId === agentId).sort((a, b) => b.version - a.version);
  }

  async maxVersion(businessId: string, agentId: string) {
    let max = 0;
    for (const row of this.rows.values()) if (row.businessId === businessId && row.agentId === agentId && row.version > max) max = row.version;
    return max;
  }
}

// ---------------------------------------------------------------------------
// live_agent (DATA-MODEL.md 2.11). One row for the one phone number (P-06).
// The table, GET /api/live-agent and PUT /api/live-agent are Arsh's. Publish
// and rollback only need to read the pointer and move it.

export interface LiveAgentPointer {
  phoneNumber: string;
  businessId: string;
  agentId: string;
  agentVersionId: string;
  updatedAt: string;
}

export interface LiveAgentStore {
  // The number this store holds the pointer for.
  readonly phoneNumber: string;
  // The current pointer, or undefined when no agent answers the number.
  get(): Promise<LiveAgentPointer | undefined>;
  // Replaces the pointer and returns the one it replaced, in one step.
  set(next: LiveAgentPointer): Promise<LiveAgentPointer | undefined>;
}

export class InMemoryLiveAgentStore implements LiveAgentStore {
  private current: LiveAgentPointer | undefined;
  constructor(readonly phoneNumber: string) {}
  async get() {
    return this.current ? { ...this.current } : undefined;
  }
  async set(next: LiveAgentPointer) {
    if (next.phoneNumber !== this.phoneNumber) throw new Error('This store holds the pointer for one phone number only.');
    const previous = this.current;
    this.current = { ...next };
    return previous ? { ...previous } : undefined;
  }
}

// ---------------------------------------------------------------------------
// Activity events written by publish, pause and rollback (CONTRACTS.md
// section 7). The real writer (activity_events) belongs to the backend lead
// and is passed in. Payloads hold IDs, a version number and the last four
// digits of the phone number only.

export type PublishActivityEvent = {
  id: string; // evt_
  businessId: string;
  correlationId: string;
  actorType: 'owner';
  occurredAt: string;
} & (
  | { type: 'agent.published'; payload: { agentId: string; agentVersionId: string; version: number; phoneNumberLast4?: string; rolledBackFrom?: string } }
  | { type: 'agent.paused'; payload: { agentId: string } }
  | { type: 'live_agent.changed'; payload: { phoneNumberLast4: string; agentId: string; agentVersionId: string; previousAgentId?: string } }
);

export interface PublishEventSink {
  write(event: PublishActivityEvent): Promise<void>;
}

export class InMemoryPublishEventSink implements PublishEventSink {
  readonly events: PublishActivityEvent[] = [];
  async write(event: PublishActivityEvent) {
    this.events.push(structuredClone(event));
  }
}
