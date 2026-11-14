import {describe, expect, it} from 'vitest';
import {ApiError, type ActivityEvent, type AgentSpec, type AgentVersion} from '@/lib/api';
import {
  canRollBack,
  changedLabels,
  defaultPair,
  diffCapabilities,
  diffFields,
  diffSnapshot,
  diffVersions,
  NOT_SET,
  orderPair,
  rollbackErrorView,
  rollbackMarks,
} from './versions';

const baseSpec: Partial<AgentSpec> = {
  name: 'Pizza Order Assistant',
  goal: 'Take pickup orders by phone.',
  knowledgeScopes: ['business_profile', 'catalog', 'hours'],
  capabilities: ['catalog.read', 'order.quote', 'order.propose', 'order.checkout.prepare'],
  writePolicy: 'owner_approval_each_action_bundle',
  escalation: 'explain_unsupported_or_offer_callback',
};

function version(n: number, spec: Partial<AgentSpec>, facts: {id: string; version: number}[] = [], catalogSyncedAt?: string): AgentVersion {
  return {
    id: `agv_x_v${n}`,
    agentId: 'agt_x',
    version: n,
    spec: spec as AgentSpec, // only the fields the diff reads
    knowledgeSnapshotRef: {facts, ...(catalogSyncedAt ? {catalogSyncedAt} : {})},
    createdBy: 'usr_owner_01',
    publishedAt: `2026-11-13T1${n}:00:00Z`,
  };
}

const err = (code: ApiError['code'], details?: Record<string, unknown>, kind: ApiError['kind'] = 'http') =>
  new ApiError({code, message: 'server text', status: 409, retryable: code === 'INTEGRATION_UNAVAILABLE', details, kind, correlationId: 'cor_1'});

describe('diffFields', () => {
  it('marks changed fields with both values and leaves unchanged ones quiet', () => {
    const rows = diffFields(baseSpec, {...baseSpec, goal: 'Take orders and answer questions.', greeting: 'Hi, I am an AI assistant.'});
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.goal).toMatchObject({changed: true, before: 'Take pickup orders by phone.', after: 'Take orders and answer questions.'});
    expect(byKey.greeting).toMatchObject({changed: true, before: NOT_SET, after: 'Hi, I am an AI assistant.'});
    expect(byKey.name.changed).toBe(false);
    expect(byKey.escalation.changed).toBe(false);
    expect(byKey.writePolicy.changed).toBe(false);
  });

  it('compares knowledge scopes as a set', () => {
    const reordered = diffFields(baseSpec, {...baseSpec, knowledgeScopes: ['hours', 'catalog', 'business_profile']});
    expect(reordered.find((r) => r.key === 'knowledgeScopes')!.changed).toBe(false);
    const more = diffFields(baseSpec, {...baseSpec, knowledgeScopes: ['business_profile', 'catalog', 'hours', 'faq']});
    const row = more.find((r) => r.key === 'knowledgeScopes')!;
    expect(row.changed).toBe(true);
    expect(row.after).toBe('Business profile, Catalog, Hours, Questions and answers');
  });

  it('shows a missing value as Not set', () => {
    const rows = diffFields({}, {});
    expect(rows.every((r) => r.before === NOT_SET && !r.changed)).toBe(true);
  });
});

describe('diffCapabilities', () => {
  it('lists added, removed and unchanged capabilities grouped by effect', () => {
    const diff = diffCapabilities(
      ['catalog.read', 'order.quote', 'order.propose', 'order.checkout.prepare'],
      ['catalog.read', 'business.facts.read', 'order.propose', 'order.checkout.prepare', 'message.checkout.send'],
    );
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    const change = Object.fromEntries(diff.groups.flatMap((g) => g.items.map((i) => [i.id, i.change])));
    expect(change).toMatchObject({
      'catalog.read': 'unchanged',
      'business.facts.read': 'added',
      'order.quote': 'removed',
      'order.propose': 'unchanged',
      'message.checkout.send': 'added',
    });
    expect(diff.groups.map((g) => g.key)).toEqual(['reads', 'proposes', 'afterApproval']);
    expect(diff.groups.find((g) => g.key === 'afterApproval')!.items.map((i) => i.id)).toEqual([
      'order.checkout.prepare',
      'message.checkout.send',
    ]);
  });

  it('never lists an ID that is not in the registry', () => {
    const diff = diffCapabilities(['catalog.read'], ['catalog.read', 'square.refund.all']);
    expect(diff.unknownCount).toBe(1);
    expect(diff.added).toBe(0);
    expect(diff.groups.flatMap((g) => g.items).map((i) => i.id)).toEqual(['catalog.read']);
  });

  it('reports no change for the same list', () => {
    const diff = diffCapabilities(['catalog.read', 'order.propose'], ['order.propose', 'catalog.read']);
    expect(diff.added + diff.removed).toBe(0);
  });
});

describe('diffSnapshot', () => {
  it('finds added, removed and changed fact versions and a new catalog sync time', () => {
    const diff = diffSnapshot(
      {facts: [{id: 'fact_a', version: 1}, {id: 'fact_b', version: 2}], catalogSyncedAt: '2026-11-13T10:00:00Z'},
      {facts: [{id: 'fact_a', version: 2}, {id: 'fact_c', version: 1}], catalogSyncedAt: '2026-11-13T12:00:00Z'},
    );
    expect(diff.facts).toEqual([
      {id: 'fact_a', before: 1, after: 2, change: 'changed'},
      {id: 'fact_b', before: 2, change: 'removed'},
      {id: 'fact_c', after: 1, change: 'added'},
    ]);
    expect(diff.factsChanged).toBe(true);
    expect(diff.catalogChanged).toBe(true);
  });

  it('reports an identical snapshot as unchanged', () => {
    const ref = {facts: [{id: 'fact_a', version: 1}], catalogSyncedAt: '2026-11-13T10:00:00Z'};
    const diff = diffSnapshot(ref, {...ref, facts: [...ref.facts]});
    expect(diff.factsChanged).toBe(false);
    expect(diff.catalogChanged).toBe(false);
  });
});

