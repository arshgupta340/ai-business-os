/**
 * Pure helpers for the version history screen: the spec diff between two
 * immutable AgentVersions, the rolled-back markers read from agent.published
 * events, the rollback rule and the rollback error messages. No React here,
 * so every rule is unit tested on its own.
 */
import {
  CAPABILITIES,
  payloadOf,
  type ActivityEvent,
  type Agent,
  type AgentSpec,
  type AgentVersion,
  type ApiError,
  type Effect,
  type CapabilityId,
} from '@/lib/api';
import type {Tone} from '@/lib/status';
import {
  ESCALATION_LABELS,
  groupCapabilities,
  isRegisteredCapability,
  SCOPE_LABELS,
  WRITE_POLICY_LABELS,
  type CapabilityGroupKey,
} from '../../../../build/_lib/spec';

export const NOT_SET = 'Not set';

// ------------------------------------------------------------ ordering

export function versionLabel(version: Pick<AgentVersion, 'version'>): string {
  return `Version ${version.version}`;
}

/** Returns the pair with the older version first, so "before" is always on the left. */
export function orderPair(a: AgentVersion, b: AgentVersion): [AgentVersion, AgentVersion] {
  return a.version <= b.version ? [a, b] : [b, a];
}

/**
 * The two versions the compare section opens with: the active version and
 * the one published just before it, or the two newest when the active one is
 * the oldest. Null when there are fewer than two versions.
 */
export function defaultPair(versions: readonly AgentVersion[], activeVersionId?: string): [string, string] | null {
  if (versions.length < 2) return null;
  const sorted = [...versions].sort((x, y) => y.version - x.version);
  const activeIndex = sorted.findIndex((v) => v.id === activeVersionId);
  if (activeIndex >= 0 && activeIndex < sorted.length - 1) {
    return [sorted[activeIndex + 1].id, sorted[activeIndex].id];
  }
  if (activeIndex === sorted.length - 1) {
    return [sorted[activeIndex].id, sorted[activeIndex - 1].id];
  }
  return [sorted[1].id, sorted[0].id];
}

// ------------------------------------------------------------ field diff

export type FieldKey = 'name' | 'goal' | 'greeting' | 'knowledgeScopes' | 'escalation' | 'writePolicy';

export type FieldDiff = {
  key: FieldKey;
  label: string;
  before: string;
  after: string;
  changed: boolean;
};

type Spec = Partial<AgentSpec>;

const text = (value: string | undefined) => (value && value.trim() ? value : NOT_SET);

function scopesText(scopes: Spec['knowledgeScopes']): string {
  if (!scopes || scopes.length === 0) return NOT_SET;
  return scopes.map((s) => SCOPE_LABELS[s] ?? s).join(', ');
}

function sameSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  if (left.size !== right.size) return false;
  for (const x of left) if (!right.has(x)) return false;
  return true;
}

/**
 * Compares the owner-facing fields of two specs. Knowledge scopes compare as
 * a set, so a different order is not a change. Values are display strings and
 * are rendered as plain text.
 */
export function diffFields(before: Spec, after: Spec): FieldDiff[] {
  const row = (key: FieldKey, label: string, b: string, a: string, changed = b !== a): FieldDiff => ({
    key,
    label,
    before: b,
    after: a,
    changed,
  });
  return [
    row('name', 'Name', text(before.name), text(after.name)),
    row('goal', 'Goal', text(before.goal), text(after.goal)),
    row('greeting', 'Greeting', text(before.greeting), text(after.greeting)),
    row(
      'knowledgeScopes',
      'Knowledge it can use',
      scopesText(before.knowledgeScopes),
      scopesText(after.knowledgeScopes),
      !sameSet(before.knowledgeScopes, after.knowledgeScopes),
    ),
    row(
      'escalation',
      'When it cannot help',
      before.escalation ? ESCALATION_LABELS[before.escalation] : NOT_SET,
      after.escalation ? ESCALATION_LABELS[after.escalation] : NOT_SET,
    ),
    row(
      'writePolicy',
      'Actions',
      before.writePolicy ? WRITE_POLICY_LABELS[before.writePolicy] : NOT_SET,
      after.writePolicy ? WRITE_POLICY_LABELS[after.writePolicy] : NOT_SET,
    ),
  ];
}

// ------------------------------------------------------------ capability diff

export type CapabilityChange = 'added' | 'removed' | 'unchanged';

export type CapabilityDiffRow = {
  id: CapabilityId;
  description: string;
  effect: Effect;
  change: CapabilityChange;
};

