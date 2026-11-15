// The mock toolset (SPEC 2.6, CONTRACTS 8): the seven agent tools, backed only by the fixtures.
// Used by preview and the test console (AC-03). It never touches the network, the database or a provider,
// writes no events, and returns approvals with the `apv_mock_` prefix. State lives in one instance only;
// `createMockToolsetRegistry` keeps one instance per test session.
// There is no tool for any write or external_message capability, and no code path reaches one.
import {
  CAPABILITIES,
  MOCK_APPROVAL_PREFIX,
  QUOTE_EXPIRY_MS,
  ServiceOfferingSchema,
  TOOL_CAPABILITY,
  TOOL_INPUT_SCHEMAS,
  ToolNameSchema,
  cartHash,
  isToolEffect,
  type AvailabilitySlot,
  type BusinessFact,
  type Cart,
  type CatalogItem,
  type HoursValue,
  type OrderStatus,
  type Quote,
  type QuoteLine,
  type ServiceOffering,
  type ToolContext,
  type ToolFailure,
  type ToolHandler,
  type ToolInput,
  type ToolName,
  type ToolResult,
  type ToolTraceEntry,
  type Toolset,
} from '@abos/contracts';
import {
  BARBER_CALENDAR_ID,
  DEMO_TAX_RATE_BPS,
  FIXTURE_NOW,
  allFacts,
  barberBusyBlocks,
  materializeBusyBlocks,
  businesses,
  messageDispatches,
  orders,
  pizzaCatalog,
} from '@abos/contracts/fixtures';
import { isoUtc, localDateTime, localToEpoch, weekdayOfLocalDate } from './time';
import { pickupTooSoon, PICKUP_TOO_SOON } from '../real/time';
import { nearestSlots } from '../real/index';

export type MockToolsetOptions = {
  businessId: string;
  /** Clock for quote expiry, minimum notice and pickup checks. Defaults to the fixture snapshot time. */
  now?: () => Date;
  /** Catalog items (Square item IDs) to treat as sold out, for testing ITEM_UNAVAILABLE. */
  unavailableItemIds?: readonly string[];
  /** Another menu in place of the pizza fixture (the demo shop, issue #161). Items of other businesses are ignored. */
  catalog?: readonly CatalogItem[];
  /** Other facts in place of the fixture facts (a stage shop of the demo). Only verified facts of this business are read. */
  facts?: readonly BusinessFact[];
};

export type MockToolset = {
  readonly businessId: string;
  /** The `ToolHandler` the runners use. Every call is validated and traced. */
  readonly handler: ToolHandler;
  /** The same seven tools as functions. They go through the same validation and trace. */
  readonly tools: Toolset;
  /** A copy of every call so far, oldest first. */
  trace(): ToolTraceEntry[];
  clearTrace(): void;
  /** Clears every quote, proposal and trace entry and restarts the mock ID counters. */
  reset(): void;
};

const GRID_MS = 15 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_CATALOG_RESULTS = 5;
const DEFAULT_MAX_SLOTS = 5;
const MAX_ALTERNATIVES = 3;

const fail = (reason: ToolFailure['reason'], message: string): ToolFailure => ({ ok: false, reason, message });

/** Half-up tax at the demo rate. Square computes the real value (P-02). */
function taxMinor(subtotalMinor: number): number {
  return Math.floor((subtotalMinor * DEMO_TAX_RATE_BPS + 5000) / 10000);
}

/** Filler words a caller says that never name an item. */
const STOP_WORDS = new Set(['a', 'an', 'the', 'with', 'and', 'of', 'on', 'some', 'any', 'please', 'do', 'you', 'have', 'i', 'want', 'like']);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

function wordMatches(word: string, haystack: string): boolean {
  if (haystack.includes(word)) return true;
  return word.length > 3 && word.endsWith('s') && haystack.includes(word.slice(0, -1));
}

type StoredQuote = { quote: Quote; cart: Cart };
type MockProposal = { orderId: string; approvalId: string; status: OrderStatus };

