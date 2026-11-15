// npm run seed:demo-stage (Arsh, 2026-11-15): sets up the three stage shops of the demo, a pizza place, a
// barbershop and a salon, each as a business of its own with its own facts, its own published agent and
// its own phone number. The data is `STAGE_SHOPS` in the contracts fixtures. Safe to run twice.
//
// What it writes, per shop:
// - the business row (the salon is created; the two seeded businesses are renamed),
// - the integration rows (the salon gets the same settings-based rows as the others),
// - the verified facts: hours, address, policies, FAQs and services. Facts are versioned, never edited, and
//   verified hours, contact, FAQ and service facts that are not in the shop's data are retired,
// - a published agent version with the shop's own greeting. A published version cannot be edited, so a
//   changed spec gets a new version, and the agent is pointed at it,
// - the live_agent row for the shop's phone number, when a number is given.
// The pizza place's menu goes to the Square SANDBOX catalog and catalog_items (seedSquareCatalog with `menu`).
//
// A reset (npm run reset) puts the two-pizza seed back and removes the salon's agent and facts. Run this
// again after one, with the same three numbers.

import { createHash } from 'node:crypto';
import { stageShops, type StageFact, type StageShop, type StageShopKey } from '@abos/contracts/fixtures';
import { inTransaction, json, tally, upsertRow, type SeedDb, type TableTally } from './db';
import { seedSquareCatalog, type SquareSeedOptions, type SquareSeedSummary } from './square';
import { SEED_OWNER_ID, integrationRows } from './world';

export const DEMO_STAGE_SOURCE_REF = 'demo-stage';
/** FAQ keys the live smoke check leaves behind ("Is this a live check?"). They do not belong on a call. */
const SMOKE_FAQ_KEY = 'live\\_%';
/** Kinds where the shop's data is the whole truth: a verified fact of these kinds that is not in it is retired. */
const OWNED_KINDS = ['hours', 'contact', 'faq', 'service'];
const E164 = /^\+[1-9][0-9]{6,14}$/;
const TIMEZONE = 'America/Los_Angeles';

export interface DemoStageOptions extends SquareSeedOptions {
  /** The phone number of each shop's line, in E.164. A shop without one gets no live_agent row. */
  numbers: Partial<Record<StageShopKey, string | undefined>>;
}

export interface DemoStageSummary {
  catalog: SquareSeedSummary;
  tables: TableTally;
  retired: number;
  /** One line per shop: its business, agent version and number. */
  lines: string[];
  notes: string[];
}

/** The facts of a shop: its listed facts plus one `service` fact per service. */
export function stageFacts(shop: StageShop): StageFact[] {
  return [...shop.facts, ...shop.services.map((s): StageFact => ({ kind: 'service', key: s.id, value: { ...s } }))];
}

/** A stable ID for the version that carries this spec, so the same spec is never published twice. */
export function stageVersionId(shop: StageShop): string {
  const hash = createHash('sha256').update(JSON.stringify(shop.agent)).digest('hex').slice(0, 10);
  return `agv_${shop.key}_stage_${hash}`;
}

async function applyFacts(db: SeedDb, shop: StageShop, at: string, tables: TableTally): Promise<number> {
  const facts = stageFacts(shop);
  for (const f of facts) {
    const value = JSON.stringify(f.value);
    const cur = (await db.query<{ id: string; same: boolean }>(
      "select id, (value = $4::jsonb) as same from public.business_facts where business_id = $1 and kind = $2 and key = $3 and status = 'verified'",
      [shop.businessId, f.kind, f.key, value])).rows[0];
    if (cur?.same) { tally(tables, 'business_facts', 'unchanged'); continue; }
    const max = (await db.query<{ v: number | string }>(
      "select coalesce(max(version), 0) as v from public.business_facts where business_id = $1 and kind = $2 and key = $3 and status <> 'draft'",
      [shop.businessId, f.kind, f.key])).rows[0];
    const version = Number(max?.v ?? 0) + 1;
    // The old row leaves 'verified' first: one verified fact per (business, kind, key).
    if (cur) await db.query("update public.business_facts set status = 'superseded', updated_at = $2 where id = $1", [cur.id, at]);
    await db.query(
      `insert into public.business_facts (id, business_id, kind, key, value, source_type, source_ref, status, confidence, version, supersedes_id, verified_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, 'seed', $6, 'verified', 1, $7, $8, $9, $9, $9)`,
      [`fact_stage_${shop.key}_${f.kind}_${f.key}_v${version}`, shop.businessId, f.kind, f.key, value, DEMO_STAGE_SOURCE_REF, version, cur?.id ?? null, at]);
    tally(tables, 'business_facts', cur ? 'updated' : 'created');
  }
  // Retire what the shop's data does not carry: the seeded placeholder phone, old FAQs and services, smoke-check FAQs.
  const keep = facts.filter((f) => OWNED_KINDS.includes(f.kind)).map((f) => `${f.kind}:${f.key}`);
  const gone = await db.query(
    `update public.business_facts set status = 'superseded', updated_at = $4
     where business_id = $1 and status = 'verified' and ((kind = any($2::text[]) and not ((kind || ':' || key) = any($3::text[]))) or (kind = 'faq' and key like $5))
     returning id`,
    [shop.businessId, OWNED_KINDS, keep, at, SMOKE_FAQ_KEY]);
  return gone.rows.length;
}

