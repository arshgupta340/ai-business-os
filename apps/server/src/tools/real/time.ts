// Wall-clock helpers for one IANA timezone, built on Intl only. Used to check a pickup time
// against the verified opening hours in the call's fact snapshot.
import type { HoursKey } from '@abos/contracts';

/** Minutes the shop needs to make an order (Arsh, 2026-11-14). A pickup sooner than this cannot be prepared. */
export const ORDER_PREP_MINUTES = 20;
/**
 * Time passes on a call between "twenty minutes from now" and the proposal, so a pickup this much short
 * of the minimum is still accepted.
 */
export const ORDER_PREP_GRACE_MS = 3 * 60_000;
export const PICKUP_TOO_SOON = `The pickup time is too soon. An order takes ${ORDER_PREP_MINUTES} minutes to prepare. Offer a pickup time ${ORDER_PREP_MINUTES} minutes from now or later.`;
/** True when a pickup time leaves the shop too little time to make the order. */
export function pickupTooSoon(pickupMs: number, nowMs: number): boolean {
  return pickupMs < nowMs + ORDER_PREP_MINUTES * 60_000 - ORDER_PREP_GRACE_MS;
}

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

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year ?? 0, month: parts.month ?? 0, day: parts.day ?? 0, hour: parts.hour ?? 0, minute: parts.minute ?? 0, second: parts.second ?? 0 };
}

function offsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epochMs / 1000) * 1000;
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

/** The weekday key of a local `YYYY-MM-DD` date. */
/** The local date `days` after a local date (negative for before). */
export function shiftLocalDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
}

/** True when a day's hours end the next morning: a close at or before the open, as in 11:00 to 02:00. */
export function closesNextMorning(hours: { open: string; close: string }): boolean {
  return hours.close <= hours.open;
}

/**
 * True when [startMs, endMs] lies inside the opening window that starts on the local `date`. The window of
 * a day that closes the next morning runs to that closing time on the following date.
 */
export function insideWindow(date: string, hours: { open: string; close: string }, timeZone: string, startMs: number, endMs: number): boolean {
  const open = localToEpoch(date, hours.open, timeZone);
  const close = localToEpoch(closesNextMorning(hours) ? shiftLocalDate(date, 1) : date, hours.close, timeZone);
  return startMs >= open && endMs <= close;
}

export function weekdayOfLocalDate(date: string): HoursKey {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay()] ?? 'sun';
}

/** The local date (`YYYY-MM-DD`) and weekday key of an instant. */
export function localDay(epochMs: number, timeZone: string): { date: string; weekday: HoursKey } {
  const p = zonedParts(epochMs, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  const weekday = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()] ?? 'sun';
  return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, weekday };
}
