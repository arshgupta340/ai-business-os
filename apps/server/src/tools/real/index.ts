// The real toolset (SPEC 2.6, CONTRACTS 8): the seven agent tools for phone calls and sim-call.
// Every tool runs through injected ports only (types.ts). Each tool validates its arguments with
// the contract schema, returns `{ ok: true, ... }` or `{ ok: false, reason }`, never throws, has a
// deadline, and appends metadata (never values) to a bounded trace. There is no tool for a write
// or external_message capability, and the module refuses to load if the tool table maps to one.
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
  type AvailabilitySlot,
  type BookingCustomer,
  type Cart,
  type Contact,
  type HoursKey,
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
import { localDay, localToEpoch, weekdayOfLocalDate } from './time';
import type { FactsSnapshot, PortContext, RealToolset, RealToolsetDeps, SafeTraceInput, SafeTraceOutput } from './types';

export type * from './types';

const MAX_CATALOG_RESULTS = 5;
const DEFAULT_MAX_SLOTS = 5;
const MAX_ALTERNATIVES = 3;
const MINUTE_MS = 60 * 1000;
/** Bounds on per-call memory. */
export const MAX_TRACE_ENTRIES = 50;
export const MAX_QUOTES = 10;
/**
 * A recipient must be presented in one proposal call, then confirmed by a second call with the
 * same number at least this long afterwards: the time it takes to read ten digits back and hear yes.
 */
export const READBACK_MIN_MS = 3000;
export const READBACK_FIELD = { order: 'contact.messageRecipient.readBack', booking: 'customer.messageRecipient.readBack' } as const;
const MAX_PORT_MESSAGE = 200;

// AGENTS rule 6: exactly seven tools, every one a read or propose capability. Checked once at load.
const ALL_TOOLS: readonly ToolName[] = ToolNameSchema.options;
if (ALL_TOOLS.length !== 7 || Object.keys(TOOL_CAPABILITY).length !== 7) throw new Error('real toolset: expected exactly seven agent tools');
assertToolCapabilities(ALL_TOOLS.map((t) => TOOL_CAPABILITY[t]));

const fail = (reason: ToolFailure['reason'], message: string): ToolFailure => ({ ok: false, reason, message });
const UNAVAILABLE = 'That information is not available right now.';
const NO_HOURS = 'Opening hours are not available, so this cannot be taken right now.';

/** A port message reaches the model only as a short single line. */
function portMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > MAX_PORT_MESSAGE ? `${line.slice(0, MAX_PORT_MESSAGE)}...` : line;
}

function portContext(ctx: ToolContext): PortContext {
  return { businessId: ctx.businessId, agentVersionId: ctx.agentVersionId, callId: ctx.callId, testSessionId: ctx.testSessionId, correlationId: ctx.correlationId };
}

/** Outcome metadata for the trace. Server-owned codes and IDs only. */
function summarize(result: unknown): SafeTraceOutput {
  const r = result as { ok?: unknown; reason?: unknown; missingFields?: unknown; proposalId?: unknown; approvalId?: unknown };
  const out: SafeTraceOutput = { ok: r.ok === true };
  if (typeof r.reason === 'string') out.reason = r.reason;
  if (Array.isArray(r.missingFields)) out.missingFields = r.missingFields.filter((f): f is string => typeof f === 'string');
  if (typeof r.proposalId === 'string') out.proposalId = r.proposalId;
  if (typeof r.approvalId === 'string') out.approvalId = r.approvalId;
  return out;
}

type HoursOnDay = { state: 'open'; open: string; close: string } | { state: 'closed' } | { state: 'unknown' };
type Invocation = { abandoned: boolean };
type Impl = { [N in ToolName]: (input: ToolInput[N], ctx: ToolContext, op: Invocation) => Promise<ToolResult<N>> };

