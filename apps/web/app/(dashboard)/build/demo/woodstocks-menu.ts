/**
 * The menu the demo result panel shows: Woodstock's Pizza, San Luis Obispo.
 *
 * The pizza names and toppings are from Woodstock's San Luis Obispo ordering
 * page (orders.woodstocksslo.com, read 2026-11-14). The sizes and prices are
 * simplified for the demo (one price per size for every pizza) and are not the
 * shop's real price list. This is a fixed constant, so the panel makes no
 * request. The agent's catalog must match this file: a caller orders from this
 * panel, so a price here that the agent does not quote is a wrong price on screen.
 */

export type WoodstocksSize = {key: string; name: string; inches: number};

/** One price in cents per size, in the order of WOODSTOCKS_MENU.sizes. */
export type SizePrices = readonly [number, number, number];

export type WoodstocksPizza = {name: string; toppings: string; priceMinor: SizePrices};

export type WoodstocksMenu = {
  currency: string;
  sizes: readonly [WoodstocksSize, WoodstocksSize, WoodstocksSize];
  pizzas: readonly WoodstocksPizza[];
};

export const WOODSTOCKS_MENU: WoodstocksMenu = {
  currency: 'USD',
  sizes: [
    {key: 'small', name: 'Small', inches: 8},
    {key: 'medium', name: 'Medium', inches: 12},
    {key: 'large', name: 'Large', inches: 14},
  ],
  pizzas: [
    {name: 'All Meat Orgy', toppings: 'Canadian-style bacon, pepperoni, Italian sausage, salami, applewood-smoked bacon', priceMinor: [1500, 2500, 3500]},
    {name: 'BBQ Bird', toppings: 'BBQ sauce, BBQ chicken, red onions, applewood-smoked bacon', priceMinor: [1500, 2500, 3500]},
    {name: 'Butter Chicken Makhani Pie', toppings: 'Butter chicken simmer sauce, cooked tomatoes, red onions, makhani grilled chicken, ranch drizzle, cilantro', priceMinor: [1500, 2500, 3500]},
    {name: 'Cheese', toppings: 'Mozzarella and red sauce', priceMinor: [1500, 2500, 3500]},
    {name: 'Classic', toppings: 'Pepperoni, Italian sausage, black olives, mushrooms, white onions', priceMinor: [1500, 2500, 3500]},
    {name: 'Garlic Bird', toppings: 'Creamy garlic sauce, grilled chicken, mushrooms, red onions, roma tomatoes', priceMinor: [1500, 2500, 3500]},
    {name: 'Grateful Veg', toppings: 'Bell peppers, white onions, roma tomatoes, black olives, mushrooms', priceMinor: [1500, 2500, 3500]},
    {name: 'Hawaiian', toppings: 'Canadian-style bacon, pineapple, extra mozzarella', priceMinor: [1500, 2500, 3500]},
    {name: "Kickin' Carnitas", toppings: 'Southern chipotle sauce, carnitas, bacon, red onions, cilantro', priceMinor: [1500, 2500, 3500]},
    {name: 'Mustang', toppings: 'Linguica, pepperoni, white onions, bell peppers, pineapple', priceMinor: [1500, 2500, 3500]},
    {name: 'Pepperoni', toppings: 'Mozzarella and pepperoni', priceMinor: [1500, 2500, 3500]},
    {name: 'Pesto Primavera', toppings: 'Pesto sauce, broccoli, artichoke hearts, red onions, roma tomatoes', priceMinor: [1500, 2500, 3500]},
    {name: 'Sriracha-Cha', toppings: 'Creamy sriracha sauce, applewood-smoked bacon, pineapple, green onions, sriracha swirl', priceMinor: [1500, 2500, 3500]},
    {name: 'The Bomb', toppings: 'Pepperoni, Italian sausage, bell peppers, white onions, mushrooms', priceMinor: [1500, 2500, 3500]},
    {name: "Woody's TGB", toppings: 'Zesty red sauce, cooked tomatoes, roasted garlic, basil, light cheese, balsamic glaze', priceMinor: [1500, 2500, 3500]},
    {name: "Woody's Waui", toppings: 'Canadian-style bacon, pineapple, applewood-smoked bacon, red onions', priceMinor: [1500, 2500, 3500]},
  ],
};

/** Pizzas that cost the same in every size, shown as one block. */
export type PriceRow = {priceMinor: SizePrices; names: string[]};

/**
 * Groups pizzas that share all their size prices. Rows go cheapest first (by
 * the smallest size, then the next ones); names keep their menu order inside a
 * row. With the demo prices every pizza lands in one row.
 */
export function groupByPrice(pizzas: readonly WoodstocksPizza[]): PriceRow[] {
  const rows = new Map<string, PriceRow>();
  for (const pizza of pizzas) {
    const key = pizza.priceMinor.join(',');
    const row = rows.get(key);
    if (row) row.names.push(pizza.name);
    else rows.set(key, {priceMinor: pizza.priceMinor, names: [pizza.name]});
  }
  return [...rows.values()].sort((a, b) => {
    for (let i = 0; i < a.priceMinor.length; i++) {
      const d = a.priceMinor[i]! - b.priceMinor[i]!;
      if (d !== 0) return d;
    }
    return 0;
  });
}
