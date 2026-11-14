// The demo world: the seeded owner, both businesses and the shared clock values.
// Every fixture in this folder belongs to this one world, so cross-references resolve.
import { BARBER_BUSINESS_ID, PIZZA_BUSINESS_ID, SEEDED_TIMEZONE, type Business, type BusinessSummary } from '../src/index';

/** The instant the fixture snapshot describes. The mock toolset uses it as its default clock. */
export const FIXTURE_NOW: string = '2026-11-14T20:30:00Z';
/** When the seed script ran. */
export const SEEDED_AT: string = '2026-11-13T08:00:00Z';

/** The one phone number both agents share (P-06). Fictional 555 number. */
export const DEMO_PHONE_NUMBER = '+15555550199';
/** The barbershop's Google Calendar (P-15). */
export const BARBER_CALENDAR_ID = 'demo-barber@group.calendar.google.com';

/**
 * The `users` row (DATA-MODEL 2.1). The contracts package has no User schema, so this type is local
 * and follows the table's columns in camelCase.
 */
export type FixtureUser = {
  id: string;
  authUserId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin';
  createdAt: string;
};

export const ownerUser = {
  id: 'usr_owner_01',
  authUserId: '00000000-0000-4000-8000-000000000001',
  email: 'owner@example.com',
  displayName: 'Demo Owner',
  role: 'owner',
  createdAt: SEEDED_AT,
} satisfies FixtureUser;

export const OWNER_USER_ID = ownerUser.id;

export const pizzaBusiness = {
  id: PIZZA_BUSINESS_ID,
  name: 'Demo Pizza Co.',
  category: 'restaurant',
  timezone: SEEDED_TIMEZONE,
  contact: { phone: '+15555550100', email: 'pizza@example.com', address: '100 Demo Street, San Luis Obispo, CA 93401' },
  settings: {},
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT,
} satisfies Business;

export const barberBusiness = {
  id: BARBER_BUSINESS_ID,
  name: 'Demo Barbershop',
  category: 'barbershop',
  timezone: SEEDED_TIMEZONE,
  contact: { phone: '+15555550200', email: 'barber@example.com', address: '200 Demo Avenue, San Luis Obispo, CA 93401' },
  settings: {},
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT,
} satisfies Business;

export const businesses = [pizzaBusiness, barberBusiness] satisfies Business[];

export const businessSummaries = businesses.map(({ id, name, category, timezone }) => ({ id, name, category, timezone })) satisfies BusinessSummary[];

/** Adds `ms` to an ISO UTC time and returns ISO UTC without milliseconds when they are zero. */
export function addMs(iso: string, ms: number): string {
  return isoUtc(Date.parse(iso) + ms);
}

/** Epoch milliseconds to ISO UTC, dropping `.000`. */
export function isoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('.000Z', 'Z');
}

export const MINUTE_MS = 60 * 1000;

/** An ISO instant in UTC (`Z`), with or without milliseconds: the only timestamp form the fixtures use. */
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Deep copy of `value` with every ISO UTC string moved by `deltaMs`. The form is kept: a string with
 * milliseconds (the `toISOString()` form payloads use) stays in that form, one without stays without.
 * Other values are copied unchanged.
 */
export function shiftIsoTimes<T>(value: T, deltaMs: number): T {
  return shiftAny(value, deltaMs) as T;
}

function shiftAny(value: unknown, deltaMs: number): unknown {
  if (typeof value === 'string') {
    const m = ISO_UTC_PATTERN.exec(value);
    if (m === null) return value;
    const shifted = Date.parse(value) + deltaMs;
    return m[1] === undefined ? isoUtc(shifted) : new Date(shifted).toISOString();
  }
  if (Array.isArray(value)) return value.map((v) => shiftAny(v, deltaMs));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shiftAny(v, deltaMs);
    return out;
  }
  return value;
}
