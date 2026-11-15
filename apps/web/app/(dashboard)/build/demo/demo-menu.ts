/**
 * The short menu the result panel shows, fixed before the demo. It is built
 * from the shared pizza catalog in @abos/contracts/fixtures (the same items
 * the demo database is seeded with), so no price is typed here and the panel
 * makes no catalog request.
 */
import {pizzaCatalog} from '@abos/contracts/fixtures';
import type {CatalogItem, CatalogModifierList} from '@/lib/api';
import {formatMoney} from '@/lib/format';

export type DemoMenuItem = {
  id: string;
  name: string;
  sizes: {variationId: string; name: string; priceMinor: number; currency: string}[];
};

export type DemoMenuTopping = {id: string; name: string; priceMinor: number};

export type DemoMenu = {
  items: DemoMenuItem[];
  /** Each modifier list once, in the order it first appears. */
  toppingLists: {id: string; name: string; toppings: DemoMenuTopping[]}[];
};

export function buildDemoMenu(catalog: readonly CatalogItem[]): DemoMenu {
  const available = catalog.filter((i) => i.available);
  const lists = new Map<string, CatalogModifierList>();
  for (const item of available) for (const list of item.modifierLists) if (!lists.has(list.id)) lists.set(list.id, list);
  return {
    items: available.map((item) => ({
      id: item.squareItemId,
      name: item.name,
      sizes: item.variations.map((v) => ({variationId: v.id, name: v.name, priceMinor: v.priceMinor, currency: v.currency})),
    })),
    toppingLists: [...lists.values()].map((list) => ({
      id: list.id,
      name: list.name,
      toppings: list.modifiers.map((m) => ({id: m.id, name: m.name, priceMinor: m.priceMinor})),
    })),
  };
}

export const DEMO_MENU: DemoMenu = buildDemoMenu(pizzaCatalog);

/** The size name of a variation in the demo menu, for example "Large". */
export function demoSizeName(menu: DemoMenu, variationId: string): string | undefined {
  for (const item of menu.items) {
    const size = item.sizes.find((s) => s.variationId === variationId);
    if (size) return size.name;
  }
  return undefined;
}

/** "Small $12.00, Medium $16.00, Large $20.00" */
export function sizesLine(item: DemoMenuItem): string {
  return item.sizes.map((s) => `${s.name} ${formatMoney(s.priceMinor, s.currency)}`).join(', ');
}

/** "Mushrooms +$1.50, Olives +$1.50" */
export function toppingsLine(list: DemoMenu['toppingLists'][number]): string {
  return list.toppings.map((t) => (t.priceMinor ? `${t.name} +${formatMoney(t.priceMinor)}` : t.name)).join(', ');
}
