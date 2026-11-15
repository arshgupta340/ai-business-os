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

function readBuilt(): boolean {
  try {
    return storage()?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function write(built: boolean): void {
  try {
    if (built) storage()?.setItem(KEY, '1');
    else storage()?.removeItem(KEY);
  } catch {
    // Storage blocked: the agent simply stays hidden until the tab reloads.
  }
  for (const listener of listeners) listener();
}

/** The demo build reached the phone number: Overview and My Agents may show the agent. */
export function markDemoAgentBuilt(): void {
  write(true);
}

/** A new demo run started, or "Start over" was clicked: hide the agent again. */
export function clearDemoAgentBuilt(): void {
  write(false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the scripted demo is on and its build step has not reached the number in this tab. */
export function useDemoHidesAgents(): boolean {
  const built = useSyncExternalStore(subscribe, readBuilt, () => false);
  return isDemoScript() && !built;
}
