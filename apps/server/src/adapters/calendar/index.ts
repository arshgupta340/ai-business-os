import {
  BookingIdSchema,
  ERROR_CODE_INFO,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  SLOT_CONFLICT_MAX_ALTERNATIVES,
  sha256Hex,
  type AvailabilitySlot,
} from '@abos/contracts';
import { computeSlots, dayWindow, validateQuery } from './slots';
import type {
  AdapterFailure,
  AvailabilityQuery,
  BusyBlock,
  CalendarAdapter,
  CalendarDependencies,
  CreateEventInput,
  EventReference,
  GoogleEvent,
} from './types';

export type * from './types';
export { computeSlots, dayWindow } from './slots';

/** Key of the private extended property that holds the booking key. */
export const BOOKING_PROPERTY_KEY = 'bookingId';
/** Google silently drops a private extended property value over 44 characters. */
export const PRIVATE_PROPERTY_MAX_LENGTH = 44;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * A fixed-length key for the private extended property: the first 44 hex
 * characters of sha256(bookingId). Always exactly 44 characters, for any
 * booking id length. The full booking id goes in the event description.
 */
export async function bookingPropertyValue(bookingId: string): Promise<string> {
  return (await sha256Hex(bookingId)).slice(0, PRIVATE_PROPERTY_MAX_LENGTH);
}

function unavailable(): AdapterFailure {
  return { ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: ERROR_CODE_INFO.INTEGRATION_UNAVAILABLE.retryable };
}
function invalid(): AdapterFailure {
  return { ok: false, reason: 'VALIDATION_FAILED', retryable: ERROR_CODE_INFO.VALIDATION_FAILED.retryable };
}
function conflict(alternatives: AvailabilitySlot[]): AdapterFailure {
  return { ok: false, reason: 'SLOT_CONFLICT', retryable: ERROR_CODE_INFO.SLOT_CONFLICT.retryable, alternatives };
}

/** HTTP status of a Google (gaxios) error, without reading its message. */
function providerStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e.response?.status, e.status, e.code]) if (typeof v === 'number') return v;
  return undefined;
}

class ProviderTimeout extends Error {
  override name = 'ProviderTimeout';
}

/** Rejects when the call takes longer than `ms`. The provider call itself may still complete. */
async function withTimeout<T>(ms: number, call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderTimeout()), ms); });
  try { return await Promise.race([call(), timeout]); }
  finally { clearTimeout(timer); }
}

function toReference(event: GoogleEvent): EventReference {
  if (!event.id) throw new Error('Missing provider event id');
  return { googleEventId: event.id, ...(event.htmlLink ? { link: event.htmlLink } : {}) };
}

/**
 * Google Calendar adapter. Write methods are for the approved executor and
 * operator cleanup only: the executor checks the owner's approval and holds the
 * per-calendar local slot lock (RECHECKING_SLOT) before it calls createEvent.
 * Every provider error or timeout becomes a typed failure; nothing raw is thrown.
 */
