// TEMPORARY mock toolset. The shared one is task S-03 (apps/server/src/tools/mock).
// When it lands, delete this file and inject that toolset instead; the runner
// only depends on the ToolHandler interface.
//
// What it guarantees:
// - It implements only the seven read and propose tools. There is no code path
//   for a write or external_message capability.
// - It never calls the network, never touches a database and writes no events.
//   Its only state is an in-memory map per test session (quotes and mock
//   proposals), which the caller can drop.
// - Every approval ID it returns starts with `apv_mock_`. Proposal IDs start
//   with `ord_mock_` and `bkg_mock_`.
// - It is deterministic for a given clock and call order.

import { BARBER_SERVICES, PIZZA_CATALOG, SEED_FACTS, TIMEZONE } from '../fixtures';
import type {
  AvailabilitySlot,
  Cart,
  Quote,
  ServiceOffering,
  ToolContext,
  ToolHandler,
  ToolInput,
  ToolName,
  ToolOutput,
  ToolResult,
} from '../pending-contracts';
import { addDays, isoZ, localDate, localParts, minutesOf, weekdayOf, zonedToUtc } from '../time';
import { canonicalJson, sha256Hex } from '../util';

export const MOCK_APPROVAL_PREFIX = 'apv_mock_';
// Illustrative only (CONTRACTS.md section 9 says Square computes the real tax).
const MOCK_TAX_RATE = 0.0875;
const QUOTE_TTL_MS = 5 * 60 * 1000;
const SLOT_GRID_MIN = 15;
// A fixed lunch block that the mock calendar reports as busy every day.
const MOCK_BUSY = { start: '12:00', end: '13:00' };
const MAX_SESSIONS = 500;

interface MockOrder {
  orderId: string;
  approvalId: string;
}
interface SessionState {
  counter: number;
  quotes: Map<string, Quote>;
  orders: Map<string, MockOrder>;
}

type Impl = { [N in ToolName]: (input: ToolInput[N], ctx: ToolContext, state: SessionState) => ToolResult<ToolOutput[N]> };

export class MockToolset implements ToolHandler {
  readonly toolset = 'mock' as const;
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<ToolOutput[N]>> {
    const impl = this.impl[name] as Impl[N] | undefined;
    if (!impl) return { ok: false, reason: 'CAPABILITY_NOT_ALLOWED' };
    return impl(input, ctx, this.state(ctx));
  }

  // Drops the in-memory state of one test session.
  reset(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  private state(ctx: ToolContext): SessionState {
    const key = ctx.testSessionId ?? ctx.correlationId;
    let s = this.sessions.get(key);
    if (!s) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      s = { counter: 0, quotes: new Map(), orders: new Map() };
      this.sessions.set(key, s);
    }
    return s;
  }

  private mockId(prefix: 'qte_mock_' | 'ord_mock_' | 'bkg_mock_' | typeof MOCK_APPROVAL_PREFIX, ctx: ToolContext, state: SessionState): string {
    state.counter += 1;
    const key = ctx.testSessionId ?? ctx.correlationId;
    return `${prefix}${sha256Hex(`${key}:${state.counter}`).slice(0, 12)}`;
  }

