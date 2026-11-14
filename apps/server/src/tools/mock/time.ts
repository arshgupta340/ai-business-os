// Wall-clock helpers for one IANA timezone, built on Intl only (no dependency, no host timezone).
import type { HoursKey } from '@abos/contracts';

const WEEKDAYS: HoursKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year ?? 0, month: parts.month ?? 0, day: parts.day ?? 0, hour: parts.hour ?? 0, minute: parts.minute ?? 0, second: parts.second ?? 0 };
}

/** Offset of the zone from UTC at an instant, in milliseconds (negative west of Greenwich). */
function offsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Local `YYYY-MM-DD` plus `HH:MM` in `timeZone` to epoch milliseconds. */
export function localToEpoch(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  const first = offsetMs(guess, timeZone);
  let epoch = guess - first;
  const second = offsetMs(epoch, timeZone);
  if (second !== first) epoch = guess - second;
  return epoch;
}

/** The weekday key (`mon`..`sun`) of a local date. */
export function weekdayOfLocalDate(date: string): HoursKey {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay()] ?? 'sun';
}

/** The local date (`YYYY-MM-DD`) and time (`HH:MM`) of an instant. */
export function localDateTime(epochMs: number, timeZone: string): { date: string; time: string } {
  const p = zonedParts(epochMs, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, time: `${two(p.hour)}:${two(p.minute)}` };
}

/** Epoch milliseconds to ISO UTC without `.000`. */
export function isoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('.000Z', 'Z');
}