export function createMockToolset(options: MockToolsetOptions): MockToolset {
  const { businessId } = options;
  const now = options.now ?? (() => new Date(FIXTURE_NOW));
  const busyBlocks = options.now === undefined ? barberBusyBlocks : materializeBusyBlocks(now());
  const unavailable = new Set(options.unavailableItemIds ?? []);
  const business = businesses.find((b) => b.id === businessId);
  const timezone = business?.timezone ?? 'America/Los_Angeles';

  // Per-instance state: nothing here is shared between two toolsets.
  const traceEntries: ToolTraceEntry[] = [];
  const quotes = new Map<string, StoredQuote>();
  const proposals = new Map<string, MockProposal>();
  const counters = { quote: 0, order: 0, booking: 0, approval: 0 };
  const nextId = (prefix: string, key: keyof typeof counters) => `${prefix}${String(++counters[key]).padStart(4, '0')}`;

  const catalog: CatalogItem[] = (options.catalog ?? pizzaCatalog).filter((i) => i.businessId === businessId);
  const verifiedFacts: BusinessFact[] = (options.facts ?? allFacts).filter((f) => f.businessId === businessId && f.status === 'verified');
  const services: ServiceOffering[] = verifiedFacts
    .filter((f) => f.kind === 'service')
    .flatMap((f) => {
      const parsed = ServiceOfferingSchema.safeParse(f.value);
      return parsed.success ? [parsed.data] : [];
    });

  const isAvailable = (item: CatalogItem) => item.available && !unavailable.has(item.squareItemId);

  function hoursFor(date: string): HoursValue | undefined {
    const fact = verifiedFacts.find((f) => f.kind === 'hours' && f.key === weekdayOfLocalDate(date));
    return fact?.value as HoursValue | undefined;
  }

  function policyMinutes(key: string): number {
    const value = verifiedFacts.find((f) => f.kind === 'policy' && f.key === key)?.value;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.minutes === 'number') return value.minutes;
    return 0;
  }

  /** Opening and closing instants of a local date, or undefined when closed. */
  function openWindow(date: string): { open: number; close: number } | undefined {
    const h = hoursFor(date);
    if (h === undefined || 'closed' in h) return undefined;
    return { open: localToEpoch(date, h.open, timezone), close: localToEpoch(date, h.close, timezone) };
  }

  // ---- Pricing ----

  function priceCart(cart: Cart): { ok: true; lines: QuoteLine[] } | ToolFailure {
    const lines: QuoteLine[] = [];
    for (const [i, line] of cart.lines.entries()) {
      const label = `line ${i + 1}`;
      const item = catalog.find((c) => c.squareItemId === line.catalogItemId);
      const variation = item?.variations.find((v) => v.id === line.variationId);
      if (item === undefined || variation === undefined) return fail('ITEM_UNAVAILABLE', `${label}: item or size not on the menu`);
      if (!isAvailable(item)) return fail('ITEM_UNAVAILABLE', `${label}: ${item.name} is not available`);
      const allMods = item.modifierLists.flatMap((l) => l.modifiers);
      const modifiers: QuoteLine['modifiers'] = [];
      for (const id of line.modifierIds) {
        const mod = allMods.find((m) => m.id === id);
        if (mod === undefined) return fail('ITEM_UNAVAILABLE', `${label}: topping ${id} is not available for ${item.name}`);
        modifiers.push({ modifierId: mod.id, name: mod.name, priceMinor: mod.priceMinor });
      }
      const unit = variation.priceMinor + modifiers.reduce((s, m) => s + m.priceMinor, 0);
      lines.push({ variationId: variation.id, name: `${variation.name} ${item.name}`, quantity: line.quantity, unitPriceMinor: variation.priceMinor, modifiers, lineTotalMinor: unit * line.quantity });
    }
    return { ok: true, lines };
  }

  async function makeQuote(cart: Cart): Promise<{ ok: true; quote: Quote } | ToolFailure> {
    const priced = priceCart(cart);
    if (!priced.ok) return priced;
    const subtotalMinor = priced.lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    const tax = taxMinor(subtotalMinor);
    const quotedAt = now().getTime();
    const quote: Quote = {
      quoteId: nextId('qte_mock_', 'quote'),
      cartHash: await cartHash(cart),
      subtotalMinor,
      taxMinor: tax,
      totalMinor: subtotalMinor + tax,
      currency: 'USD',
      lines: priced.lines,
      quotedAt: isoUtc(quotedAt),
      expiresAt: isoUtc(quotedAt + QUOTE_EXPIRY_MS),
    };
    quotes.set(quote.quoteId, { quote, cart });
    return { ok: true, quote };
  }

  // ---- Calendar ----

  function isBusy(start: number, end: number): boolean {
    return busyBlocks.some((b) => b.calendarId === BARBER_CALENDAR_ID && Date.parse(b.startUtc) < end && Date.parse(b.endUtc) > start);
  }

  /** FLOWS C3: 15 minute grid, start plus duration plus buffer free, ends within hours, after minimum notice. */
  function freeSlots(service: ServiceOffering, date: string, max: number): AvailabilitySlot[] {
    const window = openWindow(date);
    if (window === undefined || service.businessId !== businessId) return [];
    const earliest = now().getTime() + policyMinutes('min_notice') * MINUTE_MS;
    const duration = service.durationMinutes * MINUTE_MS;
    const blocked = duration + (service.bufferMinutes ?? 0) * MINUTE_MS;
    const slots: AvailabilitySlot[] = [];
    for (let t = window.open; t + duration <= window.close && slots.length < max; t += GRID_MS) {
      if (t < earliest || isBusy(t, t + blocked)) continue;
      slots.push({ serviceId: service.id, startUtc: isoUtc(t), endUtc: isoUtc(t + duration), timezone });
    }
    return slots;
  }

  // ---- The seven tools ----

  const impl: Toolset = {
    async read_catalog(input) {
      const query = words(input.query ?? '');
      const matches = catalog.filter((item) => {
        const haystack = [item.name, item.description ?? '', ...item.variations.map((v) => v.name), ...item.modifierLists.flatMap((l) => l.modifiers.map((m) => m.name))]
          .join(' ')
          .toLowerCase();
        return query.every((w) => wordMatches(w, haystack));
      });
      return {
        ok: true,
        items: matches.slice(0, MAX_CATALOG_RESULTS).map((item) => ({
          catalogItemId: item.squareItemId,
          name: item.name,
          available: isAvailable(item),
          variations: item.variations.map((v) => ({ id: v.id, name: v.name, priceMinor: v.priceMinor })),
          modifierLists: item.modifierLists.map((l) => ({
            id: l.id, name: l.name, selectionType: l.selectionType,
            modifiers: l.modifiers.map((m) => ({ id: m.id, name: m.name, priceMinor: m.priceMinor })),
          })),
        })),
      };
    },

    async read_business_facts(input) {
      const kinds = input.kinds;
      const facts = verifiedFacts
        .filter((f) => f.kind !== 'menu_item' && (kinds === undefined || (kinds as readonly string[]).includes(f.kind)))
        .flatMap((f) => (f.kind === 'menu_item' ? [] : [{ kind: f.kind, key: f.key, value: f.value }]));
      return { ok: true, facts, timezone };
    },

    async quote_order(input) {
      return makeQuote(input.cart);
    },

    async propose_order(input) {
      const stored = quotes.get(input.quoteId);
      if (stored === undefined) return fail('NOT_FOUND', 'Unknown quote. Call quote_order first.');
      const hash = await cartHash(input.cart);
      const expired = now().getTime() > Date.parse(stored.quote.expiresAt);
      if (expired || hash !== stored.quote.cartHash) {
        const fresh = await makeQuote(input.cart);
        if (!fresh.ok) return fresh;
        return { ok: false, reason: 'QUOTE_EXPIRED', message: expired ? 'The quote expired. Read back the new total.' : 'The cart changed. Read back the new total.', quote: fresh.quote };
      }

      const missingFields: string[] = [];
      if (input.contact.name.trim() === '') missingFields.push('contact.name');
      if (input.contact.messageConsent && !input.contact.messageRecipient?.trim()) missingFields.push('contact.messageRecipient');
      if (input.fulfillment.pickupAt.trim() === '') missingFields.push('fulfillment.pickupAt');
      if (missingFields.length > 0) return { ok: true, quote: stored.quote, missingFields };

      const pickup = Date.parse(input.fulfillment.pickupAt);
      if (pickup < now().getTime()) return fail('VALIDATION_FAILED', 'The pickup time is in the past.');
      if (pickupTooSoon(pickup, now().getTime())) return fail('VALIDATION_FAILED', PICKUP_TOO_SOON);
      const local = localDateTime(pickup, timezone);
      const window = openWindow(local.date);
      if (window === undefined || pickup < window.open || pickup > window.close) return fail('VALIDATION_FAILED', 'The pickup time is outside opening hours.');

      const orderId = nextId('ord_mock_', 'order');
      const approvalId = nextId(MOCK_APPROVAL_PREFIX, 'approval');
      proposals.set(orderId, { orderId, approvalId, status: 'AWAITING_OWNER_APPROVAL' });
      return { ok: true, proposalId: orderId, approvalId, quote: stored.quote, missingFields: [] };
    },

    async get_order_status(input, ctx) {
      const mock = proposals.get(input.orderId);
      if (mock !== undefined) return { ok: true, orderId: mock.orderId, status: mock.status, paid: false, checkoutLinkSent: false };
      const order = orders.find((o) => o.id === input.orderId && o.businessId === businessId);
      // FLOWS 8: only an order bound to the current call. The test console has no call, so it may read any fixture order.
      if (order === undefined || (ctx.callId !== undefined && order.callId !== ctx.callId)) return fail('NOT_FOUND', 'No order with that ID on this call.');
      const paid = order.status === 'PAID_VERIFIED' || order.status === 'FULFILLMENT_READY';
      const checkoutLinkSent = messageDispatches.some((d) => d.subjectId === order.id && (d.status === 'SENT' || d.status === 'DELIVERED'));
      return { ok: true, orderId: order.id, status: order.status, paid, checkoutLinkSent };
    },

    async read_calendar_availability(input) {
      const service = services.find((s) => s.id === input.serviceId);
      if (service === undefined) return fail('NOT_FOUND', 'No such service.');
      const max = input.maxSlots ?? DEFAULT_MAX_SLOTS;
      if (input.near === undefined) return { ok: true, slots: freeSlots(service, input.date, max), timezone };
      return { ok: true, slots: nearestSlots(freeSlots(service, input.date, 96), localToEpoch(input.date, input.near, timezone), max), timezone };
    },

    async propose_booking(input) {
      const service = services.find((s) => s.id === input.serviceId);
      if (service === undefined) return fail('NOT_FOUND', 'No such service.');
      const start = Date.parse(input.startUtc);
      const duration = service.durationMinutes * MINUTE_MS;
      const slot: AvailabilitySlot = { serviceId: service.id, startUtc: isoUtc(start), endUtc: isoUtc(start + duration), timezone };
      const { date } = localDateTime(start, timezone);
      const window = openWindow(date);
      if (window === undefined || start < window.open || start + duration > window.close) return fail('VALIDATION_FAILED', 'That time is outside opening hours.');
      if ((start - window.open) % GRID_MS !== 0) return fail('VALIDATION_FAILED', 'Appointments start on the quarter hour.');
      if (start < now().getTime() + policyMinutes('min_notice') * MINUTE_MS) return fail('VALIDATION_FAILED', 'That time is too soon to book.');
      if (isBusy(start, start + duration + (service.bufferMinutes ?? 0) * MINUTE_MS)) {
        return { ok: false, reason: 'SLOT_CONFLICT', message: 'That slot is taken.', alternatives: freeSlots(service, date, MAX_ALTERNATIVES) };
      }

      const missingFields: string[] = [];
      if (input.customer.name.trim() === '') missingFields.push('customer.name');
      if (input.customer.messageConsent && !input.customer.messageRecipient?.trim()) missingFields.push('customer.messageRecipient');
      if (missingFields.length > 0) return { ok: true, missingFields, slot };

      return { ok: true, proposalId: nextId('bkg_mock_', 'booking'), approvalId: nextId(MOCK_APPROVAL_PREFIX, 'approval'), missingFields: [], slot };
    },

    // D-13 demo mode tool. The mock never sends anything (AC-03).
    async propose_menu_message() {
      return { ok: true, sent: false, message: 'Nothing is sent in a test. Read the menu out instead.' };
    },
  };

  async function call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<N>> {
    const started = performance.now();
    const recordedInput: unknown = structuredClone(input);
    let result: ToolResult<N>;
    const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(input);
    if (!parsed.success) {
      result = fail('VALIDATION_FAILED', parsed.error.issues.map((i) => i.message).join('; '));
    } else if (ctx.businessId !== businessId) {
      // AC-17: a toolset reads only its own business.
      result = fail('CAPABILITY_NOT_ALLOWED', 'This toolset belongs to another business.');
    } else {
      const fn = impl[name] as (input: ToolInput[N], ctx: ToolContext) => Promise<ToolResult<N>>;
      result = await fn(parsed.data as ToolInput[N], ctx);
    }
    const capabilityId = TOOL_CAPABILITY[name];
    const effect = CAPABILITIES[capabilityId].effect;
    if (!isToolEffect(effect)) throw new Error(`mock toolset: ${name} is not a read or propose tool`);
    traceEntries.push({ tool: name, capabilityId, effect, input: recordedInput, output: structuredClone(result), mocked: true, durationMs: Math.max(0, performance.now() - started) });
    return result;
  }

  const tools = Object.fromEntries(
    ToolNameSchema.options.map((name) => [name, (input: ToolInput[typeof name], ctx: ToolContext) => call(name, input, ctx)]),
  ) as unknown as Toolset;

  return {
    businessId,
    handler: { toolset: 'mock', call },
    tools,
    trace: () => traceEntries.map((e) => ({ ...e })),
    clearTrace: () => {
      traceEntries.length = 0;
    },
    reset: () => {
      traceEntries.length = 0;
      quotes.clear();
      proposals.clear();
      for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0;
    },
  };
}

