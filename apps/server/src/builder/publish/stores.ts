import type { ActivityEventOf, AgentSpec, AgentVersion, KnowledgeSnapshotRef, LiveAgent } from '@abos/contracts';

export type { KnowledgeSnapshotRef };

// Persistence for publish, pause, versions and rollback (tasks B-17, B-27),
// behind small interfaces. The in-memory versions below run until the
// database lands (task B-06). Each record is shaped after its table in
// docs/DATA-MODEL.md, so a database version can be passed in through the
// plugin options without changing any caller.

// ---------------------------------------------------------------------------
// agent_versions (DATA-MODEL.md 2.10)

// KnowledgeSnapshotRef is the package's: `catalogSyncedAt` is absent when
// the catalog sync reported no time.

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

// AgentVersion as the API returns it (API.md 3.4, the package's AgentVersion).
export type AgentVersionView = AgentVersion;

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

// The package's LiveAgent with every field present: the store holds a pointer
// only while an agent answers the number.
export type LiveAgentPointer = Required<LiveAgent>;

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
// section 7, the package's ActivityEvent). The real writer (activity_events)
// belongs to the backend lead and is passed in. Payloads hold IDs, a version
// number and the last four digits of the phone number only. The service
// checks every event against ActivityEventSchema before it reaches the sink.

export type PublishActivityEvent = ActivityEventOf<'agent.published' | 'agent.paused' | 'live_agent.changed'>;

export interface PublishEventSink {
  write(event: PublishActivityEvent): Promise<void>;
}

export class InMemoryPublishEventSink implements PublishEventSink {
  readonly events: PublishActivityEvent[] = [];
  async write(event: PublishActivityEvent) {
    this.events.push(structuredClone(event));
  }
}