describe('diffVersions and ordering', () => {
  it('always puts the older version first', () => {
    const v1 = version(1, baseSpec);
    const v2 = version(2, {...baseSpec, goal: 'New goal.'});
    expect(orderPair(v2, v1)).toEqual([v1, v2]);
    const diff = diffVersions(v2, v1);
    expect(diff.before.version).toBe(1);
    expect(diff.after.version).toBe(2);
    expect(diff.changeCount).toBe(1);
  });

  it('names what changes for the rollback dialog', () => {
    const v1 = version(1, baseSpec);
    const v2 = version(2, {...baseSpec, goal: 'New goal.', capabilities: ['catalog.read']});
    expect(changedLabels(v2, v1)).toEqual(['Goal', 'Capabilities']);
    expect(changedLabels(v1, version(3, baseSpec))).toEqual([]);
  });

  it('opens compare on the active version and the one before it', () => {
    const vs = [version(3, baseSpec), version(2, baseSpec), version(1, baseSpec)];
    expect(defaultPair(vs, 'agv_x_v3')).toEqual(['agv_x_v2', 'agv_x_v3']);
    expect(defaultPair(vs, 'agv_x_v2')).toEqual(['agv_x_v1', 'agv_x_v2']);
    expect(defaultPair(vs, 'agv_x_v1')).toEqual(['agv_x_v1', 'agv_x_v2']);
    expect(defaultPair(vs, undefined)).toEqual(['agv_x_v2', 'agv_x_v3']);
    expect(defaultPair([version(1, baseSpec)], 'agv_x_v1')).toBeNull();
  });
});

describe('canRollBack', () => {
  it('is not offered for the active version or a draft', () => {
    expect(canRollBack({state: 'live', activeVersionId: 'agv_x_v2'}, {id: 'agv_x_v2'})).toBe(false);
    expect(canRollBack({state: 'live', activeVersionId: 'agv_x_v2'}, {id: 'agv_x_v1'})).toBe(true);
    expect(canRollBack({state: 'paused', activeVersionId: 'agv_x_v2'}, {id: 'agv_x_v1'})).toBe(true);
    expect(canRollBack({state: 'draft'}, {id: 'agv_x_v1'})).toBe(false);
  });
});

describe('rollbackMarks', () => {
  const ev = (id: string, at: string, payload: Record<string, unknown>, type: ActivityEvent['type'] = 'agent.published'): ActivityEvent => ({
    id,
    businessId: 'biz_pizza_01',
    type,
    correlationId: 'agt_x',
    actorType: 'owner',
    occurredAt: at,
    payload,
  }) as ActivityEvent;

  it('marks the version that became active by rollback, newest event wins, other agents ignored', () => {
    const marks = rollbackMarks(
      [
        ev('e1', '2026-11-13T10:00:00Z', {agentId: 'agt_x', agentVersionId: 'agv_x_v1', version: 1}),
        ev('e2', '2026-11-13T11:00:00Z', {agentId: 'agt_x', agentVersionId: 'agv_x_v1', version: 1, rolledBackFrom: 'agv_x_v2'}),
        ev('e3', '2026-11-13T12:00:00Z', {agentId: 'agt_x', agentVersionId: 'agv_x_v1', version: 1, rolledBackFrom: 'agv_x_v3'}),
        ev('e4', '2026-11-13T12:00:00Z', {agentId: 'agt_other', agentVersionId: 'agv_o_v1', version: 1, rolledBackFrom: 'agv_o_v2'}),
        ev('e5', '2026-11-13T12:00:00Z', {agentId: 'agt_x'}, 'agent.paused'),
      ],
      'agt_x',
    );
    expect([...marks.keys()]).toEqual(['agv_x_v1']);
    expect(marks.get('agv_x_v1')).toEqual({fromVersionId: 'agv_x_v3', occurredAt: '2026-11-13T12:00:00Z'});
  });
});

describe('rollbackErrorView', () => {
  it('gives each documented error its own message', () => {
    const views = {
      notFound: rollbackErrorView(err('NOT_FOUND')),
      active: rollbackErrorView(err('INVALID_STATE', {state: 'live'})),
      draft: rollbackErrorView(err('INVALID_STATE', {state: 'draft'})),
      conflict: rollbackErrorView(err('CONFLICT_UNRESOLVED', {conflictIds: ['cfl_pizza_01', 7]})),
      capability: rollbackErrorView(err('CAPABILITY_NOT_ALLOWED')),
      integration: rollbackErrorView(err('INTEGRATION_UNAVAILABLE', {provider: 'Square'})),
    };
    const titles = Object.values(views).map((v) => v.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(views.notFound.title).toBe('Not found in this business');
    expect(views.conflict).toMatchObject({next: 'knowledge', conflictIds: ['cfl_pizza_01'], correlationId: 'cor_1'});
    expect(views.integration).toMatchObject({title: 'Square is not responding', next: 'retry'});
    expect(views.capability.next).toBe('none');
    expect(views.draft.title).toBe('This agent was never published');
  });

  it('does not offer a blind retry after a network failure', () => {
    expect(rollbackErrorView(err('INTERNAL', undefined, 'network')).next).toBe('reload');
  });
});
