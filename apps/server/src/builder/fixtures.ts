// TEMPORARY seed data, built from the fixture descriptions in docs/CONTRACTS.md
// section 9. It stands in for packages/contracts/fixtures (task S-03) and for
// the seeded database (task B-06). Replace both uses with the real fixtures
// and the database when those land.
//
// What is from CONTRACTS.md: business IDs and names, the timezone, the pizza
// catalog items, sizes, prices and Toppings list, the pickup window of 20
// minutes, special requests allowed, the three barber services with durations,
// prices and a 5 minute buffer. What is placeholder: the opening hours, the
// Square IDs (CONTRACTS.md says they are placeholders), the fact IDs.

import type { BusinessFact, CatalogItem, FactKind, ServiceOffering } from './pending-contracts';

export const TIMEZONE = 'America/Los_Angeles';
const SEEDED_AT = '2026-11-13T08:00:00Z';

export interface BusinessProfile {
  id: string;
  name: string;
  category: string;
  timezone?: string;
}

export const BUSINESSES: readonly BusinessProfile[] = [
  { id: 'biz_pizza_01', name: 'Demo Pizza Co.', category: 'restaurant', timezone: TIMEZONE },
  { id: 'biz_barber_01', name: 'Demo Barbershop', category: 'barbershop', timezone: TIMEZONE },
];

const toppings: CatalogItem['modifierLists'][number] = {
  id: 'SQ_MODLIST_TOPPINGS',
  name: 'Toppings',
  selectionType: 'MULTIPLE',
  modifiers: [
    { id: 'SQ_MOD_MUSHROOM', name: 'Mushrooms', priceMinor: 150 },
    { id: 'SQ_MOD_OLIVES', name: 'Olives', priceMinor: 150 },
    { id: 'SQ_MOD_XCHEESE', name: 'Extra cheese', priceMinor: 200 },
  ],
};

export const PIZZA_CATALOG: readonly CatalogItem[] = [
  {
    squareItemId: 'SQ_ITEM_MARG',
    businessId: 'biz_pizza_01',
    name: 'Margherita',
    available: true,
    variations: [
      { id: 'SQ_VAR_MARG_SM', name: 'Small', priceMinor: 1200, currency: 'USD' },
      { id: 'SQ_VAR_MARG_MD', name: 'Medium', priceMinor: 1600, currency: 'USD' },
      { id: 'SQ_VAR_MARG_LG', name: 'Large', priceMinor: 2000, currency: 'USD' },
    ],
    modifierLists: [toppings],
    syncedAt: SEEDED_AT,
  },
  {
    squareItemId: 'SQ_ITEM_PEP',
    businessId: 'biz_pizza_01',
    name: 'Pepperoni',
    available: true,
    variations: [
      { id: 'SQ_VAR_PEP_SM', name: 'Small', priceMinor: 1400, currency: 'USD' },
      { id: 'SQ_VAR_PEP_MD', name: 'Medium', priceMinor: 1800, currency: 'USD' },
      { id: 'SQ_VAR_PEP_LG', name: 'Large', priceMinor: 2200, currency: 'USD' },
    ],
    modifierLists: [toppings],
    syncedAt: SEEDED_AT,
  },
];

export const BARBER_SERVICES: readonly ServiceOffering[] = [
  { id: 'svc_cut', businessId: 'biz_barber_01', name: 'Haircut', durationMinutes: 30, priceMinor: 3000, currency: 'USD', bufferMinutes: 5 },
  { id: 'svc_beard', businessId: 'biz_barber_01', name: 'Beard trim', durationMinutes: 15, priceMinor: 1500, currency: 'USD', bufferMinutes: 5 },
  { id: 'svc_cut_beard', businessId: 'biz_barber_01', name: 'Haircut and beard', durationMinutes: 45, priceMinor: 4000, currency: 'USD', bufferMinutes: 5 },
];

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAY_KEYS: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

type Hours = { open: string; close: string } | { closed: true };
const PIZZA_HOURS: Record<DayKey, Hours> = {
  mon: { open: '11:00', close: '22:00' },
  tue: { open: '11:00', close: '22:00' },
  wed: { open: '11:00', close: '22:00' },
  thu: { open: '11:00', close: '22:00' },
  fri: { open: '11:00', close: '22:00' },
  sat: { open: '11:00', close: '22:00' },
  sun: { open: '12:00', close: '21:00' },
};
const BARBER_HOURS: Record<DayKey, Hours> = {
  mon: { closed: true },
  tue: { open: '09:00', close: '18:00' },
  wed: { open: '09:00', close: '18:00' },
  thu: { open: '09:00', close: '18:00' },
  fri: { open: '09:00', close: '18:00' },
  sat: { open: '09:00', close: '18:00' },
  sun: { open: '10:00', close: '16:00' },
};

function fact(businessId: string, kind: FactKind, key: string, value: unknown): BusinessFact {
  const short = businessId === 'biz_pizza_01' ? 'pz' : 'bb';
  return {
    id: `fact_${short}_${kind}_${key}`,
    businessId,
    kind,
    key,
    value,
    sourceType: 'seed',
    status: 'verified',
    confidence: 1,
    version: 1,
    verifiedAt: SEEDED_AT,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  };
}

export const SEED_FACTS: readonly BusinessFact[] = [
  ...DAY_KEYS.map((d) => fact('biz_pizza_01', 'hours', d, PIZZA_HOURS[d])),
  fact('biz_pizza_01', 'policy', 'pickup_window', { minutes: 20 }),
  fact('biz_pizza_01', 'policy', 'special_requests', { allowed: true }),
  ...DAY_KEYS.map((d) => fact('biz_barber_01', 'hours', d, BARBER_HOURS[d])),
  ...BARBER_SERVICES.map((s) => fact('biz_barber_01', 'service', s.id, s)),
];
