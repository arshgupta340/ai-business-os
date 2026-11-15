// @vitest-environment jsdom
import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';
import {formatMoney} from '@/lib/format';
import {ResultPanel} from './ResultPanel';
import {WOODSTOCKS_MENU, type WoodstocksMenu} from './woodstocks-menu';

afterEach(cleanup);

describe('ResultPanel menu', () => {
  it('shows the number, the three prices once with inches, and every pizza', () => {
    render(<ResultPanel phoneNumber="+18055550123" />);
    expect(screen.getByText('+1 (805) 555 0123')).toBeTruthy();
    for (const [size, price] of [
      ['Small', '$15.00'],
      ['Medium', '$25.00'],
      ['Large', '$35.00'],
    ]) {
      expect(screen.getAllByText(size)).toHaveLength(1);
      expect(screen.getAllByText(price)).toHaveLength(1);
      expect(price).toBe(formatMoney({Small: 1500, Medium: 2500, Large: 3500}[size!]!));
    }
    expect(screen.getByText('8 inch')).toBeTruthy();
    expect(screen.getByText('12 inch')).toBeTruthy();
    expect(screen.getByText('14 inch')).toBeTruthy();
    expect(screen.getByText('Every pizza below, any size, same price')).toBeTruthy();
    for (const pizza of WOODSTOCKS_MENU.pizzas) expect(screen.getByText(pizza.name)).toBeTruthy();
  });

  it('takes the menu as a prop and shows one block per price row', () => {
    const menu: WoodstocksMenu = {
      ...WOODSTOCKS_MENU,
      pizzas: [
        {name: 'Test Pie', toppings: 'Cheese', priceMinor: [100, 200, 300]},
        {name: 'Fancy Pie', toppings: 'Gold', priceMinor: [500, 600, 700]},
      ],
    };
    render(<ResultPanel phoneNumber="+18055550123" menu={menu} />);
    expect(screen.getByText('Test Pie')).toBeTruthy();
    expect(screen.getByText('$1.00')).toBeTruthy();
    expect(screen.getByText('$7.00')).toBeTruthy();
    expect(screen.getAllByText('Small')).toHaveLength(2);
    expect(screen.getAllByText('These pizzas, any size')).toHaveLength(2);
    expect(screen.queryByText('Cheese')).toBeNull();
  });
});
