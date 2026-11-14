import {
  ErrorCodeSchema,
  type AgentSpec,
  type BuilderMessage,
  type BuilderSession,
  type BuilderTurnResponse as ContractBuilderTurnResponse,
  type BusinessFact,
  type DraftAgentSpec,
  type ErrorCode,
  type JsonValue,
} from '@abos/contracts';
import { BuilderAgentSpecSchema } from '../spec';
import { toPlainSpokenText } from '../runner/plain-text';
import {
  fitCapabilitySet,
  knowledgeScopesForCapabilities,
  splitRequestedCapabilities,
  TEMPLATE_CAPABILITIES,
  TEMPLATE_KNOWLEDGE_SCOPES,
  type CapabilitySetFit,
} from '../registry';
import { KeyedLock } from '../publish/lock';
import { apiError, newId } from '../util';
import { readableFactValue, sameFactMeaning, typedFactValue } from './fact-values';
import type { BusinessContext, BusinessKnowledge } from './knowledge';
import { BuilderModelUnavailable, BuilderTurnOutputSchema, type BuilderModel, type BuilderTurnOutput } from './model';
import { computeFieldStatus, fieldRule, stopConditions, suggestions, type BuilderStopCondition, type FieldStatus } from './requirements';
import type { AgentDraftStore, BuilderSessionRecord, BuilderSessionStore, DraftFactStore } from './stores';

export const OPENING_QUESTION = 'What would you like an agent to do for your business?';

const LIMITS = { reply: 2000, name: 80, goal: 300, greeting: 300, answer: 500, unsupported: 120 } as const;
const AI_DISCLOSURE = /\b(AI|artificial intelligence)\b/i;

// The session as API.md 3.3 returns it (the package's BuilderSession).
export type BuilderSessionView = BuilderSession;

// The package's BuilderTurnResponse. `proposedChange` is present only when a
// turn created a fact_edit approval through `proposeFactFromChat`.
export type BuilderTurnResponse = ContractBuilderTurnResponse & { stopConditions: BuilderStopCondition[] };

// Creates a fact_edit approval for an owner's chat answer (P-09). The server
// composition passes the approval engine's version. The input is the shape of
// compose/builder.ts ProposeFactFromChat plus three fields the builder knows:
//   new key:      subjectId is the draft fact row (its value equals `value`),
//                 fromVersion 0, before null (migration 0005).
//   existing key: subjectId is the verified fact, with its version and value.
// `value` is always typed for its readers (fact-values.ts), never a text blob.
// The same draft always gives the same subjectId, so the engine can find an
// approval it already opened for it. A function that ignores the extra fields
// still fits.
export interface ProposeFactFromChatInput {
  businessId: string;
  ownerUserId: string;
  kind: BusinessFact['kind'];
  key: string;
  value: JsonValue;
  reason?: string;
  subjectId: string;
  fromVersion: number;
  before: JsonValue | null;
}
export type ProposeFactFromChat = (input: ProposeFactFromChatInput) => Promise<{ approvalId: string; bundleType: 'fact_edit' }>;

const CONFIRM_PENDING = 'I saved your answer as a draft, but I could not open the confirmation for it just now, so it still needs your confirmation. I will try again on your next message.';
const CONFIRM_REFUSED = 'I saved your answer as a draft, but this change could not be sent for your confirmation.';

// Proposal errors that another try will not fix: the fact or the approval
// target is gone, is in a state that refuses the change, or the engine refuses
// the change itself (the value equals the current one, the fact changed since
// it was read, or the kind cannot be edited as a fact). The draft is kept, but
// it is not proposed again unless the owner repeats or corrects it.
const REFUSED_CODES: ReadonlySet<ErrorCode> = new Set(['INVALID_STATE', 'NOT_FOUND', 'VALIDATION_FAILED', 'CAPABILITY_NOT_ALLOWED']);

// An approval expires 10 minutes after it is created (SPEC 2.9). After that,
// repeating the same answer opens a new one.
const APPROVAL_EXPIRY_MS = 10 * 60_000;

// What the builder records about a proposal, on the stored assistant message of
// the turn that made it. The session's messages are stored whole, so the
// record survives a restart. It is removed from every message the API returns.
// A refused record has no approval: the engine refused the proposal with a
// code in REFUSED_CODES.
interface ProposalRecord {
  factId: string;
  approvalId?: string;
  refused?: ErrorCode;
  proposedAt: string;
}
type StoredMessage = BuilderMessage & { proposals?: ProposalRecord[] };