  private readonly impl: Impl = {
    read_catalog: (input, ctx) => {
      const tokens = (input.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
      const items = PIZZA_CATALOG.filter((c) => c.businessId === ctx.businessId).filter(
        (c) => tokens.length === 0 || tokens.some((t) => c.name.toLowerCase().includes(t)),
      );
      return {
        ok: true,
        items: items.map((c) => ({
          catalogItemId: c.squareItemId,
          name: c.name,
          available: c.available,
          variations: c.variations.map(({ id, name, priceMinor }) => ({ id, name, priceMinor })),
          modifierLists: structuredClone(c.modifierLists),
        })),
      };
    },

    read_business_facts: (input, ctx) => {
      const kinds = new Set<string>(input.kinds ?? ['hours', 'policy', 'service', 'contact', 'faq']);
      const facts = SEED_FACTS.filter((f) => f.businessId === ctx.businessId && f.status === 'verified' && kinds.has(f.kind)).map(
        ({ kind, key, value }) => ({ kind, key, value: structuredClone(value) }),
      );
      return { ok: true, facts, timezone: TIMEZONE };
    },

    quote_order: (input, ctx, state) => {
      const result = this.buildQuote(input.cart, ctx, state);
      return 'quote' in result ? { ok: true, quote: result.quote } : result;
    },

    propose_order: (input, ctx, state) => {
      const missingFields: string[] = [];
      if (!input.contact.messageConsent) missingFields.push('contact.messageConsent');
      if (missingFields.length > 0) return { ok: true, missingFields };

      const cartHash = hashCart(input.cart);
      const quote = state.quotes.get(input.quoteId);
      if (!quote || quote.cartHash !== cartHash || Date.parse(quote.expiresAt) <= this.now().getTime()) {
        const fresh = this.buildQuote(input.cart, ctx, state);
        if (!('quote' in fresh)) return fresh;
        return { ok: false, reason: 'QUOTE_EXPIRED', message: 'Read the new total back to the caller.', quote: fresh.quote };
      }
      if (!withinHours(ctx.businessId, new Date(input.fulfillment.pickupAt))) {
        return { ok: false, reason: 'VALIDATION_FAILED', message: 'The pickup time is outside opening hours.' };
      }
      const orderId = this.mockId('ord_mock_', ctx, state);
      const approvalId = this.mockId(MOCK_APPROVAL_PREFIX, ctx, state);
      state.orders.set(orderId, { orderId, approvalId });
      return { ok: true, proposalId: orderId, approvalId, quote, missingFields: [] };
    },

    get_order_status: (input, _ctx, state) => {
      if (!state.orders.has(input.orderId)) return { ok: false, reason: 'NOT_FOUND' };
      return { ok: true, orderId: input.orderId, status: 'AWAITING_OWNER_APPROVAL', paid: false, checkoutLinkSent: false };
    },

    read_calendar_availability: (input, ctx) => {
      const service = findService(ctx.businessId, input.serviceId);
      if (!service) return { ok: false, reason: 'NOT_FOUND', message: 'Unknown service.' };
      const slots = this.freeSlots(service, input.date).slice(0, input.maxSlots ?? 5);
      return { ok: true, slots, timezone: TIMEZONE };
    },

    propose_booking: (input, ctx, state) => {
      const service = findService(ctx.businessId, input.serviceId);
      if (!service) return { ok: false, reason: 'NOT_FOUND', message: 'Unknown service.' };
      const start = new Date(input.startUtc);
      if (Number.isNaN(start.getTime())) return { ok: false, reason: 'VALIDATION_FAILED', message: 'startUtc is not a time.' };
      const missingFields: string[] = [];
      if (!input.customer.messageConsent) missingFields.push('customer.messageConsent');
      if (missingFields.length > 0) return { ok: true, missingFields };
      const free = this.freeSlots(service, localDate(start, TIMEZONE));
      const slot = free.find((s) => Date.parse(s.startUtc) === start.getTime());
      if (!slot) return { ok: false, reason: 'SLOT_CONFLICT', alternatives: free.slice(0, 3) };
      const proposalId = this.mockId('bkg_mock_', ctx, state);
      const approvalId = this.mockId(MOCK_APPROVAL_PREFIX, ctx, state);
      return { ok: true, proposalId, approvalId, missingFields: [], slot };
    },
  };

  private buildQuote(cart: Cart, ctx: ToolContext, state: SessionState): { quote: Quote } | { ok: false; reason: 'VALIDATION_FAILED' | 'ITEM_UNAVAILABLE'; message: string } {
    const lines: Quote['lines'] = [];
    for (const [index, line] of cart.lines.entries()) {
      const item = PIZZA_CATALOG.find((c) => c.businessId === ctx.businessId && c.squareItemId === line.catalogItemId);
      const variation = item?.variations.find((v) => v.id === line.variationId);
      if (!item || !variation) return { ok: false, reason: 'VALIDATION_FAILED', message: `Line ${index + 1} names an unknown item or size.` };
      if (!item.available) return { ok: false, reason: 'ITEM_UNAVAILABLE', message: `Line ${index + 1}: ${item.name} is unavailable.` };
      const allModifiers = item.modifierLists.flatMap((l) => l.modifiers);
      const modifiers: Quote['lines'][number]['modifiers'] = [];
      for (const id of line.modifierIds) {
        const m = allModifiers.find((x) => x.id === id);
        if (!m) return { ok: false, reason: 'VALIDATION_FAILED', message: `Line ${index + 1} names an unknown topping.` };
        modifiers.push({ modifierId: m.id, name: m.name, priceMinor: m.priceMinor });
      }
      const unit = variation.priceMinor + modifiers.reduce((sum, m) => sum + m.priceMinor, 0);
      lines.push({
        variationId: variation.id,
        name: `${variation.name} ${item.name}`,
        quantity: line.quantity,
        unitPriceMinor: variation.priceMinor,
        modifiers,
        lineTotalMinor: unit * line.quantity,
      });
    }
    const subtotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
    const taxMinor = Math.round(subtotalMinor * MOCK_TAX_RATE);
    const quotedAt = this.now();
    const quote: Quote = {
      quoteId: this.mockId('qte_mock_', ctx, state),
      cartHash: hashCart(cart),
      subtotalMinor,
      taxMinor,
      totalMinor: subtotalMinor + taxMinor,
      currency: 'USD',
      lines,
      quotedAt: isoZ(quotedAt),
      expiresAt: isoZ(new Date(quotedAt.getTime() + QUOTE_TTL_MS)),
    };
    state.quotes.set(quote.quoteId, quote);
    return { quote };
  }

  private freeSlots(service: ServiceOffering, date: string): AvailabilitySlot[] {
    const hours = hoursFor(service.businessId, weekdayOf(date, TIMEZONE));
    if (!hours) return [];
    const length = service.durationMinutes + (service.bufferMinutes ?? 0);
    const busyStart = minutesOf(MOCK_BUSY.start);
    const busyEnd = minutesOf(MOCK_BUSY.end);
    const now = this.now().getTime();
    const slots: AvailabilitySlot[] = [];
    for (let m = minutesOf(hours.open); m + length <= minutesOf(hours.close); m += SLOT_GRID_MIN) {
      if (m < busyEnd && m + length > busyStart) continue;
      const start = zonedToUtc(date, hhmm(m), TIMEZONE);
      if (start.getTime() <= now) continue;
      const end = new Date(start.getTime() + service.durationMinutes * 60_000);
      slots.push({ serviceId: service.id, startUtc: isoZ(start), endUtc: isoZ(end), timezone: TIMEZONE });
    }
    return slots;
  }
}

// cartHash recipe (CONTRACTS.md section 4): sort modifierIds in each line, sort
// lines by variationId, then joined modifierIds, then note; canonical JSON; sha256.
export function hashCart(cart: Cart): string {
  const lines = cart.lines
    .map((l) => ({ ...l, modifierIds: [...l.modifierIds].sort() }))
    .sort((a, b) => cmp(a.variationId, b.variationId) || cmp(a.modifierIds.join(','), b.modifierIds.join(',')) || cmp(a.note ?? '', b.note ?? ''));
  return `sha256:${sha256Hex(canonicalJson({ lines }))}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function findService(businessId: string, id: string): ServiceOffering | undefined {
  return BARBER_SERVICES.find((s) => s.businessId === businessId && s.id === id);
}

function hoursFor(businessId: string, day: string): { open: string; close: string } | undefined {
  const value = SEED_FACTS.find((f) => f.businessId === businessId && f.kind === 'hours' && f.key === day)?.value as
    | { open: string; close: string }
    | { closed: true }
    | undefined;
  return value && 'open' in value ? value : undefined;
}

function withinHours(businessId: string, at: Date): boolean {
  if (Number.isNaN(at.getTime())) return false;
  const p = localParts(at, TIMEZONE);
  const hours = hoursFor(businessId, p.weekday);
  if (!hours) return false;
  const m = p.hour * 60 + p.minute;
  return m >= minutesOf(hours.open) && m <= minutesOf(hours.close);
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// Used by recorded scripts that need "tomorrow" in the business timezone.
export function businessDate(now: Date, offsetDays = 0): string {
  return addDays(localDate(now, TIMEZONE), offsetDays);
}
