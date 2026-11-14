// The end-to-end world: the in-process Postgres migrated by the owner and used as abos_app, seeded
// with the real seed script (the same fixtures the Supabase project holds), the pizza catalog cache,
// and fake Square, Calendar, message and Sheets providers injected at the composition root.
//
// The fakes record every call. The external writes are Square CreatePaymentLink, the message send,
// the Calendar insert and the Sheets append; each is counted so every test can assert how many ran.
// Reads (CalculateOrder, RetrieveOrder, GetPayment, free/busy, event lookups) are not writes.
// Each fake has a `mode` a test can switch to make the next calls fail or time out.
import { createHmac } from 'node:crypto';
import type { Square } from 'square';
import type { FastifyInstance } from 'fastify';
import { pizzaCatalog, pizzaCatalogRows, DEMO_TAX_RATE_BPS } from '@abos/contracts/fixtures';
import { buildApp, type BuildAppOptions } from '../../src/app';
import { createCalendarAdapter, type GoogleCalendarClient, type GoogleEvent, type InsertEventRequest } from '../../src/adapters/calendar/index';
import type { MessageAdapter, SendInput } from '../../src/adapters/message/index';
import type { AppendOnceInput, ReportingAdapter } from '../../src/adapters/sheets/index';
import type { SquareClient } from '../../src/adapters/square/index';
import { createSquareAdapterForTest } from '../../src/adapters/square/testing';
import type { AgentModel, AgentTurnInput } from '../../src/builder/runner/agent-model';
import { parseEnv } from '../../src/env';
import type { TokenVerifier } from '../../src/auth/verify';
import { seedWorld } from '../../../../packages/db/src/seed/world';
import { createTestDb, type TestDb } from '../support/db';


export const OWNER_AUTH = '00000000-0000-4000-8000-000000000001';
export const OTHER_AUTH = '00000000-0000-4000-8000-000000000077';
export const PHONE = '+15555550199';
export const CALENDAR_ID = 'demo-barber@group.calendar.google.com';
export const LOCATION_ID = 'LOC_E2E';
export const SHEET_ID = 'sheet_e2e';
export const PUBLIC_URL = 'https://abos-e2e.example.test';
/** Test-only signing key for the fake Square webhooks. Not a credential. */
export const SQUARE_SIGNATURE_KEY = 'e2e-square-signature-key';
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

function priceOrder(order: Square.Order): Square.Order {
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
  return { locationId: order.locationId ?? LOCATION_ID, lineItems, totalTaxMoney: money(tax(subtotal)), totalMoney: money(subtotal + tax(subtotal)) };
}

export type FakePayment = { id: string; orderId: string; amountMinor: number; status: string; refunded?: boolean; locationId?: string; currency?: string };

/** Square sandbox stand-in. Only CreatePaymentLink is a write; every call is logged in `calls`. */
export function fakeSquareClient() {
  const writes: string[] = [];
  const calls: string[] = [];
  const createKeys: string[] = [];
  const orders = new Map<string, Square.Order & { id: string }>();
  const links = new Map<string, Square.PaymentLink>();
  const payments = new Map<string, FakePayment>();
  const mode = { create: 'ok' as 'ok' | 'timeout' | 'refuse' };
  let n = 0;
  const client: SquareClient = {
    catalog: { async list() { return (async function* () { /* empty */ })(); } },
    orders: {
      async calculate({ order }) { calls.push('orders.calculate'); return { order: priceOrder(order) }; },
      async get({ orderId }) {
        calls.push('orders.get');
        const order = orders.get(orderId);
        if (!order) throw Object.assign(new Error('not found'), { statusCode: 404 });
        const tenders = [...payments.values()].filter((p) => p.orderId === orderId).map((p) => ({ id: p.id, paymentId: p.id, type: 'CARD' as const }));
        return { order: { ...order, tenders } };
      },
    },
    checkout: {
      paymentLinks: {
        async create({ order, idempotencyKey }) {
          calls.push('checkout.paymentLinks.create');
          writes.push('checkout.paymentLinks.create');
          createKeys.push(idempotencyKey);
          if (mode.create === 'timeout') throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
          n += 1;
          const id = `SQ_ORDER_${n}`;
          orders.set(id, { ...priceOrder(order), id });
          const link: Square.PaymentLink = { id: `SQ_LINK_${n}`, version: 1, orderId: id, url: `https://sandbox.square.link/u/e2e${n}` };
          links.set(link.id!, link);
          return { paymentLink: link };
        },
        async get({ id }) {
          calls.push('checkout.paymentLinks.get');
          const link = links.get(id);
          if (!link) throw Object.assign(new Error('not found'), { statusCode: 404 });
          return { paymentLink: link };
        },
        async list() { calls.push('checkout.paymentLinks.list'); const all = [...links.values()]; return (async function* () { yield* all; })(); },
      },
    },
    payments: {
      async get({ paymentId }) {
        calls.push('payments.get');
        const p = payments.get(paymentId);
        if (!p) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return { payment: { id: p.id, orderId: p.orderId, status: p.status, locationId: p.locationId ?? LOCATION_ID,
          amountMoney: { amount: BigInt(p.amountMinor), currency: (p.currency ?? 'USD') as Square.Currency },
          ...(p.refunded ? { refundedMoney: money(p.amountMinor), refundIds: ['RF_1'] } : {}) } };
      },
      async list() {
        calls.push('payments.list');
        const all = [...payments.values()].map((p) => ({ id: p.id, orderId: p.orderId }));
        return (async function* () { yield* all; })();
      },
    },
  };
  return { client, writes, calls, createKeys, orders, payments, mode, addPayment(p: FakePayment) { payments.set(p.id, p); } };
}
export type FakeSquare = ReturnType<typeof fakeSquareClient>;

