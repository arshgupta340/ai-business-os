/**
 * Pure helpers for the My Agents list and the agent detail page. No React
 * here, so each rule is unit tested on its own (agents-view.test.ts).
 */
import {isApiError, type Agent, type AgentSpec, type LiveAgent} from '@/lib/api';
import {errorText} from '@/lib/error-text';
import {providerLabel} from '@/lib/labels';

type BusinessName = {id: string; name: string};

// ------------------------------------------------------------ phone number

/**
 * Who answers the shared phone number, seen from the selected business.
 * - `none`: no agent answers it (SPEC 2.9, live agent empty case).
 * - `this`: an agent of the selected business answers it. `agent` is set when
 *   that agent is in the list we have.
 * - `other`: an agent of another business answers it. Only that business's
 *   name is shown, nothing else of its data.
 */
export type NumberOwner =
  | {kind: 'none'}
  | {kind: 'this'; agentId: string; agent?: Agent}
  | {kind: 'other'; businessName: string};

export function numberOwner(
  liveAgent: LiveAgent,
  businessId: string,
  agents: readonly Agent[],
  businesses: readonly BusinessName[],
): NumberOwner {
  if (!liveAgent.agentId) return {kind: 'none'};
  if (liveAgent.businessId !== businessId) {
    const name = businesses.find((b) => b.id === liveAgent.businessId)?.name ?? 'another business';
    return {kind: 'other', businessName: name};
  }
  const agent = agents.find((a) => a.id === liveAgent.agentId);
  return {kind: 'this', agentId: liveAgent.agentId, ...(agent ? {agent} : {})};
}

/** One sentence that says who answers the number now. */
export function numberOwnerSentence(owner: NumberOwner): string {
  switch (owner.kind) {
    case 'none':
      return 'No agent is answering the phone number.';
    case 'other':
      return `An agent of ${owner.businessName} answers the phone number, not an agent of this business.`;
    case 'this':
      return owner.agent ? `${owner.agent.name} answers the phone number.` : 'An agent of this business answers the phone number.';
  }
}

/** The name the confirm dialog uses for the agent that stops answering. */
export function replacedAgentLabel(owner: NumberOwner): string | null {
  switch (owner.kind) {
    case 'none':
      return null;
    case 'other':
      return `the agent of ${owner.businessName}`;
    case 'this':
      return owner.agent ? owner.agent.name : 'another agent of this business';
  }
}

/**
 * True when this agent answers the number. The live agent read wins when we
 * have it, because it is the record the phone path reads.
 */
export function answersNumber(agent: Agent, liveAgent: LiveAgent | undefined): boolean {
  if (liveAgent) return liveAgent.agentId === agent.id;
  return agent.isLiveAgent;
}

/**
 * "Make this agent answer the phone" is offered only for a published agent in
 * the `live` state that does not answer the number already. The server
 * refuses anything else with INVALID_STATE (API.md 3.6).
 */
export function canOfferLiveSwitch(agent: Agent, liveAgent: LiveAgent | undefined): boolean {
  if (!liveAgent) return false;
  if (agent.state !== 'live' || !agent.activeVersionId) return false;
  return liveAgent.agentId !== agent.id;
}

/** Pause is offered for a published agent that is live. A draft cannot be paused (API.md 3.4). */
export function canOfferPause(agent: Agent): boolean {
  return agent.state === 'live';
}

// ------------------------------------------------------------------- spec

export type ShownSpec = {
  spec: Partial<AgentSpec>;
  /** `active`: the published version callers get. `draft`: nothing is published yet. */
  source: 'active' | 'draft';
};

/**
 * The spec whose capabilities and knowledge scopes the detail page lists:
 * the active version when there is one (screen data map, section 6), else
 * the draft.
 */
export function shownSpec(agent: Agent): ShownSpec {
  if (agent.activeVersion) return {spec: agent.activeVersion.spec, source: 'active'};
  return {spec: agent.draftSpec, source: 'draft'};
}

// ------------------------------------------------------------------ errors

export type ErrorContext = 'load' | 'pause' | 'liveSwitch' | 'change';

export type ErrorView = {
  title: string;
  message: string;
  canRetry: boolean;
  correlationId?: string;
  /** UNAUTHENTICATED: offer a sign in link. */
  needsSignIn: boolean;
  /** FORBIDDEN_BUSINESS: reset the business selector. */
  forbidden: boolean;
  notFound: boolean;
};

const TITLES: Record<ErrorContext, string> = {
  load: 'Could not load this',
  pause: 'The agent was not paused',
  liveSwitch: 'The phone number was not moved',
  change: 'The change was not sent',
};

/** Maps any thrown value to what the screen shows (data map rule 9). */
export function errorView(err: unknown, context: ErrorContext): ErrorView {
  const base: ErrorView = {
    title: TITLES[context],
    message: 'Something went wrong. Try again.',
    canRetry: true,
    needsSignIn: false,
    forbidden: false,
    notFound: false,
  };
  if (!isApiError(err)) return base;
  const view: ErrorView = {
    ...base,
    // The server message can carry an error code. The owner reads the sentence for the code.
    message: errorText(err),
    canRetry: err.retryable,
    ...(err.correlationId ? {correlationId: err.correlationId} : {}),
  };
  const state = typeof err.details?.state === 'string' ? err.details.state : undefined;
  switch (err.code) {
    case 'UNAUTHENTICATED':
      return {...view, message: 'Your sign-in has ended. Sign in again.', needsSignIn: true, canRetry: false};
    case 'FORBIDDEN_BUSINESS':
      return {...view, message: 'You do not have access to this business.', forbidden: true, canRetry: false};
    case 'NOT_FOUND':
      return {...view, message: 'Not found in this business.', notFound: true, canRetry: false};
    case 'INVALID_STATE':
      if (context === 'pause') {
        return {
          ...view,
          message: state === 'draft' ? 'This agent is a draft. Publish before pausing.' : 'This agent cannot be paused in its current state.',
        };
      }
      if (context === 'liveSwitch') {
        return {
          ...view,
          message:
            state === 'paused'
              ? 'This agent is paused. Publish it again before it can answer the phone number.'
              : 'Only a published, live agent can answer the phone number.',
        };
      }
      return view;
    case 'RATE_LIMITED':
      return {...view, message: 'Too many requests. Wait a moment, then try again.', canRetry: true};
    case 'INTEGRATION_UNAVAILABLE': {
      const provider = typeof err.details?.provider === 'string' ? providerLabel(err.details.provider) : 'A provider';
      return {...view, message: `${provider} is not responding.`, canRetry: true};
    }
    default:
      return view;
  }
}