export type CapabilityDiffGroup = {
  key: CapabilityGroupKey;
  title: string;
  description: string;
  tone: Tone;
  badge: string;
  items: CapabilityDiffRow[];
};

export type CapabilityDiff = {
  groups: CapabilityDiffGroup[];
  added: number;
  removed: number;
  /** IDs in either spec that are not in the registry. They are never listed. */
  unknownCount: number;
};

/**
 * Capabilities added, removed and unchanged between two specs, grouped by
 * effect with the same groups as the builder (reads, proposes, runs only after
 * approval).
 */
export function diffCapabilities(before: readonly string[] | undefined, after: readonly string[] | undefined): CapabilityDiff {
  const b = new Set(before ?? []);
  const a = new Set(after ?? []);
  const union = [...new Set([...(before ?? []), ...(after ?? [])])];
  const {groups} = groupCapabilities(union);
  let added = 0;
  let removed = 0;
  const out = groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const change: CapabilityChange = b.has(item.id) && a.has(item.id) ? 'unchanged' : a.has(item.id) ? 'added' : 'removed';
      if (change === 'added') added += 1;
      if (change === 'removed') removed += 1;
      return {...item, change};
    }),
  }));
  const unknownCount = union.filter((id) => !isRegisteredCapability(id)).length;
  return {groups: out, added, removed, unknownCount};
}

export function capabilityDescription(id: CapabilityId): string {
  return CAPABILITIES[id].description;
}

// ------------------------------------------------------------ knowledge snapshot

export type FactRefChange = {
  id: string;
  before?: number;
  after?: number;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
};

export type SnapshotDiff = {
  facts: FactRefChange[];
  factsChanged: boolean;
  catalogBefore?: string;
  catalogAfter?: string;
  catalogChanged: boolean;
};

/** Compares the knowledge snapshot references (fact IDs with versions, catalog sync time). */
export function diffSnapshot(before: AgentVersion['knowledgeSnapshotRef'], after: AgentVersion['knowledgeSnapshotRef']): SnapshotDiff {
  const b = new Map(before.facts.map((f) => [f.id, f.version]));
  const a = new Map(after.facts.map((f) => [f.id, f.version]));
  const ids = [...new Set([...b.keys(), ...a.keys()])].sort();
  const facts: FactRefChange[] = ids.map((id) => {
    const bv = b.get(id);
    const av = a.get(id);
    const change = bv === undefined ? 'added' : av === undefined ? 'removed' : bv === av ? 'unchanged' : 'changed';
    return {id, ...(bv !== undefined ? {before: bv} : {}), ...(av !== undefined ? {after: av} : {}), change};
  });
  return {
    facts,
    factsChanged: facts.some((f) => f.change !== 'unchanged'),
    ...(before.catalogSyncedAt ? {catalogBefore: before.catalogSyncedAt} : {}),
    ...(after.catalogSyncedAt ? {catalogAfter: after.catalogSyncedAt} : {}),
    catalogChanged: before.catalogSyncedAt !== after.catalogSyncedAt,
  };
}

// ------------------------------------------------------------ whole diff

export type VersionDiff = {
  before: AgentVersion;
  after: AgentVersion;
  fields: FieldDiff[];
  capabilities: CapabilityDiff;
  snapshot: SnapshotDiff;
  /** Number of changed owner-facing fields plus one for any capability change. */
  changeCount: number;
};

/** The full comparison of two versions. The older one is always `before`. */
export function diffVersions(x: AgentVersion, y: AgentVersion): VersionDiff {
  const [before, after] = orderPair(x, y);
  const fields = diffFields(before.spec, after.spec);
  const capabilities = diffCapabilities(before.spec.capabilities, after.spec.capabilities);
  const snapshot = diffSnapshot(before.knowledgeSnapshotRef, after.knowledgeSnapshotRef);
  const changeCount = fields.filter((f) => f.changed).length + (capabilities.added + capabilities.removed > 0 ? 1 : 0);
  return {before, after, fields, capabilities, snapshot, changeCount};
}

/** Labels of what changes when the agent moves from `from` to `to`, for the rollback dialog. */
export function changedLabels(from: AgentVersion, to: AgentVersion): string[] {
  const labels = diffFields(from.spec, to.spec)
    .filter((f) => f.changed)
    .map((f) => f.label);
  const caps = diffCapabilities(from.spec.capabilities, to.spec.capabilities);
  if (caps.added + caps.removed > 0) labels.push('Capabilities');
  return labels;
}

// ------------------------------------------------------------ rolled-back markers

export type RollbackMark = {
  /** The version that was active before the rollback (an agv_ id). */
  fromVersionId: string;
  occurredAt: string;
};

