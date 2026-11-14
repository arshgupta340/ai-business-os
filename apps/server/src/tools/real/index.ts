// The real toolset (SPEC 2.6, CONTRACTS 8): the seven agent tools for phone calls and sim-call.
// Every tool runs through injected ports only (types.ts). Each tool validates its arguments with
// the contract schema, returns `{ ok: true, ... }` or `{ ok: false, reason }`, never throws, and
// appends to a tool trace. There is no tool for a write or external_message capability, and the
// module refuses to load if the tool table ever maps to one.
import {
  CAPABILITIES,
  HoursValueSchema,
  ServiceOfferingSchema,
  TOOL_CAPABILITY,
  TOOL_INPUT_SCHEMAS,
  ToolNameSchema,
  assertToolCapabilities,
  cartHash,
  isToolEffect,
  toolResultSchema,
  toolsForCapabilities,
  type Cart,
  type Contact,
  type MessageChannelSetting,
  type Quote,
  type ServiceOffering,
  type ToolContext,
  type ToolFailure,
  type ToolInput,
  type ToolName,
  type ToolResult,
  type ToolTraceEntry,
  type Toolset,
} from '@abos/contracts';
import { localDay, localToEpoch } from './time';
import type { FactsSnapshot, PortContext, RealToolset, RealToolsetDeps } from './types';

export type * from './types';

const MAX_CATALOG_RESULTS = 5;
const DEFAULT_MAX_SLOTS = 5;
const MINUTE_MS = 60 * 1000;

// AGENTS rule 6: exactly seven tools, every one a read or propose capability. Checked once at load.
const ALL_TOOLS: readonly ToolName[] = ToolNameSchema.options;
if (ALL_TOOLS.length !== 7 || Object.keys(TOOL_CAPABILITY).length !== 7) throw new Error('real toolset: expected exactly seven agent tools');
assertToolCapabilities(ALL_TOOLS.map((t) => TOOL_CAPABILITY[t]));

const fail = (reason: ToolFailure['reason'], message: string): ToolFailure => ({ ok: false, reason, message });

/** Masks every `messageRecipient` in a traced value to its last four digits. */
function maskRecipients(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskRecipients);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'messageRecipient' && typeof v === 'string' ? `***${v.slice(-4)}` : maskRecipients(v);
  }
  return out;
}

function portContext(ctx: ToolContext): PortContext {
  return { businessId: ctx.businessId, agentVersionId: ctx.agentVersionId, callId: ctx.callId, testSessionId: ctx.testSessionId, correlationId: ctx.correlationId };
}

