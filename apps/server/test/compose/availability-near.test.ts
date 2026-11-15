// The `near` lookup of read_calendar_availability, through the real pieces: the real toolset, the
// availability port and the real Calendar adapter over a fake Google client. On 2026-11-15 the toolset asked
// the adapter for a whole day of slots and the adapter refused anything above 5, so every booking call that
// named a time failed before Google was asked. The mock toolset has no such limit, so no test saw it.
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@abos/contracts';
import { barberFacts, serviceHaircut } from '@abos/contracts/fixtures';
import { createCalendarAdapter } from '../../src/adapters/calendar';
import { AVAILABILITY_DAY_SLOTS } from '../../src/adapters/calendar/slots';
import type { GoogleCalendarClient } from '../../src/adapters/calendar/types';
import { calendarAvailabilityPort } from '../../src/compose/ports';
import type { Providers } from '../../src/compose/providers';
import { createRealToolset } from '../../src/tools/real/index';
import type { FactsSnapshot, RealToolsetPorts } from '../../src/tools/real/types';

const BARBER = 'biz_barber_01';
const TZ = 'America/Los_Angeles';
const ctx: ToolContext = { businessId: BARBER, agentVersionId: 'agv_barber_01_v1', callId: 'call_test_02', correlationId: 'call_test_02' };
const now = () => new Date('2026-11-13T18:00:00Z');

const snapshot: FactsSnapshot = {
  facts: barberFacts.flatMap((f) => (f.kind === 'menu_item' || f.status !== 'verified' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])),
  timezone: TZ,
};

function setup(busy: { start: string; end: string }[] = []) {
  const freebusy = vi.fn<GoogleCalendarClient['freebusy']['query']>(async () => ({ data: { calendars: { cal: { busy } } } }));
  const never = () => { throw new Error('not used'); };
  const client = { events: { list: never, get: never, insert: never, delete: never }, freebusy: { query: freebusy } } as unknown as GoogleCalendarClient;
  const calendar = createCalendarAdapter({ client, now, timeoutMs: 50 });
  const availability = calendarAvailabilityPort({ calendar, calendarId: 'cal' } as unknown as Providers, async () => snapshot);
  const freeSlots = vi.fn(availability.freeSlots);
  const ports = { availability: { freeSlots } } as unknown as RealToolsetPorts;
  const ts = createRealToolset({ businessId: BARBER, messageChannel: 'surge', ports, now, factsSnapshot: structuredClone(snapshot) });
  return { ts, freebusy, freeSlots };
}

describe('read_calendar_availability with near, through the real Calendar adapter', () => {
  it('returns the slots nearest the wanted time', async () => {
    const s = setup();
    // Tuesday 2026-11-17, 14:00 in Los Angeles is 22:00 UTC.
    const r = await s.ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-17', near: '14:00', maxSlots: 3 }, ctx);
    expect(r).toMatchObject({ ok: true });
    const starts = r.ok ? r.slots.map((x) => x.startUtc) : [];
    expect(starts).toHaveLength(3);
    expect(starts).toContain('2026-11-17T22:00:00.000Z');
    expect(s.freebusy).toHaveBeenCalledTimes(1);
    // What the toolset asks for is inside what the adapter accepts.
    expect(s.freeSlots.mock.calls[0]![0].maxSlots).toBeLessThanOrEqual(AVAILABILITY_DAY_SLOTS);
  });

  it('offers the nearest free times when the wanted time is taken', async () => {
    const s = setup([{ start: '2026-11-17T21:30:00Z', end: '2026-11-17T23:00:00Z' }]);
    const r = await s.ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-17', near: '14:00', maxSlots: 2 }, ctx);
    const starts = r.ok ? r.slots.map((x) => x.startUtc) : [];
    expect(starts).toHaveLength(2);
    expect(starts).not.toContain('2026-11-17T22:00:00.000Z');
  });

  it('still answers without near', async () => {
    const s = setup();
    const r = await s.ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-17' }, ctx);
    expect(r.ok && r.slots.length).toBe(5);
  });
});
