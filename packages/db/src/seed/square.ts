// npm run seed:square: writes the demo pizza menu to the Square SANDBOX catalog, then records the
// real Square object IDs and versions in catalog_items, one row per variation.
// Logic lifted from scripts/spikes/square/src/seed-catalog.ts, with the data taken from the fixtures.
// Safe to run twice: existing objects are found by name, and when they already match the menu no
// upsert is sent at all, so the versions and the catalog_items rows stay the same.

import { createHash } from 'node:crypto';
import type { CatalogItem, CatalogModifierList } from '@abos/contracts';
import { DEMO_TAX_RATE_BPS, pizzaBusiness, pizzaCatalog, pizzaCatalogRows, toppingsModifierList } from '@abos/contracts/fixtures';
import { inTransaction, json, tally, upsertRow, type SeedDb, type TableTally } from './db';
import { envValue, requireEnv, type SeedEnv } from './env';

// ---- The Square REST catalog shapes this script uses (snake_case, as on the wire). ----

export interface SquareMoney { amount: number; currency: string }

export interface SquareCatalogObject {
  type: string;
  id: string;
  version?: number;
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  item_data?: {
    name?: string;
    description?: string;
    product_type?: string;
    tax_ids?: string[];
    modifier_list_info?: { modifier_list_id: string; enabled?: boolean }[];
    variations?: SquareCatalogObject[];
  };
  item_variation_data?: { item_id?: string; name?: string; ordinal?: number; pricing_type?: string; price_money?: SquareMoney };
  modifier_list_data?: { name?: string; selection_type?: string; modifiers?: SquareCatalogObject[] };
  modifier_data?: { name?: string; price_money?: SquareMoney; ordinal?: number; modifier_list_id?: string };
  tax_data?: {
    name?: string; calculation_phase?: string; inclusion_type?: string; percentage?: string;
    applies_to_custom_amounts?: boolean; enabled?: boolean;
  };
}

export interface SquareCatalogClient {
  /** Every live object of these types (ListCatalog, all pages). */
  listCatalog(types: string[]): Promise<SquareCatalogObject[]>;
  /** BatchUpsertCatalogObjects with one batch. */
  batchUpsert(idempotencyKey: string, objects: SquareCatalogObject[]): Promise<{
    objects: SquareCatalogObject[];
    idMappings: { clientObjectId: string; objectId: string }[];
  }>;
}

export const DEMO_TAX_NAME = 'Demo Sales Tax';
/** 875 basis points is "8.75" percent, the string Square expects. */
export const DEMO_TAX_PERCENT = (DEMO_TAX_RATE_BPS / 100).toFixed(2);
const CURRENCY = 'USD';

export interface SquareSeedOptions {
  env: SeedEnv;
  client: SquareCatalogClient;
  /** Used to stamp synced_at. Tests pass a fixed clock. */
  now?: () => Date;
  /**
   * Another menu for the pizza business, in place of the two-pizza fixture (issue #161, the demo shop).
   * Its items carry no modifier list: the Toppings list is neither written nor attached, and an item that
   * already exists in Square under the same name is updated in place. Rows of the business that are not on
   * this menu leave catalog_items, so the agent cannot sell them; their Square objects are left alone.
   */
  menu?: readonly CatalogItem[] | undefined;
}

export interface SquareSeedSummary {
  upserted: boolean;
  created: string[];
  updated: string[];
  tables: TableTally;
}

