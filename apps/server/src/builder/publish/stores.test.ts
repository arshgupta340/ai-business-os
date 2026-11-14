import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '@abos/contracts';
import { InMemoryAgentDraftStore, type AgentRecord } from '../session/stores';
import { createPublishStores } from './index';
import { KeyedLock } from './lock';
import { InMemoryAgentVersionStore, InMemoryLiveAgentStore, toVersionView, type AgentVersionRecord } from './stores';

const SPEC = {
  id: 'agt_t1',
  businessId: 'biz_pizza_01',
  version: 1,
  template: 'custom',
  name: 'T',
  channel: 'phone',
  goal: 'G',
  knowledgeScopes: ['faq'],
  capabilities: ['business.facts.read'],
  writePolicy: 'owner_approval_each_action_bundle',
  escalation: 'explain_unsupported_or_offer_callback',
  status: 'live',
  guardrailVersion: 'v1',
} satisfies AgentSpec;

function version(overrides: Partial<AgentVersionRecord> = {}): AgentVersionRecord {
  return {
    id: 'agv_t1',
    businessId: 'biz_pizza_01',
    agentId: 'agt_t1',
    version: 1,
    spec: structuredClone(SPEC),
    knowledgeSnapshotRef: { facts: [] },
    guardrailVersion: 'v1',
    createdBy: 'usr_owner_01',
    createdAt: '2026-11-13T19:30:00Z',
    publishedAt: '2026-11-13T19:30:00Z',
    ...overrides,
  };
}

describe('InMemoryAgentVersionStore', () => {
  it('keeps a frozen copy, refuses a repeated id or number, and scopes reads by business', async () => {
    const store = new InMemoryAgentVersionStore();
    const input = version();
    await store.insert(input);
    input.spec.goal = 'changed after insert';
    const stored = (await store.get('biz_pizza_01', 'agv_t1'))!;
    expect(stored.spec.goal).toBe('G');
    expect(Object.isFrozen(stored.knowledgeSnapshotRef.facts)).toBe(true);
    await expect(store.insert(version())).rejects.toThrow(/duplicate/);
    await expect(store.insert(version({ id: 'agv_t2' }))).rejects.toThrow(/already has version 1/);
    expect(await store.get('biz_barber_01', 'agv_t1')).toBeUndefined();
    expect(await store.maxVersion('biz_pizza_01', 'agt_t1')).toBe(1);
    expect(await store.maxVersion('biz_pizza_01', 'agt_other')).toBe(0);
    expect('update' in store || 'delete' in store).toBe(false);
  });
});

describe('toVersionView', () => {
  it('sends the author name only when the store loaded one', () => {
    expect(toVersionView(version()).createdByName).toBeUndefined();
    expect('createdByName' in toVersionView(version())).toBe(false);
    expect(toVersionView(version({ createdByName: 'Demo Owner' })).createdByName).toBe('Demo Owner');
    expect('createdByName' in toVersionView(version({ createdByName: '' }))).toBe(false);
  });
});

describe('InMemoryLiveAgentStore', () => {
  it('returns the pointer it replaced and holds one number only', async () => {
    const store = new InMemoryLiveAgentStore('+15555550142');
    const p = { phoneNumber: '+15555550142', businessId: 'biz_pizza_01', agentId: 'agt_a', agentVersionId: 'agv_a', updatedAt: '2026-11-13T19:30:00Z' };
    expect(await store.set(p)).toBeUndefined();
    expect(await store.set({ ...p, agentId: 'agt_b', agentVersionId: 'agv_b' })).toEqual(p);
    await expect(store.set({ ...p, phoneNumber: '+15555550100' })).rejects.toThrow();
  });
});

describe('KeyedLock', () => {
  it('runs work for one key one at a time, in order, and goes on after a failure', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      log.push(`${name} start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name} end`);
      return name;
    };
    const failing = lock.run('a', async () => {
      throw new Error('boom');
    });
    const results = await Promise.allSettled([failing, lock.run('a', slow('one', 10)), lock.run('a', slow('two', 1))]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(log).toEqual(['one start', 'one end', 'two start', 'two end']);
  });
});

describe('guardDraftWrites', () => {
  it('a draft write never changes state or activeVersionId', async () => {
    const raw = new InMemoryAgentDraftStore();
    const guarded = createPublishStores(undefined, {}).guardDraftWrites(raw);
    const record: AgentRecord = {
      id: 'agt_t1',
      businessId: 'biz_pizza_01',
      name: 'T',
      template: 'custom',
      channel: 'phone',
      state: 'draft',
      draftSpec: { ...SPEC, status: 'draft' },
      seeded: false,
      specRevision: 1,
      createdAt: '2026-11-13T19:30:00Z',
      updatedAt: '2026-11-13T19:30:00Z',
    };
    await raw.insert(record);
    // A draft writer read the row before a publish ...
    const stale = (await guarded.get('biz_pizza_01', 'agt_t1'))!;
    // ... publish then sets it live ...
    await raw.update({ ...record, state: 'live', activeVersionId: 'agv_t1' });
    // ... and the draft writer saves its change.
    stale.draftSpec = { ...stale.draftSpec, goal: 'new goal' };
    await guarded.update(stale);
    const after = (await raw.get('biz_pizza_01', 'agt_t1'))!;
    expect(after).toMatchObject({ state: 'live', activeVersionId: 'agv_t1', draftSpec: { goal: 'new goal' } });
  });

  it('uses TWILIO_PHONE_NUMBER for the in-memory pointer when it is a valid number', () => {
    expect(createPublishStores(undefined, { TWILIO_PHONE_NUMBER: '+15555550177' }).liveAgents.phoneNumber).toBe('+15555550177');
    expect(createPublishStores(undefined, { TWILIO_PHONE_NUMBER: 'not a number' }).liveAgents.phoneNumber).toBe('+15555550199');
  });
});
