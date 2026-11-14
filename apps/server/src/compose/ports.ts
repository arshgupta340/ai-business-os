// The ports each piece declared, implemented by connecting the pieces to the database, the
// approval engine and the provider adapters. Every query runs as abos_app. None of these ports
// performs an external write: quotes and availability are provider reads, and proposals only
// store a subject and open an approval request.
import {
  SLOT_CONFLICT_MAX_ALTERNATIVES, AgentSpecSchema, HoursKeySchema, OrderStatusSchema, HoursValueSchema, ReadableFactKindSchema, ServiceOfferingSchema, ToolFailureReasonSchema,
  type AvailabilitySlot, type CallEndReason, type CallStage, type CallStatus, type CatalogItem, type HoursKey, type HoursValue,
  type JsonValue, type ServiceOffering, type ToolFailureReason,
} from '@abos/contracts';
import type { Db, QueryDb } from '../db/index';
import { AppError } from '../errors';
import { mapRow } from '../api/rows';
import { emitActivity } from '../policy/activity';
import type { PolicyEngine } from '../policy/engine';
import { PolicyError } from '../policy/types';
import type { AvailabilityPort, CatalogPort, FactsPort, FactsSnapshot, OrderStatusPort, ProposalPort, QuotePort } from '../tools/real/types';
import type { CallsPort, LiveAgentPort, LiveAgentResolution, VoiceEventsPort } from '../voice/types';
import { initialStage } from '../voice/relay';
import { computeSlots, dayWindow, weekdayOf } from '../adapters/calendar/slots';
import type { Providers } from './providers';

type Row = Record<string, unknown>;
const rows = async (db: QueryDb, text: string, params: unknown[]) => (await db.query(text, params)).rows as Row[];

// ---------- catalog cache (P-10) ----------

/** Groups `catalog_items` rows (one per variation) into items with a `variations` array (SPEC 2.9). */
export function groupCatalog(businessId: string, raw: Row[]): CatalogItem[] {
  const grouped = new Map<string, CatalogItem>();
  for (const row of raw.map(mapRow)) {
    const id = String(row.squareItemId);
    const variation = { id: String(row.squareVariationId), name: String(row.variationName), priceMinor: Number(row.priceMinor), currency: 'USD' as const };
    const existing = grouped.get(id);
    if (existing) {
      existing.variations.push(variation);
      existing.available ||= row.isAvailable === true;
      if (String(row.syncedAt) > existing.syncedAt) existing.syncedAt = String(row.syncedAt);
    } else {
      grouped.set(id, { squareItemId: id, businessId, name: String(row.itemName),
        ...(row.description === undefined ? {} : { description: String(row.description) }), available: row.isAvailable === true,
        variations: [variation], modifierLists: (row.modifierLists ?? []) as CatalogItem['modifierLists'], syncedAt: String(row.syncedAt) });
    }
  }
  return [...grouped.values()];
}