/** Google Calendar stand-in: free/busy is free except for inserted events; insert is the write. */
export function fakeCalendarClient() {
  const writes: string[] = [];
  const events = new Map<string, InsertEventRequest['requestBody']>();
  /** Extra busy periods a test adds (someone else's appointment). */
  const busy: { start: string; end: string }[] = [];
  const queries: { timeMin: string; timeMax: string }[] = [];
  const client: GoogleCalendarClient = {
    freebusy: { async query(input) {
      queries.push({ timeMin: input.requestBody.timeMin, timeMax: input.requestBody.timeMax });
      const blocks = [...busy, ...[...events.values()].map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }))];
      return { data: { calendars: Object.fromEntries(input.requestBody.items.map((i) => [i.id, { busy: blocks }])) } };
    } },
    events: {
      // Google returns only the events that carry every private property asked for (key=value).
      async list(input) {
        const wanted = (input.privateExtendedProperty ?? []).map((p) => { const at = p.indexOf('='); return [p.slice(0, at), p.slice(at + 1)] as const; });
        const items = [...events.values()]
          .filter((e) => wanted.every(([key, value]) => e.extendedProperties?.private?.[key] === value))
          .map((e): GoogleEvent => ({ id: e.id, status: 'confirmed', htmlLink: `https://calendar.example.test/${e.id}`, start: e.start, end: e.end }));
        return { data: { items } };
      },
      async get({ eventId }) {
        const e = events.get(eventId);
        if (!e) throw Object.assign(new Error('not found'), { code: 404 });
        return { data: { id: e.id, status: 'confirmed', htmlLink: `https://calendar.example.test/${e.id}`, start: e.start, end: e.end } };
      },
      async insert(input) {
        writes.push('events.insert');
        events.set(input.requestBody.id, input.requestBody);
        return { data: { id: input.requestBody.id, status: 'confirmed', htmlLink: `https://calendar.example.test/${input.requestBody.id}` } };
      },
      async delete() { writes.push('events.delete'); throw new Error('e2e: Calendar delete is not expected'); },
    },
  };
  return { client, writes, events, busy, queries };
}

/** Message channel stand-in. Every send is an external write. */
export function fakeMessages() {
  const sent: SendInput[] = [];
  const mode = { send: 'ok' as 'ok' | 'fail' };
  const adapter: MessageAdapter = {
    channel: 'surge',
    async send(input) {
      sent.push(input);
      if (mode.send === 'fail') return { status: 'FAILED', errorCode: 'INTEGRATION_UNAVAILABLE' };
      return { status: 'SENT', providerMessageId: `surge_msg_${sent.length}` };
    },
  };
  return { adapter, sent, mode };
}