async function applyAgent(db: SeedDb, shop: StageShop, at: string, tables: TableTally): Promise<string> {
  const { agent } = shop;
  const versionId = stageVersionId(shop);
  // The agent row first, as a draft when it is new (agents_check: a live agent needs its version).
  const existing = (await db.query<{ id: string }>('select id from public.agents where id = $1', [agent.id])).rows[0];
  if (!existing) {
    await db.query(
      `insert into public.agents (id, business_id, name, template, channel, state, draft_spec, seeded, created_at)
       values ($1, $2, $3, $4, 'phone', 'draft', null, true, $5)`,
      [agent.id, shop.businessId, agent.name, agent.template, at]);
  }
  const version = (await db.query<{ version: number | string }>('select version from public.agent_versions where id = $1', [versionId])).rows[0];
  let number: number;
  if (version) {
    number = Number(version.version);
    tally(tables, 'agent_versions', 'unchanged');
  } else {
    const max = (await db.query<{ v: number | string }>('select coalesce(max(version), 0) as v from public.agent_versions where agent_id = $1', [agent.id])).rows[0];
    number = Number(max?.v ?? 0) + 1;
    await db.query(
      `insert into public.agent_versions (id, business_id, agent_id, version, spec, knowledge_snapshot_ref, guardrail_version, created_by, created_at, published_at)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $9)`,
      [versionId, shop.businessId, agent.id, number, JSON.stringify({ ...agent, version: number }), JSON.stringify({ facts: [] }), agent.guardrailVersion, SEED_OWNER_ID, at]);
    tally(tables, 'agent_versions', 'created');
  }
  const spec = JSON.stringify({ ...agent, version: number });
  const changed = await db.query(
    `update public.agents set name = $2, template = $3, state = 'live', active_version_id = $4, draft_spec = $5::jsonb
     where id = $1 and (name, template, state, active_version_id, draft_spec) is distinct from ($2, $3, 'live', $4, $5::jsonb) returning id`,
    [agent.id, agent.name, agent.template, versionId, spec]);
  tally(tables, 'agents', !existing ? 'created' : changed.rows.length > 0 ? 'updated' : 'unchanged');
  return versionId;
}

export async function seedDemoStage(db: SeedDb, opts: DemoStageOptions): Promise<DemoStageSummary> {
  const now = opts.now ?? (() => new Date());
  for (const [key, n] of Object.entries(opts.numbers)) {
    if (n !== undefined && !E164.test(n)) throw new Error(`The ${key} number is not an E.164 number such as +15555550199.`);
  }
  const owner = await db.query('select 1 from public.users where id = $1', [SEED_OWNER_ID]);
  if (owner.rows.length === 0) throw new Error(`The owner row ${SEED_OWNER_ID} does not exist. Run npm run seed first.`);

  const tables: TableTally = {};
  const lines: string[] = [];
  const notes: string[] = [];
  let retired = 0;
  const at = now().toISOString();

  // Businesses and integrations first: the catalog step needs the pizza business, the rest need all three.
  await inTransaction(db, async () => {
    for (const shop of stageShops) {
      const contact = { email: `${shop.key}@example.com`, address: shop.address, ...(opts.numbers[shop.key] ? { phone: opts.numbers[shop.key]! } : {}) };
      tally(tables, 'businesses', await upsertRow(db, 'businesses', {
        id: shop.businessId, owner_id: SEED_OWNER_ID, name: shop.name, category: shop.category, timezone: TIMEZONE, currency: 'USD',
        contact: json(contact), settings: json({}), created_at: at,
      }, { conflict: ['id'], insertOnly: ['created_at', 'settings', 'timezone', 'owner_id', 'currency'] }));
      for (const row of integrationRows(shop.businessId, opts.env)) {
        tally(tables, 'integrations', await upsertRow(db, 'integrations', row, { conflict: ['business_id', 'provider', 'alias'], insertOnly: ['id'] }));
      }
    }
  });

  const pizza = stageShops.find((s) => s.catalog.length > 0);
  if (!pizza) throw new Error('No stage shop has a catalog.');
  const catalog = await seedSquareCatalog(db, { env: opts.env, client: opts.client, now, menu: pizza.catalog });

  await inTransaction(db, async () => {
    for (const shop of stageShops) {
      retired += await applyFacts(db, shop, at, tables);
      const versionId = await applyAgent(db, shop, at, tables);
      const phone = opts.numbers[shop.key];
      if (phone === undefined) {
        notes.push(`${shop.name} has no phone number, so no live_agent row was written for it`);
      } else {
        tally(tables, 'live_agent', await upsertRow(db, 'live_agent', {
          phone_number: phone, business_id: shop.businessId, agent_id: shop.agent.id, agent_version_id: versionId,
        }, { conflict: ['phone_number'] }));
      }
      lines.push(`${shop.name}: ${shop.businessId}, ${versionId}, ${phone ?? 'no number'}`);
    }
    // Any other number that still points at a stage agent (the Twilio line) follows the agent's new version.
    for (const shop of stageShops) {
      await db.query('update public.live_agent set agent_version_id = $2 where agent_id = $1 and agent_version_id <> $2', [shop.agent.id, stageVersionId(shop)]);
    }
  });

  return { catalog, tables, retired, lines, notes };
}