/** Refuses outside sandbox and names every missing Square variable. Call this before building a client. */
export function requireSquareSandboxEnv(env: SeedEnv): { accessToken: string; locationId: string } {
  if (envValue(env, 'SQUARE_ENVIRONMENT') !== 'sandbox') {
    throw new Error('seed:square refuses to run unless SQUARE_ENVIRONMENT is "sandbox".');
  }
  const v = requireEnv(env, ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'], 'Create the Square sandbox application and put its keys in .env.local.');
  return { accessToken: v.SQUARE_ACCESS_TOKEN!, locationId: v.SQUARE_LOCATION_ID! };
}

export async function seedSquareCatalog(db: SeedDb, opts: SquareSeedOptions): Promise<SquareSeedSummary> {
  requireSquareSandboxEnv(opts.env);
  const now = opts.now ?? (() => new Date());
  const biz = await db.query('select 1 from public.businesses where id = $1', [pizzaBusiness.id]);
  if (biz.rows.length === 0) throw new Error(`${pizzaBusiness.id} does not exist. Run npm run seed first.`);

  // 1. What exists, by name. ListCatalog does not return deleted objects.
  const existing = (await opts.client.listCatalog(['ITEM', 'MODIFIER_LIST', 'TAX'])).filter((o) => !o.is_deleted);
  const byName = (type: string, name: string): SquareCatalogObject | undefined =>
    existing.find((o) => o.type === type && objectName(o) === name);

  // 2. The desired objects, reusing real IDs and versions where they exist.
  const created: string[] = [];
  const updated: string[] = [];
  const note = (label: string, e: SquareCatalogObject | undefined) => (e ? updated : created).push(label);
  const ref = (e: SquareCatalogObject | undefined, tempId: string) =>
    e ? { id: e.id, ...(e.version !== undefined ? { version: e.version } : {}) } : { id: tempId };

  const exTax = byName('TAX', DEMO_TAX_NAME);
  note(`TAX ${DEMO_TAX_NAME}`, exTax);
  const tax: SquareCatalogObject = {
    type: 'TAX', ...ref(exTax, '#tax'), present_at_all_locations: true,
    tax_data: {
      name: DEMO_TAX_NAME, calculation_phase: 'TAX_SUBTOTAL_PHASE', inclusion_type: 'ADDITIVE',
      percentage: DEMO_TAX_PERCENT, applies_to_custom_amounts: false, enabled: true,
    },
  };

  const menu: readonly CatalogItem[] = opts.menu ?? pizzaCatalog;
  const withToppings = opts.menu === undefined;
  const exList = withToppings ? byName('MODIFIER_LIST', toppingsModifierList.name) : undefined;
  if (withToppings) note(`MODIFIER_LIST ${toppingsModifierList.name}`, exList);
  const listRef = ref(exList, '#toppings');
  const modifierList: SquareCatalogObject = {
    type: 'MODIFIER_LIST', ...listRef, present_at_all_locations: true,
    modifier_list_data: {
      name: toppingsModifierList.name,
      selection_type: toppingsModifierList.selectionType,
      modifiers: !withToppings ? [] : toppingsModifierList.modifiers.map((m, i) => {
        const e = exList?.modifier_list_data?.modifiers?.find((x) => x.modifier_data?.name === m.name);
        note(`MODIFIER ${m.name}`, e);
        return {
          type: 'MODIFIER', ...ref(e, `#mod-${i}`), present_at_all_locations: true,
          modifier_data: {
            name: m.name, price_money: { amount: m.priceMinor, currency: CURRENCY }, ordinal: i,
            ...(exList ? { modifier_list_id: exList.id } : {}),
          },
        };
      }),
    },
  };

  const items: SquareCatalogObject[] = menu.map((item, pi) => {
    const exItem = byName('ITEM', item.name);
    note(`ITEM ${item.name}`, exItem);
    const itemRef = ref(exItem, `#item-${pi}`);
    return {
      type: 'ITEM', ...itemRef, present_at_all_locations: true,
      item_data: {
        name: item.name,
        ...(item.description !== undefined ? { description: item.description } : {}),
        product_type: 'REGULAR',
        tax_ids: [tax.id],
        modifier_list_info: withToppings ? [{ modifier_list_id: modifierList.id, enabled: true }] : [],
        variations: item.variations.map((v, si) => {
          const e = exItem?.item_data?.variations?.find((x) => x.item_variation_data?.name === v.name);
          note(`ITEM_VARIATION ${item.name} ${v.name}`, e);
          return {
            type: 'ITEM_VARIATION', ...ref(e, `#var-${pi}-${si}`), present_at_all_locations: true,
            item_variation_data: {
              item_id: itemRef.id, name: v.name, ordinal: si, pricing_type: 'FIXED_PRICING',
              price_money: { amount: v.priceMinor, currency: v.currency },
            },
          };
        }),
      },
    };
  });

  const desired = [tax, ...(withToppings ? [modifierList] : []), ...items];
  const needsUpsert = created.length > 0 || desired.some((d) => {
    const e = existing.find((x) => x.id === d.id);
    return !e || JSON.stringify(project(e)) !== JSON.stringify(project(d));
  });

  // 3. One upsert, only when something differs. The key is a hash of the request, so a retry of
  // the same request reuses the same key and a changed request gets a new one.
  let final: SquareCatalogObject[];
  if (needsUpsert) {
    const key = createHash('sha256').update(JSON.stringify(desired)).digest('hex');
    const res = await opts.client.batchUpsert(key, desired);
    final = res.objects;
  } else {
    final = existing;
  }

  // 4. Read the real IDs and versions back by name.
  const finalItem = (name: string) => final.find((o) => o.type === 'ITEM' && objectName(o) === name);
  const finalList = withToppings ? final.find((o) => o.type === 'MODIFIER_LIST' && objectName(o) === toppingsModifierList.name) : undefined;
  if (withToppings && !finalList) throw new Error('Square did not return the Toppings modifier list.');
  const modifierLists: CatalogModifierList[] = !finalList ? [] : [{
    id: finalList.id,
    name: toppingsModifierList.name,
    selectionType: toppingsModifierList.selectionType,
    modifiers: toppingsModifierList.modifiers.map((m) => {
      const sq = finalList.modifier_list_data?.modifiers?.find((x) => x.modifier_data?.name === m.name);
      if (!sq) throw new Error(`Square did not return the modifier ${m.name}.`);
      return { id: sq.id, name: m.name, priceMinor: m.priceMinor };
    }),
  }];

  // 5. catalog_items, one row per variation, keyed by the fixture row IDs (cat_marg_sm and so on).
  const tables: TableTally = {};
  const syncedAt = now().toISOString();
  const rowIdOf = (variationId: string) => pizzaCatalogRows.find((r) => r.squareVariationId === variationId)?.id ?? `cat_${variationId.toLowerCase()}`;
  await inTransaction(db, async () => {
    // Rows that are not on this menu go first: an item kept under the same name keeps its Square variation
    // IDs, and (business_id, square_variation_id) is unique, so an old row would block the new one.
    const keep = menu.flatMap((item) => item.variations.map((v) => rowIdOf(v.id)));
    await db.query('delete from public.catalog_items where business_id = $1 and not (id = any($2::text[]))', [pizzaBusiness.id, keep]);
    for (const item of menu) {
      const sqItem = finalItem(item.name);
      if (!sqItem || sqItem.version === undefined) throw new Error(`Square did not return the item ${item.name} with a version.`);
      for (const v of item.variations) {
        const sqVar = sqItem.item_data?.variations?.find((x) => x.item_variation_data?.name === v.name);
        if (!sqVar || sqVar.version === undefined) throw new Error(`Square did not return the variation ${item.name} ${v.name}.`);
        const rowId = rowIdOf(v.id);
        tally(tables, 'catalog_items', await upsertRow(db, 'catalog_items', {
          id: rowId, business_id: item.businessId, square_item_id: sqItem.id, square_variation_id: sqVar.id,
          square_item_version: sqItem.version, square_variation_version: sqVar.version,
          item_name: item.name, description: item.description ?? null, variation_name: v.name,
          price_minor: v.priceMinor, currency: 'USD', modifier_lists: json(modifierLists), is_available: item.available,
          synced_at: syncedAt,
        }, { conflict: ['id'], ignoreInCompare: ['synced_at'] }));
      }
    }
  });

  return { upserted: needsUpsert, created, updated, tables };
}

function objectName(o: SquareCatalogObject): string | undefined {
  return o.item_data?.name ?? o.modifier_list_data?.name ?? o.tax_data?.name ?? o.item_variation_data?.name ?? o.modifier_data?.name;
}

/** The fields that decide whether an existing object already matches the menu. */
function project(o: SquareCatalogObject): unknown {
  const money = (m: SquareMoney | undefined) => (m ? [Number(m.amount), m.currency] : null);
  if (o.type === 'TAX') {
    const t = o.tax_data;
    return [t?.name, t?.percentage, t?.calculation_phase, t?.inclusion_type, t?.enabled];
  }
  if (o.type === 'MODIFIER_LIST') {
    const l = o.modifier_list_data;
    return [l?.name, l?.selection_type, (l?.modifiers ?? []).map((m) => [m.modifier_data?.name, money(m.modifier_data?.price_money)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))];
  }
  const i = o.item_data;
  return [
    i?.name, i?.description ?? null, [...(i?.tax_ids ?? [])].sort(),
    (i?.modifier_list_info ?? []).map((m) => [m.modifier_list_id, m.enabled ?? true]),
    (i?.variations ?? []).map((v) => [v.item_variation_data?.name, v.item_variation_data?.pricing_type, money(v.item_variation_data?.price_money)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ];
}
