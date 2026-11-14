/**
 * Pure helpers for the Build an Agent screen: capability grouping, the
 * Continue rule, display labels and the notes kept from each builder turn.
 * No React here, so every rule is unit tested on its own.
 */
import {PROVIDER_LABELS} from '@/components/shell/ConnectionHealth';
import {
  CAPABILITIES,
  type AgentSpec,
  type ApiError,
  type BuilderTurnResponse,
  type Effect,
  type CapabilityId,
} from '@/lib/api';
import type {Tone} from '@/lib/status';

// ------------------------------------------------------------ capabilities

export type CapabilityGroupKey = 'reads' | 'proposes' | 'afterApproval';

export type CapabilityRow = {
  id: CapabilityId;
  description: string;
  effect: Effect;
};

export type CapabilityGroup = {
  key: CapabilityGroupKey;
  title: string;
  description: string;
  /** Tone from the screen data map: read neutral, propose info, write and external_message warning. */
  tone: Tone;
  badge: string;
  items: CapabilityRow[];
};

const GROUP_ORDER: readonly {key: CapabilityGroupKey; effects: readonly Effect[]; title: string; description: string; tone: Tone; badge: string}[] = [
  {
    key: 'reads',
    effects: ['read'],
    title: 'Reads only',
    description: 'The agent can look this up during a call. It changes nothing.',
    tone: 'neutral',
    badge: 'Read',
  },
  {
    key: 'proposes',
    effects: ['propose'],
    title: 'Proposes, you approve',
    description: 'The agent can prepare a proposal. Nothing happens until you approve it.',
    tone: 'info',
    badge: 'Proposal',
  },
  {
    key: 'afterApproval',
    effects: ['write', 'external_message'],
    title: 'Runs only after your approval',
    description: 'The system runs these after you approve the exact action. The agent never runs them itself.',
    tone: 'warning',
    badge: 'Needs your approval',
  },
];

export function isRegisteredCapability(id: string): id is CapabilityId {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, id);
}

/**
 * Groups the draft's capabilities by effect, using the contract registry for
 * names, descriptions and effects. An ID that is not in the registry is never
 * listed; it is counted in `unknownCount` instead.
 */
export function groupCapabilities(ids: readonly string[] | undefined): {groups: CapabilityGroup[]; unknownCount: number} {
  const seen = new Set<string>();
  const rows: CapabilityRow[] = [];
  let unknownCount = 0;
  for (const id of ids ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!isRegisteredCapability(id)) {
      unknownCount += 1;
      continue;
    }
    const entry = CAPABILITIES[id];
    rows.push({id, description: entry.description, effect: entry.effect});
  }
  const groups = GROUP_ORDER.map(({effects, ...group}) => ({
    ...group,
    items: rows.filter((row) => effects.includes(row.effect)),
  })).filter((group) => group.items.length > 0);
  return {groups, unknownCount};
}

// ------------------------------------------------------------ Continue rule

export type ContinueInput = {
  draftSpec: Partial<AgentSpec> | undefined;
  missingFields: readonly string[];
  stopConditions: readonly {code: string}[];
  progress?: {answered: number; required: number};
  /** True once the owner has sent at least one message in this session. */
  hasOwnerTurn: boolean;
};

export type ContinueState = {canContinue: boolean; reasons: string[]};

/**
 * Continue creates the agent draft. It is enabled only when no required field
 * is missing and no stop condition blocks the draft (see BLOCKING_STOP_CODES:
 * the others are needed before publish, and publish stays their gate). A brand
 * new session also reports no missing fields, so the draft must have a
 * template and the owner must have answered at least once.
 */
export function continueState({draftSpec, missingFields, stopConditions, progress, hasOwnerTurn}: ContinueInput): ContinueState {
  const reasons: string[] = [];
  if (!hasOwnerTurn || !draftSpec?.template) {
    reasons.push('Describe the job first so the builder can pick a template.');
  }
  if (missingFields.length > 0) {
    reasons.push(
      missingFields.length === 1 ? 'One question is still open.' : `${missingFields.length} questions are still open.`,
    );
  } else if (progress && progress.required > 0 && progress.answered < progress.required) {
    reasons.push('Some details are not confirmed yet.');
  }
  const blocking = groupStopConditions(stopConditions).blocking.length;
  if (blocking > 0) {
    reasons.push(blocking === 1 ? 'One issue blocks the draft.' : `${blocking} issues block the draft.`);
  }
  return {canContinue: reasons.length === 0, reasons};
}