export interface BuilderSessionDeps {
  sessions: BuilderSessionStore;
  agents: AgentDraftStore;
  draftFacts: DraftFactStore;
  knowledge: BusinessKnowledge;
  model: BuilderModel;
  now: () => Date;
  // Optional. Without it, chat answers stay drafts and no approval is created.
  proposeFactFromChat?: ProposeFactFromChat;
  // Optional. Gets error codes only, never a value or the owner's words.
  log?: SessionLogger;
}

export interface SessionLogger {
  warn(fields: { code: string; step: string }, message: string): void;
}

const silent: SessionLogger = { warn() {} };

export class BuilderSessionService {
  // One turn per session at a time, in this process (see message()).
  private readonly turns = new KeyedLock();
  // Proposal records whose session write failed, per session, so the next
  // turn in this process neither proposes them again nor loses them. They are
  // written with that turn's reply. A restart loses them (see turn()).
  private readonly unrecorded = new Map<string, ProposalRecord[]>();
  private readonly log: SessionLogger;

  constructor(private readonly deps: BuilderSessionDeps) {
    this.log = deps.log ?? silent;
  }

  async create(input: { businessId: string; ownerId: string; agentId?: string }): Promise<BuilderSessionView> {
    const context = await this.context(input.businessId);
    let draftSpec: DraftAgentSpec = {};
    if (input.agentId) {
      const agent = await this.deps.agents.get(input.businessId, input.agentId);
      if (!agent) throw apiError('NOT_FOUND', 'Agent not found.');
      draftSpec = structuredClone(agent.draftSpec);
    }
    const now = this.timestamp();
    const id = newId('bld_');
    const status = computeFieldStatus(draftSpec, context, []);
    const session: BuilderSessionRecord = {
      id,
      businessId: input.businessId,
      ownerId: input.ownerId,
      status: 'active',
      messages: [{ id: newId('bmsg_'), sessionId: id, role: 'assistant', inputMode: 'text', text: OPENING_QUESTION, createdAt: now }],
      draftSpec,
      missingFields: status.missing,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.sessions.insert(session);
    return view(session, status);
  }

  async get(businessId: string, id: string): Promise<BuilderSessionView> {
    const session = await this.load(businessId, id);
    const status = computeFieldStatus(session.draftSpec, await this.context(businessId), await this.deps.draftFacts.listBySession(businessId, id));
    return view(session, status);
  }

  // Turns for one session run one at a time in this process, so two answers
  // sent together cannot both read "no draft yet" or overwrite each other's
  // messages. The session store has no revision column, so across processes
  // the builder only refuses a write when the stored session changed since it
  // was read (a check, not an atomic compare and swap).
  async message(businessId: string, sessionId: string, input: { text: string; inputMode: 'text' | 'voice' }): Promise<BuilderTurnResponse> {
    return this.turns.run(`${businessId}:${sessionId}`, () => this.turn(businessId, sessionId, input));
  }

  private async turn(businessId: string, sessionId: string, input: { text: string; inputMode: 'text' | 'voice' }): Promise<BuilderTurnResponse> {
    const session = await this.load(businessId, sessionId);
    const loadedAt = session.updatedAt;
    if (session.status !== 'active') throw apiError('INVALID_STATE', 'This builder session is closed.', { state: session.status });
    const context = await this.context(businessId);
    const priorDrafts = await this.deps.draftFacts.listBySession(businessId, sessionId);
    const before = computeFieldStatus(session.draftSpec, context, priorDrafts);

    const ownerMessage: BuilderMessage = {
      id: newId('bmsg_'),
      sessionId,
      role: 'owner',
      inputMode: input.inputMode,
      text: input.text,
      createdAt: this.timestamp(),
    };

    // One model call. Its output is untrusted until validated below.
    let raw: unknown;
    try {
      raw = await this.deps.model.turn({
        businessName: context.profile.name,
        ownerText: input.text,
        history: session.messages.map(({ role, text }) => ({ role, text })),
        draftSpec: session.draftSpec,
        missingFields: before.missing,
        knownFacts: [...context.verifiedFacts, ...priorDrafts].map(({ kind, key, value }) => ({ kind, key, value })),
      });
    } catch (error) {
      if (error instanceof BuilderModelUnavailable) {
        throw apiError('INTEGRATION_UNAVAILABLE', 'The builder model is not available right now. Try again.', { provider: 'openai' });
      }
      throw error;
    }
    const parsed = BuilderTurnOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw apiError('INTEGRATION_UNAVAILABLE', 'The builder model returned an answer that did not pass validation.', { provider: 'openai' });
    }
    const out = parsed.data;

    // Registry check: anything not registered is removed and reported.
    const split = splitRequestedCapabilities(out.capabilityIds);
    const unsupportedRequests = dedupe([...out.unsupportedRequests, ...split.unsupported].map((s) => s.trim().slice(0, LIMITS.unsupported)).filter(Boolean));

    const { spec: nextSpec, patch, dropped } = mergeSpec(session.draftSpec, out, split.allowed, context);

    // Answers count only for fields that can be answered in chat. Without
    // proposeFactFromChat, only a field that was missing before the turn takes
    // an answer, kept as the owner's text (as before). With it, the answer is
    // typed for its readers, and an answer may also change a verified fact or
    // correct an earlier draft; each saved draft then opens a fact_edit.
    const propose = this.deps.proposeFactFromChat;
    const lockKey = `${businessId}:${sessionId}`;
    const carried = this.unrecorded.get(lockKey) ?? [];
    const ledger = proposalLedger(session.messages, carried);
    const newDrafts: BusinessFact[] = [];
    const repeated = new Set<string>();
    const hints: string[] = [];
    for (const answer of out.answers) {
      const rule = fieldRule(answer.field);
      const value = answer.value.trim().slice(0, LIMITS.answer);
      if (!rule?.answerableInChat || !value) continue;
      if (newDrafts.some((f) => fieldOf(f) === answer.field)) continue;
      if (!propose) {
        if (before.missing.includes(answer.field)) newDrafts.push(this.draftFact(businessId, sessionId, answer.field, { text: value }));
        continue;
      }
      const latest = latestDraft(priorDrafts, answer.field);
      const verified = verifiedFact(context, answer.field);
      if (!before.missing.includes(answer.field) && !latest && !verified) continue;
      const typed = typedFactValue(answer.field, value);
      if (!typed.ok) {
        if (!hints.includes(typed.hint)) hints.push(typed.hint);
        continue;
      }
      if (latest && sameFactMeaning(answer.field, latest.value, typed.value)) {
        repeated.add(latest.id);
        continue;
      }
      if (!latest && verified && (sameFactMeaning(answer.field, verified.value, typed.value) || sameValue(verified.value, value))) continue;
      newDrafts.push(this.draftFact(businessId, sessionId, answer.field, typed.value));
    }
    for (const fact of newDrafts) await this.deps.draftFacts.insertDraft(fact);

    // What to propose this turn: the latest draft of each field that has a
    // typed value and no open approval. That covers a new draft, a draft whose
    // proposal failed on an earlier turn, and a repeated answer whose approval
    // has expired. A draft replaced by a correction is never proposed.
    const toPropose: BusinessFact[] = [];
    if (propose) {
      const latestByField = new Map<string, BusinessFact>();
      for (const f of [...priorDrafts, ...newDrafts]) latestByField.set(fieldOf(f), f);
      for (const [field, draft] of latestByField) {
        if (!readableFactValue(field, draft.value)) continue;
        const verified = verifiedFact(context, field);
        if (verified && sameFactMeaning(field, verified.value, draft.value)) continue;
        const record = ledger.get(draft.id);
        if (record?.refused) {
          // Refused for good: tried again only when the owner repeats it.
          if (!repeated.has(draft.id)) continue;
        } else if (record) {
          const expired = this.deps.now().getTime() - Date.parse(record.proposedAt) > APPROVAL_EXPIRY_MS;
          if (!(expired && repeated.has(draft.id))) continue;
        }
        toPropose.push(draft);
      }
    }
    const after = computeFieldStatus(nextSpec, context, [...priorDrafts, ...newDrafts]);
    const composed = [composeReply(out.reply, unsupportedRequests, after, dropped), ...hints].join(' ');

    const reply: StoredMessage = {
      id: newId('bmsg_'),
      sessionId,
      role: 'assistant',
      inputMode: input.inputMode,
      text: composed,
      ...(Object.keys(patch).length > 0 ? { specPatch: patch } : {}),
      ...(after.evidence.length > 0 ? { evidenceRefs: after.evidence } : {}),
      // Records an earlier turn could not write go with this reply.
      ...(carried.length > 0 ? { proposals: [...carried] } : {}),
      createdAt: this.timestamp(),
    };

    // The owner's turn is written before any approval is opened, so a failed
    // session write leaves no approval behind; its drafts are proposed on the
    // next turn.
    const current = await this.deps.sessions.get(businessId, sessionId);
    if (current && current.updatedAt !== loadedAt) {
      throw apiError('INVALID_STATE', 'This builder session changed while the message was handled. Send it again.', { state: current.status });
    }
    session.messages.push(ownerMessage, reply);
    session.draftSpec = nextSpec;
    session.missingFields = after.missing;
    session.updatedAt = reply.createdAt;
    await this.deps.sessions.update(session);
    this.unrecorded.delete(lockKey);
    await this.writeAgentDraft(session);

    // One fact_edit approval per turn: the contract carries one
    // proposedChange, so a second approval made now would never be shown in
    // the chat. The loop stops at the first success. A draft after it has no
    // record yet, so the next turn proposes it (the selection above).
    // A retryable failure keeps the draft and marks nothing, so a later turn
    // tries again, and the loop moves on to the next draft. A refusal
    // (REFUSED_CODES) is recorded, so it is not retried on every turn.
    let proposedChange: BuilderTurnResponse['proposedChange'];
    let confirmPending = false;
    let confirmRefused = false;
    const made: ProposalRecord[] = [];
    if (propose) {
      for (const fact of toPropose) {
        const verified = verifiedFact(context, fieldOf(fact));
        try {
          const created = await propose({
            businessId,
            ownerUserId: session.ownerId,
            kind: fact.kind,
            key: fact.key,
            value: fact.value,
            reason: 'Owner answer in the builder chat.',
            subjectId: verified ? verified.id : fact.id,
            fromVersion: verified ? verified.version : 0,
            before: verified ? verified.value : null,
          });
          made.push({ factId: fact.id, approvalId: created.approvalId, proposedAt: this.timestamp() });
          proposedChange = { approvalId: created.approvalId, bundleType: created.bundleType };
          break;
        } catch (error) {
          const code = errorCode(error);
          this.log.warn({ code: code ?? 'unknown', step: 'propose_fact_from_chat' }, 'builder chat proposal failed');
          if (code && REFUSED_CODES.has(code)) {
            made.push({ factId: fact.id, refused: code, proposedAt: this.timestamp() });
            confirmRefused = true;
          } else {
            confirmPending = true;
          }
        }
      }
    }
    if (made.length > 0 || confirmPending || confirmRefused) {
      if (made.length > 0) reply.proposals = [...(reply.proposals ?? []), ...made];
      if (confirmRefused) reply.text = `${reply.text} ${CONFIRM_REFUSED}`;
      if (confirmPending) reply.text = `${reply.text} ${CONFIRM_PENDING}`;
      // The approval already exists, so a failed write here must not turn
      // the turn into an error: the owner would see a 500 and the approval
      // would never reach the chat. The records are kept in this process
      // and written with the next turn, so the next turn does not open a
      // duplicate. What remains: after a restart (or on another process)
      // before that next write, the record is lost and the next turn opens a
      // second approval for the same subject. Closing that needs the engine
      // to return the open approval for a subjectId, or one transaction
      // across the proposal and the session write; neither is in this folder.
      // The reply text change is lost with the failed write as well.
      try {
        await this.deps.sessions.update(session);
      } catch (error) {
        this.log.warn({ code: errorCode(error) ?? 'unknown', step: 'record_proposals' }, 'builder proposal record was not written');
        // The first write above already stored the carried records.
        if (made.length > 0) this.unrecorded.set(lockKey, made);
      }
    }

    return {
      reply: publicMessage(reply),
      draftSpec: nextSpec,
      missingFields: after.missing,
      suggestions: suggestions(after),
      // What publish would refuse on (verified facts only), plus open_conflict.
      stopConditions: stopConditions(nextSpec, context),
      progress: progress(after),
      unsupportedRequests,
      ...(proposedChange ? { proposedChange } : {}),
    };
  }

