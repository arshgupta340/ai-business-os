/**
 * Timing for the mock layer. Tests call setMockTiming(FAST_TIMING) so the
 * scripted timelines finish in milliseconds; the browser uses the defaults.
 */

export interface MockTiming {
  /** Response latency range for every handler, in ms. */
  latencyMinMs: number;
  latencyMaxMs: number;
  /** Gap between scripted executor and timeline steps (API.md 7 says about 1.5 seconds). */
  stepMs: number;
  /** Gap between conversation stage changes on a scripted call. */
  callTurnMs: number;
  /** How long the scripted customer takes to pay after the link is ready. */
  paymentMs: number;
  /** Time before an upload moves to EXTRACTING, and then to EXTRACTED. */
  extractionStartMs: number;
  extractionMs: number;
}

export const DEFAULT_TIMING: MockTiming = {
  latencyMinMs: 120,
  latencyMaxMs: 380,
  stepMs: 1500,
  callTurnMs: 1800,
  paymentMs: 6000,
  extractionStartMs: 600,
  extractionMs: 3000,
};

export const FAST_TIMING: MockTiming = {
  latencyMinMs: 0,
  latencyMaxMs: 0,
  stepMs: 1,
  callTurnMs: 1,
  paymentMs: 5,
  extractionStartMs: 1,
  extractionMs: 2,
};

export const timing: MockTiming = { ...DEFAULT_TIMING };

export function setMockTiming(next: Partial<MockTiming>): void {
  Object.assign(timing, next);
}

export function latencyMs(): number {
  const { latencyMinMs: min, latencyMaxMs: max } = timing;
  return max <= min ? min : Math.round(min + Math.random() * (max - min));
}

const timers = new Set<ReturnType<typeof setTimeout>>();
/** Scheduled steps that returned a promise and have not settled yet (the contract's hashing is async). */
let running = 0;
let idleWaiters: (() => void)[] = [];

function checkIdle() {
  if (timers.size === 0 && running === 0) {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }
}

/** Run fn after ms. Tracked so reset() can cancel it and tests can wait for idle. */
export function schedule(fn: () => void | Promise<void>, ms: number): ReturnType<typeof setTimeout> {
  const id = setTimeout(() => {
    timers.delete(id);
    let result: void | Promise<void> = undefined;
    try {
      result = fn();
    } finally {
      if (result instanceof Promise) {
        // whenIdle() waits for an async step too.
        running += 1;
        result
          .catch((err: unknown) => console.error("Scripted mock step failed", err))
          .finally(() => {
            running -= 1;
            checkIdle();
          });
      } else {
        checkIdle();
      }
    }
  }, ms);
  timers.add(id);
  return id;
}

export function cancel(id: ReturnType<typeof setTimeout> | undefined): void {
  if (id === undefined) return;
  clearTimeout(id);
  timers.delete(id);
  checkIdle();
}

export function cancelAllScheduled(): void {
  for (const id of timers) clearTimeout(id);
  timers.clear();
  checkIdle();
}

/** Resolves when no scripted step is waiting. */
export function whenIdle(): Promise<void> {
  if (timers.size === 0 && running === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

export function pendingCount(): number {
  return timers.size + running;
}