export function createCalendarAdapter(deps: CalendarDependencies): CalendarAdapter {
  const { client } = deps;
  const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function busy(calendarId: string, timeMin: string, timeMax: string, timeZone?: string): Promise<BusyBlock[]> {
    const response = await withTimeout(ms, () => client.freebusy.query({
      requestBody: { timeMin, timeMax, ...(timeZone ? { timeZone } : {}), items: [{ id: calendarId }] },
    }));
    const entry = response.data.calendars?.[calendarId];
    // A missing entry or a per-calendar error means we do not know the calendar is free.
    if (!entry || entry.errors?.length || !Array.isArray(entry.busy)) throw new Error('Free/busy unavailable');
    return entry.busy.map(block => {
      if (!block.start || !block.end) throw new Error('Invalid free/busy block');
      const start = Date.parse(block.start), end = Date.parse(block.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid free/busy block');
      return { start: block.start, end: block.end };
    });
  }

  /** Live events carrying this booking's key in their private extended properties. */
  async function findByProperty(bookingId: string, calendarId: string): Promise<GoogleEvent[]> {
    const value = await bookingPropertyValue(bookingId);
    const events: GoogleEvent[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      if (pageToken) {
        if (seen.has(pageToken)) throw new Error('Repeated event page');
        seen.add(pageToken);
      }
      const token = pageToken;
      const response = await withTimeout(ms, () => client.events.list({
        calendarId,
        privateExtendedProperty: [`${BOOKING_PROPERTY_KEY}=${value}`],
        showDeleted: false,
        singleEvents: true,
        ...(token ? { pageToken: token } : {}),
      }));
      events.push(...(response.data.items ?? []).filter(e => e.status !== 'cancelled'));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return events;
  }

  /** Reads the event by its deterministic id. 404 or 410 means there is none. */
  async function findById(calendarId: string, eventId: string): Promise<GoogleEvent | undefined> {
    try {
      const response = await withTimeout(ms, () => client.events.get({ calendarId, eventId }));
      return response.data.status === 'cancelled' ? undefined : response.data;
    } catch (error) {
      const status = providerStatus(error);
      if (status === 404 || status === 410) return undefined;
      throw error;
    }
  }

  /**
   * The lookup that decides whether this booking already has an event: first the
   * private property (FLOWS C8), then the deterministic event id, which also
   * covers an insert whose response was lost before the property search sees it.
   */
  async function findExisting(bookingId: string, calendarId: string, eventId: string): Promise<GoogleEvent | undefined> {
    return (await findByProperty(bookingId, calendarId))[0] ?? (await findById(calendarId, eventId));
  }

  async function alternatives(input: CreateEventInput): Promise<AvailabilitySlot[]> {
    if (!input.alternativesQuery) return [];
    try {
      const query: AvailabilityQuery = { ...input.alternativesQuery, calendarId: input.calendarId };
      validateQuery(query);
      const window = dayWindow(query.date, query.timezone);
      const blocks = await busy(query.calendarId, window.startUtc, window.endUtc, query.timezone);
      return computeSlots(query, blocks, deps.now()).slice(0, SLOT_CONFLICT_MAX_ALTERNATIVES);
    } catch {
      // The conflict is certain; alternatives are a courtesy. Return none rather than hide the conflict.
      return [];
    }
  }

  return {
    async getAvailability(input) {
      let window: { startUtc: string; endUtc: string };
      try {
        validateQuery(input);
        window = dayWindow(input.date, input.timezone);
      } catch { return invalid(); }
      let blocks: BusyBlock[];
      // Free/busy for that local day only.
      try { blocks = await busy(input.calendarId, window.startUtc, window.endUtc, input.timezone); }
      catch { return unavailable(); }
      try { return { ok: true, slots: computeSlots(input, blocks, deps.now()) }; }
      catch { return invalid(); }
    },

    async createEvent(input) {
      if (
        !BookingIdSchema.safeParse(input.bookingId).success
        || !input.calendarId.trim()
        || !IsoDateTimeSchema.safeParse(input.startUtc).success
        || !IsoDateTimeSchema.safeParse(input.endUtc).success
        || Date.parse(input.endUtc) <= Date.parse(input.startUtc)
        || (input.idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(input.idempotencyKey).success)
      ) return invalid();

      try {
        // Lowercase hex fits Google's base32hex event id rule (CONTRACTS 5).
        const eventId = input.idempotencyKey ?? await sha256Hex(input.bookingId);

        // 1. A retry finds the event from an earlier attempt and inserts nothing.
        const existing = await findExisting(input.bookingId, input.calendarId, eventId);
        if (existing) return { ok: true, ...toReference(existing) };

        // 2. Recheck free/busy for exactly the service window. The buffer is not part of the event.
        const blocks = await busy(input.calendarId, input.startUtc, input.endUtc);
        const start = Date.parse(input.startUtc), end = Date.parse(input.endUtc);
        if (blocks.some(b => Date.parse(b.start) < end && start < Date.parse(b.end))) return conflict(await alternatives(input));

        // 3. One insert: no attendees, no notifications.
        const propertyValue = await bookingPropertyValue(input.bookingId);
        try {
          const response = await withTimeout(ms, () => client.events.insert({
            calendarId: input.calendarId,
            sendUpdates: 'none',
            requestBody: {
              id: eventId,
              summary: input.summary,
              description: `${input.description}\nBooking ID: ${input.bookingId}`,
              start: { dateTime: input.startUtc },
              end: { dateTime: input.endUtc },
              transparency: 'opaque',
              extendedProperties: { private: { [BOOKING_PROPERTY_KEY]: propertyValue } },
            },
          }));
          return { ok: true, ...toReference(response.data) };
        } catch {
          // Error, timeout, 409 (id exists) or a malformed response: the outcome
          // is unknown, so the follow-up lookup decides. Never insert again here.
          const recovered = await findExisting(input.bookingId, input.calendarId, eventId);
          return recovered ? { ok: true, ...toReference(recovered) } : unavailable();
        }
      } catch { return unavailable(); }
    },

    async deleteEventForBooking(bookingId, calendarId) {
      if (!BookingIdSchema.safeParse(bookingId).success || !calendarId.trim()) return invalid();
      try {
        const eventId = await sha256Hex(bookingId);
        const events = await findByProperty(bookingId, calendarId);
        const byId = events.some(e => e.id === eventId) ? undefined : await findById(calendarId, eventId);
        const all = byId ? [...events, byId] : events;
        for (const event of all) {
          const id = event.id;
          if (!id) throw new Error('Missing provider event id');
          try { await withTimeout(ms, () => client.events.delete({ calendarId, eventId: id, sendUpdates: 'none' })); }
          catch (error) {
            const status = providerStatus(error);
            if (status !== 404 && status !== 410) throw error;
          }
        }
        return { ok: true, deleted: all.length > 0 };
      } catch { return unavailable(); }
    },
  };
}
