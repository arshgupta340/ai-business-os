import { randomUUID } from 'node:crypto';
// The real toolset (SPEC 2.6, CONTRACTS 8): the seven agent tools for phone calls and sim-call.
// Every tool runs through injected ports only (types.ts). Each tool validates its arguments with
// the contract schema, returns `{ ok: true, ... }` or `{ ok: false, reason }`, never throws, has a
// deadline, and appends metadata (never values) to a bounded trace. There is no tool for a write
// or external_message capability, and the module refuses to load if the tool table maps to one.
import {
  CAPABILITIES,
  E164Schema,
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
import { localDay, localToEpoch, pickupTooSoon, PICKUP_TOO_SOON, weekdayOfLocalDate } from './time';
import type { ConsentEvidence, FactsSnapshot, PortContext, RealToolset, RealToolsetDeps, InvocationControl, SafeTraceInput, SafeTraceOutput } from './types';

export type * from './types';

const MAX_CATALOG_RESULTS = 5;
const DEFAULT_MAX_SLOTS = 5;
/** Enough for every slot of one day on the 15 minute grid. */
const DAY_SLOTS = 96;

/** The `max` slots whose start is closest to `at`, in time order. A slot exactly at `at` is always among them. */
export function nearestSlots<T extends { startUtc: string }>(slots: readonly T[], at: number, max: number): T[] {
  return [...slots]
    .sort((a, b) => Math.abs(Date.parse(a.startUtc) - at) - Math.abs(Date.parse(b.startUtc) - at) || Date.parse(a.startUtc) - Date.parse(b.startUtc))
    .slice(0, max)
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
}
const MAX_ALTERNATIVES = 3;
const MINUTE_MS = 60 * 1000;
/** Bounds on per-call memory. */
export const MAX_TRACE_ENTRIES = 50;
export const MAX_QUOTES = 10;
// AGENTS rule 6: exactly eight tools (the seven of SPEC 2.6 and the D-13 demo menu tool), every one a
// read or propose capability. Checked once at load.
const ALL_TOOLS: readonly ToolName[] = ToolNameSchema.options;
if (ALL_TOOLS.length !== 8 || Object.keys(TOOL_CAPABILITY).length !== 8) throw new Error('real toolset: expected exactly eight agent tools');
/** D-13: what the menu tool says when nothing was sent. */
export const MENU_NOT_SENT = 'The menu cannot be sent by message on this call. Read it out instead.';
assertToolCapabilities(ALL_TOOLS.map((t) => TOOL_CAPABILITY[t]));

const fail = (reason: ToolFailure['reason'], message: string): ToolFailure => ({ ok: false, reason, message });
const UNAVAILABLE = 'That information is not available right now.';
const NO_HOURS = 'Opening hours are not available, so this cannot be taken right now.';

/** Provider prose can contain private data. Only fixed local wording reaches error messages. */
function portMessage(message: string | undefined): string | undefined {
  return message === undefined ? undefined : 'The request could not be completed right now.';
}

function portContext(ctx: ToolContext, op: Invocation, operationId: string): PortContext {
  return { operationId, signal: op.controller.signal, businessId: ctx.businessId, agentVersionId: ctx.agentVersionId, callId: ctx.callId, testSessionId: ctx.testSessionId, correlationId: ctx.correlationId };
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
type Invocation = { controller: AbortController };
type Impl = { [N in ToolName]: (input: ToolInput[N], ctx: ToolContext, op: Invocation) => Promise<ToolResult<N>> };

export function createRealToolset(deps: RealToolsetDeps): RealToolset {
  const { businessId, ports } = deps;
  const now = deps.now ?? (() => new Date());
  const allowed = new Set<ToolName>(deps.capabilities === undefined ? ALL_TOOLS : toolsForCapabilities(deps.capabilities));

  let disposed = false;
  const traceEntries: ToolTraceEntry[] = [];
  // SPEC 2.9 "Not persisted": quotes made on this call live here, bounded, until a proposal stores one.
  const quotes = new Map<string, { quote: Quote; cart: Cart }>();
  const invocations = new Set<AbortController>();
  const lifetime = new AbortController();
  // Never release an uncertain quote reservation. Bounded separately from the quote cache.
  const reservedQuotes = new Map<string, string>();
  let bookingReserved = false;

  // AC-16, FLOWS B2: the facts are the snapshot pinned with the call. Without a pinned snapshot they
  // are read once; a failure is kept, never retried, so a call cannot silently switch versions.
  let facts: Promise<FactsSnapshot>;
  if (deps.factsSnapshot !== undefined) facts = Promise.resolve(structuredClone(deps.factsSnapshot));
  else if (ports.facts !== undefined) facts = ports.facts.readVerified({ businessId, signal: lifetime.signal }).then((s) => structuredClone(s));
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

  async function quoteCart(cart: Cart, op: Invocation): Promise<{ ok: true; quote: Quote } | ToolFailure> {
    const r = await ports.quotes.quote({ businessId, cart, signal: op.controller.signal });
    if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
    if (!r.ok) return fail('ITEM_UNAVAILABLE', portMessage(r.message) ?? 'An item in the cart is not available.');
    storeQuote(r.quote, cart);
    return { ok: true, quote: r.quote };
  }

  /**
   * PROPOSED (SPEC 2.9 "Consent evidence on a phone call"): the only consent this toolset accepts is
   * server-held evidence from the phone relay, read through `deps.consent`, for this exact call and
   * version, while the server channel sends messages. The model's `messageConsent`, `messageRecipient`
   * and `consentAt` are never read. Without valid evidence the proposal is `qr_only` with no recipient.
   */
  function trustedConsent(ctx: ToolContext): ConsentEvidence | undefined {
    const source = deps.consent;
    if (source === undefined || deps.messageChannel === 'qr_only') return undefined;
    if (ctx.callId === undefined || ctx.callId !== source.callId || ctx.agentVersionId !== source.agentVersionId) return undefined;
    let e: ConsentEvidence | undefined;
    try {
      e = source.read();
    } catch {
      return undefined;
    }
    if (e === undefined || e.callId !== source.callId || e.agentVersionId !== source.agentVersionId) return undefined;
    if (e.method !== 'spoken' && e.method !== 'keypad') return undefined;
    if (!E164Schema.safeParse(e.recipient).success) return undefined;
    const spoken = Date.parse(e.offerSpokenAt);
    const agreed = Date.parse(e.consentAt);
    if (!Number.isFinite(spoken) || !Number.isFinite(agreed) || agreed < spoken) return undefined;
    return { ...e };
  }
  const channelFor = (consent: ConsentEvidence | undefined): MessageChannelSetting => (consent === undefined ? 'qr_only' : deps.messageChannel);
  const live = (op: Invocation) => !op.controller.signal.aborted && !disposed;

  // ---- The tools ----

  const impl: Impl = {
    async read_catalog(input, _ctx, op) {
      const items = await ports.catalog.search({ businessId, query: input.query, limit: MAX_CATALOG_RESULTS, signal: op.controller.signal });
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
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

    async read_business_facts(input, _ctx, op) {
      const snapshot = await facts;
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      const kinds = input.kinds;
      const out = snapshot.facts
        .filter((f) => kinds === undefined || kinds.includes(f.kind))
        .map((f) => ({ kind: f.kind, key: f.key, value: f.value }));
      return { ok: true, facts: out, timezone: snapshot.timezone };
    },

    async quote_order(input, _ctx, op) {
      return quoteCart(input.cart, op);
    },

    async propose_order(input, ctx, op) {
      // Only a quote made on this call can be proposed (FLOWS B14).
      const stored = quotes.get(input.quoteId);
      if (stored === undefined) return fail('NOT_FOUND', 'Unknown quote. Call quote_order first.');
      if (reservedQuotes.has(input.quoteId)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      const hash = await cartHash(input.cart);
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      const expired = now().getTime() >= Date.parse(stored.quote.expiresAt);
      if (expired || hash !== stored.quote.cartHash) {
        quotes.delete(input.quoteId);
        const fresh = await quoteCart(input.cart, op);
        if (!fresh.ok) return fresh;
        return { ok: false, reason: 'QUOTE_EXPIRED', message: expired ? 'The quote expired. Read back the new total.' : 'The cart changed. Read back the new total.', quote: fresh.quote };
      }
      if (input.contact.name.trim() === '') return { ok: true, quote: stored.quote, missingFields: ['contact.name'] };

      const snapshot = await facts;
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      const pickup = Date.parse(input.fulfillment.pickupAt);
      if (pickup < now().getTime()) return fail('VALIDATION_FAILED', 'The pickup time is in the past.');
      if (pickupTooSoon(pickup, now().getTime())) return fail('VALIDATION_FAILED', PICKUP_TOO_SOON);
      const where = insideHours(snapshot, pickup, pickup);
      if (where === 'unknown') return fail('VALIDATION_FAILED', NO_HOURS);
      if (where === 'outside') return fail('VALIDATION_FAILED', 'The pickup time is outside opening hours.');

      const consent = trustedConsent(ctx);
      const contact: Contact = consent === undefined
        ? { name: input.contact.name, messageConsent: false }
        : { name: input.contact.name, messageRecipient: consent.recipient, messageConsent: true, consentAt: consent.consentAt };

      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      if (ports.proposals.atomicOperations !== true || reservedQuotes.size >= MAX_QUOTES) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      // Synchronous reservation after validation and before the first proposal await.
      if (reservedQuotes.has(input.quoteId)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      const operationId = randomUUID();
      reservedQuotes.set(input.quoteId, operationId);
      const r = await ports.proposals.createOrderProposal({
        ...portContext(ctx, op, operationId),
        cart: input.cart,
        quote: stored.quote,
        contact,
        fulfillment: input.fulfillment,
        messageChannel: channelFor(consent),
      });
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
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

    async get_order_status(input, ctx, op) {
      const view = await ports.orderStatus.read({ businessId, orderId: input.orderId, callId: ctx.callId, signal: op.controller.signal });
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      if (view === null || ctx.callId === undefined || view.businessId !== businessId || view.callId !== ctx.callId || view.orderId !== input.orderId) return fail('NOT_FOUND', 'No order with that ID on this call.');
      return { ok: true, orderId: view.orderId, status: view.status, paid: view.paid, checkoutLinkSent: view.checkoutLinkSent };
    },

    async read_calendar_availability(input, _ctx, op) {
      const snapshot = await facts;
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      const service = servicesIn(snapshot).find((s) => s.id === input.serviceId);
      if (service === undefined) return fail('NOT_FOUND', 'No such service.');
      const max = input.maxSlots ?? DEFAULT_MAX_SLOTS;
      const h = hoursOn(snapshot, weekdayOfLocalDate(input.date));
      if (h.state === 'unknown') return fail('VALIDATION_FAILED', NO_HOURS);
      if (h.state === 'closed') return { ok: true, slots: [], timezone: snapshot.timezone };
      // With `near`, the whole day's free slots are read, so the caller's own time can be found among them.
      const slots = await ports.availability.freeSlots({ businessId, service, date: input.date, hours: { open: h.open, close: h.close }, timezone: snapshot.timezone,
        maxSlots: input.near === undefined ? max : DAY_SLOTS, signal: op.controller.signal });
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      // Only slots that are inside the pinned hours and match the pinned duration are offered.
      const ok = (s: AvailabilitySlot) =>
        s.serviceId === service.id &&
        Date.parse(s.endUtc) - Date.parse(s.startUtc) === service.durationMinutes * MINUTE_MS &&
        insideHours(snapshot, Date.parse(s.startUtc), Date.parse(s.endUtc)) === 'inside';
      const usable = slots.filter(ok);
      if (input.near === undefined) return { ok: true, slots: usable.slice(0, max), timezone: snapshot.timezone };
      return { ok: true, slots: nearestSlots(usable, localToEpoch(input.date, input.near, snapshot.timezone), max), timezone: snapshot.timezone };
    },

    async propose_booking(input, ctx, op) {
      const snapshot = await facts;
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
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

      // BookingCustomer has no consentAt field; the evidence's time stays with the relay.
      const consent = trustedConsent(ctx);
      const customer: BookingCustomer = consent === undefined
        ? { name: input.customer.name, messageConsent: false }
        : { name: input.customer.name, messageRecipient: consent.recipient, messageConsent: true };

      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      if (ports.proposals.atomicOperations !== true || bookingReserved) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      bookingReserved = true;
      const r = await ports.proposals.createBookingProposal({
        ...portContext(ctx, op, randomUUID()),
        serviceId: input.serviceId,
        startUtc: input.startUtc,
        customer,
        messageChannel: channelFor(consent),
      });
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      if (!r.ok) {
        bookingReserved = false;
        const out: ToolFailure = { ok: false, reason: r.reason };
        const message = portMessage(r.message);
        if (message !== undefined) out.message = message;
        if (r.reason === 'SLOT_CONFLICT' && r.alternatives !== undefined) out.alternatives = r.alternatives.slice(0, MAX_ALTERNATIVES);
        return out;
      }
      return { ok: true, proposalId: r.bookingId, approvalId: r.approvalId, missingFields: [], slot: r.slot };
    },

    // D-13 demo mode. The model only asks; the server's demo port decides whether to send, to whom and what.
    // Without the port (demo mode off, or a caller who is not a listed number) nothing is sent.
    async propose_menu_message(_input, ctx, op) {
      const port = deps.menuMessage;
      if (port === undefined || ctx.callId === undefined) return { ok: true, sent: false, message: MENU_NOT_SENT };
      const r = await port.send({ callId: ctx.callId, signal: op.controller.signal });
      if (!live(op)) return fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      return r.sent ? { ok: true, sent: true } : { ok: true, sent: false, message: MENU_NOT_SENT };
    },
  };

  async function run<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext, control?: InvocationControl): Promise<{ result: ToolResult<N>; trace: SafeTraceInput }> {
    const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(input);
    if (!parsed.success) return { result: fail('VALIDATION_FAILED', 'The arguments do not match the tool.'), trace: { valid: false } };
    const fields = Object.keys(parsed.data as object).sort();
    const traced: SafeTraceInput = { valid: true, fields };
    if (disposed) return { result: fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE), trace: traced };
    // AC-17: a toolset reads only its own business.
    if (ctx.businessId !== businessId) return { result: fail('CAPABILITY_NOT_ALLOWED', 'This toolset belongs to another business.'), trace: traced };
    if (!allowed.has(name)) return { result: fail('CAPABILITY_NOT_ALLOWED', 'This agent version does not have that tool.'), trace: traced };

    const controller = new AbortController();
    invocations.add(controller);
    const abort = () => controller.abort();
    control?.signal.addEventListener('abort', abort, { once: true });
    if (control?.signal.aborted) controller.abort();
    const op: Invocation = { controller };
    const timeoutMs = control?.timeoutMs ?? deps.toolTimeoutMs ?? CAPABILITIES[TOOL_CAPABILITY[name]].timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      if (controller.signal.aborted) resolve('timeout');
      else controller.signal.addEventListener('abort', () => resolve('timeout'), { once: true });
      if (control === undefined) timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, timeoutMs);
    });
    let result: ToolResult<N>;
    try {
      const fn = impl[name] as (input: ToolInput[N], ctx: ToolContext, op: Invocation) => Promise<ToolResult<N>>;
      const work = live(op) ? fn(parsed.data as ToolInput[N], ctx, op) : Promise.resolve(fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE));
      const outcome = await Promise.race([work, deadline]);
      if (outcome === 'timeout') {
        // The abandoned operation can still finish; the shared signal stops it before any state change.
        controller.abort();
        return { result: fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE), trace: traced };
      }
      result = outcome;
    } catch {
      // A port that throws means a provider or the database could not be reached. Never rethrow.
      return { result: fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE), trace: traced };
    } finally {
      clearTimeout(timer);
      control?.signal.removeEventListener('abort', abort);
      invocations.delete(controller);
    }
    // A port that returns a malformed shape is treated as unavailable, so the model never sees it.
    if (!toolResultSchema(name).safeParse(result).success) return { result: fail('INTEGRATION_UNAVAILABLE', UNAVAILABLE), trace: traced };
    return { result, trace: traced };
  }

  async function call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext, control?: InvocationControl): Promise<ToolResult<N>> {
    const started = performance.now();
    const { result, trace } = await run(name, input, ctx, control);
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
      lifetime.abort();
      quotes.clear();
      for (const controller of invocations) controller.abort();
      invocations.clear();
      reservedQuotes.clear();
      traceEntries.length = 0;
    },
  };
}
