import type { AgentSpec, AgentStatus, AgentTemplate, BuilderSession, BusinessFact } from '@abos/contracts';

// Persistence behind small interfaces. The in-memory versions below are what
// runs until the database lands (task B-06). Each record is shaped after its
// table in docs/DATA-MODEL.md, so a database version can replace it without
// changing any caller. Every read takes the businessId, so a lookup can never
// cross businesses.

// builder_sessions (DATA-MODEL.md 2.12). `ownerId` is the owner_id column.
// `progress` is computed on every read, so it is not stored.
export interface BuilderSessionRecord extends Omit<BuilderSession, 'progress'> {
  ownerId: string;
}

export interface BuilderSessionStore {
  insert(session: BuilderSessionRecord): Promise<void>;
  get(businessId: string, id: string): Promise<BuilderSessionRecord | undefined>;
  update(session: BuilderSessionRecord): Promise<void>;
}

// agents (DATA-MODEL.md 2.9). `specRevision` has no column yet: it backs the
// `specRevision` field of the preview response (API.md 3.4). B-17 adds
// versions; nothing here writes agent_versions.
export interface AgentRecord {
  id: string;
  businessId: string;
  name: string;
  template: AgentTemplate;
  channel: 'phone';
  state: AgentStatus;
  draftSpec: AgentSpec;
  activeVersionId?: string;
  seeded: boolean;
  specRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDraftStore {
  insert(agent: AgentRecord): Promise<void>;
  get(businessId: string, id: string): Promise<AgentRecord | undefined>;
  list(businessId: string): Promise<AgentRecord[]>;
  update(agent: AgentRecord): Promise<void>;
}

// Draft business_facts written from the owner's chat answers
// (sourceType "owner_chat", sourceRef the bld_ session ID, status "draft").
// The builder never writes a verified fact.
export interface DraftFactStore {
  insertDraft(fact: BusinessFact): Promise<void>;
  listBySession(businessId: string, sessionId: string): Promise<BusinessFact[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryBuilderSessionStore implements BuilderSessionStore {
  private readonly rows = new Map<string, BuilderSessionRecord>();
  async insert(session: BuilderSessionRecord) {
    if (this.rows.has(session.id)) throw new Error(`duplicate session ${session.id}`);
    this.rows.set(session.id, clone(session));
  }
  async get(businessId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.businessId === businessId ? clone(row) : undefined;
  }
  async update(session: BuilderSessionRecord) {
    if (!this.rows.has(session.id)) throw new Error(`unknown session ${session.id}`);
    this.rows.set(session.id, clone(session));
  }
}

export class InMemoryAgentDraftStore implements AgentDraftStore {
  private readonly rows = new Map<string, AgentRecord>();
  async insert(agent: AgentRecord) {
    if (this.rows.has(agent.id)) throw new Error(`duplicate agent ${agent.id}`);
    this.rows.set(agent.id, clone(agent));
  }
  async get(businessId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.businessId === businessId ? clone(row) : undefined;
  }
  async list(businessId: string) {
    return [...this.rows.values()]
      .filter((a) => a.businessId === businessId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
      .map(clone);
  }
  async update(agent: AgentRecord) {
    if (!this.rows.has(agent.id)) throw new Error(`unknown agent ${agent.id}`);
    this.rows.set(agent.id, clone(agent));
  }
}

export class InMemoryDraftFactStore implements DraftFactStore {
  private readonly rows: BusinessFact[] = [];
  async insertDraft(fact: BusinessFact) {
    if (fact.status !== 'draft') throw new Error('The builder writes draft facts only.');
    this.rows.push(clone(fact));
  }
  async listBySession(businessId: string, sessionId: string) {
    return this.rows.filter((f) => f.businessId === businessId && f.sourceRef === sessionId).map(clone);
  }
}
