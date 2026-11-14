// The end-to-end world: the in-process Postgres migrated by the owner and used as abos_app, seeded
// with the real seed script (the same fixtures the Supabase project holds), the pizza catalog cache,
// and fake Square, Calendar, message and Sheets providers injected at the composition root.
//
// The fakes record every call. Square's payment link, the message send, the Calendar insert and the
// Sheets append are the external writes; until the executor lands they must never be called.
//
// EXTEND (when B-11 lands): pass `executor` to `createWorld` and replace the throwing write methods
// below with recording fakes, then assert the steps reach SUCCEEDED and the order PAYMENT_LINK_READY.
import type { Square } from 'square';
import type { FastifyInstance } from 'fastify';
import { pizzaCatalog, pizzaCatalogRows, DEMO_TAX_RATE_BPS } from '@abos/contracts/fixtures';
import { buildApp, type BuildAppOptions } from '../../src/app';
import { createCalendarAdapter, type GoogleCalendarClient } from '../../src/adapters/calendar/index';
import { createSquareAdapter, type SquareClient } from '../../src/adapters/square/index';
import type { AgentModel, AgentTurnInput } from '../../src/builder/runner/agent-model';
import { parseEnv } from '../../src/env';
import type { TokenVerifier } from '../../src/auth/verify';
import { seedWorld } from '../../../../packages/db/src/seed/world';
import { createTestDb, type TestDb } from '../support/db';


export const OWNER_AUTH = '00000000-0000-4000-8000-000000000001';
export const OTHER_AUTH = '00000000-0000-4000-8000-000000000077';
export const PHONE = '+15555550199';
export const CALENDAR_ID = 'demo-barber@group.calendar.google.com';
export const verifier: TokenVerifier = {
  async verify(token) {
    if (token === 'owner') return { authUserId: OWNER_AUTH };
    if (token === 'other') return { authUserId: OTHER_AUTH };
    throw new Error('Invalid token');
  },
};
export const OWNER = { authorization: 'Bearer owner' };
export const OTHER = { authorization: 'Bearer other' };

const money = (amount: number): Square.Money => ({ amount: BigInt(amount), currency: 'USD' });
const tax = (gross: number) => Math.round((gross * DEMO_TAX_RATE_BPS) / 10_000);

/** Square sandbox stand-in. CalculateOrder prices the fixture catalog; every write throws and is counted. */
export function fakeSquareClient() {
  const writes: string[] = [];
  const refuse = (name: string) => async () => { writes.push(name); throw new Error(`e2e: ${name} is an external write and must not run`); };
  const client: SquareClient = {
    catalog: { async list() { return (async function* () { /* empty */ })(); } },
    orders: {
      async calculate({ order }) {
        const lineItems = (order.lineItems ?? []).map((line): Square.OrderLineItem => {
          const item = pizzaCatalog.find((c) => c.variations.some((v) => v.id === line.catalogObjectId))!;
          const variation = item.variations.find((v) => v.id === line.catalogObjectId)!;
          const modifiers = (line.modifiers ?? []).map((mod) => {
            const found = item.modifierLists.flatMap((l) => l.modifiers).find((m) => m.id === mod.catalogObjectId)!;
            return { ...mod, name: found.name, basePriceMoney: money(found.priceMinor) };
          });
          const gross = (variation.priceMinor + modifiers.reduce((s, m) => s + Number(m.basePriceMoney.amount), 0)) * Number(line.quantity);
          return { ...line, name: `${item.name} ${variation.name}`, basePriceMoney: money(variation.priceMinor), modifiers, grossSalesMoney: money(gross), totalMoney: money(gross + tax(gross)) };
        });
        const subtotal = lineItems.reduce((s, l) => s + Number(l.grossSalesMoney!.amount), 0);
        return { order: { locationId: 'LOC_E2E', lineItems, totalTaxMoney: money(tax(subtotal)), totalMoney: money(subtotal + tax(subtotal)) } };
      },
      get: refuse('orders.get') as SquareClient['orders']['get'],
    },
    checkout: { paymentLinks: { create: refuse('checkout.paymentLinks.create') as SquareClient['checkout']['paymentLinks']['create'] } },
    payments: { get: refuse('payments.get') as SquareClient['payments']['get'], list: refuse('payments.list') as SquareClient['payments']['list'] },
  };
  return { client, writes };
}

/** Google Calendar stand-in: free/busy is always free; insert and delete throw and are counted. */
export function fakeCalendarClient() {
  const writes: string[] = [];
  const client: GoogleCalendarClient = {
    freebusy: { async query(input) { return { data: { calendars: Object.fromEntries(input.requestBody.items.map((i) => [i.id, { busy: [] }])) } }; } },
    events: {
      async list() { return { data: { items: [] } }; },
      async get() { throw Object.assign(new Error('not found'), { code: 404 }); },
      async insert() { writes.push('events.insert'); throw new Error('e2e: Calendar insert is an external write'); },
      async delete() { writes.push('events.delete'); throw new Error('e2e: Calendar delete is an external write'); },
    },
  };
  return { client, writes };
}

