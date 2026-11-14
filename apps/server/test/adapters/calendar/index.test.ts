import { sha256Hex } from '@abos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { bookingPropertyValue, createCalendarAdapter, PRIVATE_PROPERTY_MAX_LENGTH } from '../../../src/adapters/calendar';
import type { AvailabilityQuery, FreeBusyResponse, GoogleCalendarClient, GoogleEvent } from '../../../src/adapters/calendar/types';

const query: AvailabilityQuery = {
  calendarId: 'cal', serviceId: 'svc_cut', date: '2026-11-16', timezone: 'America/Los_Angeles',
  hours: { mon: { open: '09:00', close: '17:00' } }, serviceDurationMinutes: 30, bufferMinutes: 15, minNoticeMinutes: 0,
};
const { calendarId: _omit, ...alternativesQuery } = query;
const input = {
  bookingId: `bkg_${'long'.repeat(30)}`, calendarId: 'cal', startUtc: '2026-11-16T17:00:00Z', endUtc: '2026-11-16T17:30:00Z',
  summary: 'Haircut', description: 'Approved booking', alternativesQuery,
};

function notFound(): Error {
  return Object.assign(new Error('Not Found'), { response: { status: 404 } });
}

/** A fake Google Calendar that stores events in memory, keyed by event id. */
function setup() {
  const events = new Map<string, GoogleEvent & { property?: string }>();
  const list = vi.fn<GoogleCalendarClient['events']['list']>(async req => {
    const wanted = req.privateExtendedProperty[0]?.split('=')[1];
    return { data: { items: [...events.values()].filter(e => e.property === wanted && e.status !== 'cancelled') } };
  });
  const get = vi.fn<GoogleCalendarClient['events']['get']>(async req => {
    const event = events.get(req.eventId);
    if (!event) throw notFound();
    return { data: event };
  });
  const insert = vi.fn<GoogleCalendarClient['events']['insert']>(async req => {
    if (events.has(req.requestBody.id)) throw Object.assign(new Error('duplicate'), { response: { status: 409 } });
    const event = { id: req.requestBody.id, htmlLink: 'https://example.test/event', status: 'confirmed', property: req.requestBody.extendedProperties.private.bookingId };
    events.set(event.id, event);
    return { data: { id: event.id, htmlLink: event.htmlLink, status: event.status } };
  });
  const remove = vi.fn<GoogleCalendarClient['events']['delete']>(async req => {
    if (!events.delete(req.eventId)) throw notFound();
  });
  const freebusy = vi.fn<GoogleCalendarClient['freebusy']['query']>(async () => ({ data: { calendars: { cal: { busy: [] } } } }));
  const client: GoogleCalendarClient = { events: { list, get, insert, delete: remove }, freebusy: { query: freebusy } };
  const adapter = createCalendarAdapter({ client, now: () => new Date('2026-11-01T00:00:00Z'), timeoutMs: 50 });
  return { adapter, events, list, get, insert, remove, freebusy };
}

