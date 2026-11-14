// Pure slot finder. No I/O, no clock reads: the caller passes `now`.
// Written to be lifted into apps/server for task B-19.
//
// Rule (FLOWS.md step C3): build candidate starts on a grid in local time,
// keep a start only if
//   1. the service (start to start + duration) ends within business hours,
//   2. start to start + duration + buffer overlaps no busy block,
//   3. start is at least the minimum notice after now,
// and return at most `maxSlots` starts, earliest first.

import {
  addDays,
  assertTimeZone,
  comparePlainDate,
  formatLocalIso,
  parseClock,
  plainDateOf,
  weekdayOf,
  zonedWallTimeToUtc,
  type PlainDate,
  type WeekdayKey,
} from "./time.js";

/** One open interval in local clock time, for example { open: "09:00", close: "18:00" }. */
export interface OpenInterval {
  open: string;
  close: string;
}

/**
 * Opening hours per weekday, keyed like the `hours` facts (SPEC 2.9: mon to sun).
 * A missing key or an empty array means closed. Intervals must not cross midnight.
 */
export type BusinessHours = Partial<Record<WeekdayKey, OpenInterval[]>>;

/** A busy block as Google free/busy returns it: start inclusive, end exclusive. */
export interface BusyBlock {
  start: string | Date;
  end: string | Date;
}

export interface SlotQuery {
  timeZone: string;
  businessHours: BusinessHours;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  /** Grid spacing for candidate starts, in minutes. Default 15. */
  gridMinutes?: number;
  busy: BusyBlock[];
  now: Date;
  /** Search window. Default: from `now` to `now` plus 7 days. */
  from?: Date;
  to?: Date;
  /** Default 5. */
  maxSlots?: number;
}

export interface Slot {
  /** UTC instant, ISO 8601 with Z. */
  startAt: string;
  /** End of the service, not including the buffer. */
  endAt: string;
  /** Same instant in the business time zone, with offset. */
  localStart: string;
  localEnd: string;
  timeZone: string;
}

const MINUTE = 60_000;

function toMs(v: string | Date): number {
  const ms = typeof v === "string" ? Date.parse(v) : v.getTime();
  if (Number.isNaN(ms)) throw new Error(`Bad busy time: ${String(v)}`);
  return ms;
}

function positiveInt(name: string, v: number, allowZero: boolean): void {
  if (!Number.isInteger(v) || v < 0 || (!allowZero && v === 0)) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer, got ${v}`);
  }
}

export function findFreeSlots(q: SlotQuery): Slot[] {
  const grid = q.gridMinutes ?? 15;
  const maxSlots = q.maxSlots ?? 5;
  assertTimeZone(q.timeZone);
  positiveInt("durationMinutes", q.durationMinutes, false);
  positiveInt("bufferMinutes", q.bufferMinutes, true);
  positiveInt("minNoticeMinutes", q.minNoticeMinutes, true);
  positiveInt("gridMinutes", grid, false);
  positiveInt("maxSlots", maxSlots, true);

  const nowMs = q.now.getTime();
  const fromMs = (q.from ?? q.now).getTime();
  const toMsLimit = (q.to ?? new Date(nowMs + 7 * 24 * 60 * MINUTE)).getTime();
  const earliestStart = Math.max(fromMs, nowMs + q.minNoticeMinutes * MINUTE);

  const busy = q.busy
    .map((b) => ({ start: toMs(b.start), end: toMs(b.end) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const overlapsBusy = (s: number, e: number): boolean =>
    busy.some((b) => b.start < e && s < b.end);

  const slots: Slot[] = [];
  if (maxSlots === 0 || toMsLimit <= fromMs) return slots;

  const firstDay = plainDateOf(fromMs, q.timeZone);
  const lastDay = plainDateOf(toMsLimit, q.timeZone);

  for (let day: PlainDate = firstDay; comparePlainDate(day, lastDay) <= 0; day = addDays(day, 1)) {
    const intervals = q.businessHours[weekdayOf(day)] ?? [];
    const sorted = [...intervals].sort((a, b) => parseClock(a.open) - parseClock(b.open));
    for (const iv of sorted) {
      const openMin = parseClock(iv.open);
      const closeMin = parseClock(iv.close);
      if (closeMin <= openMin) {
        throw new Error(`Interval ${iv.open}-${iv.close} is empty or crosses midnight`);
      }
      // Grid aligned to local clock minutes after midnight (9:00, 9:15, ...).
      const firstGrid = Math.ceil(openMin / grid) * grid;
      const close = localMinuteToUtc(day, closeMin, q.timeZone);
      for (let m = firstGrid; m + q.durationMinutes <= closeMin; m += grid) {
        const start = localMinuteToUtc(day, m, q.timeZone);
        const end = start + q.durationMinutes * MINUTE;
        // Check the service end against the real close instant. On a day with
        // a clock change the wall minutes and the elapsed minutes differ.
        if (end > close) break;
        if (start < earliestStart) continue;
        if (end > toMsLimit) continue;
        if (overlapsBusy(start, end + q.bufferMinutes * MINUTE)) continue;
        // Two grid minutes can map to the same instant only inside a DST gap,
        // which business hours do not usually reach. Skip duplicates anyway.
        if (slots.length && Date.parse(slots[slots.length - 1]!.startAt) >= start) continue;
        slots.push({
          startAt: new Date(start).toISOString(),
          endAt: new Date(end).toISOString(),
          localStart: formatLocalIso(start, q.timeZone),
          localEnd: formatLocalIso(end, q.timeZone),
          timeZone: q.timeZone,
        });
        if (slots.length >= maxSlots) return slots;
      }
    }
  }
  return slots;
}

function localMinuteToUtc(day: PlainDate, minuteOfDay: number, timeZone: string): number {
  if (minuteOfDay === 24 * 60) {
    const next = addDays(day, 1);
    return zonedWallTimeToUtc({ ...next, hour: 0, minute: 0, second: 0 }, timeZone);
  }
  return zonedWallTimeToUtc(
    { ...day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60, second: 0 },
    timeZone,
  );
}
