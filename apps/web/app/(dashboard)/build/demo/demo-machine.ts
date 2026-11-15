/**
 * The phases of the demo run on the Build screen, as a pure reducer.
 *
 * compose  -> the judge picks a shop, the presenter attaches its two files and sends one message
 * progress -> the timed steps show one after the other (no request)
 * ready    -> the shop's number and its menu or services are shown; the screen waits for the call
 * order    -> a new order or booking from the server is waiting for approval
 * decided  -> the server answered the decision
 */
import type {StageShopKey} from '@abos/contracts/fixtures';
import type {ApprovalRequest, ApprovalState} from '@/lib/api';
import {DEMO_STEPS, type DemoStepDefinition} from './demo-steps';

/** How often the pending approvals and the order are read again, besides the live updates. */
export const WAITING_POLL_MS = 3000;

/**
 * How long the order card shows "Approving" after the click, at the least.
 * The server usually answers in well under a second, which is too fast for a
 * room to see that something happened. "Approved" still shows only after the
 * server has confirmed: this only delays it, it never shows it early.
 */
export const APPROVE_HOLD_MS = 2000;

/** Shows the "Demo" badge and its line in the page header. Set to false to hide both. */
export const SHOW_DEMO_BADGE = false;

export const DEMO_BADGE_TEXT = 'Demo run. This agent was set up before the demo.';

export type DemoPhase = 'compose' | 'progress' | 'ready' | 'order' | 'decided';

export type StepStatus = 'pending' | 'running' | 'done';

export type DemoState = {
  phase: DemoPhase;
  /** Goes up on every send and start over, so a timer from an earlier run is ignored. */
  run: number;
  message: {text: string; fileNames: string[]} | null;
  /** The stage shop the attached files chose. Set on send, cleared on start over. */
  shopKey: StageShopKey | null;
  steps: StepStatus[];
  /** When the message was sent (ms). The steps run from it, also after the screen comes back. */
  sentAt: number | null;
  /** When the number was shown (ms). Only orders created after it count. */
  numberShownAt: number | null;
  approvalId: string | null;
  /** What the waiting approval is: an order (pizza place) or a booking (barbershop, salon). */
  approvalKind: ApprovalKind | null;
  decidedState: ApprovalState | null;
};

export type ApprovalKind = 'order_bundle' | 'booking_bundle';

export type DemoAction =
  | {type: 'send'; text: string; fileNames: string[]; shopKey: StageShopKey; now?: number}
  | {type: 'step_done'; run: number; index: number; now: number}
  | {type: 'order_arrived'; approvalId: string; kind: ApprovalKind}
  | {type: 'decided'; approvalId: string; state: ApprovalState}
  | {type: 'start_over'}
  /** The screen came back to a run saved earlier in this tab (see demo-run-store.ts). Applies only on the starting page. */
  | {type: 'restore'; state: DemoState};

const allPending = (): StepStatus[] => DEMO_STEPS.map(() => 'pending');

export function initialDemoState(run = 0): DemoState {
  return {phase: 'compose', run, message: null, shopKey: null, steps: allPending(), sentAt: null, numberShownAt: null, approvalId: null, approvalKind: null, decidedState: null};
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'send': {
      if (state.phase !== 'compose') return state;
      const text = action.text.trim();
      if (!text || !action.shopKey) return state;
      const steps = allPending();
      steps[0] = 'running';
      return {
        ...initialDemoState(state.run + 1),
        phase: 'progress',
        message: {text, fileNames: [...action.fileNames]},
        shopKey: action.shopKey,
        steps,
        sentAt: action.now ?? null,
      };
    }
    case 'step_done': {
      if (state.phase !== 'progress' || action.run !== state.run || state.steps[action.index] !== 'running') return state;
      const steps = [...state.steps];
      steps[action.index] = 'done';
      const next = action.index + 1;
      if (next >= steps.length) return {...state, steps, phase: 'ready', numberShownAt: action.now};
      steps[next] = 'running';
      return {...state, steps};
    }
    case 'order_arrived': {
      if (state.phase !== 'ready') return state;
      return {...state, phase: 'order', approvalId: action.approvalId, approvalKind: action.kind};
    }
    case 'decided': {
      if (state.phase !== 'order' || action.approvalId !== state.approvalId) return state;
      return {...state, phase: 'decided', decidedState: action.state};
    }
    case 'start_over':
      return initialDemoState(state.run + 1);
    case 'restore':
      return state.phase === 'compose' ? action.state : state;
  }
}