export function dbCatalogPort(db: Db): CatalogPort {
  return {
    async search({ businessId, query, limit }) {
      const items = groupCatalog(businessId, await rows(db, 'select * from public.catalog_items where business_id = $1 order by item_name, price_minor, square_variation_id', [businessId]));
      const words = (query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      // Caller text is only ever a search string (AGENTS rule 7).
      const score = (item: CatalogItem) => words.filter((w) => item.name.toLowerCase().includes(w) || item.variations.some((v) => v.name.toLowerCase().includes(w))).length;
      const ranked = words.length === 0 ? items : items.map((item) => ({ item, s: score(item) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.item);
      return ranked.slice(0, limit);
    },
  };
}

// ---------- verified facts ----------

export function dbFactsPort(db: Db): FactsPort {
  return {
    async readVerified({ businessId }) {
      const business = (await rows(db, 'select timezone from public.businesses where id = $1', [businessId]))[0];
      if (!business) throw new AppError('NOT_FOUND', 'Business was not found.');
      const facts = await rows(db, `select kind, key, value, version from public.business_facts
        where business_id = $1 and status = 'verified' and kind <> 'menu_item' order by kind, key`, [businessId]);
      return {
        timezone: String(business.timezone),
        facts: facts.map((f) => ({ kind: ReadableFactKindSchema.parse(f.kind), key: String(f.key), value: f.value as JsonValue, version: Number(f.version) })),
      };
    },
  };
}

// ---------- booking context: service, hours, notice, calendar ----------

type BookingContext = { service: ServiceOffering; timezone: string; hours: Partial<Record<HoursKey, HoursValue>>; minNoticeMinutes: number; calendarId: string };

/** The call's pinned facts. Booking ports read service, hours, notice and timezone only from here (AC-16). */
export type PinnedFacts = (businessId: string) => Promise<FactsSnapshot>;

function bookingContext(s: FactsSnapshot, businessId: string, serviceId: string, calendarId: string | undefined): BookingContext | null {
  const service = s.facts.filter((f) => f.kind === 'service').map((f) => ServiceOfferingSchema.safeParse(f.value)).flatMap((p) => p.success ? [p.data] : [])
    .find((x) => x.id === serviceId && x.businessId === businessId);
  if (!service) return null;
  if (!calendarId) throw new AppError('INTEGRATION_UNAVAILABLE', 'Google Calendar is not configured.', undefined, undefined, { provider: 'google_calendar' });
  const hours: Partial<Record<HoursKey, HoursValue>> = {};
  for (const f of s.facts) {
    if (f.kind !== 'hours') continue;
    const key = HoursKeySchema.safeParse(f.key);
    const value = HoursValueSchema.safeParse(f.value);
    if (key.success && value.success) hours[key.data] = value.data;
  }
  const notice = s.facts.find((f) => f.kind === 'policy' && f.key === 'min_notice')?.value;
  const minNoticeMinutes = notice && typeof notice === 'object' && !Array.isArray(notice) && typeof notice.minutes === 'number' ? notice.minutes : 0;
  return { service, timezone: s.timezone, hours, minNoticeMinutes, calendarId };
}

function localDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function localTime(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  return `${parts.find((p) => p.type === 'hour')?.value ?? '00'}:${parts.find((p) => p.type === 'minute')?.value ?? '00'}`;
}

/**
 * The exact-slot recheck (FLOWS C5, review finding 3). First the local rules from the pinned facts: the
 * start is on the grid, inside the hours, past the notice, and the whole service fits. Then free/busy
 * for exactly that occupied interval (service plus buffer): the adapter is asked for one slot with the
 * hours of that day narrowed to the requested service window, so only the requested start can come back.
 */
export async function slotIsFree(providers: Providers, ctx: BookingContext, startMs: number, now: Date): Promise<'free' | 'taken' | 'invalid' | 'unavailable'> {
  if (!providers.calendar) return 'unavailable';
  const date = localDate(new Date(startMs).toISOString(), ctx.timezone);
  const query = { calendarId: ctx.calendarId, timezone: ctx.timezone, serviceId: ctx.service.id, date, hours: ctx.hours,
    serviceDurationMinutes: ctx.service.durationMinutes, bufferMinutes: ctx.service.bufferMinutes ?? 0, minNoticeMinutes: ctx.minNoticeMinutes, maxSlots: 1 };
  try {
    // Local rules, with no provider call: everything before the requested start counts as busy.
    const dayStart = Date.parse(dayWindow(date, ctx.timezone).startUtc);
    const first = computeSlots(query, startMs > dayStart ? [{ start: new Date(dayStart).toISOString(), end: new Date(startMs).toISOString() }] : [], now)[0];
    if (!first || Date.parse(first.startUtc) !== startMs) return 'invalid';
  } catch { return 'invalid'; }
  const end = startMs + ctx.service.durationMinutes * 60_000;
  const narrowed = { ...query, hours: { [weekdayOf(date)]: { open: localTime(startMs, ctx.timezone), close: localTime(end, ctx.timezone) } } };
  const r = await providers.calendar.getAvailability(narrowed);
  if (!r.ok) return 'unavailable';
  return r.slots.some((s) => Date.parse(s.startUtc) === startMs) ? 'free' : 'taken';
}

export function calendarAvailabilityPort(providers: Providers, pinned: PinnedFacts): AvailabilityPort {
  return {
    // The toolset passes the pinned service, that date's pinned hours and the time zone; the minimum
    // notice comes from the same pinned snapshot. No fact is read again.
    async freeSlots({ businessId, service, date, hours, timezone, maxSlots }) {
      if (!providers.calendar || !providers.calendarId) throw new AppError('INTEGRATION_UNAVAILABLE', 'Google Calendar is not configured.', undefined, undefined, { provider: 'google_calendar' });
      const ctx = bookingContext(await pinned(businessId), businessId, service.id, providers.calendarId);
      const r = await providers.calendar.getAvailability({ calendarId: providers.calendarId, timezone, serviceId: service.id, date, hours: { [weekdayOf(date)]: hours },
        serviceDurationMinutes: service.durationMinutes, bufferMinutes: service.bufferMinutes ?? 0, minNoticeMinutes: ctx?.minNoticeMinutes ?? 0, maxSlots });
      if (!r.ok) throw new AppError('INTEGRATION_UNAVAILABLE', 'Google Calendar free/busy failed.', undefined, undefined, { provider: 'google_calendar' });
      return r.slots;
    },
  };
}

// ---------- quotes (P-02) ----------

export function squareQuotePort(db: Db, providers: Providers): QuotePort {
  return {
    async quote({ businessId, cart }) {
      if (!providers.square) throw new AppError('INTEGRATION_UNAVAILABLE', 'Square is not configured.', undefined, undefined, { provider: 'square' });
      const r = await providers.square.quote(db, businessId, cart);
      if (r.ok) return r;
      if (r.code === 'ITEM_UNAVAILABLE') return { ok: false, reason: 'ITEM_UNAVAILABLE', message: r.message };
      // Anything else means Square could not price the cart. The toolset reports it as unavailable.
      throw new AppError('INTEGRATION_UNAVAILABLE', 'Square could not price the order.', undefined, undefined, { provider: 'square' });
    },
  };
}

// ---------- proposals: the real toolset's port onto the approval engine ----------

function toolReason(error: unknown): ToolFailureReason {
  const code = error instanceof PolicyError || error instanceof AppError ? error.code : undefined;
  const parsed = ToolFailureReasonSchema.safeParse(code);
  if (parsed.success) return parsed.data;
  if (code === 'FORBIDDEN_BUSINESS') return 'CAPABILITY_NOT_ALLOWED';
  if (code === 'INVALID_STATE') return 'VALIDATION_FAILED';
  return 'INTEGRATION_UNAVAILABLE';
}

/**
 * Results by operation ID, so a retry of one operation returns its stored result instead of a second
 * proposal. INTEGRATION GAP (voice NOTES 1 and 2): this is per process. Cross-process uniqueness needs a
 * routine with a unique (business_id, call_id, operation_id), which 0005 does not have. Within one
 * process the engine's own replay (same call and cart returns the stored pending proposal) also holds.
 */
const OPERATION_MEMORY = 500;
function operationMemo() {
  const done = new Map<string, Promise<unknown>>();
  return <T>(input: { businessId: string; callId?: string | undefined; operationId: string }, run: () => Promise<T>): Promise<T> => {
    const key = `${input.businessId}:${input.callId ?? ''}:${input.operationId}`;
    const existing = done.get(key);
    if (existing) return existing as Promise<T>;
    const result = run();
    done.set(key, result);
    if (done.size > OPERATION_MEMORY) done.delete(done.keys().next().value as string);
    return result;
  };
}

export function engineProposalPort(engine: PolicyEngine, pinned: PinnedFacts, providers: Providers, now: () => Date = () => new Date()): ProposalPort {
  const once = operationMemo();
  return {
    // One engine transaction stores the subject and its approval together, and refuses unless the call
    // is this business's IN_PROGRESS call on this agent version (policy/engine.ts assertCall).
    atomicOperations: true,
    createOrderProposal: (input) => input.signal.aborted ? Promise.resolve({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' }) : once(input, () => createOrder(input)),
    createBookingProposal: (input) => input.signal.aborted ? Promise.resolve({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' }) : once(input, () => createBooking(input)),
  };
  async function createOrder(input: Parameters<ProposalPort['createOrderProposal']>[0]): ReturnType<ProposalPort['createOrderProposal']> {
    {
      try {
        const { order, approval } = await engine.createOrderProposal({
          businessId: input.businessId, callId: input.callId ?? '', agentVersionId: input.agentVersionId,
          cart: input.cart, quote: input.quote, contact: input.contact, fulfillment: input.fulfillment, messageChannel: input.messageChannel,
        });
        return { ok: true, orderId: order.id, approvalId: approval.id };
      } catch (error) {
        return { ok: false, reason: toolReason(error) };
      }
    }
  }
  async function createBooking(input: Parameters<ProposalPort['createBookingProposal']>[0]): ReturnType<ProposalPort['createBookingProposal']> {
    {
      try {
        const ctx = bookingContext(await pinned(input.businessId), input.businessId, input.serviceId, providers.calendarId);
        if (!ctx) return { ok: false, reason: 'NOT_FOUND', message: 'No such service.' };
        if (!providers.calendar) return { ok: false, reason: 'INTEGRATION_UNAVAILABLE' };
        const start = Date.parse(input.startUtc);
        const slot: AvailabilitySlot = { serviceId: ctx.service.id, startUtc: new Date(start).toISOString(),
          endUtc: new Date(start + ctx.service.durationMinutes * 60_000).toISOString(), timezone: ctx.timezone };
        // Re-check exactly this slot before it is proposed (FLOWS C5). The insert re-checks again after approval.
        const check = await slotIsFree(providers, ctx, start, now());
        if (check === 'unavailable') return { ok: false, reason: 'INTEGRATION_UNAVAILABLE' };
        if (check === 'invalid') return { ok: false, reason: 'VALIDATION_FAILED', message: 'That time is not a bookable slot.' };
        if (check === 'taken') {
          // Only on a conflict: the capped list of alternatives for that day.
          const alt = await providers.calendar.getAvailability({ calendarId: ctx.calendarId, timezone: ctx.timezone, serviceId: ctx.service.id,
            date: localDate(slot.startUtc, ctx.timezone), hours: ctx.hours, serviceDurationMinutes: ctx.service.durationMinutes,
            bufferMinutes: ctx.service.bufferMinutes ?? 0, minNoticeMinutes: ctx.minNoticeMinutes, maxSlots: SLOT_CONFLICT_MAX_ALTERNATIVES });
          return { ok: false, reason: 'SLOT_CONFLICT', alternatives: alt.ok ? alt.slots.slice(0, SLOT_CONFLICT_MAX_ALTERNATIVES) : [] };
        }
        const { booking, approval } = await engine.createBookingProposal({
          businessId: input.businessId, callId: input.callId, agentVersionId: input.agentVersionId, serviceId: ctx.service.id,
          serviceName: ctx.service.name, startUtc: slot.startUtc, endUtc: slot.endUtc, timezone: ctx.timezone, calendarId: ctx.calendarId,
          customer: input.customer, messageChannel: input.messageChannel,
        });
        return { ok: true, bookingId: booking.id, approvalId: approval.id, slot };
      } catch (error) {
        return { ok: false, reason: toolReason(error) };
      }
    }
  }
}

// ---------- order status ----------

export function dbOrderStatusPort(db: Db): OrderStatusPort {
  return {
    async read({ businessId, orderId, callId }) {
      // Scoped by business and, when given, by call in the query itself (voice NOTES 6).
      const order = (await rows(db, `select id, business_id, status, call_id from public.orders where id = $1 and business_id = $2 and ($3::text is null or call_id = $3)`,
        [orderId, businessId, callId ?? null]))[0];
      if (!order || order.business_id !== businessId || (callId !== undefined && order.call_id !== callId)) return null;
      const sent = await rows(db, `select 1 from public.message_dispatches where business_id = $1 and order_id = $2 and status in ('SENT','DELIVERED') limit 1`, [businessId, orderId]);
      const status = OrderStatusSchema.parse(order.status);
      return { businessId, callId: String(order.call_id), orderId, status, paid: status === 'PAID_VERIFIED' || status === 'FULFILLMENT_READY', checkoutLinkSent: sent.length > 0 };
    },
  };
}

// ---------- live agent and calls (voice worker and sim-call) ----------

export function dbLiveAgentPort(db: Db): LiveAgentPort {
  return {
    async resolve(phoneNumber): Promise<LiveAgentResolution> {
      const row = (await rows(db, `select l.business_id, l.agent_id, l.agent_version_id, a.state, v.spec, b.name as business_name
        from public.live_agent l join public.businesses b on b.id = l.business_id
        left join public.agents a on a.id = l.agent_id left join public.agent_versions v on v.id = l.agent_version_id
        where l.phone_number = $1`, [phoneNumber]))[0];
      if (!row || typeof row.agent_id !== 'string' || typeof row.agent_version_id !== 'string') return { state: 'none' };
      // The identity lets the voice webhook record the refused call as started and ended (API.md 4).
      if (row.state !== 'live') return { state: 'paused', businessId: String(row.business_id), agentId: row.agent_id, agentVersionId: row.agent_version_id };
      const spec = AgentSpecSchema.safeParse(row.spec);
      if (!spec.success) return { state: 'none' };
      return { state: 'live', businessId: String(row.business_id), businessName: String(row.business_name), agentId: row.agent_id, agentVersionId: row.agent_version_id, spec: spec.data };
    },
  };
}

const STATUS_FOR_REASON: Record<CallEndReason, Exclude<CallStatus, 'IN_PROGRESS'>> = { completed: 'COMPLETED', dropped: 'DROPPED', failed: 'FAILED' };

export interface CallsStore extends CallsPort {
  /** A simulated call (P-18): channel test_console, no provider call ID. */
  startSimulatedCall(input: { businessId: string; agentId: string; agentVersionId: string }): Promise<{ callId: string }>;
}

export function dbCallsPort(db: Db, newId: (prefix: string) => string): CallsStore {
  async function start(tx: QueryDb, input: { businessId: string; agentId: string; agentVersionId: string; providerCallId?: string; callerLast4?: string | undefined }) {
    const agent = (await rows(tx, 'select template from public.agents where id = $1 and business_id = $2', [input.agentId, input.businessId]))[0];
    if (!agent) throw new AppError('NOT_FOUND', 'Agent was not found.');
    const stage = initialStage(agent.template as Parameters<typeof initialStage>[0]);
    const channel = input.providerCallId ? 'phone' : 'test_console';
    const id = newId('call_');
    const inserted = await rows(tx, `insert into public.calls (id, business_id, agent_id, agent_version_id, channel, provider_call_id, caller_last4, stage)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (provider_call_id) do nothing returning id, started_at`,
    [id, input.businessId, input.agentId, input.agentVersionId, channel, input.providerCallId ?? null, input.callerLast4 ?? null, stage]);
    // A second delivery of the same CallSid (another process) must not open a second call or credential
    // (voice NOTES 4): the webhook answers with the setup-failed message instead.
    if (!inserted[0]) throw new AppError('INVALID_STATE', 'Call was already started.');
    const at = inserted[0].started_at instanceof Date ? inserted[0].started_at : new Date();
    await emitActivity(tx, { id: newId('evt_'), businessId: input.businessId, correlationId: id, type: 'call.started', actorType: 'system', occurredAt: at.toISOString(),
      payload: { callId: id, agentId: input.agentId, agentVersionId: input.agentVersionId, channel, ...(input.callerLast4 ? { callerLast4: input.callerLast4 } : {}) } });
    return { callId: id };
  }
  return {
    async findByProviderCallId(providerCallId) {
      const row = (await rows(db, 'select id, status from public.calls where provider_call_id = $1', [providerCallId]))[0];
      return row ? { callId: String(row.id), status: String(row.status) as CallStatus } : null;
    },
    startCall: (input) => db.transaction((tx) => start(tx, input)),
    startSimulatedCall: (input) => db.transaction((tx) => start(tx, input)),
    async getStatus(callId) {
      const row = (await rows(db, 'select status from public.calls where id = $1', [callId]))[0];
      return row ? (String(row.status) as CallStatus) : null;
    },
    async updateStage(callId, stage: CallStage) {
      await db.query("update public.calls set stage = $2 where id = $1 and status = 'IN_PROGRESS'", [callId, stage]);
    },
    async endCall(callId, reason) {
      await db.transaction(async (tx) => {
        // Only the first end writes the row and the event, whichever path ends the call first.
        const ended = (await rows(tx, `update public.calls set status = $2, end_reason = $3, ended_at = greatest(now(), started_at)
          where id = $1 and status = 'IN_PROGRESS' returning business_id, started_at, ended_at`, [callId, STATUS_FOR_REASON[reason], reason]))[0];
        if (!ended) return;
        const started = ended.started_at as Date;
        const end = ended.ended_at as Date;
        await emitActivity(tx, { id: newId('evt_'), businessId: String(ended.business_id), correlationId: callId, type: 'call.ended', actorType: 'system', occurredAt: end.toISOString(),
          payload: { callId, status: STATUS_FOR_REASON[reason], reason, durationSec: Math.max(0, Math.round((end.getTime() - started.getTime()) / 1000)) } });
      });
    },
  };
}

/** webhook.rejected and guardrail.refused from the voice worker. Payloads are fixed codes. */
export function dbVoiceEventsPort(db: Db, newId: (prefix: string) => string, now: () => Date, twilioNumber?: string): VoiceEventsPort {
  // SPEC 2.9: a rejected webhook is written against the business that owns the integration the URL
  // belongs to. The voice webhook belongs to the Twilio number, so its owner is that number's business.
  const twilioOwner = async () => twilioNumber
    ? ((await rows(db, 'select business_id from public.live_agent where phone_number = $1', [twilioNumber]))[0]?.business_id as string | undefined)
    : undefined;
  const write = (businessId: string, type: 'webhook.rejected' | 'guardrail.refused', payload: unknown, correlationId: string) =>
    emitActivity(db, { id: newId('evt_'), businessId, correlationId, type, actorType: type === 'webhook.rejected' ? 'provider' : 'system', occurredAt: now().toISOString(), payload });
  return {
    async webhookRejected({ businessId, payload }) {
      const owner = businessId ?? await twilioOwner();
      if (owner) await write(owner, 'webhook.rejected', payload, newId('req_'));
    },
    async guardrailRefused({ businessId, payload }) { await write(businessId, 'guardrail.refused', payload, payload.callId ?? newId('req_')); },
  };
}