// ------------------------------------------------------------ turn notes

/**
 * What a builder turn returns beyond the session itself. The session read
 * (GET /api/builder/sessions/:id) does not carry these, so the screen keeps
 * them per session.
 */
export type TurnNotes = {
  unsupportedRequests: string[];
  stopConditions: {code: string}[];
  suggestions: string[];
  proposedChanges: {approvalId: string; bundleType: string}[];
  progress?: {answered: number; required: number};
};

export const EMPTY_NOTES: TurnNotes = {unsupportedRequests: [], stopConditions: [], suggestions: [], proposedChanges: []};

/**
 * Folds one turn into the notes. Unsupported requests and proposed changes
 * accumulate (the owner reviews all of them). Stop conditions, suggestions and
 * progress are replaced by the latest turn, because the server recomputes them.
 */
export function mergeTurn(notes: TurnNotes, turn: BuilderTurnResponse): TurnNotes {
  const unsupported = [...notes.unsupportedRequests];
  for (const text of turn.unsupportedRequests) {
    const trimmed = text.trim();
    if (trimmed && !unsupported.includes(trimmed)) unsupported.push(trimmed);
  }
  const proposed = [...notes.proposedChanges];
  if (turn.proposedChange && !proposed.some((p) => p.approvalId === turn.proposedChange!.approvalId)) {
    proposed.push({approvalId: turn.proposedChange.approvalId, bundleType: turn.proposedChange.bundleType});
  }
  return {
    unsupportedRequests: unsupported,
    stopConditions: turn.stopConditions.map((s) => ({code: s.code})),
    suggestions: [...turn.suggestions],
    proposedChanges: proposed,
    progress: {answered: turn.progress.answered, required: turn.progress.required},
  };
}

/** Reads stored notes defensively. Anything malformed gives the empty notes. */
export function parseNotes(raw: string | null): TurnNotes {
  if (!raw) return EMPTY_NOTES;
  try {
    const value = JSON.parse(raw) as Partial<TurnNotes>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const stops = Array.isArray(value.stopConditions)
      ? value.stopConditions.filter((s): s is {code: string} => !!s && typeof (s as {code?: unknown}).code === 'string')
      : [];
    const proposed = Array.isArray(value.proposedChanges)
      ? value.proposedChanges.filter(
          (p): p is {approvalId: string; bundleType: string} =>
            !!p && typeof (p as {approvalId?: unknown}).approvalId === 'string' && typeof (p as {bundleType?: unknown}).bundleType === 'string',
        )
      : [];
    const progress =
      value.progress && typeof value.progress.answered === 'number' && typeof value.progress.required === 'number'
        ? {answered: value.progress.answered, required: value.progress.required}
        : undefined;
    return {
      unsupportedRequests: strings(value.unsupportedRequests),
      stopConditions: stops.map((s) => ({code: s.code})),
      suggestions: strings(value.suggestions),
      proposedChanges: proposed.map((p) => ({approvalId: p.approvalId, bundleType: p.bundleType})),
      ...(progress ? {progress} : {}),
    };
  } catch {
    return EMPTY_NOTES;
  }
}

// ------------------------------------------------------------ labels

export const TEMPLATE_LABELS: Record<AgentSpec['template'], string> = {
  restaurant_order_taker: 'Restaurant order taker',
  appointment_booker: 'Appointment booker',
  custom: 'Custom agent',
};

export const SCOPE_LABELS: Record<AgentSpec['knowledgeScopes'][number], string> = {
  business_profile: 'Business profile',
  catalog: 'Catalog',
  hours: 'Hours',
  order_policies: 'Order policies',
  services: 'Services',
  faq: 'Questions and answers',
};

export const CHANNEL_LABELS: Record<AgentSpec['channel'], string> = {phone: 'Phone'};

