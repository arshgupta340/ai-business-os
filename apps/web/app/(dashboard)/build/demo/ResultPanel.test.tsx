// @vitest-environment jsdom
import {cleanup, render, screen} from '@testing-library/react';
import {STAGE_SHOPS} from '@abos/contracts/fixtures';
import {afterEach, describe, expect, it} from 'vitest';
import {formatMoney} from '@/lib/format';
import {ResultPanel, wholeDollars} from './ResultPanel';
import {missingNumberText} from './stage-shop';

afterEach(cleanup);

describe('ResultPanel for the pizza place', () => {
  const shop = STAGE_SHOPS.pizza;

  it('shows the shop, the caller line, the number, the hours, the three prices once and every pizza', () => {
    render(<ResultPanel shop={shop} phoneNumber="+18055550123" />);
    expect(screen.getByText(shop.name)).toBeTruthy();
    expect(screen.getByText(shop.callerAction)).toBeTruthy();
    expect(screen.getByText('(805) 555-0123')).toBeTruthy();
    expect(screen.getByText(shop.hoursText)).toBeTruthy();
    expect(screen.getByText('Menu')).toBeTruthy();
    expect(screen.getByText('Sandbox prices')).toBeTruthy();
    for (const [size, price, inches] of [
      ['Small', '$15', '10 inch'],
      ['Medium', '$25', '12 inch'],
      ['Large', '$35', '14 inch'],
    ]) {
      expect(screen.getAllByText(size!)).toHaveLength(1);
      expect(screen.getAllByText(price!)).toHaveLength(1);
      expect(screen.getByText(inches!)).toBeTruthy();
    }
    expect(shop.catalog).toHaveLength(8);
    for (const item of shop.catalog) expect(screen.getByText(item.name)).toBeTruthy();
  });

  it('says plainly that the number is not set, and never invents one', () => {
    render(<ResultPanel shop={shop} phoneNumber={undefined} />);
    expect(screen.getByText(missingNumberText('pizza'))).toBeTruthy();
    expect(screen.queryByText(/\(\d{3}\) \d{3}-\d{4}/)).toBeNull();
  });
});

describe.each(['barber', 'salon'] as const)('ResultPanel for the %s', (key) => {
  const shop = STAGE_SHOPS[key];

  it('shows the shop, its number and hours, and each service with its duration and price', () => {
    render(<ResultPanel shop={shop} phoneNumber="+18055550124" />);
    expect(screen.getByText(shop.name)).toBeTruthy();
    expect(screen.getByText(shop.callerAction)).toBeTruthy();
    expect(screen.getByText('(805) 555-0124')).toBeTruthy();
    expect(screen.getByText(shop.hoursText)).toBeTruthy();
    expect(screen.getByText('Services')).toBeTruthy();
    expect(screen.getByText('Sandbox prices')).toBeTruthy();
    expect(shop.services.length).toBeGreaterThan(0);
    for (const service of shop.services) {
      expect(screen.getByText(service.name)).toBeTruthy();
      expect(screen.getAllByText(formatMoney(service.priceMinor, service.currency)).length).toBeGreaterThan(0);
      expect(screen.getAllByText(`${service.durationMinutes} minutes`).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText('Every pizza below, any size, same price')).toBeNull();
  });
});

describe('wholeDollars', () => {
  it('drops the cents only when there are none', () => {
    expect(wholeDollars(1500)).toBe('$15');
    expect(wholeDollars(1550)).toBe('$15.50');
  });
});
