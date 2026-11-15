'use client';

/**
 * The demo run, kept in sessionStorage while the presenter is on another tab
 * of the dashboard or reloads the page. Without it the Build screen starts
 * over each time it is opened.
 *
 * Only plain data is kept: the shop, the message and file names, the moments
 * the machine needs, the orders already waiting when the number was shown, and
 * which order or booking is on screen. Whether that order was approved is not
 * kept: the card reads it from the server. Closing the tab forgets the run, and
 * with storage blocked the screen simply starts over as before.
 */

import {STAGE_SHOPS, type StageShopKey} from '@abos/contracts/fixtures';
import type {ApprovalKind, SavedDemoRun} from './demo-machine';

export const DEMO_RUN_STORAGE_KEY = 'abos.demo.run';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const isNumberOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isKind = (v: unknown): v is ApprovalKind => v === 'order_bundle' || v === 'booking_bundle';

function parse(raw: string): SavedDemoRun | null {
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.shopKey !== 'string' || !Object.prototype.hasOwnProperty.call(STAGE_SHOPS, r.shopKey)) return null;
  if (typeof r.run !== 'number' || !isNumberOrNull(r.sentAt) || !isNumberOrNull(r.numberShownAt)) return null;
  const m = r.message as Record<string, unknown> | null;
  const message = m && typeof m === 'object' && typeof m.text === 'string' && isStringArray(m.fileNames) ? {text: m.text, fileNames: m.fileNames} : null;
  const approvalId = typeof r.approvalId === 'string' && r.approvalId ? r.approvalId : null;
  return {
    run: r.run,
    shopKey: r.shopKey as StageShopKey,
    message,
    sentAt: r.sentAt,
    numberShownAt: r.numberShownAt,
    knownIds: isStringArray(r.knownIds) ? r.knownIds : null,
    approvalId,
    approvalKind: approvalId && isKind(r.approvalKind) ? r.approvalKind : null,
  };
}

/** The run saved in this tab, or null when there is none or it cannot be read. */
export function readDemoRun(): SavedDemoRun | null {
  try {
    const raw = storage()?.getItem(DEMO_RUN_STORAGE_KEY);
    return raw ? parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveDemoRun(run: SavedDemoRun | null): void {
  try {
    if (run) storage()?.setItem(DEMO_RUN_STORAGE_KEY, JSON.stringify(run));
    else storage()?.removeItem(DEMO_RUN_STORAGE_KEY);
  } catch {
    // Storage blocked or full: the screen starts over next time, as before.
  }
}

/** "Start over" was clicked. */
export function clearDemoRun(): void {
  saveDemoRun(null);
}

/**
 * Keeps the orders that were already waiting when the number was shown, for
 * that moment only, so a run that comes back ignores the same orders.
 */
export function rememberKnownIds(shownAt: number, ids: ReadonlySet<string>): void {
  const saved = readDemoRun();
  if (!saved || saved.numberShownAt !== shownAt) return;
  saveDemoRun({...saved, knownIds: [...ids]});
}