/** Sheets stand-in: appendOnce dedupes by record ID, as the real adapter does by reading column A. */
export function fakeSheets() {
  const appended: AppendOnceInput[] = [];
  const adapter: ReportingAdapter = {
    async appendOnce(input) {
      if (appended.some((a) => a.recordId === input.recordId && a.tab === input.tab)) return { ok: true, status: 'skipped' };
      appended.push(input);
      return { ok: true, status: 'appended' };
    },
  };
  return { adapter, appended };
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
  square: FakeSquare;
  /** Square write calls (CreatePaymentLink). */
  squareWrites: string[];
  calendarWrites: string[];
  calendar: ReturnType<typeof fakeCalendarClient>;
  messages: ReturnType<typeof fakeMessages>;
  sheets: ReturnType<typeof fakeSheets>;
  /** Message sends (external writes). */
  readonly messageSends: number;
  /** The server clock is real time plus this offset. Tests advance it (read-back waits, stale leases). */
  clock: { offsetMs: number; advance(ms: number): void; now(): Date };
  /** Waits for the executor and the webhook jobs started by the last request to settle. */
  settle(): Promise<void>;
  /** Signs a Square webhook body with the test key for the public URL, as Square would. */
  squareSignature(body: string, url?: string): string;
  close(): Promise<void>;
};

export async function createWorld(extra: BuildAppOptions = {}, envExtra: Record<string, string> = {}): Promise<World> {
  const t = await createTestDb();
  await t.admin(async (q) => {
    await q.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [OWNER_AUTH, 'owner@example.com', OTHER_AUTH, 'other@example.com']);
    await q.query("insert into public.users (id, auth_user_id, email, role) values ('usr_owner_01', $1, 'owner@example.com', 'owner'), ('usr_other_01', $2, 'other@example.com', 'owner')", [OWNER_AUTH, OTHER_AUTH]);
    await seedWorld({ query: async <R>(text: string, params?: unknown[]) => (await q.query(text, params)) as { rows: R[] } }, { env: { TWILIO_PHONE_NUMBER: PHONE, SQUARE_LOCATION_ID: LOCATION_ID, SQUARE_ENVIRONMENT: 'sandbox' } });
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
  const messages = fakeMessages();
  const sheets = fakeSheets();
  const model = new ScriptedModel();
  const clock: World['clock'] = { offsetMs: 0, advance(ms) { clock.offsetMs += ms; }, now: () => new Date(Date.now() + clock.offsetMs) };
  const env = parseEnv({ TWILIO_PHONE_NUMBER: PHONE, MESSAGE_CHANNEL: 'surge', SURGE_API_KEY: 'test-key', SURGE_ACCOUNT_ID: 'test-account', GOOGLE_CALENDAR_ID: CALENDAR_ID,
    PUBLIC_SERVER_URL: PUBLIC_URL, SQUARE_WEBHOOK_SIGNATURE_KEY: SQUARE_SIGNATURE_KEY, ...envExtra });
  const app = await buildApp(env, {
    db: t.db, verifier, agentModel: model, now: clock.now,
    providers: {
      square: createSquareAdapterForTest(square.client, { locationId: LOCATION_ID, environment: 'sandbox', now: () => new Date() }),
      squareLocationId: LOCATION_ID,
      squarePaymentStatus: async (paymentId) => square.payments.get(paymentId)?.status,
      calendar: createCalendarAdapter({ client: cal.client, now: () => new Date() }),
      calendarId: CALENDAR_ID,
      message: messages.adapter,
      sheets: sheets.adapter,
      sheetId: SHEET_ID,
    },
    ...extra,
  });
  return {
    t, app, model, square, squareWrites: square.writes, calendarWrites: cal.writes, calendar: cal, messages, sheets, clock,
    get messageSends() { return messages.sent.length; },
    async settle() {
      // The executor drains after each approve; webhook jobs run after each response. Both may chain.
      for (let i = 0; i < 3; i++) {
        // onResponse hooks (which enqueue webhook jobs) run just after inject resolves.
        await new Promise((r) => setImmediate(r));
        await app.composed.executor.idle?.();
        await app.composed.webhooks?.idle();
      }
    },
    squareSignature: (body, url = `${PUBLIC_URL}/webhooks/square`) => createHmac('sha256', SQUARE_SIGNATURE_KEY).update(url + body).digest('base64'),
    close: async () => { await app.close(); await t.close(); },
  };
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
