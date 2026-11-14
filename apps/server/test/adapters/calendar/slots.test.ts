import type { HoursKey, HoursValue } from '@abos/contracts';
import { describe, expect, it } from 'vitest';
import { computeSlots, dayWindow, weekdayOf } from '../../../src/adapters/calendar/slots';
import type { AvailabilityQuery, BusyBlock } from '../../../src/adapters/calendar/types';

const TZ = 'America/Los_Angeles';
const open = (o: string, c: string): HoursValue => ({ open: o, close: c });
// Tuesday to Sunday 09:00 to 18:00, Monday closed (as in the spike).
const HOURS: Partial<Record<HoursKey, HoursValue>> = {
  mon: { closed: true }, tue: open('09:00', '18:00'), wed: open('09:00', '18:00'), thu: open('09:00', '18:00'),
  fri: open('09:00', '18:00'), sat: open('09:00', '18:00'), sun: open('09:00', '18:00'),
};
// Monday 2026-11-16 12:00 PST.
const MON_NOON = new Date('2026-11-16T20:00:00Z');
const TUESDAY = '2026-11-17';

function q(over: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return { calendarId: 'cal', serviceId: 'svc_cut', date: TUESDAY, timezone: TZ, hours: HOURS, serviceDurationMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 0, ...over };
}
const run = (over: Partial<AvailabilityQuery> = {}, busy: BusyBlock[] = [], now = MON_NOON) => computeSlots(q(over), busy, now);
/** Local HH:MM of each slot start, in the business time zone. */
const local = (slots: { startUtc: string }[]) =>
  slots.map(s => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.parse(s.startUtc)));

describe('computeSlots: grid, hours and cap', () => {
  it('returns starts inside business hours on the 15 minute grid', () => {
    const slots = run();
    expect(slots).toHaveLength(5);
    expect(slots[0]).toEqual({ serviceId: 'svc_cut', startUtc: '2026-11-17T17:00:00.000Z', endUtc: '2026-11-17T17:30:00.000Z', timezone: TZ });
    expect(local(slots)).toEqual(['09:00', '09:15', '09:30', '09:45', '10:00']);
  });

  it('aligns to the local grid when opening is off grid', () => {
    expect(local(run({ hours: { tue: open('09:07', '10:00') } }))).toEqual(['09:15', '09:30']);
  });

  it('never offers a start whose service runs past closing; the last service ends exactly at close', () => {
    expect(local(run({ hours: { tue: open('17:00', '18:00') } }))).toEqual(['17:00', '17:15', '17:30']);
  });

  it('lets the buffer run past closing, since it is added after the service only', () => {
    expect(local(run({ hours: { tue: open('17:00', '18:00') }, bufferMinutes: 15 }))).toEqual(['17:00', '17:15', '17:30']);
  });

  it('returns nothing on a closed day or a weekday with no hours fact', () => {
    expect(run({ date: '2026-11-16' })).toEqual([]);
    expect(run({ hours: { mon: open('09:00', '18:00') } })).toEqual([]);
  });

  it('returns nothing on a fully booked day', () => {
    expect(run({}, [{ start: '2026-11-17T17:00:00Z', end: '2026-11-18T02:00:00Z' }])).toEqual([]);
    expect(run({}, [{ start: '2026-11-17T00:00:00Z', end: '2026-11-19T00:00:00Z' }])).toEqual([]);
  });

  it('caps the result at 5 and honors a smaller maxSlots', () => {
    expect(run()).toHaveLength(5);
    expect(run({ maxSlots: 2 })).toHaveLength(2);
    expect(run({ maxSlots: 1 })).toHaveLength(1);
  });
});

describe('computeSlots: buffer, busy blocks and notice', () => {
  it('applies the buffer after the service against busy blocks', () => {
    // Busy Tuesday 10:00 to 11:00 PST.
    const busy = [{ start: '2026-11-17T18:00:00Z', end: '2026-11-17T19:00:00Z' }];
    const noBuffer = local(run({}, busy));
    const withBuffer = local(run({ bufferMinutes: 10 }, busy));
    expect(noBuffer).toContain('09:30'); // 09:30 to 10:00 touches the block but does not overlap
    expect(withBuffer).not.toContain('09:30'); // 10:00 plus 10 minutes of buffer overlaps
    expect(withBuffer).toContain('09:15'); // ends 09:45, buffer to 09:55
    expect(withBuffer).toContain('11:00'); // busy end is exclusive
    expect(withBuffer).not.toContain('10:45');
  });

  it('drops starts that a partly overlapping busy block touches', () => {
    // Busy Tuesday 09:40 to 09:50 PST.
    const busy = [{ start: '2026-11-17T17:40:00Z', end: '2026-11-17T17:50:00Z' }];
    expect(local(run({}, busy))).toEqual(['09:00', '10:00', '10:15', '10:30', '10:45']);
  });

  it('checks a partial overlap together with the buffer', () => {
    const busy = [{ start: '2026-11-17T17:35:00Z', end: '2026-11-17T18:05:00Z' }];
    expect(local(run({ bufferMinutes: 15 }, busy))[0]).toBe('10:15');
  });

  it('enforces the minimum notice and rounds up to the grid', () => {
    const now = new Date('2026-11-17T17:05:00Z'); // Tuesday 09:05 PST
    expect(local(run({ minNoticeMinutes: 60 }, [], now))[0]).toBe('10:15');
    expect(local(run({ minNoticeMinutes: 25 }, [], new Date('2026-11-17T17:00:00Z')))[0]).toBe('09:30');
  });

  it('returns nothing once the day is past closing', () => {
    expect(run({}, [], new Date('2026-11-18T03:00:00Z'))).toEqual([]);
  });
});

