/**
 * The phases of the demo run on the Build screen, as a pure reducer.
 *
 * compose  -> the presenter pastes the menu and sends one message
 * progress -> the timed steps show one after the other (no request)
 * ready    -> the number and the menu are shown; the screen waits for an order
 * order    -> a new order from the server is waiting for approval
 * decided  -> the server answered the decision
 */
import type {ApprovalRequest, ApprovalState} from '@/lib/api';
import {DEMO_STEPS} from './demo-steps';

/** How often the pending approvals and the order are read again, besides the live updates. */
export const WAITING_POLL_MS = 3000;

/** Shows the "Demo" badge and its line in the page header. Set to false to hide both. */
export const SHOW_DEMO_BADGE = true;

export const DEMO_BADGE_TEXT = 'Demo run. This agent was set up before the demo.';

/** The prompt from the demo script (issue #152), offered as a one-click suggestion. */
export const DEMO_PROMPT =
  'Create a voice calling agent for this pizza shop using the attached menu and FAQs. It should answer customer questions, take pickup orders, confirm the details with the customer, and submit each order for my approval.';

export type DemoPhase = 'compose' | 'progress' | 'ready' | 'order' | 'decided';

export type StepStatus = 'pending' | 'running' | 'done';

export type DemoState = {
  phase: DemoPhase;
  /** Goes up on every send and start over, so a timer from an earlier run is ignored. */
  run: number;
  message: {text: string; fileName?: string} | null;
  steps: StepStatus[];
  /** When the number was shown (ms). Only orders created after it count. */
  numberShownAt: number | null;
  approvalId: string | null;
  decidedState: ApprovalState | null;
};

export type DemoAction =
  | {type: 'send'; text: string; fileName?: string}
  | {type: 'step_done'; run: number; index: number; now: number}
  | {type: 'order_arrived'; approvalId: string}
  | {type: 'decided'; approvalId: string; state: ApprovalState}
  | {type: 'start_over'};

const allPending = (): StepStatus[] => DEMO_STEPS.map(() => 'pending');

export function initialDemoState(run = 0): DemoState {
  return {phase: 'compose', run, message: null, steps: allPending(), numberShownAt: null, approvalId: null, decidedState: null};
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'send': {
      if (state.phase !== 'compose') return state;
      const text = action.text.trim();
      if (!text) return state;
      const steps = allPending();
      steps[0] = 'running';
      return {
        ...initialDemoState(state.run + 1),
        phase: 'progress',
        message: {text, ...(action.fileName ? {fileName: action.fileName} : {})},
        steps,
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
      return {...state, phase: 'order', approvalId: action.approvalId};
    }
    case 'decided': {
      if (state.phase !== 'order' || action.approvalId !== state.approvalId) return state;
      return {...state, phase: 'decided', decidedState: action.state};
    }
    case 'start_over':
      return initialDemoState(state.run + 1);
  }
}

/** True once the result panel shows. The finale's queries start only then. */
export function isShowingResult(state: DemoState): boolean {
  return state.phase === 'ready' || state.phase === 'order' || state.phase === 'decided';
}

function isPendingOrder(a: ApprovalRequest): boolean {
  return a.bundleType === 'order_bundle' && a.state === 'PENDING';
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

/** The newest pending order that was not already waiting when the number was shown. */
export function pickIncomingApproval(items: readonly ApprovalRequest[], known: ReadonlySet<string>): ApprovalRequest | null {
  let newest: ApprovalRequest | null = null;
  for (const a of items) {
    if (!isPendingOrder(a) || known.has(a.id)) continue;
    if (!newest || Date.parse(a.createdAt) > Date.parse(newest.createdAt)) newest = a;
  }
  return newest;
}