describe('calendar adapter: getAvailability', () => {
  it('queries free/busy for that local day only and returns slots', async () => {
    const s = setup();
    const result = await s.adapter.getAvailability(query);
    expect(result.ok && result.slots.map(x => x.startUtc)).toEqual([
      '2026-11-16T17:00:00.000Z', '2026-11-16T17:15:00.000Z', '2026-11-16T17:30:00.000Z', '2026-11-16T17:45:00.000Z', '2026-11-16T18:00:00.000Z',
    ]);
    expect(s.freebusy.mock.calls[0]![0].requestBody).toEqual({
      timeMin: '2026-11-16T08:00:00.000Z', timeMax: '2026-11-17T08:00:00.000Z', timeZone: 'America/Los_Angeles', items: [{ id: 'cal' }],
    });
  });

  it.each([
    ['2026-03-08', '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z'],
    ['2026-11-01', '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
  ])('requests only the local day on the clock change %s', async (date, timeMin, timeMax) => {
    const s = setup();
    expect((await s.adapter.getAvailability({ ...query, date })).ok).toBe(true);
    expect(s.freebusy.mock.calls[0]![0].requestBody).toMatchObject({ timeMin, timeMax });
  });

  it('rejects bad input as VALIDATION_FAILED without calling Google', async () => {
    const s = setup();
    for (const bad of [
      { ...query, hours: { mon: { open: '22:00', close: '02:00' } } },
      { ...query, serviceDurationMinutes: 0 },
      { ...query, timezone: 'Mars/Olympus' },
      { ...query, date: '2026-02-30' },
      { ...query, maxSlots: 6 },
    ]) expect(await s.adapter.getAvailability(bad)).toEqual({ ok: false, reason: 'VALIDATION_FAILED', retryable: false });
    expect(s.freebusy).not.toHaveBeenCalled();
  });
});

describe('calendar adapter: createEvent', () => {
  it('inserts one event with no attendees, no notifications and the full booking id in the description', async () => {
    const s = setup();
    const result = await s.adapter.createEvent(input);
    expect(result).toEqual({ ok: true, googleEventId: await sha256Hex(input.bookingId), link: 'https://example.test/event' });
    expect(s.insert).toHaveBeenCalledTimes(1);
    const request = s.insert.mock.calls[0]![0];
    expect(request.sendUpdates).toBe('none');
    expect(request.requestBody).not.toHaveProperty('attendees');
    expect(JSON.stringify(request)).not.toMatch(/attendee|email/i);
    expect(request.requestBody.description).toContain(input.bookingId);
    // The event covers the service only, not the buffer.
    expect(request.requestBody.start.dateTime).toBe(input.startUtc);
    expect(request.requestBody.end.dateTime).toBe(input.endUtc);
    // Free/busy is rechecked for exactly the proposed window.
    expect(s.freebusy.mock.calls[0]![0].requestBody).toMatchObject({ timeMin: input.startUtc, timeMax: input.endUtc, items: [{ id: 'cal' }] });
  });

  it('returns the existing event on a repeat and makes no second insert', async () => {
    const s = setup();
    const first = await s.adapter.createEvent(input);
    const second = await s.adapter.createEvent(input);
    expect(second).toEqual(first);
    expect(s.insert).toHaveBeenCalledTimes(1);
    // The retry is decided by the lookup, before any free/busy read.
    expect(s.freebusy).toHaveBeenCalledTimes(1);
    expect(s.list.mock.calls[1]![0].privateExtendedProperty).toEqual([`bookingId=${await bookingPropertyValue(input.bookingId)}`]);
  });

  it('lets the follow-up lookup decide when the insert committed but timed out', async () => {
    const s = setup();
    const realInsert = s.insert.getMockImplementation()!;
    s.insert.mockImplementationOnce(async req => {
      await realInsert(req);
      return new Promise<never>(() => {}); // the response never arrives
    });
    const first = await s.adapter.createEvent(input);
    expect(first).toMatchObject({ ok: true, googleEventId: await sha256Hex(input.bookingId) });
    const retry = await s.adapter.createEvent(input);
    expect(retry).toEqual(first);
    expect(s.insert).toHaveBeenCalledTimes(1);
    expect(s.events.size).toBe(1);
  });

  it('marks an insert whose outcome the follow-up lookup cannot establish as unknown (SPEC 2.9: review, not a blind retry); a later resume inserts once', async () => {
    const s = setup();
    s.insert.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await s.adapter.createEvent(input)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true, outcome: 'unknown' });
    expect((await s.adapter.createEvent(input)).ok).toBe(true);
    expect(s.events.size).toBe(1);
  });

  it('finds the event by its deterministic id when the property search does not see it yet', async () => {
    const s = setup();
    await s.adapter.createEvent(input);
    s.list.mockResolvedValue({ data: { items: [] } });
    expect((await s.adapter.createEvent(input)).ok).toBe(true);
    expect(s.insert).toHaveBeenCalledTimes(1);
  });

  it('treats a 409 on insert as an existing event', async () => {
    const s = setup();
    const id = await sha256Hex(input.bookingId);
    s.events.set(id, { id, status: 'confirmed' }); // exists but has no property and get() misses it the first time
    s.get.mockRejectedValueOnce(notFound());
    expect(await s.adapter.createEvent(input)).toMatchObject({ ok: true, googleEventId: id });
    expect(s.insert).toHaveBeenCalledTimes(1);
  });

  it('uses the step idempotency key as the event id when given', async () => {
    const s = setup();
    const key = 'a'.repeat(64);
    expect(await s.adapter.createEvent({ ...input, idempotencyKey: key })).toMatchObject({ ok: true, googleEventId: key });
    expect(await s.adapter.createEvent({ ...input, idempotencyKey: 'NOT-HEX' })).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
  });

  it.each([1, 5, 40, 44, 45, 100, 500])('stores a private property value of at most 44 characters for a %i character booking suffix', async length => {
    const s = setup();
    const bookingId = `bkg_${'x'.repeat(length)}`;
    const result = await s.adapter.createEvent({ ...input, bookingId });
    expect(result.ok).toBe(true);
    const props = s.insert.mock.calls[0]![0].requestBody.extendedProperties.private;
    for (const [key, value] of Object.entries(props)) {
      expect(key.length).toBeLessThanOrEqual(PRIVATE_PROPERTY_MAX_LENGTH);
      expect(value.length).toBeLessThanOrEqual(PRIVATE_PROPERTY_MAX_LENGTH);
    }
    expect(s.insert.mock.calls[0]![0].requestBody.description).toContain(bookingId);
  });

  it('gives SLOT_CONFLICT with up to 3 alternatives and no insert when the window is taken', async () => {
    const s = setup();
    s.freebusy.mockImplementation(async req => ({
      data: { calendars: { cal: { busy: req.requestBody.timeMin === input.startUtc ? [{ start: input.startUtc, end: input.endUtc }] : [{ start: '2026-11-16T17:00:00Z', end: '2026-11-16T17:30:00Z' }] } } },
    }));
    const result = await s.adapter.createEvent(input);
    expect(result).toMatchObject({ ok: false, reason: 'SLOT_CONFLICT', retryable: false });
    if (result.ok) throw new Error('expected a conflict');
    expect(result.alternatives?.map(a => a.startUtc)).toEqual(['2026-11-16T17:30:00.000Z', '2026-11-16T17:45:00.000Z', '2026-11-16T18:00:00.000Z']);
    expect(s.insert).not.toHaveBeenCalled();
  });

  it('detects a partly overlapping busy block as a conflict', async () => {
    const s = setup();
    s.freebusy.mockResolvedValue({ data: { calendars: { cal: { busy: [{ start: '2026-11-16T17:20:00Z', end: '2026-11-16T17:40:00Z' }] } } } });
    expect(await s.adapter.createEvent(input)).toMatchObject({ ok: false, reason: 'SLOT_CONFLICT' });
    expect(s.insert).not.toHaveBeenCalled();
  });

  it('still reports the conflict, with no alternatives, when the alternatives lookup fails or has no facts', async () => {
    const s = setup();
    s.freebusy.mockResolvedValueOnce({ data: { calendars: { cal: { busy: [{ start: input.startUtc, end: input.endUtc }] } } } });
    s.freebusy.mockRejectedValueOnce(new Error('timeout'));
    expect(await s.adapter.createEvent(input)).toEqual({ ok: false, reason: 'SLOT_CONFLICT', retryable: false, alternatives: [] });
    const { alternativesQuery: _a, ...bare } = input;
    s.freebusy.mockResolvedValueOnce({ data: { calendars: { cal: { busy: [{ start: input.startUtc, end: input.endUtc }] } } } });
    expect(await s.adapter.createEvent(bare)).toEqual({ ok: false, reason: 'SLOT_CONFLICT', retryable: false, alternatives: [] });
    expect(s.insert).not.toHaveBeenCalled();
  });

  it('fails closed on per-calendar errors and missing calendars', async () => {
    const s = setup();
    const cases: FreeBusyResponse['data'][] = [{ calendars: {} }, { calendars: null }, { calendars: { cal: { errors: [{ reason: 'notFound' }] } } }];
    for (const data of cases) {
      s.freebusy.mockResolvedValueOnce({ data });
      expect(await s.adapter.createEvent(input)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
    }
    expect(s.insert).not.toHaveBeenCalled();
  });

  it('rejects invalid input without calling Google', async () => {
    const s = setup();
    for (const bad of [{ ...input, bookingId: 'ord_1' }, { ...input, endUtc: input.startUtc }, { ...input, startUtc: 'tomorrow' }]) {
      expect(await s.adapter.createEvent(bad)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED', retryable: false });
    }
    expect(s.list).not.toHaveBeenCalled();
  });
});

describe('calendar adapter: deleteEventForBooking', () => {
  it('deletes the booking event and reports when there was none', async () => {
    const s = setup();
    expect(await s.adapter.deleteEventForBooking(input.bookingId, 'cal')).toEqual({ ok: true, deleted: false });
    await s.adapter.createEvent(input);
    expect(await s.adapter.deleteEventForBooking(input.bookingId, 'cal')).toEqual({ ok: true, deleted: true });
    expect(s.remove).toHaveBeenCalledTimes(1);
    expect(s.remove.mock.calls[0]![0].sendUpdates).toBe('none');
    expect(s.events.size).toBe(0);
  });
});

describe('calendar adapter: provider failures', () => {
  it('maps provider errors and timeouts to a retryable failure without leaking their text', async () => {
    const s = setup();
    s.list.mockRejectedValue(new Error('token secret timeout'));
    expect(await s.adapter.createEvent(input)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
    expect(await s.adapter.deleteEventForBooking(input.bookingId, 'cal')).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
    s.freebusy.mockRejectedValue(new Error('boom'));
    expect(await s.adapter.getAvailability(query)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
    s.freebusy.mockImplementation(() => new Promise<never>(() => {}));
    expect(await s.adapter.getAvailability(query)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
  });

  it('maps a non-404 lookup error to a retryable failure and inserts nothing', async () => {
    const s = setup();
    s.get.mockRejectedValue(Object.assign(new Error('forbidden'), { response: { status: 403 } }));
    expect(await s.adapter.createEvent(input)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
    expect(s.insert).not.toHaveBeenCalled();
  });
});
