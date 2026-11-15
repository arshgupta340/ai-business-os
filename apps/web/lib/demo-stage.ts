'use client';

/**
 * What the scripted demo (NEXT_PUBLIC_DEMO_SCRIPT=1) has shown so far in this
 * browser tab.
 *
 * On stage the agent is set up beforehand, and the Build screen plays the
 * build as a timed sequence (issue #152). Until that sequence has reached the
 * phone number, Overview and My Agents show no agent, so the room does not see
 * the agent before it is "built". After it, both show the agent as usual.
 *
 * This is display only, kept in sessionStorage: it changes nothing on the
 * server, and closing the tab resets it. With the flag off it does nothing.
 */

import {useSyncExternalStore} from 'react';
import {isDemoScript} from '@/lib/env';

const KEY = 'abos.demo.agentBuilt';
const listeners = new Set<() => void>();

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Any business: written when the build reached the number with no business named. */
const ANY = '1';

/** The business the demo build reached the number for, '1' for any, or null. */
function readBuilt(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

function write(built: string | null): void {
  try {
    if (built) storage()?.setItem(KEY, built);
    else storage()?.removeItem(KEY);
  } catch {
    // Storage blocked: the agent simply stays hidden until the tab reloads.
  }
  for (const listener of listeners) listener();
}

/**
 * The demo build reached the phone number: Overview and My Agents may show the
 * agent of that business (the stage shop the judge picked). Without a business, any.
 */
export function markDemoAgentBuilt(businessId?: string): void {
  write(businessId ?? ANY);
}

/** A new demo run started, or "Start over" was clicked: hide the agent again. */
export function clearDemoAgentBuilt(): void {
  write(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * True while the scripted demo is on and its build step has not reached the
 * number in this tab for this business. Each of the three stage shops is its
 * own business, so the agent of a shop that was not built stays hidden.
 */
export function useDemoHidesAgents(businessId?: string | null): boolean {
  const built = useSyncExternalStore(subscribe, readBuilt, () => null);
  if (!isDemoScript()) return false;
  if (!built) return true;
  return built !== ANY && !!businessId && built !== businessId;
}
