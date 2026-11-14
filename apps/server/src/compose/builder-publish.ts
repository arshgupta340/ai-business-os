// Database implementations of the builder's publish seams (builder NOTES-backend-changes.md), so
// publish, pause, rollback and versions survive a restart. Every query runs as abos_app on tables it
// may write (agent_versions insert, live_agent insert/update/delete, activity_events insert).
// agent_versions rows are immutable (0002 trigger); nothing here updates one.
import type { AgentSpec, KnowledgeSnapshotRef } from '@abos/contracts';
import type { AgentVersionRecord, AgentVersionStore, LiveAgentPointer, LiveAgentStore, PublishEventSink } from '../builder/publish/stores';
import type { CatalogSync } from '../builder/publish/catalog-sync';
import type { IntegrationHealthReader } from '../builder/publish/integrations';
import type { Db } from '../db/index';
import { emitActivity } from '../policy/activity';
import type { HealthMonitor } from './health';
import type { Providers } from './providers';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

// The author's display name for the version history, read in the same query as the version. The name
// is joined only when the author is the owner of the version's business (as `ownerDisplayNames` in
// api/display.ts does), so a read never names a user outside that business. The email is never read.
const VERSION_SELECT = `select v.*, u.display_name as created_by_name from public.agent_versions v
  left join public.businesses b on b.id = v.business_id
  left join public.users u on u.id = v.created_by and u.id = b.owner_id`;

function versionFromRow(r: Row): AgentVersionRecord {
  const name = typeof r.created_by_name === 'string' ? r.created_by_name.trim() : '';
  return {
    id: String(r.id), businessId: String(r.business_id), agentId: String(r.agent_id), version: Number(r.version),
    spec: r.spec as AgentSpec, knowledgeSnapshotRef: (r.knowledge_snapshot_ref ?? {}) as KnowledgeSnapshotRef,
    guardrailVersion: 'v1', createdBy: String(r.created_by), createdAt: iso(r.created_at), publishedAt: iso(r.published_at ?? r.created_at),
    ...(name ? { createdByName: name } : {}),
  };
}

export function dbAgentVersionStore(db: Db): AgentVersionStore {
  return {
    async insert(v) {
      await db.query(`insert into public.agent_versions (id, business_id, agent_id, version, spec, knowledge_snapshot_ref, guardrail_version, created_by, created_at, published_at)
        values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)`,
      [v.id, v.businessId, v.agentId, v.version, JSON.stringify(v.spec), JSON.stringify(v.knowledgeSnapshotRef), v.guardrailVersion, v.createdBy, v.createdAt, v.publishedAt]);
    },
    async get(businessId, id) {
      const r = (await db.query(`${VERSION_SELECT} where v.id = $1 and v.business_id = $2`, [id, businessId])).rows[0] as Row | undefined;
      return r ? versionFromRow(r) : undefined;
    },
    async listByAgent(businessId, agentId) {
      return ((await db.query(`${VERSION_SELECT} where v.business_id = $1 and v.agent_id = $2 order by v.version desc`, [businessId, agentId])).rows as Row[]).map(versionFromRow);
    },
    async maxVersion(businessId, agentId) {
      const r = (await db.query('select coalesce(max(version), 0)::int as max from public.agent_versions where business_id = $1 and agent_id = $2', [businessId, agentId])).rows[0] as Row | undefined;
      return Number(r?.max ?? 0);
    },
  };
}

/** The live_agent row for one phone number (the configured Twilio number). */
export function dbLiveAgentStore(db: Db, phoneNumber: string): LiveAgentStore {
  const fromRow = (r: Row): LiveAgentPointer => ({ phoneNumber: String(r.phone_number), businessId: String(r.business_id), agentId: String(r.agent_id),
    agentVersionId: String(r.agent_version_id), updatedAt: iso(r.updated_at) });
  return {
    phoneNumber,
    async get() {
      const r = (await db.query('select * from public.live_agent where phone_number = $1', [phoneNumber])).rows[0] as Row | undefined;
      return r ? fromRow(r) : undefined;
    },
    async set(next) {
      if (next.phoneNumber !== phoneNumber) throw new Error('This store holds the pointer for one phone number only.');
      return db.transaction(async (tx) => {
        const prior = (await tx.query('select * from public.live_agent where phone_number = $1 for update', [phoneNumber])).rows[0] as Row | undefined;
        await tx.query(`insert into public.live_agent (phone_number, business_id, agent_id, agent_version_id, updated_at) values ($1,$2,$3,$4,$5)
          on conflict (phone_number) do update set business_id = excluded.business_id, agent_id = excluded.agent_id,
            agent_version_id = excluded.agent_version_id, updated_at = excluded.updated_at`,
        [phoneNumber, next.businessId, next.agentId, next.agentVersionId, next.updatedAt]);
        return prior ? fromRow(prior) : undefined;
      });
    },
  };
}

export function dbPublishEventSink(db: Db): PublishEventSink {
  return { write: (event) => emitActivity(db, event) };
}

/**
 * Issue #94 item 6: the one configured Square location's catalog belongs to the business that already
 * holds its cached rows (the same rule webhook attribution uses). Another business may not copy it.
 */
export async function catalogOwnedElsewhere(db: Db, businessId: string): Promise<boolean> {
  return (await db.query('select 1 from public.catalog_items where business_id <> $1 limit 1', [businessId])).rows.length > 0;
}

/** Publish refreshes the catalog cache from Square first. Without Square, or for a business that does not sell from it, nothing is synced. */
export function squareCatalogSync(db: Db, providers: Providers, now: () => Date): CatalogSync {
  return async ({ businessId }) => {
    if (!providers.square) return {};
    if (await catalogOwnedElsewhere(db, businessId)) return {};
    await providers.square.syncCatalog(db, businessId);
    return { syncedAt: now().toISOString() };
  };
}

/** The last stored health results (no live probe at publish time). */
export function healthReader(health: HealthMonitor): IntegrationHealthReader {
  return { read: () => health.read({ refresh: false }) };
}
