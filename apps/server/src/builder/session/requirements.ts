import { HoursKeySchema, type BusinessFact, type CapabilityId, type DraftAgentSpec, type StopCondition } from '@abos/contracts';
import type { BusinessContext } from './knowledge';

// Missing-field computation (FLOWS.md step A6): the union of the details each
// chosen capability needs, minus what is already known. A field name is
// "kind.key" for a fact (API.md example: "policy.pickup_window"), or a spec
// field name.

export interface FieldRule {
  field: string;
  // True when the owner can answer it in chat. The answer is saved as a draft
  // owner_chat fact. Catalog and services come from Square or an upload.
  answerableInChat: boolean;
  question: string;
}

const DAY_KEYS = HoursKeySchema.options;

const hoursRules: FieldRule[] = DAY_KEYS.map((d) => ({
  field: `hours.${d}`,
  answerableInChat: true,
  question: `What are your opening hours on ${dayName(d)}?`,
}));

const RULES: Record<string, FieldRule> = Object.fromEntries(
  [
    ...hoursRules,
    { field: 'catalog.items', answerableInChat: false, question: 'Should the agent use your Square catalog, or will you upload a menu?' },
    { field: 'policy.pickup_window', answerableInChat: true, question: 'How many minutes after ordering can a customer pick up?' },
    { field: 'policy.special_requests', answerableInChat: true, question: 'Do you accept special requests on an order, such as "light sauce"?' },
    { field: 'policy.message_consent', answerableInChat: true, question: 'How should the agent ask the customer for consent before it sends them a text message?' },
    { field: 'policy.min_notice', answerableInChat: true, question: 'How much notice do you need before an appointment?' },
    { field: 'services', answerableInChat: false, question: 'Which services do you offer, and how long does each take? You can upload a service list.' },
    { field: 'name', answerableInChat: false, question: 'What should the agent be called?' },
    { field: 'goal', answerableInChat: false, question: 'In one sentence, what should the agent do?' },
  ].map((r) => [r.field, r]),
);

// Which details each capability needs before it can run on a call.
const CAPABILITY_FIELDS: Partial<Record<CapabilityId, string[]>> = {
  'business.facts.read': DAY_KEYS.map((d) => `hours.${d}`),
  'catalog.read': ['catalog.items'],
  'order.quote': ['catalog.items'],
  'order.propose': ['policy.pickup_window', 'policy.special_requests'],
  'message.checkout.send': ['policy.message_consent'],
  'calendar.availability.read': ['services'],
  'booking.propose': ['policy.min_notice'],
  'message.booking.confirm': ['policy.message_consent'],
};

const SPEC_FIELDS = ['name', 'goal'] as const;

export function fieldRule(field: string): FieldRule | undefined {
  return RULES[field];
}

export function requiredFields(spec: DraftAgentSpec): string[] {
  if (!spec.template) return [];
  const out: string[] = [];
  const add = (f: string) => {
    if (!out.includes(f)) out.push(f);
  };
  for (const f of SPEC_FIELDS) add(f);
  for (const id of spec.capabilities ?? []) for (const f of CAPABILITY_FIELDS[id] ?? []) add(f);
  return out;
}

export interface FieldStatus {
  required: string[];
  missing: string[];
  // fact_ IDs that satisfied a field, for BuilderMessage.evidenceRefs.
  evidence: string[];
}

export function computeFieldStatus(
  spec: DraftAgentSpec,
  context: BusinessContext,
  sessionDrafts: readonly BusinessFact[],
): FieldStatus {
  const required = requiredFields(spec);
  const missing: string[] = [];
  const evidence: string[] = [];
  const facts = [...context.verifiedFacts, ...sessionDrafts];
  for (const field of required) {
    const found = satisfiedBy(field, spec, context, facts);
    if (found === false) missing.push(field);
    else if (typeof found === 'string' && !evidence.includes(found)) evidence.push(found);
  }
  return { required, missing, evidence };
}

// false: missing. true: satisfied with no fact to cite. string: the fact ID.
function satisfiedBy(field: string, spec: DraftAgentSpec, context: BusinessContext, facts: readonly BusinessFact[]): boolean | string {
  if (field === 'name') return Boolean(spec.name);
  if (field === 'goal') return Boolean(spec.goal);
  if (field === 'catalog.items') return context.catalogItemCount > 0;
  if (field === 'services') return facts.find((f) => f.kind === 'service')?.id ?? false;
  const dot = field.indexOf('.');
  const kind = field.slice(0, dot);
  const key = field.slice(dot + 1);
  return facts.find((f) => f.kind === kind && f.key === key)?.id ?? false;
}

// PRD section 6 stop conditions that the builder can see during the interview.
// The codes are the builder's own (API.md gives only "missing_timezone"). The
// contract's StopCondition is `{ code }`; `conflictIds` is an extra field the
// builder sends with `open_conflict` (see docs/notes-saina.md).
export interface BuilderStopCondition extends StopCondition {
  code: 'missing_timezone' | 'open_conflict' | 'missing_message_consent_policy';
  conflictIds?: string[];
}

export function stopConditions(spec: DraftAgentSpec, context: BusinessContext, status: FieldStatus): BuilderStopCondition[] {
  const out: BuilderStopCondition[] = [];
  if (!context.profile.timezone) out.push({ code: 'missing_timezone' });
  if (context.openRequiredConflictIds.length > 0) out.push({ code: 'open_conflict', conflictIds: [...context.openRequiredConflictIds] });
  const sendsMessages = (spec.capabilities ?? []).some((c) => c === 'message.checkout.send' || c === 'message.booking.confirm');
  if (sendsMessages && status.missing.includes('policy.message_consent')) out.push({ code: 'missing_message_consent_policy' });
  return out;
}

export function suggestions(status: FieldStatus): string[] {
  const out: string[] = [];
  if (status.missing.includes('catalog.items')) out.push('Upload menu', 'Use Square catalog');
  if (status.missing.includes('services')) out.push('Upload service list');
  return out;
}

function dayName(d: string): string {
  return { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }[d] ?? d;
}
