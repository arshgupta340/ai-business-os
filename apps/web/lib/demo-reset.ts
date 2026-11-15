/**
 * The demo reset (Arsh, 2026-11-15): on the scripted demo build, pressing the
 * "Integrations OK" badge in the top bar puts the app back to its starting
 * page and clears the lists of calls, orders, bookings, approvals and activity.
 *
 * Nothing is deleted. The web app cannot delete run data and must not: the
 * server has no admin database login, and run data is archived before it is
 * cleared. The reset stores one moment in this browser, and every list hook
 * (lib/api/hooks.ts) leaves out what happened at or before it. The rows stay
 * in the database and show again in another browser, or here after
 * `showEverythingAgain()`.
 */

import {useSyncExternalStore} from 'react';
import {getBrowserStorage, readItem, removeItem, writeItem} from './storage';

export const HIDDEN_BEFORE_STORAGE_KEY = 'abos.demo.hiddenBefore';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** The moment of the last reset in this browser, in epoch milliseconds, or null when there was none. */
export function readHiddenBefore(): number | null {
  const raw = readItem(getBrowserStorage(), HIDDEN_BEFORE_STORAGE_KEY);
  if (raw === null) return null;
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** Hides everything that happened up to `now` from the lists of this browser. */
export function hideEverythingUntil(now: number): void {
  writeItem(getBrowserStorage(), HIDDEN_BEFORE_STORAGE_KEY, String(now));
  notify();
}

/** Undoes the reset: the lists show everything the server returns again. */
export function showEverythingAgain(): void {
  removeItem(getBrowserStorage(), HIDDEN_BEFORE_STORAGE_KEY);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The reset moment as React state. Null on the server and on the first client
 * render, so both render the same page; the stored value applies right after.
 */
export function useHiddenBefore(): number | null {
  return useSyncExternalStore(subscribe, readHiddenBefore, () => null);
}

/** The items that happened after `cutoff`. An item whose time cannot be read is kept. */
export function newerThan<T>(items: readonly T[], cutoff: number | null, at: (item: T) => string | undefined): T[] {
  if (cutoff === null) return [...items];
  return items.filter((item) => {
    const t = Date.parse(at(item) ?? '');
    return !(t <= cutoff);
  });
}