/** The plain data of a run that is kept while the presenter is on another tab. */
export type SavedDemoRun = {
  run: number;
  shopKey: StageShopKey;
  message: {text: string; fileNames: string[]} | null;
  sentAt: number | null;
  numberShownAt: number | null;
  /** The orders already waiting when the number was shown, once the first list after it was read. */
  knownIds: string[] | null;
  approvalId: string | null;
  approvalKind: ApprovalKind | null;
};

/**
 * The state to show when the screen comes back to a saved run.
 *
 * An order or booking on screen comes back as the same card; whether it was
 * approved is never taken from here, the card reads it from the server. With
 * the number shown, the screen waits again with the original moment the
 * number was shown. During the steps, the clock decides: the steps already
 * over show as done, and if the whole build would be over by now, the number
 * shows, as of the moment it would have shown.
 */
export function restoreDemoState(
  saved: SavedDemoRun,
  {now, steps = DEMO_STEPS, scale = 1}: {now: number; steps?: readonly DemoStepDefinition[]; scale?: number},
): DemoState {
  const base: DemoState = {...initialDemoState(saved.run), message: saved.message, shopKey: saved.shopKey, sentAt: saved.sentAt};
  const allDone = (): StepStatus[] => steps.map(() => 'done');
  if (saved.approvalId && saved.approvalKind) {
    return {...base, phase: 'order', steps: allDone(), numberShownAt: saved.numberShownAt ?? now, approvalId: saved.approvalId, approvalKind: saved.approvalKind};
  }
  if (saved.numberShownAt !== null) return {...base, phase: 'ready', steps: allDone(), numberShownAt: saved.numberShownAt};
  const elapsed = saved.sentAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - saved.sentAt);
  const statuses: StepStatus[] = [];
  let end = 0;
  for (const step of steps) {
    const start = end;
    end += Math.max(0, step.durationMs * scale);
    statuses.push(elapsed >= end ? 'done' : elapsed >= start && !statuses.includes('running') ? 'running' : 'pending');
  }
  if (!statuses.includes('running')) {
    return {...base, phase: 'ready', steps: allDone(), numberShownAt: saved.sentAt === null ? now : saved.sentAt + end};
  }
  return {...base, phase: 'progress', steps: statuses};
}

/** The saved form of a state, or null on the starting page. `known` is kept only for this run's number. */
export function toSavedRun(state: DemoState, known: {shownAt: number; ids: ReadonlySet<string>} | null): SavedDemoRun | null {
  if (state.phase === 'compose' || !state.shopKey) return null;
  const knownIds = known && state.numberShownAt !== null && known.shownAt === state.numberShownAt ? [...known.ids] : null;
  return {
    run: state.run,
    shopKey: state.shopKey,
    message: state.message,
    sentAt: state.sentAt,
    numberShownAt: state.numberShownAt,
    knownIds,
    approvalId: state.approvalId,
    approvalKind: state.approvalKind,
  };
}

/** True once the result panel shows. The finale's queries start only then. */
export function isShowingResult(state: DemoState): boolean {
  return state.phase === 'ready' || state.phase === 'order' || state.phase === 'decided';
}

/** A pending order (pizza place) or booking (barbershop, salon): what a caller's call produces. */
function isPendingOrder(a: ApprovalRequest): boolean {
  return (a.bundleType === 'order_bundle' || a.bundleType === 'booking_bundle') && a.state === 'PENDING';
}

/**
 * The orders that were already waiting when the number was shown, by id:
 * every pending order in the first list read after that moment that was
 * created before it. They are ignored for the rest of the run, which is also
 * the clean start between rehearsals.
 *
 * After this first list, ids decide and times do not. An order that is not in
 * this set is new, whatever its time says, so the server's clock and this
 * laptop's clock do not have to agree for the judge's order to show.
 */
export function knownBeforeDemo(items: readonly ApprovalRequest[], since: number): Set<string> {
  return new Set(items.filter((a) => isPendingOrder(a) && !(Date.parse(a.createdAt) > since)).map((a) => a.id));
}

/** The newest pending order or booking that was not already waiting when the number was shown. */
export function pickIncomingApproval(items: readonly ApprovalRequest[], known: ReadonlySet<string>): ApprovalRequest | null {
  let newest: ApprovalRequest | null = null;
  for (const a of items) {
    if (!isPendingOrder(a) || known.has(a.id)) continue;
    if (!newest || Date.parse(a.createdAt) > Date.parse(newest.createdAt)) newest = a;
  }
  return newest;
}