export function createRealToolset(deps: RealToolsetDeps): RealToolset {
  const { businessId, ports } = deps;
  const now = deps.now ?? (() => new Date());
  const allowed = new Set<ToolName>(deps.capabilities === undefined ? ALL_TOOLS : toolsForCapabilities(deps.capabilities));

  let disposed = false;
  const traceEntries: ToolTraceEntry[] = [];
  // SPEC 2.9 "Not persisted": quotes made on this call live here, bounded, until a proposal stores one.
  const quotes = new Map<string, { quote: Quote; cart: Cart }>();
  // Call-bound read-back state for the message recipient (see READBACK_MIN_MS).
  let readBack: { recipient: string; firstSeenAt: number; confirmedAt?: number } | undefined;

  // AC-16, FLOWS B2: the facts are the snapshot pinned with the call. Without a pinned snapshot they
  // are read once; a failure is kept, never retried, so a call cannot silently switch versions.
  let facts: Promise<FactsSnapshot>;
  if (deps.factsSnapshot !== undefined) facts = Promise.resolve(structuredClone(deps.factsSnapshot));
  else if (ports.facts !== undefined) facts = ports.facts.readVerified({ businessId }).then((s) => structuredClone(s));
  else facts = Promise.reject(new Error('no facts'));
  facts.catch(() => undefined);

  function servicesIn(snapshot: FactsSnapshot): ServiceOffering[] {
    return snapshot.facts
      .filter((f) => f.kind === 'service')
      .flatMap((f) => {
        const parsed = ServiceOfferingSchema.safeParse(f.value);
        return parsed.success && parsed.data.businessId === businessId ? [parsed.data] : [];
      });
  }

  function hoursOn(snapshot: FactsSnapshot, weekday: HoursKey): HoursOnDay {
    const fact = snapshot.facts.find((f) => f.kind === 'hours' && f.key === weekday);
    const parsed = fact === undefined ? undefined : HoursValueSchema.safeParse(fact.value);
    if (parsed === undefined || !parsed.success) return { state: 'unknown' };
    return 'closed' in parsed.data ? { state: 'closed' } : { state: 'open', open: parsed.data.open, close: parsed.data.close };
  }

  /** Fails closed: only an affirmative answer from readable hours is `inside`. */
  function insideHours(snapshot: FactsSnapshot, startMs: number, endMs: number): 'inside' | 'outside' | 'unknown' {
    const tz = snapshot.timezone;
    const { date, weekday } = localDay(startMs, tz);
    const h = hoursOn(snapshot, weekday);
    if (h.state === 'unknown') return 'unknown';
    if (h.state === 'closed') return 'outside';
    return startMs >= localToEpoch(date, h.open, tz) && endMs <= localToEpoch(date, h.close, tz) ? 'inside' : 'outside';
  }

  function storeQuote(quote: Quote, cart: Cart) {
    const t = now().getTime();
    for (const [id, q] of quotes) if (Date.parse(q.quote.expiresAt) < t) quotes.delete(id);
    while (quotes.size >= MAX_QUOTES) {
      const oldest = quotes.keys().next().value;
      if (oldest === undefined) break;
      quotes.delete(oldest);
    }
    quotes.set(quote.quoteId, { quote, cart });
  }

  async function quoteCart(cart: Cart): Promise<{ ok: true; quote: Quote } | ToolFailure> {
    const r = await ports.quotes.quote({ businessId, cart });
    if (!r.ok) return fail('ITEM_UNAVAILABLE', portMessage(r.message) ?? 'An item in the cart is not available.');
    if (!disposed) storeQuote(r.quote, cart);
    return { ok: true, quote: r.quote };
  }

  /** Returns the server consent time once the recipient was presented earlier and confirmed now, else null. */
  function confirmRecipient(recipient: string): string | null {
    const t = now().getTime();
    if (readBack === undefined || readBack.recipient !== recipient) {
      readBack = { recipient, firstSeenAt: t };
      return null;
    }
    if (t - readBack.firstSeenAt < READBACK_MIN_MS) return null;
    readBack.confirmedAt ??= t;
    return new Date(readBack.confirmedAt).toISOString();
  }

  const channelFor = (consent: boolean): MessageChannelSetting => (consent ? deps.messageChannel : 'qr_only');
  const live = (op: Invocation) => !op.abandoned && !disposed;

  // ---- The seven tools ----

  const impl: Impl = {
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
      const snapshot = await facts;
      const kinds = input.kinds;
      const out = snapshot.facts
        .filter((f) => kinds === undefined || kinds.includes(f.kind))
        .map((f) => ({ kind: f.kind, key: f.key, value: f.value }));
      return { ok: true, facts: out, timezone: snapshot.timezone };
    },

    async quote_order(input) {
      return quoteCart(input.cart);
    },

    async propose_order(input, ctx, op) {
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
      if (input.contact.name.trim() === '') return { ok: true, quote: stored.quote, missingFields: ['contact.name'] };

      const snapshot = await facts;
      const pickup = Date.parse(input.fulfillment.pickupAt);
      if (pickup < now().getTime()) return fail('VALIDATION_FAILED', 'The pickup time is in the past.');
      const where = insideHours(snapshot, pickup, pickup);
      if (where === 'unknown') return fail('VALIDATION_FAILED', NO_HOURS);
      if (where === 'outside') return fail('VALIDATION_FAILED', 'The pickup time is outside opening hours.');

      // SPEC 2.9: without consent there is no recipient and the channel is qr_only. With consent the
      // recipient must have been read back on this call, and the consent time is the server's.
      let contact: Contact;
      if (input.contact.messageConsent && input.contact.messageRecipient !== undefined) {
        const consentAt = confirmRecipient(input.contact.messageRecipient);
        if (consentAt === null) return { ok: true, quote: stored.quote, missingFields: [READBACK_FIELD.order] };
        contact = { name: input.contact.name, messageRecipient: input.contact.messageRecipient, messageConsent: true, consentAt };
      } else {
        contact = { name: input.contact.name, messageConsent: false };
      }

      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      const r = await ports.proposals.createOrderProposal({
        ...portContext(ctx),
        cart: input.cart,
        quote: stored.quote,
        contact,
        fulfillment: input.fulfillment,
        messageChannel: channelFor(contact.messageConsent),
      });
      if (!r.ok) {
        const out: ToolFailure = { ok: false, reason: r.reason };
        const message = portMessage(r.message);
        if (message !== undefined) out.message = message;
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
      const snapshot = await facts;
      const service = servicesIn(snapshot).find((s) => s.id === input.serviceId);
      if (service === undefined) return fail('NOT_FOUND', 'No such service.');
      const max = input.maxSlots ?? DEFAULT_MAX_SLOTS;
      const h = hoursOn(snapshot, weekdayOfLocalDate(input.date));
      if (h.state === 'unknown') return fail('VALIDATION_FAILED', NO_HOURS);
      if (h.state === 'closed') return { ok: true, slots: [], timezone: snapshot.timezone };
      const slots = await ports.availability.freeSlots({ businessId, service, date: input.date, hours: { open: h.open, close: h.close }, timezone: snapshot.timezone, maxSlots: max });
      // Only slots that are inside the pinned hours and match the pinned duration are offered.
      const ok = (s: AvailabilitySlot) =>
        s.serviceId === service.id &&
        Date.parse(s.endUtc) - Date.parse(s.startUtc) === service.durationMinutes * MINUTE_MS &&
        insideHours(snapshot, Date.parse(s.startUtc), Date.parse(s.endUtc)) === 'inside';
      return { ok: true, slots: slots.filter(ok).slice(0, max), timezone: snapshot.timezone };
    },

    async propose_booking(input, ctx, op) {
      const snapshot = await facts;
      const service = servicesIn(snapshot).find((s) => s.id === input.serviceId);
      if (service === undefined) return fail('NOT_FOUND', 'No such service.');
      const start = Date.parse(input.startUtc);
      const end = start + service.durationMinutes * MINUTE_MS;
      const slot = { serviceId: service.id, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), timezone: snapshot.timezone };
      if (start < now().getTime()) return fail('VALIDATION_FAILED', 'That time is in the past.');
      const where = insideHours(snapshot, start, end);
      if (where === 'unknown') return fail('VALIDATION_FAILED', NO_HOURS);
      if (where === 'outside') return fail('VALIDATION_FAILED', 'That time is outside opening hours.');
      if (input.customer.name.trim() === '') return { ok: true, missingFields: ['customer.name'], slot };

      let customer: BookingCustomer;
      if (input.customer.messageConsent && input.customer.messageRecipient !== undefined) {
        if (confirmRecipient(input.customer.messageRecipient) === null) return { ok: true, missingFields: [READBACK_FIELD.booking], slot };
        customer = { name: input.customer.name, messageRecipient: input.customer.messageRecipient, messageConsent: true };
      } else {
        customer = { name: input.customer.name, messageConsent: false };
      }

      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      const r = await ports.proposals.createBookingProposal({
        ...portContext(ctx),
        serviceId: input.serviceId,
        startUtc: input.startUtc,
        customer,
        messageChannel: channelFor(customer.messageConsent),
      });
      if (!r.ok) {
        const out: ToolFailure = { ok: false, reason: r.reason };
        const message = portMessage(r.message);
        if (message !== undefined) out.message = message;
        if (r.reason === 'SLOT_CONFLICT' && r.alternatives !== undefined) out.alternatives = r.alternatives.slice(0, MAX_ALTERNATIVES);
        return out;
      }
      return { ok: true, proposalId: r.bookingId, approvalId: r.approvalId, missingFields: [], slot: r.slot };
    },
  };

  async function run<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<{ result: ToolResult<N>; trace: SafeTraceInput }> {
    const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(input);
    if (!parsed.success) return { result: fail('VALIDATION_FAILED', 'The arguments do not match the tool.'), trace: { valid: false } };
    const fields = Object.keys(parsed.data as object).sort();
    const traced: SafeTraceInput = { valid: true, fields };
    if (disposed) return { result: fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE), trace: traced };
    // AC-17: a toolset reads only its own business.
    if (ctx.businessId !== businessId) return { result: fail('CAPABILITY_NOT_ALLOWED', 'This toolset belongs to another business.'), trace: traced };
    if (!allowed.has(name)) return { result: fail('CAPABILITY_NOT_ALLOWED', 'This agent version does not have that tool.'), trace: traced };

    const op: Invocation = { abandoned: false };
    const timeoutMs = deps.toolTimeoutMs ?? CAPABILITIES[TOOL_CAPABILITY[name]].timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    let result: ToolResult<N>;
    try {
      const fn = impl[name] as (input: ToolInput[N], ctx: ToolContext, op: Invocation) => Promise<ToolResult<N>>;
      const outcome = await Promise.race([fn(parsed.data as ToolInput[N], ctx, op), deadline]);
      if (outcome === 'timeout') {
        // The abandoned operation can still finish; `op.abandoned` stops it before any proposal.
        op.abandoned = true;
        return { result: fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE), trace: traced };
      }
      result = outcome;
    } catch {
      // A port that throws means a provider or the database could not be reached. Never rethrow.
      return { result: fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE), trace: traced };
    } finally {
      clearTimeout(timer);
    }
    // A port that returns a malformed shape is treated as unavailable, so the model never sees it.
    if (!toolResultSchema(name).safeParse(result).success) return { result: fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE), trace: traced };
    return { result, trace: traced };
  }

  async function call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<N>> {
    const started = performance.now();
    const { result, trace } = await run(name, input, ctx);
    const capabilityId = TOOL_CAPABILITY[name];
    const effect = CAPABILITIES[capabilityId].effect;
    if (isToolEffect(effect) && !disposed) {
      traceEntries.push({ tool: name, capabilityId, effect, input: trace, output: summarize(result), mocked: false, durationMs: Math.max(0, performance.now() - started) });
      if (traceEntries.length > MAX_TRACE_ENTRIES) traceEntries.splice(0, traceEntries.length - MAX_TRACE_ENTRIES);
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
    trace: () => traceEntries.map((e) => structuredClone(e)),
    clearTrace: () => {
      traceEntries.length = 0;
    },
    dispose: () => {
      disposed = true;
      quotes.clear();
      readBack = undefined;
      traceEntries.length = 0;
    },
  };
}