/** A scripted agent model: each turn is a function of the turn input, calling tools like the real model. */
export type Script = (input: AgentTurnInput) => Promise<string>;
export class ScriptedModel implements AgentModel {
  readonly kind = 'recorded' as const;
  private queue: Script[] = [];
  push(...turns: Script[]) { this.queue.push(...turns); }
  async respond(input: AgentTurnInput): Promise<{ reply: string }> {
    const next = this.queue.shift();
    if (!next) return { reply: 'No script for this turn.' };
    return { reply: await next(input) };
  }
}

export type World = {
  t: TestDb;
  app: FastifyInstance;
  model: ScriptedModel;
  squareWrites: string[];
  calendarWrites: string[];
  messageSends: number;
  close(): Promise<void>;
};

export async function createWorld(extra: BuildAppOptions = {}, envExtra: Record<string, string> = {}): Promise<World> {
  const t = await createTestDb();
  await t.admin(async (q) => {
    await q.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [OWNER_AUTH, 'owner@example.com', OTHER_AUTH, 'other@example.com']);
    await q.query("insert into public.users (id, auth_user_id, email, role) values ('usr_owner_01', $1, 'owner@example.com', 'owner'), ('usr_other_01', $2, 'other@example.com', 'owner')", [OWNER_AUTH, OTHER_AUTH]);
    await seedWorld({ query: async <R>(text: string, params?: unknown[]) => (await q.query(text, params)) as { rows: R[] } }, { env: { TWILIO_PHONE_NUMBER: PHONE } });
    await q.query("insert into public.businesses (id, owner_id, name, category, timezone) values ('biz_other_01', 'usr_other_01', 'Other Shop', 'restaurant', 'America/Los_Angeles')");
    for (const r of pizzaCatalogRows) {
      const item = pizzaCatalog.find((i) => i.squareItemId === r.squareItemId)!;
      await q.query(`insert into public.catalog_items (id, business_id, square_item_id, square_variation_id, square_item_version, square_variation_version,
        item_name, description, variation_name, price_minor, currency, modifier_lists, is_available, synced_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'USD',$11::jsonb,$12,now())`,
      [r.id, r.businessId, r.squareItemId, r.squareVariationId, r.squareItemVersion, r.squareVariationVersion, r.itemName, item.description ?? null,
        r.variationName, r.priceMinor, JSON.stringify(item.modifierLists), r.available]);
    }
  });
  const square = fakeSquareClient();
  const cal = fakeCalendarClient();
  const model = new ScriptedModel();
  const world = { messageSends: 0 } as World;
  const env = parseEnv({ TWILIO_PHONE_NUMBER: PHONE, MESSAGE_CHANNEL: 'surge', SURGE_API_KEY: 'test-key', SURGE_ACCOUNT_ID: 'test-account', GOOGLE_CALENDAR_ID: CALENDAR_ID, ...envExtra });
  const app = await buildApp(env, {
    db: t.db, verifier, agentModel: model,
    providers: {
      square: createSquareAdapter({ client: square.client, locationId: 'LOC_E2E', environment: 'sandbox', now: () => new Date() }),
      calendar: createCalendarAdapter({ client: cal.client, now: () => new Date() }),
      calendarId: CALENDAR_ID,
      message: { channel: 'surge', async send() { world.messageSends += 1; throw new Error('e2e: a message send is an external write'); } },
      sheets: { async appendOnce() { throw new Error('e2e: a Sheets append is an external write'); } },
    },
    ...extra,
  });
  Object.assign(world, { t, app, model, squareWrites: square.writes, calendarWrites: cal.writes, close: async () => { await app.close(); await t.close(); } });
  return world;
}

/** Local wall time in a zone to a UTC ISO string (no DST edge cases at the demo times used here). */
export function zonedIso(date: string, hhmm: string, timeZone: string): string {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (asLocal - guess)).toISOString();
}

/** The next date (YYYY-MM-DD in Los Angeles) at least `minDays` ahead whose weekday is in `weekdays` (0 = Sunday). */
export function nextLocalDate(weekdays: number[], minDays = 1): string {
  for (let d = minDays; d < 14; d++) {
    const candidate = new Date(Date.now() + d * 86_400_000);
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(candidate);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.find((p) => p.type === 'weekday')!.value);
    if (weekdays.includes(wd)) return `${local.find((p) => p.type === 'year')!.value}-${local.find((p) => p.type === 'month')!.value}-${local.find((p) => p.type === 'day')!.value}`;
  }
  throw new Error('no date found');
}
