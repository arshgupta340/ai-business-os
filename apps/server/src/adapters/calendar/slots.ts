// Pure slot computation. No I/O and no clock reads: the caller passes `now`.
//
// Rule (FLOWS C3): candidate starts sit on a 15 minute grid of local clock
// time. A start is kept only if
//   1. every minute of the service (start to start + duration) is inside the
//      business hours for that weekday, on that local date,
//   2. start to start + duration + buffer overlaps no busy block (the buffer
//      comes after the service only and may run past closing),
//   3. start is at least the minimum notice after now.
// At most 5 slots are returned, earliest first. The slot covers the service
// only, never the buffer.
//
// Daylight saving: the code walks real instants one minute apart and reads the
// local wall clock for each, so a local time that does not exist (spring) is
// never offered and a local time that happens twice (fall) appears twice.
import {
  AVAILABILITY_GRID_MINUTES,
  AVAILABILITY_MAX_SLOTS,
  HoursValueSchema,
  LocalDateSchema,
  type AvailabilitySlot,
  type HoursKey,
} from '@abos/contracts';
import type { AvailabilityQuery, BusyBlock } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEKDAYS: readonly HoursKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function formatter(timezone: string): Intl.DateTimeFormat {
  // Throws RangeError for an unknown time zone.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

/** Local date and minute of day of an instant. */
function wall(f: Intl.DateTimeFormat, instant: number): { date: string; minute: number } {
  const parts = f.formatToParts(instant);
  const part = (key: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find(p => p.type === key);
    if (!found) throw new Error(`Missing ${key} in formatted date`);
    return found.value;
  };
  return { date: `${part('year')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

function assertDate(date: string): void {
  LocalDateSchema.parse(date);
  if (new Date(Date.parse(`${date}T00:00:00Z`)).toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
}

/**
 * The UTC instants of local midnight at the start and end of `date`. The day is
 * 23 hours long on the spring change and 25 hours on the fall change.
 */
export function dayWindow(date: string, timezone: string): { startUtc: string; endUtc: string } {
  assertDate(date);
  const f = formatter(timezone);
  const midnight = (target: number): number => {
    const targetDate = new Date(target).toISOString().slice(0, 10);
    const candidates: number[] = [];
    // Sample the zone offset on both sides of a possible clock change.
    for (let h = -36; h <= 36; h += 6) {
      const sample = target + h * HOUR;
      const local = wall(f, sample);
      const offset = Date.parse(`${local.date}T00:00:00Z`) + local.minute * MINUTE - sample;
      const candidate = target - offset;
      const result = wall(f, candidate);
      if (result.date === targetDate && result.minute === 0) candidates.push(candidate);
    }
    if (!candidates.length) throw new Error('Local midnight does not exist');
    return Math.min(...candidates);
  };
  const base = Date.parse(`${date}T00:00:00Z`);
  return { startUtc: new Date(midnight(base)).toISOString(), endUtc: new Date(midnight(base + 24 * HOUR)).toISOString() };
}

function clockMinute(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/**
 * Checks every input that would make the slot computation wrong. Throws on bad
 * input; the adapter maps that to VALIDATION_FAILED before any provider call.
 */
export function validateQuery(q: AvailabilityQuery): void {
  for (const [name, value, minimum] of [
    ['serviceDurationMinutes', q.serviceDurationMinutes, 1],
    ['bufferMinutes', q.bufferMinutes, 0],
    ['minNoticeMinutes', q.minNoticeMinutes, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  if (q.maxSlots !== undefined && (!Number.isSafeInteger(q.maxSlots) || q.maxSlots < 1 || q.maxSlots > AVAILABILITY_MAX_SLOTS)) {
    throw new Error(`maxSlots must be 1 to ${AVAILABILITY_MAX_SLOTS}`);
  }
  assertDate(q.date);
  formatter(q.timezone);
  for (const value of Object.values(q.hours)) {
    if (value === undefined) continue;
    const parsed = HoursValueSchema.parse(value);
    if ('open' in parsed && clockMinute(parsed.close) <= clockMinute(parsed.open)) {
      throw new Error(`Hours ${parsed.open}-${parsed.close} are empty or cross midnight`);
    }
  }
}

export function weekdayOf(date: string): HoursKey {
  const key = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  if (!key) throw new Error('Invalid date');
  return key;
}

/** Free slots on `q.date`. `busy` comes from free/busy: start inclusive, end exclusive. */
export function computeSlots(q: AvailabilityQuery, busy: readonly BusyBlock[], now: Date): AvailabilitySlot[] {
  validateQuery(q);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid clock');
  const blocks = busy.map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  if (blocks.some(b => !Number.isFinite(b.start) || !Number.isFinite(b.end) || b.end <= b.start)) throw new Error('Invalid busy block');

  const hours = q.hours[weekdayOf(q.date)];
  if (!hours) return [];
  const interval = HoursValueSchema.parse(hours);
  if ('closed' in interval) return [];
  const open = clockMinute(interval.open);
  const close = clockMinute(interval.close);

  const f = formatter(q.timezone);
  const range = dayWindow(q.date, q.timezone);
  const maxSlots = q.maxSlots ?? AVAILABILITY_MAX_SLOTS;
  const earliest = now.getTime() + q.minNoticeMinutes * MINUTE;
  const duration = q.serviceDurationMinutes * MINUTE;
  const occupied = duration + q.bufferMinutes * MINUTE;
  const result: AvailabilitySlot[] = [];

  for (let start = Date.parse(range.startUtc); start < Date.parse(range.endUtc); start += MINUTE) {
    if (start < earliest) continue;
    const local = wall(f, start);
    if (local.minute % AVAILABILITY_GRID_MINUTES !== 0 || local.minute < open || local.minute >= close) continue;
    if (blocks.some(b => b.start < start + occupied && start < b.end)) continue;
    // Every minute of the service must be open on this local date, measured in
    // real elapsed time, so a clock change inside the service is handled.
    let inside = true;
    for (let time = start; time < start + duration; time += MINUTE) {
      const at = wall(f, time);
      if (at.date !== q.date || at.minute < open || at.minute >= close) { inside = false; break; }
    }
    if (!inside) continue;
    result.push({ serviceId: q.serviceId, startUtc: new Date(start).toISOString(), endUtc: new Date(start + duration).toISOString(), timezone: q.timezone });
    if (result.length >= maxSlots) break;
  }
  return result;
}
