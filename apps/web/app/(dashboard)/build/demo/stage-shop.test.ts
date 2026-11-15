import {DEMO_PHONE_NUMBER, STAGE_SHOPS} from '@abos/contracts/fixtures';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {pizzaCatalog} from '@abos/contracts/fixtures';
import {bookingPrice, durationMinutes} from './BookingCard';
import {lineSizeName, lineTitle, toppingsText} from './OrderCard';
import {demoPhoneNumberFor, shopForFileNames} from './stage-shop';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('shopForFileNames', () => {
  it('picks the shop of the first recognized file, either of its two files, in any case', () => {
    expect(shopForFileNames([STAGE_SHOPS.pizza.files.info])?.key).toBe('pizza');
    expect(shopForFileNames([STAGE_SHOPS.barber.files.faq])?.key).toBe('barber');
    expect(shopForFileNames([STAGE_SHOPS.salon.files.info.toUpperCase()])?.key).toBe('salon');
    expect(shopForFileNames(['notes.txt', STAGE_SHOPS.salon.files.faq, STAGE_SHOPS.pizza.files.info])?.key).toBe('salon');
  });

  it('finds no shop for other files or none', () => {
    expect(shopForFileNames([])).toBeUndefined();
    expect(shopForFileNames(['menu.pdf', 'faq.pdf'])).toBeUndefined();
  });
});

describe('demoPhoneNumberFor', () => {
  it('reads one number per shop', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_PIZZA', '+18055550101');
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_BARBER', ' +18055550102 ');
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_SALON', '+18055550103');
    expect(demoPhoneNumberFor('pizza')).toBe('+18055550101');
    expect(demoPhoneNumberFor('barber')).toBe('+18055550102');
    expect(demoPhoneNumberFor('salon')).toBe('+18055550103');
  });

  it('falls back to the old single number for the pizza place only', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_PIZZA', '');
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_BARBER', '');
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_SALON', '');
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_NUMBER', '+18055550100');
    vi.stubEnv('NEXT_PUBLIC_MOCK', '');
    expect(demoPhoneNumberFor('pizza')).toBe('+18055550100');
    expect(demoPhoneNumberFor('barber')).toBeUndefined();
    expect(demoPhoneNumberFor('salon')).toBeUndefined();
  });

  it('uses the fixture number in mock mode when a number is missing', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_SALON', '');
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    expect(demoPhoneNumberFor('salon')).toBe(DEMO_PHONE_NUMBER);
  });
});

type Line = Parameters<typeof lineTitle>[0];
const line = (variationId: string, name: string, extra: Record<string, unknown> = {}): Line =>
  ({variationId, name, quantity: 1, modifiers: [], unitPriceMinor: 0, lineTotalMinor: 0, ...extra}) as unknown as Line;

describe('order lines', () => {
  const variation = pizzaCatalog[0]!.variations.at(-1)!;

  it('names the size from the line, else from the API catalog by variation id', () => {
    expect(lineSizeName(line(variation.id, 'Pizza', {variationName: 'Extra large'}), pizzaCatalog)).toBe('Extra large');
    expect(lineSizeName(line(variation.id, 'Pizza'), pizzaCatalog)).toBe(variation.name);
    expect(lineSizeName(line('VAR_UNKNOWN', 'Calzone'), pizzaCatalog)).toBeUndefined();
    expect(lineSizeName(line(variation.id, 'Pizza'))).toBeUndefined();
  });

  it('puts the size before the name unless the name has it', () => {
    expect(lineTitle(line('x', 'Pepperoni'), 'Large')).toBe('Large Pepperoni');
    expect(lineTitle(line('x', 'Large Pepperoni'), 'Large')).toBe('Large Pepperoni');
    expect(lineTitle(line('x', 'Calzone'), undefined)).toBe('Calzone');
  });

  it('lists the toppings, or nothing', () => {
    expect(toppingsText(line('x', 'y', {modifiers: [{modifierId: 'm', name: 'Olives', priceMinor: 150}]}))).toBe('Olives');
    expect(toppingsText(line('x', 'y'))).toBeNull();
  });
});

describe('booking helpers', () => {
  it('measures the duration in minutes', () => {
    expect(durationMinutes('2026-11-15T17:00:00Z', '2026-11-15T17:45:00Z')).toBe(45);
  });

  it('prices a booking from the stage shop services', () => {
    const service = STAGE_SHOPS.salon.services[0]!;
    expect(bookingPrice(STAGE_SHOPS.salon.businessId, service.id)).toEqual({priceMinor: service.priceMinor, currency: service.currency});
    expect(bookingPrice(STAGE_SHOPS.barber.businessId, 'svc_unknown')).toBeUndefined();
  });
});