export const ESCALATION_LABELS: Record<AgentSpec['escalation'], string> = {
  explain_unsupported_or_offer_callback: 'Explains what it cannot do and offers a callback',
};

export const WRITE_POLICY_LABELS: Record<AgentSpec['writePolicy'], string> = {
  owner_approval_each_action_bundle: 'You approve every action before it runs',
};

export const BUNDLE_LABELS: Record<string, string> = {
  fact_edit: 'Business fact change',
  price_edit: 'Price change',
  order_bundle: 'Order',
  booking_bundle: 'Booking',
};

/**
 * Questions for the missing field keys the builder uses today. The contract
 * does not list these keys, so any other key falls back to a readable form of
 * the key itself.
 */
const FIELD_QUESTIONS: Record<string, string> = {
  'hours.weekday_close': 'What is the latest weekday pickup time?',
  'policy.pickup_window': 'How long until an order is ready for pickup?',
  'policy.special_requests': 'Can callers add special requests?',
  'policy.message_consent': 'How should customers get messages, and with what consent?',
  'approval.behavior': 'Do you accept approving each order before it runs?',
  services: 'Which services should the agent offer?',
  'service.durations': 'How long does each service take?',
  'service.buffer': 'Do you want a buffer between appointments?',
  'policy.minimum_notice': 'How much notice do you need before an appointment?',
  // Keys the real builder sends (apps/server/src/builder/session/requirements.ts, RULES).
  'hours.mon': 'What are your opening hours on Monday?',
  'hours.tue': 'What are your opening hours on Tuesday?',
  'hours.wed': 'What are your opening hours on Wednesday?',
  'hours.thu': 'What are your opening hours on Thursday?',
  'hours.fri': 'What are your opening hours on Friday?',
  'hours.sat': 'What are your opening hours on Saturday?',
  'hours.sun': 'What are your opening hours on Sunday?',
  'catalog.items': 'Should the agent use your Square catalog, or will you upload a menu?',
  'policy.min_notice': 'How much notice do you need before an appointment?',
  name: 'What should the agent be called?',
  goal: 'In one sentence, what should the agent do?',
};