export function createRealToolset(deps: RealToolsetDeps): RealToolset {
  const { businessId, ports } = deps;
  const now = deps.now ?? (() => new Date());
  const allowed = new Set<ToolName>(deps.capabilities === undefined ? ALL_TOOLS : toolsForCapabilities(deps.capabilities));

  const traceEntries: ToolTraceEntry[] = [];
  // SPEC 2.9 "Not persisted": quotes made on this call live here until a proposal stores one.
  const quotes = new Map<string, { quote: Quote; cart: Cart }>();

  // AC-16: the verified facts are read once, when the toolset (the call) starts, and reused for the
  // whole call. A fact the owner changes mid-call reaches the next call, not this one.
  let factsPromise: Promise<FactsSnapshot> | undefined;
  const loadFacts = (): Promise<FactsSnapshot> => {
    if (factsPromise === undefined) {
      const p = ports.facts.readVerified({ businessId });
      factsPromise = p;
      p.catch(() => {
        // A failed read is not cached, so the next tool call can try again.
        if (factsPromise === p) factsPromise = undefined;
      });
    }
    return factsPromise;
  };
  void loadFacts().catch(() => undefined);

  async function factsOrUndefined(): Promise<FactsSnapshot | undefined> {
    try {
      return await loadFacts();
    } catch {
      return undefined;
    }
  }

  function servicesIn(snapshot: FactsSnapshot): ServiceOffering[] {
    return snapshot.facts
      .filter((f) => f.kind === 'service')
      .flatMap((f) => {
        const parsed = ServiceOfferingSchema.safeParse(f.value);
        return parsed.success && parsed.data.businessId === businessId ? [parsed.data] : [];
      });
  }

  /** True, false, or undefined when the snapshot has no hours for that day. */
  function insideHours(snapshot: FactsSnapshot, startMs: number, endMs: number): boolean | undefined {
    const tz = snapshot.timezone;
    const { date, weekday } = localDay(startMs, tz);
    const fact = snapshot.facts.find((f) => f.kind === 'hours' && f.key === weekday);
    if (fact === undefined) return undefined;
    const hours = HoursValueSchema.safeParse(fact.value);
    if (!hours.success) return undefined;
    if ('closed' in hours.data) return false;
    const open = localToEpoch(date, hours.data.open, tz);
    const close = localToEpoch(date, hours.data.close, tz);
    return startMs >= open && endMs <= close;
  }

  async function quoteCart(cart: Cart): Promise<{ ok: true; quote: Quote } | ToolFailure> {
    const r = await ports.quotes.quote({ businessId, cart });
    if (!r.ok) return fail('ITEM_UNAVAILABLE', r.message ?? 'An item in the cart is not available.');
    quotes.set(r.quote.quoteId, { quote: r.quote, cart });
    return { ok: true, quote: r.quote };
  }

  const channelFor = (consent: boolean): MessageChannelSetting => (consent ? deps.messageChannel : 'qr_only');

  // ---- The seven tools ----

  const impl: Toolset = {
    async read_catalog(input) {
      const items = await ports.catalog.search({ businessId, query: input.query, limit: MAX_CATALOG_RESULTS });
      return {
        ok: true,
        items: items
          .filter((item) => item.businessId === businessId)
          .slice(0, MAX_CATALOG_RESULTS)
          .map((item) => ({
            catalogItemId: item.squareItemId,
            name: item.name,
            available: item.available,
            variations: item.variations.map((v) => ({ id: v.id, name: v.name, priceMinor: v.priceMinor })),
            modifierLists: item.modifierLists.map((l) => ({
              id: l.id, name: l.name, selectionType: l.selectionType,
              modifiers: l.modifiers.map((m) => ({ id: m.id, name: m.name, priceMinor: m.priceMinor })),
            })),
          })),
      };
    },

    async read_business_facts(input) {
      const snapshot = await loadFacts();
      const kinds = input.kinds;
      const facts = snapshot.facts
        .filter((f) => kinds === undefined || kinds.includes(f.kind))
        .map((f) => ({ kind: f.kind, key: f.key, value: f.value }));
      return { ok: true, facts, timezone: snapshot.timezone };
    },

    async quote_order(input) {
      return quoteCart(input.cart);
    },

    async propose_order(input, ctx) {
      // Only a quote made on this call can be proposed (FLOWS B14).
      const stored = quotes.get(input.quoteId);
      if (stored === undefined) return fail('NOT_FOUND', 'Unknown quote. Call quote_order first.');
      const hash = await cartHash(input.cart);
      const expired = now().getTime() > Date.parse(stored.quote.expiresAt);
      if (expired || hash !== stored.quote.cartHash) {
        quotes.delete(input.quoteId);
        const fresh = await quoteCart(input.cart);
        if (!fresh.ok) return fresh;
        return { ok: false, reason: 'QUOTE_EXPIRED', message: expired ? 'The quote expired. Read back the new total.' : 'The cart changed. Read back the new total.', quote: fresh.quote };
      }

      const missingFields: string[] = [];
      if (input.contact.name.trim() === '') missingFields.push('contact.name');
      if (missingFields.length > 0) return { ok: true, quote: stored.quote, missingFields };

      const pickup = Date.parse(input.fulfillment.pickupAt);
      if (pickup < now().getTime()) return fail('VALIDATION_FAILED', 'The pickup time is in the past.');
      const snapshot = await factsOrUndefined();
      if (snapshot !== undefined && insideHours(snapshot, pickup, pickup) === false) {
        return fail('VALIDATION_FAILED', 'The pickup time is outside opening hours.');
      }

      // SPEC 2.9: a customer who declines messages has no recipient, and the channel is qr_only.
      const consent = input.contact.messageConsent;
      const contact: Contact = consent ? input.contact : { name: input.contact.name, messageConsent: false };
      const r = await ports.proposals.createOrderProposal({
        ...portContext(ctx),
        cart: input.cart,
        quote: stored.quote,
        contact,
        fulfillment: input.fulfillment,
        messageChannel: channelFor(consent),
      });
      if (!r.ok) {
        const out: ToolFailure = { ok: false, reason: r.reason };
        if (r.message !== undefined) out.message = r.message;
        if (r.reason === 'QUOTE_EXPIRED' && r.quote !== undefined) out.quote = r.quote;
        return out;
      }
      quotes.delete(input.quoteId);
      return { ok: true, proposalId: r.orderId, approvalId: r.approvalId, quote: stored.quote, missingFields: [] };
    },

    async get_order_status(input, ctx) {
      const view = await ports.orderStatus.read({ businessId, orderId: input.orderId, callId: ctx.callId });
      if (view === null) return fail('NOT_FOUND', 'No order with that ID on this call.');
      return { ok: true, orderId: view.orderId, status: view.status, paid: view.paid, checkoutLinkSent: view.checkoutLinkSent };
    },

    async read_calendar_availability(input) {
      const r = await ports.availability.freeSlots({ businessId, serviceId: input.serviceId, date: input.date, maxSlots: input.maxSlots ?? DEFAULT_MAX_SLOTS });
      if (r === null) return fail('NOT_FOUND', 'No such service.');
      return { ok: true, slots: r.slots.slice(0, input.maxSlots ?? DEFAULT_MAX_SLOTS), timezone: r.timezone };
    },

    async propose_booking(input, ctx) {
      const snapshot = await loadFacts();
      const service = servicesIn(snapshot).find((s) => s.id === input.serviceId);
      if (service === undefined) return fail('NOT_FOUND', 'No such service.');
      const start = Date.parse(input.startUtc);
      const end = start + service.durationMinutes * MINUTE_MS;
      const slot = { serviceId: service.id, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), timezone: snapshot.timezone };
      if (start < now().getTime()) return fail('VALIDATION_FAILED', 'That time is in the past.');
      if (insideHours(snapshot, start, end) === false) return fail('VALIDATION_FAILED', 'That time is outside opening hours.');

      const missingFields: string[] = [];
      if (input.customer.name.trim() === '') missingFields.push('customer.name');
      if (missingFields.length > 0) return { ok: true, missingFields, slot };

      const consent = input.customer.messageConsent;
      const customer = consent ? input.customer : { name: input.customer.name, messageConsent: false };
      const r = await ports.proposals.createBookingProposal({
        ...portContext(ctx),
        serviceId: input.serviceId,
        startUtc: input.startUtc,
        customer,
        messageChannel: channelFor(consent),
      });
      if (!r.ok) {
        const out: ToolFailure = { ok: false, reason: r.reason };
        if (r.message !== undefined) out.message = r.message;
        if (r.reason === 'SLOT_CONFLICT' && r.alternatives !== undefined) out.alternatives = r.alternatives.slice(0, 3);
        return out;
      }
      return { ok: true, proposalId: r.bookingId, approvalId: r.approvalId, missingFields: [], slot: r.slot };
    },
  };

  async function run<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<N>> {
    const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(input);
    if (!parsed.success) return fail('VALIDATION_FAILED', parsed.error.issues.map((i) => i.message).join('; '));
    // AC-17: a toolset reads only its own business.
    if (ctx.businessId !== businessId) return fail('CAPABILITY_NOT_ALLOWED', 'This toolset belongs to another business.');
    if (!allowed.has(name)) return fail('CAPABILITY_NOT_ALLOWED', 'This agent version does not have that tool.');
    let result: ToolResult<N>;
    try {
      const fn = impl[name] as (input: ToolInput[N], ctx: ToolContext) => Promise<ToolResult<N>>;
      result = await fn(parsed.data as ToolInput[N], ctx);
    } catch {
      // A port that throws means a provider or the database could not be reached. Never rethrow.
      return fail('INTEGRATION_UNAVAILABLE', 'That information is not available right now.');
    }
    // A port that returns a malformed shape is treated as unavailable, so the model never sees it.
    if (!toolResultSchema(name).safeParse(result).success) return fail('INTEGRATION_UNAVAILABLE', 'That information is not available right now.');
    return result;
  }

  async function call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<N>> {
    const started = performance.now();
    let recordedInput: unknown;
    try {
      recordedInput = maskRecipients(structuredClone(input));
    } catch {
      recordedInput = null;
    }
    const result = await run(name, input, ctx);
    const capabilityId = TOOL_CAPABILITY[name];
    const effect = CAPABILITIES[capabilityId].effect;
    if (isToolEffect(effect)) {
      traceEntries.push({ tool: name, capabilityId, effect, input: recordedInput, output: maskRecipients(structuredClone(result)), mocked: false, durationMs: Math.max(0, performance.now() - started) });
    }
    return result;
  }

  const tools = Object.fromEntries(
    ALL_TOOLS.map((name) => [name, (input: ToolInput[typeof name], ctx: ToolContext) => call(name, input, ctx)]),
  ) as unknown as Toolset;

  return {
    businessId,
    handler: { toolset: 'real', call },
    tools,
    trace: () => traceEntries.map((e) => ({ ...e })),
    clearTrace: () => {
      traceEntries.length = 0;
    },
  };
}
