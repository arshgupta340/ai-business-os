import {
  type AgentSpec,
  type BuilderMessage,
  type BuilderSession,
  type BuilderTurnResponse as ContractBuilderTurnResponse,
  type BusinessFact,
  type DraftAgentSpec,
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
import { apiError, newId } from '../util';
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
// compose/builder.ts ProposeFactFromChat plus `fromVersion` and `before`, which
// the builder knows: 0 and null for a new key, else the verified fact's
// version and value. A function that ignores those two still fits.
export interface ProposeFactFromChatInput {
  businessId: string;
  ownerUserId: string;
  kind: BusinessFact['kind'];
  key: string;
  value: JsonValue;
  reason?: string;
  fromVersion: number;
  before: JsonValue | null;
}
export type ProposeFactFromChat = (input: ProposeFactFromChatInput) => Promise<{ approvalId: string; bundleType: 'fact_edit' }>;

const CONFIRM_PENDING = 'I saved your answer as a draft, but I could not open the confirmation for it just now, so it still needs your confirmation.';

export interface BuilderSessionDeps {
  sessions: BuilderSessionStore;
  agents: AgentDraftStore;
  draftFacts: DraftFactStore;
  knowledge: BusinessKnowledge;
  model: BuilderModel;
  now: () => Date;
  // Optional. Without it, chat answers stay drafts and no approval is created.
  proposeFactFromChat?: ProposeFactFromChat;
}

export class BuilderSessionService {
  constructor(private readonly deps: BuilderSessionDeps) {}

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

  async message(businessId: string, sessionId: string, input: { text: string; inputMode: 'text' | 'voice' }): Promise<BuilderTurnResponse> {
    const session = await this.load(businessId, sessionId);
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

    // Answers count only for fields that were missing and can be answered in chat.
    // With proposeFactFromChat, an answer that changes a verified fact is
    // also kept, so the owner can confirm the change (API.md facts/propose).
    const propose = this.deps.proposeFactFromChat;
    const newDrafts: BusinessFact[] = [];
    const replaces = new Map<string, BusinessFact>();
    for (const answer of out.answers) {
      const rule = fieldRule(answer.field);
      const value = answer.value.trim().slice(0, LIMITS.answer);
      if (!rule?.answerableInChat || !value) continue;
      if (newDrafts.some((f) => `${f.kind}.${f.key}` === answer.field)) continue;
      if (before.missing.includes(answer.field)) {
        newDrafts.push(this.draftFact(businessId, sessionId, answer.field, value));
        continue;
      }
      const verified = propose ? verifiedFact(context, answer.field) : undefined;
      if (!verified || sameValue(verified.value, value) || priorDrafts.some((f) => `${f.kind}.${f.key}` === answer.field)) continue;
      const draft = this.draftFact(businessId, sessionId, answer.field, value);
      replaces.set(draft.id, verified);
      newDrafts.push(draft);
    }
    for (const fact of newDrafts) await this.deps.draftFacts.insertDraft(fact);

    // Each saved draft opens a fact_edit approval. The turn reports the first
    // one. A failed call keeps the draft and says confirmation is pending.
    let proposedChange: BuilderTurnResponse['proposedChange'];
    let confirmPending = false;
    if (propose) {
      for (const fact of newDrafts) {
        const current = replaces.get(fact.id);
        try {
          const created = await propose({
            businessId,
            ownerUserId: session.ownerId,
            kind: fact.kind,
            key: fact.key,
            value: fact.value,
            reason: 'Owner answer in the builder chat.',
            fromVersion: current ? current.version : 0,
            before: current ? current.value : null,
          });
          proposedChange ??= { approvalId: created.approvalId, bundleType: created.bundleType };
        } catch {
          confirmPending = true;
        }
      }
    }

    const after = computeFieldStatus(nextSpec, context, [...priorDrafts, ...newDrafts]);
    const composed = composeReply(out.reply, unsupportedRequests, after, dropped);
    const replyText = confirmPending ? `${composed} ${CONFIRM_PENDING}` : composed;

    const reply: BuilderMessage = {
      id: newId('bmsg_'),
      sessionId,
      role: 'assistant',
      inputMode: input.inputMode,
      text: replyText,
      ...(Object.keys(patch).length > 0 ? { specPatch: patch } : {}),
      ...(after.evidence.length > 0 ? { evidenceRefs: after.evidence } : {}),
      createdAt: this.timestamp(),
    };

    session.messages.push(ownerMessage, reply);
    session.draftSpec = nextSpec;
    session.missingFields = after.missing;
    session.updatedAt = reply.createdAt;
    await this.deps.sessions.update(session);
    await this.writeAgentDraft(session);

    return {
      reply,
      draftSpec: nextSpec,
      missingFields: after.missing,
      suggestions: suggestions(after),
      stopConditions: stopConditions(nextSpec, context, after),
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

  private draftFact(businessId: string, sessionId: string, field: string, text: string): BusinessFact {
    const dot = field.indexOf('.');
    const now = this.timestamp();
    return {
      id: newId('fact_'),
      businessId,
      kind: field.slice(0, dot) as BusinessFact['kind'],
      key: field.slice(dot + 1),
      // The owner's words, kept as text. Turning them into a typed value is
      // the owner's confirm step, not the model's.
      value: { text },
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
  return { ...rest, missingFields: status.missing, progress: progress(status) };
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