export function humanizeKey(key: string): string {
  const words = key
    .split(/[._\s]+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function missingFieldQuestion(key: string): string {
  return FIELD_QUESTIONS[key] ?? humanizeKey(key);
}

/**
 * Stop condition codes are not listed in the contract. These are the codes the
 * builder sends (apps/server/src/builder/session/requirements.ts,
 * BuilderStopCondition). Any other code falls back to a readable form of it.
 */
const STOP_LABELS: Record<string, string> = {
  missing_timezone: 'The business has no timezone.',
  open_conflict: 'Two sources disagree on a fact the agent needs. Resolve the conflict in Business Knowledge.',
  missing_message_consent_policy:
    'The agent sends text messages, but there is no message consent policy. Answer the consent question here or add it in Business Knowledge.',
  empty_catalog: 'The catalog has no items. Sync it from Square or upload a menu in Business Knowledge.',
  missing_required_fact: 'A required answer is not confirmed yet. Confirm it in the chat or in Approvals.',
};

const STOP_LINKS: Record<string, {label: string; href: string}> = {
  missing_timezone: {label: 'Open Settings', href: '/settings'},
  open_conflict: {label: 'Resolve in Business Knowledge', href: '/knowledge'},
  missing_message_consent_policy: {label: 'Open Business Knowledge', href: '/knowledge'},
  empty_catalog: {label: 'Open Business Knowledge', href: '/knowledge'},
  missing_required_fact: {label: 'Open Approvals', href: '/approvals'},
};

export function stopConditionLabel(code: string): string {
  return STOP_LABELS[code] ?? humanizeKey(code);
}

/** Where the owner fixes a stop condition, or null for a code the web app does not know. */
export function stopConditionLink(code: string): {label: string; href: string} | null {
  return STOP_LINKS[code] ?? null;
}

/**
 * The stop conditions that keep Continue off. Every other code (the consent
 * policy, an empty catalog, a required fact that is not verified yet, and any
 * code the web app does not know) is needed before publish only: the server
 * refuses the publish and the Publish panel explains each one.
 */
export const BLOCKING_STOP_CODES: readonly string[] = ['missing_timezone', 'open_conflict'];

export type StopLine = {key: string; code: string; label: string; link: {label: string; href: string} | null};

const REQUIRED_FACT = 'missing_required_fact';

function requiredFactsLabel(count: number): string {
  return count === 1
    ? '1 required answer is not confirmed yet. Confirm it in the chat or in Approvals.'
    : `${count} required answers are not confirmed yet. Confirm each one in the chat or in Approvals.`;
}

/**
 * One line per stop condition code, split into the ones that block the draft
 * and the ones needed before publish. The contract carries only `code`, so the
 * missing_required_fact entries cannot be told apart: they become one counted
 * line. Repeated codes show once.
 */
export function groupStopConditions(stops: readonly {code: string}[]): {blocking: StopLine[]; beforePublish: StopLine[]} {
  const blocking: StopLine[] = [];
  const beforePublish: StopLine[] = [];
  const seen = new Set<string>();
  const requiredCount = stops.filter((s) => s.code === REQUIRED_FACT).length;
  for (const {code} of stops) {
    if (seen.has(code)) continue;
    seen.add(code);
    const line: StopLine = {
      key: code,
      code,
      label: code === REQUIRED_FACT ? requiredFactsLabel(requiredCount) : stopConditionLabel(code),
      link: stopConditionLink(code),
    };
    (BLOCKING_STOP_CODES.includes(code) ? blocking : beforePublish).push(line);
  }
  return {blocking, beforePublish};
}

// ------------------------------------------------------------ send errors

export type BuilderSendErrorView = {
  title: string;
  description: string;
  tone: 'warning' | 'error';
  /** Offer "Send again" with the same text, even when the server marked the code not retryable. */
  canRetry: boolean;
  /** Refetch the session first: the server changed it while the turn ran. */
  refreshSession: boolean;
  /** The session cannot take more messages. Only then should the screen offer a new session. */
  sessionBroken: boolean;
};

/**
 * What a failed sendBuilderMessage means for the owner. The failed text is
 * always kept in the pending bubble, so every view says it can be sent again
 * when that is true.
 */
export function builderSendErrorView(error: ApiError): BuilderSendErrorView {
  if (error.code === 'INVALID_STATE') {
    const state = typeof error.details?.state === 'string' ? error.details.state : undefined;
    // "This builder session changed while the message was handled. Send it again."
    // carries the session's current status, which is still "active".
    if (state === undefined || state === 'active') {
      return {
        title: 'Send your message again',
        description: 'The session changed while your message was handled, so the builder did not use it. Your message was not lost: it is kept below, so you can send it again.',
        tone: 'warning',
        canRetry: true,
        refreshSession: true,
        sessionBroken: false,
      };
    }
    return {
      title: 'This builder session is closed',
      description: 'It cannot take more messages. Start a new session to keep building.',
      tone: 'error',
      canRetry: false,
      refreshSession: true,
      sessionBroken: true,
    };
  }
  if (error.code === 'INTEGRATION_UNAVAILABLE') {
    const raw = typeof error.details?.provider === 'string' ? error.details.provider : null;
    const name = raw ? ((PROVIDER_LABELS as Record<string, string>)[raw] ?? raw) : 'The builder';
    return {
      title: 'The builder is not available right now',
      description: `${name} is not responding. Your message is kept below, so you can send it again.`,
      tone: 'warning',
      canRetry: true,
      refreshSession: false,
      sessionBroken: false,
    };
  }
  return {
    title: 'Your message was not sent',
    description: error.message,
    tone: 'error',
    canRetry: error.retryable,
    refreshSession: false,
    sessionBroken: false,
  };
}

export const EXAMPLE_PROMPTS: readonly string[] = [
  'I run a pizza shop and want an AI that takes pickup orders',
  'Book haircut appointments for my barbershop',
  'Answer questions about our hours and menu',
];

export const FIRST_PROMPT = 'What would you like an agent to do for your business?';
