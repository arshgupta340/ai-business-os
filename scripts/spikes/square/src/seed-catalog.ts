// npm run seed-catalog: creates (or updates in place) two pizzas with three
// sizes each, a "Toppings" modifier list attached to both, and one sales tax
// applied to both items, in one BatchUpsertCatalogObjects call.
// Safe to run twice: existing objects are found by name and updated with their
// real ID and current version instead of being duplicated.
import { randomUUID } from "node:crypto";
import type { Square } from "square";
import { requireSquareEnv } from "./env.js";
import {
  CATALOG_IDS_FILE,
  PIZZAS,
  SIZES,
  TOPPINGS,
  makeClient,
  run,
  writeJson,
  type CatalogIds,
  type PizzaName,
  type SizeName,
  type ToppingName,
} from "./common.js";

const env = requireSquareEnv(["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]);
const client = makeClient(env.SQUARE_ACCESS_TOKEN);

const TAX_NAME = "Spike Sales Tax";
const TAX_PERCENT = "8.75";
const MODIFIER_LIST_NAME = "Toppings";
const CURRENCY = "USD";

// Prices in minor units (cents).
const PRICES: Record<PizzaName, Record<SizeName, bigint>> = {
  Margherita: { Small: 1099n, Medium: 1399n, Large: 1699n },
  Pepperoni: { Small: 1199n, Medium: 1499n, Large: 1799n },
};
const TOPPING_PRICES: Record<ToppingName, bigint> = {
  "Extra cheese": 150n,
  Mushrooms: 100n,
  Jalapenos: 75n,
};

type Existing = { id: string; version?: bigint };

async function listByType(types: string): Promise<Square.CatalogObject[]> {
  const out: Square.CatalogObject[] = [];
  const page = await client.catalog.list({ types });
  for await (const obj of page) out.push(obj);
  return out;
}

function ref(e: Existing | undefined, tempId: string): { id: string; version?: bigint } {
  return e ? { id: e.id, ...(e.version !== undefined ? { version: e.version } : {}) } : { id: tempId };
}

await run("seed-catalog", async () => {
  // 1. Find what already exists, by name. Deleted objects are not returned by ListCatalog.
  const existing = await listByType("ITEM,MODIFIER_LIST,TAX");
  const taxes = existing.filter((o): o is Square.CatalogObject.Tax => o.type === "TAX");
  const lists = existing.filter((o): o is Square.CatalogObject.ModifierList => o.type === "MODIFIER_LIST");
  const items = existing.filter((o): o is Square.CatalogObject.Item => o.type === "ITEM");

  const pickOne = <T extends { id: string }>(arr: T[], label: string): T | undefined => {
    if (arr.length > 1) console.warn(`WARN: ${arr.length} objects named ${label}; updating the first (${arr[0]!.id}).`);
    return arr[0];
  };

  const exTax = pickOne(taxes.filter((t) => t.taxData?.name === TAX_NAME), TAX_NAME);
  const exList = pickOne(lists.filter((l) => l.modifierListData?.name === MODIFIER_LIST_NAME), MODIFIER_LIST_NAME);

  const exModifiers = new Map<string, Existing>();
  for (const m of exList?.modifierListData?.modifiers ?? []) {
    if (m.type === "MODIFIER" && m.modifierData?.name) exModifiers.set(m.modifierData.name, m);
  }

  const created: string[] = [];
  const updated: string[] = [];
  const note = (label: string, e: Existing | undefined) => (e ? updated : created).push(label);

  // 2. Build the desired objects, reusing real IDs and versions where they exist.
  const taxRef = ref(exTax, "#tax");
  note(`TAX ${TAX_NAME}`, exTax);
  const tax: Square.CatalogObject.Tax = {
    type: "TAX",
    ...taxRef,
    presentAtAllLocations: true,
    taxData: {
      name: TAX_NAME,
      calculationPhase: "TAX_SUBTOTAL_PHASE",
      inclusionType: "ADDITIVE",
      percentage: TAX_PERCENT,
      appliesToCustomAmounts: false,
      enabled: true,
    },
  };

  const listRef = ref(exList, "#toppings");
  note(`MODIFIER_LIST ${MODIFIER_LIST_NAME}`, exList);
  const modifierList: Square.CatalogObject.ModifierList = {
    type: "MODIFIER_LIST",
    ...listRef,
    presentAtAllLocations: true,
    modifierListData: {
      name: MODIFIER_LIST_NAME,
      selectionType: "MULTIPLE",
      modifiers: TOPPINGS.map((name, i): Square.CatalogObject.Modifier => {
        const e = exModifiers.get(name);
        note(`MODIFIER ${name}`, e);
        return {
          type: "MODIFIER",
          ...ref(e, `#mod-${i}`),
          presentAtAllLocations: true,
          modifierData: {
            name,
            priceMoney: { amount: TOPPING_PRICES[name], currency: CURRENCY },
            ordinal: i,
            ...(exList ? { modifierListId: exList.id } : {}),
          },
        };
      }),
    },
  };

  const itemObjects: Square.CatalogObject.Item[] = PIZZAS.map((pizza, pi) => {
    const exItem = pickOne(items.filter((it) => it.itemData?.name === pizza), pizza);
    note(`ITEM ${pizza}`, exItem);
    const itemRef = ref(exItem, `#item-${pi}`);
    const exVars = new Map<string, Existing>();
    for (const v of exItem?.itemData?.variations ?? []) {
      if (v.type === "ITEM_VARIATION" && v.itemVariationData?.name) exVars.set(v.itemVariationData.name, v);
    }
    return {
      type: "ITEM",
      ...itemRef,
      presentAtAllLocations: true,
      itemData: {
        name: pizza,
        description: `Spike test pizza (${pizza}). Sandbox only.`,
        productType: "REGULAR",
        taxIds: [taxRef.id],
        modifierListInfo: [{ modifierListId: listRef.id, enabled: true }],
        variations: SIZES.map((size, si): Square.CatalogObject.ItemVariation => {
          const e = exVars.get(size);
          note(`ITEM_VARIATION ${pizza} ${size}`, e);
          return {
            type: "ITEM_VARIATION",
            ...ref(e, `#var-${pi}-${si}`),
            presentAtAllLocations: true,
            itemVariationData: {
              itemId: itemRef.id,
              name: size,
              ordinal: si,
              pricingType: "FIXED_PRICING",
              priceMoney: { amount: PRICES[pizza][size], currency: CURRENCY },
            },
          };
        }),
      },
    };
  });

  // 3. One upsert call. A fresh key each run is fine: duplicates are prevented by the name lookup above.
  const res = await client.catalog.batchUpsert({
    idempotencyKey: randomUUID(),
    batches: [{ objects: [tax, modifierList, ...itemObjects] }],
  });

  // 4. Resolve every #temp ID to its real ID.
  const map = new Map<string, string>();
  for (const m of res.idMappings ?? []) {
    if (m.clientObjectId && m.objectId) map.set(m.clientObjectId, m.objectId);
  }
  const real = (id: string): string => {
    if (!id.startsWith("#")) return id;
    const r = map.get(id);
    if (!r) throw new Error(`No id_mapping returned for ${id}`);
    return r;
  };

  const ids: CatalogIds = {
    locationId: env.SQUARE_LOCATION_ID,
    taxId: real(tax.id),
    modifierListId: real(modifierList.id),
    modifiers: Object.fromEntries(
      (modifierList.modifierListData!.modifiers ?? []).map((m) => [
        (m as Square.CatalogObject.Modifier).modifierData!.name!,
        real(m.id ?? ""),
      ]),
    ) as Record<ToppingName, string>,
    items: Object.fromEntries(
      itemObjects.map((it) => [
        it.itemData!.name!,
        {
          itemId: real(it.id),
          variations: Object.fromEntries(
            (it.itemData!.variations ?? []).map((v) => [
              (v as Square.CatalogObject.ItemVariation).itemVariationData!.name!,
              real(v.id ?? ""),
            ]),
          ),
        },
      ]),
    ) as CatalogIds["items"],
    seededAt: new Date().toISOString(),
  };

  writeJson(CATALOG_IDS_FILE, ids);
  console.log(`SANDBOX catalog upserted. Created ${created.length}, updated ${updated.length}.`);
  if (created.length) console.log(`  created: ${created.join("; ")}`);
  if (updated.length) console.log(`  updated: ${updated.join("; ")}`);
  console.log(`Wrote ${CATALOG_IDS_FILE}`);
  console.log(JSON.stringify(ids, null, 2));
});
