// Time zone helpers built on Intl only, so they carry no dependency into production.
// All instants are plain epoch milliseconds or Date objects. "Wall time" means the
// clock reading in a named IANA time zone such as America/Los_Angeles.

export interface PlainDate {
  year: number;
  month: number; // 1 to 12
  day: number; // 1 to 31
}

export interface WallTime extends PlainDate {
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Throws a RangeError if the time zone name is not a valid IANA zone. */
export function assertTimeZone(timeZone: string): void {
  partsFormatter(timeZone);
}

/** The wall clock reading of an instant in a time zone. */
export function wallTimeOf(instantMs: number, timeZone: string): WallTime {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl did not return ${type}`);
    return Number(p.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of the zone from UTC at an instant, in minutes. Los Angeles is -480 or -420. */
export function offsetMinutesAt(instantMs: number, timeZone: string): number {
  const w = wallTimeOf(instantMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  return Math.round((asUtc - wholeSecond) / 60000);
}

/**
 * The instant at which the wall clock in `timeZone` reads the given time.
 * In the spring-forward gap (a time that does not exist) the result is shifted
 * forward by the gap, the same as most calendar software. In the fall-back
 * overlap (a time that happens twice) the earlier instant is returned.
 */
export function zonedWallTimeToUtc(w: WallTime, timeZone: string): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Try both offsets seen in the 24 hours around the naive time. Pick the
  // earliest candidate that reads back as the requested wall time.
  const offA = offsetMinutesAt(naive - 12 * 3600_000, timeZone);
  const offB = offsetMinutesAt(naive + 12 * 3600_000, timeZone);
  const candidates = [...new Set([offA, offB])]
    .map((off) => naive - off * 60000)
    .sort((a, b) => a - b);
  for (const c of candidates) {
    const back = wallTimeOf(c, timeZone);
    if (
      back.year === w.year &&
      back.month === w.month &&
      back.day === w.day &&
      back.hour === w.hour &&
      back.minute === w.minute
    ) {
      return c;
    }
  }
  // Gap: no candidate reads back. Use the offset in force before the gap,
  // which lands the same number of minutes past the jump.
  return naive - offA * 60000;
}

/** Calendar date of an instant in a time zone. */
export function plainDateOf(instantMs: number, timeZone: string): PlainDate {
  const w = wallTimeOf(instantMs, timeZone);
  return { year: w.year, month: w.month, day: w.day };
}

export function addDays(d: PlainDate, days: number): PlainDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function comparePlainDate(a: PlainDate, b: PlainDate): number {
  return (a.year - b.year) * 10000 + (a.month - b.month) * 100 + (a.day - b.day);
}

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export function weekdayOf(d: PlainDate): WeekdayKey {
  const idx = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return WEEKDAY_KEYS[idx]!;
}

/** "HH:MM" to minutes after midnight. Accepts "24:00" as the end of the day. */
export function parseClock(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Bad clock time "${hhmm}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) {
    throw new Error(`Bad clock time "${hhmm}"`);
  }
  return h * 60 + min;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** ISO 8601 with the zone's offset, for example 2026-11-14T09:00:00-08:00. */
export function formatLocalIso(instantMs: number, timeZone: string): string {
  const w = wallTimeOf(instantMs, timeZone);
  const off = offsetMinutesAt(instantMs, timeZone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Short human form, for example "Sat Nov 14, 9:00 AM PST". */
export function formatHuman(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(instantMs));
}
