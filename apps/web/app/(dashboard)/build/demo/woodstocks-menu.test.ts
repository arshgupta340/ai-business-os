import {describe, expect, it} from 'vitest';
import {groupByPrice, WOODSTOCKS_MENU, type WoodstocksPizza} from './woodstocks-menu';

describe('WOODSTOCKS_MENU', () => {
  it('has 3 sizes with inches and 16 pizzas with 3 prices each', () => {
    expect(WOODSTOCKS_MENU.sizes.map((s) => `${s.name} ${s.inches}`)).toEqual(['Small 8', 'Medium 12', 'Large 14']);
    expect(WOODSTOCKS_MENU.pizzas).toHaveLength(16);
    expect(new Set(WOODSTOCKS_MENU.pizzas.map((p) => p.name)).size).toBe(16);
    for (const pizza of WOODSTOCKS_MENU.pizzas) {
      expect(pizza.priceMinor).toHaveLength(3);
      expect(pizza.priceMinor.every((p) => Number.isInteger(p) && p > 0)).toBe(true);
      expect(pizza.toppings.length).toBeGreaterThan(0);
    }
  });
});

describe('groupByPrice', () => {
  it('gives one row with every pizza in menu order for the demo prices', () => {
    const rows = groupByPrice(WOODSTOCKS_MENU.pizzas);
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.priceMinor]).toEqual([1500, 2500, 3500]);
    expect(rows[0]!.names).toEqual(WOODSTOCKS_MENU.pizzas.map((p) => p.name));
    expect(rows[0]!.names[0]).toBe('All Meat Orgy');
    expect(rows[0]!.names[15]).toBe("Woody's Waui");
  });

  it('splits by price when prices differ: cheapest row first, names in input order', () => {
    const pizzas: WoodstocksPizza[] = [
      {name: 'B', toppings: 'x', priceMinor: [200, 300, 400]},
      {name: 'A', toppings: 'x', priceMinor: [100, 300, 400]},
      {name: 'C', toppings: 'x', priceMinor: [200, 300, 400]},
      {name: 'D', toppings: 'x', priceMinor: [100, 300, 500]},
    ];
    expect(groupByPrice(pizzas).map((r) => r.names)).toEqual([['A'], ['D'], ['B', 'C']]);
  });
});
