import {pizzaCatalog, SQ} from '@abos/contracts/fixtures';
import {describe, expect, it} from 'vitest';
import type {CatalogItem, Order} from '@/lib/api';
import {DEMO_MENU, demoSizeName, sizesLine, toppingsLine} from './demo-menu';
import {lineSizeName, lineTitle, toppingsText} from './OrderCard';

type Line = Order['quote']['lines'][number];
const line = (variationId: string, name: string, extra: Record<string, unknown> = {}): Line =>
  ({variationId, name, quantity: 1, unitPriceMinor: 2200, modifiers: [], lineTotalMinor: 2200, ...extra}) as Line;

describe('DEMO_MENU', () => {
  it('is the shared pizza catalog: items, sizes with prices, toppings once', () => {
    expect(DEMO_MENU.items.map((i) => i.name)).toEqual(pizzaCatalog.map((i) => i.name));
    expect(sizesLine(DEMO_MENU.items[0]!)).toBe('Small $12.00, Medium $16.00, Large $20.00');
    expect(DEMO_MENU.toppingLists).toHaveLength(1);
    expect(toppingsLine(DEMO_MENU.toppingLists[0]!)).toBe('Mushrooms +$1.50, Olives +$1.50, Extra cheese +$2.00');
    expect(demoSizeName(DEMO_MENU, SQ.varPepperoniLarge)).toBe('Large');
  });
});

describe('the size on an order line', () => {
  const catalog: CatalogItem[] = [
    {...pizzaCatalog[0]!, variations: [{id: 'VAR_ONLY_IN_CATALOG', name: 'Family', priceMinor: 3000, currency: 'USD'}]},
  ];

  it('uses the variationName the server sends first', () => {
    expect(lineSizeName(line(SQ.varPepperoniLarge, 'Pepperoni', {variationName: 'Extra large'}), DEMO_MENU, catalog)).toBe('Extra large');
  });

  it('then the demo menu', () => {
    expect(lineSizeName(line(SQ.varPepperoniLarge, 'Pepperoni'), DEMO_MENU, catalog)).toBe('Large');
  });

  it('then the catalog', () => {
    expect(lineSizeName(line('VAR_ONLY_IN_CATALOG', 'Margherita'), DEMO_MENU, catalog)).toBe('Family');
  });

  it('else nothing, and the line name shows alone', () => {
    const l = line('VAR_UNKNOWN', 'Calzone');
    expect(lineSizeName(l, DEMO_MENU, catalog)).toBeUndefined();
    expect(lineTitle(l, undefined)).toBe('Calzone');
  });

  it('puts the size next to the item name once', () => {
    expect(lineTitle(line(SQ.varPepperoniLarge, 'Pepperoni'), 'Large')).toBe('Large Pepperoni');
    expect(lineTitle(line(SQ.varPepperoniLarge, 'Large Pepperoni'), 'Large')).toBe('Large Pepperoni');
  });

  it('lists the toppings', () => {
    expect(toppingsText(line('x', 'y', {modifiers: [{modifierId: 'm', name: 'Olives', priceMinor: 150}]}))).toBe('Olives');
    expect(toppingsText(line('x', 'y'))).toBeNull();
  });
});