export type MockToolsetRegistryOptions = {
  /** Clock shared by every session's toolset. Defaults to the fixture snapshot time. */
  now?: () => Date;
};

export type MockToolsetRegistry = {
  /**
   * The toolset of one test session, created on first use. Each session has its own quotes, proposals,
   * trace and ID counters. A session is bound to one business: asking for it with another business throws.
   */
  forSession(sessionId: string, businessId: string): MockToolset;
  /** Resets one session's toolset (see `MockToolset.reset`). Other sessions are not touched. Unknown IDs are ignored. */
  reset(sessionId: string): void;
  /** Resets every session's toolset. */
  resetAll(): void;
};

/** One isolated mock toolset per test session (for example per browser tab or per test). */
export function createMockToolsetRegistry(options: MockToolsetRegistryOptions = {}): MockToolsetRegistry {
  const sessions = new Map<string, MockToolset>();
  return {
    forSession(sessionId, businessId) {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        if (existing.businessId !== businessId) {
          throw new Error(`mock toolset registry: session ${sessionId} belongs to ${existing.businessId}, not ${businessId}`);
        }
        return existing;
      }
      const toolset = createMockToolset(options.now === undefined ? { businessId } : { businessId, now: options.now });
      sessions.set(sessionId, toolset);
      return toolset;
    },
    reset(sessionId) {
      sessions.get(sessionId)?.reset();
    },
    resetAll() {
      for (const toolset of sessions.values()) toolset.reset();
    },
  };
}