describe('computeSlots: daylight saving (America/Los_Angeles 2026)', () => {
  it('keeps 09:00 local on every day of a week that crosses the fall change', () => {
    const daily = Object.fromEntries((['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map(d => [d, open('09:00', '09:30')]));
    const now = new Date('2026-10-28T07:00:00Z');
    const days = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'];
    const firsts = days.map(date => run({ date, hours: daily }, [], now)[0]?.startUtc);
    expect(firsts).toEqual([
      '2026-10-28T16:00:00.000Z', '2026-10-29T16:00:00.000Z', '2026-10-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z',
      '2026-11-01T17:00:00.000Z', '2026-11-02T17:00:00.000Z', '2026-11-03T17:00:00.000Z',
    ]);
  });

  it('keeps 09:00 local across the spring change', () => {
    const now = new Date('2026-03-07T08:00:00Z');
    const hours = { sat: open('09:00', '09:30'), sun: open('09:00', '09:30') };
    expect(run({ date: '2026-03-07', hours }, [], now).map(s => s.startUtc)).toEqual(['2026-03-07T17:00:00.000Z']);
    expect(run({ date: '2026-03-08', hours }, [], now).map(s => s.startUtc)).toEqual(['2026-03-08T16:00:00.000Z']);
  });

  it.each([['2026-03-08', 23], ['2026-11-01', 25], ['2026-01-15', 24], ['2026-07-15', 24]])('the local day %s is %i hours long', (date, hours) => {
    const w = dayWindow(date, TZ);
    expect((Date.parse(w.endUtc) - Date.parse(w.startUtc)) / 3_600_000).toBe(hours);
  });

  it('maps winter and summer local midnight to the right instant', () => {
    expect(dayWindow('2026-01-15', TZ).startUtc).toBe('2026-01-15T08:00:00.000Z');
    expect(dayWindow('2026-07-15', TZ).startUtc).toBe('2026-07-15T07:00:00.000Z');
  });

  it('never offers a start in the spring gap', () => {
    // 02:00 to 02:59 does not exist on 2026-03-08. The first open minute is 03:00 PDT.
    const slots = run({ date: '2026-03-08', hours: { sun: open('02:00', '04:00') } }, [], new Date('2026-01-01'));
    expect(slots[0]?.startUtc).toBe('2026-03-08T10:00:00.000Z');
    expect(local(slots).every(t => !t.startsWith('02:'))).toBe(true);
  });

  it('measures a service in real minutes across the spring gap', () => {
    // 01:45 PST plus 30 real minutes is 03:15 PDT, still inside hours.
    const slots = run({ date: '2026-03-08', hours: { sun: open('01:00', '04:00') }, maxSlots: 5 }, [], new Date('2026-01-01'));
    expect(slots.map(s => s.startUtc)).toContain('2026-03-08T09:45:00.000Z');
    expect(slots.find(s => s.startUtc === '2026-03-08T09:45:00.000Z')?.endUtc).toBe('2026-03-08T10:15:00.000Z');
  });

  it('offers both occurrences of a repeated fall time', () => {
    const slots = run({ date: '2026-11-01', hours: { sun: open('01:30', '01:45') }, serviceDurationMinutes: 15 }, [], new Date('2026-01-01'));
    // 01:30 PDT is 08:30Z and 01:30 PST is 09:30Z.
    expect(slots.map(s => s.startUtc)).toEqual(['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z']);
  });

  it('measures the service in real minutes on the night the clocks fall back', () => {
    const now = new Date('2026-11-01T06:00:00Z'); // Sat 23:00 PDT
    const slots = run({ date: '2026-11-01', hours: { sun: open('00:00', '04:00') }, serviceDurationMinutes: 60 }, [], now);
    const starts = slots.map(s => Date.parse(s.startUtc));
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    expect(slots.every(s => Date.parse(s.endUtc) <= Date.parse('2026-11-01T12:00:00Z'))).toBe(true);
    expect(slots[0]?.startUtc).toBe('2026-11-01T07:00:00.000Z'); // 00:00 PDT
  });
});

describe('computeSlots: input checks', () => {
  it('rejects bad input', () => {
    expect(() => run({ timezone: 'Mars/Olympus' })).toThrow();
    expect(() => run({ serviceDurationMinutes: 0 })).toThrow(/serviceDurationMinutes/);
    expect(() => run({ bufferMinutes: -5 })).toThrow(/bufferMinutes/);
    expect(() => run({ maxSlots: 0 })).toThrow(/maxSlots/);
    expect(() => run({ hours: { tue: open('22:00', '02:00') } })).toThrow(/cross midnight/);
    expect(() => run({ date: '2026-13-01' })).toThrow();
    expect(() => run({}, [{ start: 'later', end: 'soon' }])).toThrow(/busy/);
  });

  it('reads the weekday of the local date', () => {
    expect(weekdayOf('2026-11-16')).toBe('mon');
    expect(weekdayOf('2026-11-15')).toBe('sun');
  });
});
