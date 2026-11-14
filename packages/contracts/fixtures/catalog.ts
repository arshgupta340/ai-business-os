// The Demo Pizza Co. catalog (CONTRACTS 9): two pizzas in three sizes and one shared Toppings list.
// Square IDs are placeholders (`SQ_...`); the seed script maps them to real sandbox IDs.
import { PIZZA_BUSINESS_ID, type CatalogItem, type CatalogModifierList } from '../src/index';

/** When the `catalog_items` cache was last synced from Square. */
export const CATALOG_SYNCED_AT: string = '2026-11-14T16:00:00Z';

export const SQ = {
  itemMargherita: 'SQ_ITEM_MARG',
  varMargheritaSmall: 'SQ_VAR_MARG_SM',
  varMargheritaMedium: 'SQ_VAR_MARG_MD',
  varMargheritaLarge: 'SQ_VAR_MARG_LG',
  itemPepperoni: 'SQ_ITEM_PEP',
  varPepperoniSmall: 'SQ_VAR_PEP_SM',
  varPepperoniMedium: 'SQ_VAR_PEP_MD',
  varPepperoniLarge: 'SQ_VAR_PEP_LG',
  modListToppings: 'SQ_MODLIST_TOPPINGS',
  modMushrooms: 'SQ_MOD_MUSHROOMS',
  modOlives: 'SQ_MOD_OLIVES',
  modExtraCheese: 'SQ_MOD_XCHEESE',
} as const;

export const toppingsModifierList = {
  id: SQ.modListToppings,
  name: 'Toppings',
  selectionType: 'MULTIPLE',
  modifiers: [
    { id: SQ.modMushrooms, name: 'Mushrooms', priceMinor: 150 },
    { id: SQ.modOlives, name: 'Olives', priceMinor: 150 },
    { id: SQ.modExtraCheese, name: 'Extra cheese', priceMinor: 200 },
  ],
} satisfies CatalogModifierList;

export const margherita = {
  squareItemId: SQ.itemMargherita,
  businessId: PIZZA_BUSINESS_ID,
  name: 'Margherita',
  description: 'Tomato, mozzarella and basil pizza.',
  available: true,
  variations: [
    { id: SQ.varMargheritaSmall, name: 'Small', priceMinor: 1200, currency: 'USD' },
    { id: SQ.varMargheritaMedium, name: 'Medium', priceMinor: 1600, currency: 'USD' },
    { id: SQ.varMargheritaLarge, name: 'Large', priceMinor: 2000, currency: 'USD' },
  ],
  modifierLists: [toppingsModifierList],
  syncedAt: CATALOG_SYNCED_AT,
} satisfies CatalogItem;

export const pepperoni = {
  squareItemId: SQ.itemPepperoni,
  businessId: PIZZA_BUSINESS_ID,
  name: 'Pepperoni',
  description: 'Tomato, mozzarella and pepperoni pizza.',
  available: true,
  variations: [
    { id: SQ.varPepperoniSmall, name: 'Small', priceMinor: 1400, currency: 'USD' },
    { id: SQ.varPepperoniMedium, name: 'Medium', priceMinor: 1800, currency: 'USD' },
    { id: SQ.varPepperoniLarge, name: 'Large', priceMinor: 2200, currency: 'USD' },
  ],
  modifierLists: [toppingsModifierList],
  syncedAt: CATALOG_SYNCED_AT,
} satisfies CatalogItem;

/** The grouped form the API (`GET /api/businesses/:id/catalog`) and the tools return (SPEC 2.9). */
export const pizzaCatalog = [margherita, pepperoni] satisfies CatalogItem[];

/**
 * One `catalog_items` row per sellable variation (DATA-MODEL 2.7). The contracts package has no row
 * schema, so this type is local and follows the table's columns in camelCase.
 */
export type CatalogRow = {
  id: string; // cat_ id
  businessId: string;
  squareItemId: string;
  squareVariationId: string;
  squareItemVersion: number;
  squareVariationVersion: number;
  itemName: string;
  variationName: string;
  priceMinor: number;
  currency: 'USD';
  available: boolean;
  syncedAt: string;
};

const ROW_ID_BY_VARIATION: Record<string, string> = {
  [SQ.varMargheritaSmall]: 'cat_marg_sm',
  [SQ.varMargheritaMedium]: 'cat_marg_md',
  [SQ.varMargheritaLarge]: 'cat_marg_lg',
  [SQ.varPepperoniSmall]: 'cat_pep_sm',
  [SQ.varPepperoniMedium]: 'cat_pep_md',
  [SQ.varPepperoniLarge]: 'cat_pep_lg',
};

export const pizzaCatalogRows: CatalogRow[] = pizzaCatalog.flatMap((item) =>
  item.variations.map((v) => ({
    id: ROW_ID_BY_VARIATION[v.id] ?? `cat_${v.id.toLowerCase()}`,
    businessId: item.businessId,
    squareItemId: item.squareItemId,
    squareVariationId: v.id,
    squareItemVersion: 3,
    squareVariationVersion: 3,
    itemName: item.name,
    variationName: v.name,
    priceMinor: v.priceMinor,
    currency: v.currency,
    available: item.available,
    syncedAt: CATALOG_SYNCED_AT,
  })),
);

/**
 * Demo sales tax in basis points (8.75 percent). Illustrative only: in the real flow Square
 * CalculateOrder computes tax (P-02). Matches the CONTRACTS 9 worked example (4350 gives 381).
 */
export const DEMO_TAX_RATE_BPS = 875;

/** Tax in minor units, rounded half up. */
export function demoTaxMinor(subtotalMinor: number): number {
  return Math.floor((subtotalMinor * DEMO_TAX_RATE_BPS + 5000) / 10000);
}
