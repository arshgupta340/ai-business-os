// npm run seed:demo-shop (issue #161): loads the demo shop for the pizza business. The menu goes to the
// Square SANDBOX catalog and to catalog_items (seedSquareCatalog with `menu`), and the shop's facts
// (hours, address, policies, FAQs) become the verified facts. Safe to run twice.
//
// Facts are versioned, never edited: a fact whose value differs gets a new verified row that supersedes
// the old one, as an owner edit does. A reset (npm run reset) puts the two-pizza seed facts back; run this
// again after one.

import { demoShopCatalog, demoShopFacts, demoShopRetiredFacts, pizzaBusiness, type DemoShopFact } from '@abos/contracts/fixtures';
import { inTransaction, tally, type SeedDb, type TableTally } from './db';
import { seedSquareCatalog, type SquareSeedOptions, type SquareSeedSummary } from './square';

export const DEMO_SHOP_SOURCE_REF = 'issue-161';
/** FAQ keys the live smoke check leaves behind ("Is this a live check?"). They do not belong on a call. */
const SMOKE_FAQ_KEY = 'live\\_%';

export interface DemoShopSummary {
  catalog: SquareSeedSummary;
  facts: TableTally;
  retired: number;
}

/** Makes each (kind, key) the verified fact with this value. Returns per-table counts and how many facts were retired. */
export async function applyDemoShopFacts(db: SeedDb, now: () => Date = () => new Date(),
  facts: readonly DemoShopFact[] = demoShopFacts, retire: readonly { kind: string; key: string }[] = demoShopRetiredFacts): Promise<{ tables: TableTally; retired: number }> {
  const businessId = pizzaBusiness.id;
  const at = now().toISOString();
  const tables: TableTally = {};
  let retired = 0;
  await inTransaction(db, async () => {
    for (const f of facts) {
      const value = JSON.stringify(f.value);
      const cur = (await db.query<{ id: string; same: boolean }>(
        "select id, (value = $4::jsonb) as same from public.business_facts where business_id = $1 and kind = $2 and key = $3 and status = 'verified'",
        [businessId, f.kind, f.key, value])).rows[0];
      if (cur?.same) { tally(tables, 'business_facts', 'unchanged'); continue; }
      const max = (await db.query<{ v: number | string }>(
        "select coalesce(max(version), 0) as v from public.business_facts where business_id = $1 and kind = $2 and key = $3 and status <> 'draft'",
        [businessId, f.kind, f.key])).rows[0];
      const version = Number(max?.v ?? 0) + 1;
      // The old row leaves 'verified' first: one verified fact per (business, kind, key).
      if (cur) await db.query("update public.business_facts set status = 'superseded', updated_at = $2 where id = $1", [cur.id, at]);
      await db.query(
        `insert into public.business_facts (id, business_id, kind, key, value, source_type, source_ref, status, confidence, version, supersedes_id, verified_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, 'seed', $6, 'verified', 1, $7, $8, $9, $9, $9)`,
        [`fact_demo_${f.kind}_${f.key}_v${version}`, businessId, f.kind, f.key, value, DEMO_SHOP_SOURCE_REF, version, cur?.id ?? null, at]);
      tally(tables, 'business_facts', cur ? 'updated' : 'created');
    }
    for (const r of retire) {
      const gone = await db.query(
        "update public.business_facts set status = 'superseded', updated_at = $4 where business_id = $1 and kind = $2 and key = $3 and status = 'verified' returning id",
        [businessId, r.kind, r.key, at]);
      retired += gone.rows.length;
    }
    const smoke = await db.query(
      "update public.business_facts set status = 'superseded', updated_at = $3 where business_id = $1 and kind = 'faq' and key like $2 and status = 'verified' returning id",
      [businessId, SMOKE_FAQ_KEY, at]);
    retired += smoke.rows.length;
  });
  return { tables, retired };
}

export async function seedDemoShop(db: SeedDb, opts: SquareSeedOptions): Promise<DemoShopSummary> {
  const catalog = await seedSquareCatalog(db, { ...opts, menu: demoShopCatalog });
  const facts = await applyDemoShopFacts(db, opts.now);
  return { catalog, facts: facts.tables, retired: facts.retired };
}
