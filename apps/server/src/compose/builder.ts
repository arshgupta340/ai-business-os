// Database implementations of the builder's seams (issue #65, items 1, 3, 4 and 5), passed to the
// builder plugin through its own options. Nothing under apps/server/src/builder/ is edited: the
// builder's interfaces are imported as types only. Every query runs as abos_app on ordinary tables
// it may write (builder_sessions, agents, business_facts); none touches approval_requests directly.
import type { AgentRecord, AgentDraftStore, BuilderSessionRecord, BuilderSessionStore, DraftFactStore } from '../builder/session/stores';
import type { BusinessContext, BusinessKnowledge } from '../builder/session/knowledge';
import type { LiveAgentReader } from '../builder/agents';
import type { ProposeFactFromChat as BuilderProposeFactFromChat } from '../builder/session/service';
import type { BusinessFact } from '@abos/contracts';
import type { Db } from '../db/index';
import { mapRow } from '../api/rows';
import type { PolicyEngine } from '../policy/engine';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const json = (v: unknown) => JSON.stringify(v ?? null);

// ---------- builder_sessions ----------

function sessionFromRow(r: Row): BuilderSessionRecord {
  return {
    id: String(r.id), businessId: String(r.business_id), ownerId: String(r.owner_id),
    status: r.status as BuilderSessionRecord['status'], messages: (r.messages ?? []) as BuilderSessionRecord['messages'],
    draftSpec: (r.draft_spec ?? {}) as BuilderSessionRecord['draftSpec'], missingFields: (r.missing_fields ?? []) as string[],
    ...(typeof r.agent_id === 'string' ? { agentId: r.agent_id } : {}),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export function dbBuilderSessionStore(db: Db): BuilderSessionStore {
  return {
    async insert(s) {
      await db.query(`insert into public.builder_sessions (id, business_id, owner_id, agent_id, status, messages, draft_spec, missing_fields, created_at, updated_at)
        values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)`,
      [s.id, s.businessId, s.ownerId, s.agentId ?? null, s.status, json(s.messages), json(s.draftSpec), json(s.missingFields), s.createdAt, s.updatedAt]);
    },
    async get(businessId, id) {
      const r = (await db.query('select * from public.builder_sessions where id = $1 and business_id = $2', [id, businessId])).rows[0] as Row | undefined;
      return r ? sessionFromRow(r) : undefined;
    },
    async update(s) {
      const r = await db.query(`update public.builder_sessions set agent_id = $3, status = $4, messages = $5::jsonb, draft_spec = $6::jsonb, missing_fields = $7::jsonb
        where id = $1 and business_id = $2 returning id`, [s.id, s.businessId, s.agentId ?? null, s.status, json(s.messages), json(s.draftSpec), json(s.missingFields)]);
      if (r.rows.length === 0) throw new Error(`unknown session ${s.id}`);
    },
  };
}

// ---------- agents (drafts) ----------

/**
 * `specRevision` has no column yet. Until a migration adds `agents.spec_revision integer not null
 * default 1`, the revision the builder last wrote is kept in this process and an agent read
 * without one reports 1. It resets on restart; nothing but the preview response reads it.
 */
export function dbAgentDraftStore(db: Db): AgentDraftStore {
  // agents.spec_revision (0005) holds the builder's revision, so it survives a restart.
  const fromRow = (r: Row): AgentRecord => ({
    id: String(r.id), businessId: String(r.business_id), name: String(r.name), template: r.template as AgentRecord['template'],
    channel: 'phone', state: r.state as AgentRecord['state'], draftSpec: (r.draft_spec ?? {}) as AgentRecord['draftSpec'],
    ...(typeof r.active_version_id === 'string' ? { activeVersionId: r.active_version_id } : {}),
    seeded: r.seeded === true, specRevision: typeof r.spec_revision === 'number' ? r.spec_revision : 1,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  });
  return {
    async insert(a) {
      await db.query(`insert into public.agents (id, business_id, name, template, channel, state, draft_spec, active_version_id, seeded, created_at, updated_at, spec_revision)
        values ($1,$2,$3,$4,'phone',$5,$6::jsonb,$7,$8,$9,$10,$11)`,
      [a.id, a.businessId, a.name, a.template, a.state, json(a.draftSpec), a.activeVersionId ?? null, a.seeded, a.createdAt, a.updatedAt, a.specRevision]);
    },
    async get(businessId, id) {
      const r = (await db.query('select * from public.agents where id = $1 and business_id = $2', [id, businessId])).rows[0] as Row | undefined;
      return r ? fromRow(r) : undefined;
    },
    async list(businessId) {
      return (await db.query('select * from public.agents where business_id = $1 order by created_at desc, id desc', [businessId])).rows.map((r) => fromRow(r as Row));
    },
    async update(a) {
      // Publish state and versions belong to B-17. This store changes only the draft fields.
      // The template column follows the draft (review finding 6): the summary and the call stage read it.
      const r = await db.query('update public.agents set name = $3, draft_spec = $4::jsonb, template = $5, spec_revision = $6 where id = $1 and business_id = $2 returning id',
        [a.id, a.businessId, a.name, json(a.draftSpec), a.template, a.specRevision]);
      if (r.rows.length === 0) throw new Error(`unknown agent ${a.id}`);
    },
  };
}

// ---------- draft facts from owner chat answers ----------

function factFromRow(r: Row): BusinessFact {
  const m = mapRow(r);
  return { ...(m as unknown as BusinessFact), value: r.value as BusinessFact['value'], createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    ...(r.verified_at ? { verifiedAt: iso(r.verified_at) } : {}) };
}

export function dbDraftFactStore(db: Db): DraftFactStore {
  return {
    async insertDraft(f) {
      if (f.status !== 'draft') throw new Error('The builder writes draft facts only.');
      await db.query(`insert into public.business_facts (id, business_id, kind, key, value, source_type, source_ref, status, confidence, version, created_at, updated_at)
        values ($1,$2,$3,$4,$5::jsonb,$6,$7,'draft',$8,$9,$10,$11)`,
      [f.id, f.businessId, f.kind, f.key, json(f.value), f.sourceType, f.sourceRef ?? null, f.confidence, f.version, f.createdAt, f.updatedAt]);
    },
    async listBySession(businessId, sessionId) {
      return (await db.query("select * from public.business_facts where business_id = $1 and source_ref = $2 and status = 'draft' order by created_at, id", [businessId, sessionId]))
        .rows.map((r) => factFromRow(r as Row));
    },
  };
}

// ---------- business knowledge (FLOWS A6) ----------

export function dbBusinessKnowledge(db: Db): BusinessKnowledge {
  return {
    async getContext(businessId): Promise<BusinessContext | undefined> {
      const b = (await db.query('select id, name, category, timezone from public.businesses where id = $1', [businessId])).rows[0] as Row | undefined;
      if (!b) return undefined;
      const facts = (await db.query("select * from public.business_facts where business_id = $1 and status = 'verified' order by kind, key", [businessId])).rows.map((r) => factFromRow(r as Row));
      const count = (await db.query('select count(*)::int as n from public.catalog_items where business_id = $1', [businessId])).rows[0] as { n: number };
      const conflicts = (await db.query("select id from public.fact_conflicts where business_id = $1 and state = 'open' and required order by id", [businessId])).rows as Row[];
      return {
        profile: { id: String(b.id), name: String(b.name), category: String(b.category), timezone: String(b.timezone) },
        verifiedFacts: facts, catalogItemCount: count.n, openRequiredConflictIds: conflicts.map((c) => String(c.id)),
      };
    },
  };
}

// ---------- live agent ----------

export function dbLiveAgentReader(db: Db): LiveAgentReader {
  return {
    async isLiveAgent(businessId, agentId) {
      return (await db.query('select 1 from public.live_agent where business_id = $1 and agent_id = $2', [businessId, agentId])).rows.length > 0;
    },
  };
}

// ---------- fact edit from an owner chat answer (P-09) ----------

/**
 * Creates a `fact_edit` approval for the owner's own chat answer and returns what the builder turn
 * puts in `proposedChange`. Nothing changes until the owner confirms through the decision endpoint.
 * The builder's subjectId, fromVersion and before are forwarded; the engine refuses a stale view.
 */
export type ProposeFactFromChat = BuilderProposeFactFromChat;

export function createProposeFactFromChat(engine: PolicyEngine): ProposeFactFromChat {
  return async (input) => {
    const { approval } = await engine.proposeFactEdit({ businessId: input.businessId, ownerUserId: input.ownerUserId, kind: input.kind, key: input.key,
      value: input.value, subjectId: input.subjectId, fromVersion: input.fromVersion, before: input.before, ...(input.reason ? { reason: input.reason } : {}) });
    return { approvalId: approval.id, bundleType: 'fact_edit' };
  };
}