  // A session started with an agentId writes its draft to that agent (API.md 3.3).
  // Only a spec that passes the full AgentSpec schema is written.
  private async writeAgentDraft(session: BuilderSessionRecord): Promise<void> {
    if (!session.agentId) return;
    const agent = await this.deps.agents.get(session.businessId, session.agentId);
    if (!agent) return;
    const full = BuilderAgentSpecSchema.safeParse({ ...agent.draftSpec, ...session.draftSpec, id: agent.id, businessId: agent.businessId });
    if (!full.success) return;
    agent.draftSpec = full.data;
    agent.name = full.data.name;
    agent.template = full.data.template;
    agent.specRevision += 1;
    agent.updatedAt = session.updatedAt;
    await this.deps.agents.update(agent);
  }

  private draftFact(businessId: string, sessionId: string, field: string, value: JsonValue): BusinessFact {
    const dot = field.indexOf('.');
    const now = this.timestamp();
    return {
      id: newId('fact_'),
      businessId,
      kind: field.slice(0, dot) as BusinessFact['kind'],
      key: field.slice(dot + 1),
      // Without proposeFactFromChat, the owner's words kept as text. With it,
      // the typed value the approval proposes (the draft row is its subject).
      value,
      sourceType: 'owner_chat',
      sourceRef: sessionId,
      status: 'draft',
      // Owner edits are 1 (CONTRACTS.md), but this value went through the model.
      confidence: 0.8,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async load(businessId: string, id: string): Promise<BuilderSessionRecord> {
    const session = await this.deps.sessions.get(businessId, id);
    if (!session) throw apiError('NOT_FOUND', 'Builder session not found.');
    return session;
  }

  private async context(businessId: string): Promise<BusinessContext> {
    const context = await this.deps.knowledge.getContext(businessId);
    if (!context) throw apiError('NOT_FOUND', 'Business not found.');
    return context;
  }

  private timestamp(): string {
    return this.deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

// Merge one validated model output into the draft. Template sets come from the
// registry, never from the model. Returns the next draft and the fields that
// changed (BuilderMessage.specPatch).
export function mergeSpec(
  current: DraftAgentSpec,
  out: BuilderTurnOutput,
  allowedCapabilities: AgentSpec['capabilities'],
  context: BusinessContext,
): { spec: DraftAgentSpec; patch: DraftAgentSpec; dropped: CapabilitySetFit['dropped'] } {
  const spec: DraftAgentSpec = structuredClone(current);
  const patch: DraftAgentSpec = {};
  const set = <K extends keyof AgentSpec>(key: K, value: AgentSpec[K]) => {
    if (JSON.stringify(spec[key]) !== JSON.stringify(value)) {
      spec[key] = value;
      patch[key] = value;
    }
  };

  let dropped: CapabilitySetFit['dropped'] = [];
  const templateChanged = out.template !== null && out.template !== spec.template;
  if (out.template !== null) set('template', out.template);
  const template = spec.template;
  if (template) {
    // A known template starts from its registry set. Model requests can only
    // add registered IDs on top; they never remove the template's set. A
    // custom agent starts empty and holds only what the model selected.
    const templateSet = template === 'custom' ? [] : [...TEMPLATE_CAPABILITIES[template]];
    const base = templateChanged ? templateSet : (spec.capabilities ?? templateSet);
    // The set rules (registry.ts CAPABILITY_RULES) decide what stays. A
    // capability that breaks one is removed and the reply says why. Nothing
    // is added that neither the template nor the model named.
    const fit = fitCapabilitySet(dedupe([...base, ...allowedCapabilities]));
    dropped = fit.dropped;
    const capabilities = fit.kept;
    if (capabilities.length > 0) set('capabilities', capabilities);
    else if (spec.capabilities) {
      delete spec.capabilities;
      delete patch.capabilities;
    }

    set('channel', 'phone');
    set('writePolicy', 'owner_approval_each_action_bundle');
    set('escalation', 'explain_unsupported_or_offer_callback');
    set('guardrailVersion', 'v1');
    if (!spec.status) set('status', 'draft');
    set('businessId', context.profile.id);
    if (out.knowledgeScopes && out.knowledgeScopes.length > 0) set('knowledgeScopes', dedupe(out.knowledgeScopes));
    else if (template === 'custom') {
      // A custom agent's scopes follow from its capabilities.
      if (!spec.knowledgeScopes || templateChanged || 'capabilities' in patch) set('knowledgeScopes', knowledgeScopesForCapabilities(capabilities));
    } else if (!spec.knowledgeScopes || templateChanged) set('knowledgeScopes', [...TEMPLATE_KNOWLEDGE_SCOPES[template]]);
  }

  const name = clean(out.name, LIMITS.name);
  if (name) set('name', name);
  const goal = clean(out.goal, LIMITS.goal);
  if (goal) set('goal', goal);
  const greeting = clean(out.greeting, LIMITS.greeting);
  if (greeting && AI_DISCLOSURE.test(greeting)) set('greeting', greeting);
  else if (template && !spec.greeting) {
    set('greeting', `Hi, thanks for calling ${context.profile.name}. I am an AI assistant.`);
  }
  return { spec, patch, dropped };
}

// The reply always explains what was left out, in the builder's own words, and
// always asks about a missing field if the model's text did not ask anything.
export function composeReply(
  modelReply: string,
  unsupported: readonly string[],
  status: FieldStatus,
  dropped: CapabilitySetFit['dropped'] = [],
): string {
  // The reply is shown as plain text and may be read aloud (voice input), so
  // any Markdown the model wrote is removed before the builder adds its own lines.
  const parts = [toPlainSpokenText(modelReply).slice(0, LIMITS.reply)];
  if (unsupported.length > 0) {
    parts.push(`Not available, so it is not part of this agent: ${unsupported.join('; ')}.`);
  }
  for (const d of dropped) parts.push(`Left out of this agent: ${d.reason}`);
  if (status.missing.length > 0 && !parts[0]!.includes('?')) {
    const question = fieldRule(status.missing[0]!)?.question;
    if (question) parts.push(question);
  }
  return parts.filter(Boolean).join(' ');
}

function fieldOf(f: Pick<BusinessFact, 'kind' | 'key'>): string {
  return `${f.kind}.${f.key}`;
}

function latestDraft(drafts: readonly BusinessFact[], field: string): BusinessFact | undefined {
  return [...drafts].reverse().find((f) => fieldOf(f) === field);
}

function proposalLedger(messages: readonly StoredMessage[], carried: readonly ProposalRecord[]): Map<string, ProposalRecord> {
  const out = new Map<string, ProposalRecord>();
  for (const m of messages) for (const p of m.proposals ?? []) out.set(p.factId, p);
  for (const p of carried) out.set(p.factId, p);
  return out;
}

// The API error code of a thrown error (AppError, PolicyError), or undefined.
// Only a code from the contract's list is returned, so nothing else from the
// error reaches a log.
function errorCode(error: unknown): ErrorCode | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
  const parsed = ErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : undefined;
}

function publicMessage(m: StoredMessage): BuilderMessage {
  const { proposals: _proposals, ...rest } = m;
  return rest;
}

function verifiedFact(context: BusinessContext, field: string): BusinessFact | undefined {
  const dot = field.indexOf('.');
  if (dot < 0) return undefined;
  const kind = field.slice(0, dot);
  const key = field.slice(dot + 1);
  return context.verifiedFacts.find((f) => f.kind === kind && f.key === key && f.status === 'verified');
}

// An answer repeats a verified fact when its text equals the fact's text, or
// any text field of the fact's value (for example a consent policy's wording).
function sameValue(current: BusinessFact['value'], text: string): boolean {
  if (typeof current === 'string') return current.trim() === text;
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return Object.values(current).some((v) => typeof v === 'string' && v.trim() === text);
  }
  return false;
}

function view(session: BuilderSessionRecord, status: FieldStatus): BuilderSessionView {
  const { ownerId: _ownerId, ...rest } = session;
  return { ...rest, messages: rest.messages.map(publicMessage), missingFields: status.missing, progress: progress(status) };
}

function progress(status: FieldStatus) {
  return { answered: status.required.length - status.missing.length, required: status.required.length };
}

function clean(value: string | null, max: number): string | undefined {
  const v = value?.trim();
  return v ? v.slice(0, max) : undefined;
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