/**
 * Reads agent.published events for one agent. An event with rolledBackFrom
 * means its agentVersionId became active again by a rollback. The newest such
 * event per version wins. Events of other agents are ignored.
 */
export function rollbackMarks(events: readonly ActivityEvent[], agentId: string): Map<string, RollbackMark> {
  const marks = new Map<string, RollbackMark>();
  for (const event of events) {
    if (event.type !== 'agent.published') continue;
    const payload = payloadOf(event as ActivityEvent & {type: 'agent.published'});
    if (payload.agentId !== agentId || typeof payload.rolledBackFrom !== 'string' || typeof payload.agentVersionId !== 'string') continue;
    const existing = marks.get(payload.agentVersionId);
    if (!existing || existing.occurredAt < event.occurredAt) {
      marks.set(payload.agentVersionId, {fromVersionId: payload.rolledBackFrom, occurredAt: event.occurredAt});
    }
  }
  return marks;
}

// ------------------------------------------------------------ rollback rule

/**
 * Rollback is offered only on a version that is not the active one, and only
 * when the agent has been published (a draft has nothing to roll back).
 */
export function canRollBack(agent: Pick<Agent, 'state' | 'activeVersionId'>, version: Pick<AgentVersion, 'id'>): boolean {
  if (agent.state === 'draft') return false;
  if (!agent.activeVersionId) return false;
  return agent.activeVersionId !== version.id;
}

// ------------------------------------------------------------ rollback errors

export type RollbackErrorView = {
  title: string;
  message: string;
  /** retry: the same request may be sent again. knowledge: link to /knowledge. reload: refetch the history. sign_in. none. */
  next: 'retry' | 'knowledge' | 'reload' | 'sign_in' | 'none';
  conflictIds?: string[];
  correlationId?: string;
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** One message per documented rollback error (API.md 3.4 and section 2). Nothing changed in any of them. */
export function rollbackErrorView(error: ApiError): RollbackErrorView {
  const correlationId = error.correlationId;
  switch (error.code) {
    case 'NOT_FOUND':
      return {
        title: 'Not found in this business',
        message: 'This agent or version does not exist in the selected business. Nothing changed.',
        next: 'reload',
        correlationId,
      };
    case 'INVALID_STATE': {
      const state = typeof error.details?.state === 'string' ? error.details.state : undefined;
      return {
        title: state === 'draft' ? 'This agent was never published' : 'This version cannot be rolled back to',
        message:
          state === 'draft'
            ? 'A draft agent has no published version to go back to. Nothing changed.'
            : 'It may already be the active version. Nothing changed. Reload the history to see the current state.',
        next: 'reload',
        correlationId,
      };
    }
    case 'CONFLICT_UNRESOLVED': {
      const conflictIds = stringList(error.details?.conflictIds);
      return {
        title: 'An open conflict blocks this rollback',
        message: 'Resolve the required conflicts in Knowledge review, then try again. Nothing changed.',
        next: 'knowledge',
        conflictIds,
        correlationId,
      };
    }
    case 'CAPABILITY_NOT_ALLOWED':
      return {
        title: 'This version uses a capability that is no longer allowed',
        message: 'It cannot be made active again. Build a new version instead. Nothing changed.',
        next: 'none',
        correlationId,
      };
    case 'INTEGRATION_UNAVAILABLE': {
      const provider = typeof error.details?.provider === 'string' ? error.details.provider : undefined;
      return {
        title: provider ? `${provider} is not responding` : 'A connected service is not responding',
        message: 'Nothing changed. Try again in a moment.',
        next: 'retry',
        correlationId,
      };
    }
    case 'VALIDATION_FAILED':
      return {
        title: 'The rollback request was not accepted',
        message: 'Nothing changed. Close this and try again.',
        next: 'none',
        correlationId,
      };
    case 'UNAUTHENTICATED':
      return {title: 'You are signed out', message: 'Sign in again, then open this page.', next: 'sign_in', correlationId};
    case 'FORBIDDEN_BUSINESS':
      return {title: 'No access', message: 'You do not have access to this business.', next: 'none', correlationId};
    default:
      if (error.kind === 'network') {
        return {
          title: 'Could not reach the server',
          message: 'The rollback may not have arrived. Reload the history to see which version is active before you try again.',
          next: 'reload',
          correlationId,
        };
      }
      return {
        title: 'The rollback did not go through',
        message: error.message || 'Something went wrong on the server.',
        next: error.retryable ? 'retry' : 'none',
        correlationId,
      };
  }
}
