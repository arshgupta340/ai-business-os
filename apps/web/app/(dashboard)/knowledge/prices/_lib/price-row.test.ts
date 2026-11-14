import {describe, expect, it} from 'vitest';
import type {ActivityEvent, ApprovalRequest, BusinessFact, FactConflict} from '@/lib/api';
import {approvalByVariation, canProposeAgain, mergeExecutionEvents, phaseBadge, priceConflictFor, pricePhase, stepOutcome} from './price-row';

const payload = {
  businessId: 'biz_pizza_01',
  subjectId: 'cat_sq_var_marg_lg',
  squareItemId: 'SQ_ITEM_MARG',
  variationId: 'SQ_VAR_MARG_LG',
  fromPriceMinor: 2000,
  newPriceMinor: 2100,
  currency: 'USD' as const,
  squareVersion: 3,
  actionBundle: ['square.catalog.price.update', 'local.catalog.sync'],
  expiresAt: '2026-11-14T20:10:00.000Z',
};

function approval(state: ApprovalRequest['state'], over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'apv_1',
    businessId: 'biz_pizza_01',
    actorType: 'owner',
    bundleType: 'price_edit',
    actionBundle: payload.actionBundle,
    subjectId: payload.subjectId,
    payload,
    payloadHash: 'hash',
    state,
    expiresAt: payload.expiresAt,
    createdAt: '2026-11-14T20:00:00.000Z',
    ...over,
  } as ApprovalRequest;
}

let n = 0;
function ev(type: string, p: Record<string, unknown>): ActivityEvent {
  n += 1;
  return {
    id: `evt_${n}`,
    businessId: 'biz_pizza_01',
    type: type as ActivityEvent['type'],
    correlationId: 'apv_1',
    actorType: 'system',
    occurredAt: `2026-11-14T20:01:${String(n).padStart(2, '0')}.000Z`,
    payload: p,
  };
}

const started = (exe: string, actionType: string, approvalId = 'apv_1') => ev('execution.started', {executionId: exe, approvalId, actionType, stepIndex: 0, attempt: 1});
const ok = (exe: string, actionType: string) => ev('execution.succeeded', {executionId: exe, actionType});
const failed = (exe: string, actionType: string, nextStatus = 'FAILED', errorCode = 'INTEGRATION_UNAVAILABLE') =>
  ev('execution.failed', {executionId: exe, actionType, errorCode, retryable: nextStatus === 'QUEUED', nextStatus});

const SQ = 'square.catalog.price.update';
const SYNC = 'local.catalog.sync';

describe('pricePhase', () => {
  it('is idle with no approval and pending while the owner has not confirmed', () => {
    expect(pricePhase({events: [], catalogPriceMinor: 2000}).kind).toBe('idle');
    expect(pricePhase({approval: approval('PENDING'), events: [], catalogPriceMinor: 2000}).kind).toBe('pending');
  });

  it('keeps updating after approval until both steps succeeded', () => {
    expect(pricePhase({approval: approval('APPROVED'), events: [], catalogPriceMinor: 2000}).kind).toBe('updating');
    const e1 = [started('exe_a', SQ), ok('exe_a', SQ)];
    expect(pricePhase({approval: approval('APPROVED'), events: e1, catalogPriceMinor: 2000}).kind).toBe('updating');
    const e2 = [...e1, started('exe_b', SYNC)];
    expect(pricePhase({approval: approval('APPROVED'), events: e2, catalogPriceMinor: 2000}).kind).toBe('updating');
  });

  it('shows the new price as verified only once the catalog returns it', () => {
    const events = [started('exe_a', SQ), ok('exe_a', SQ), started('exe_b', SYNC), ok('exe_b', SYNC)];
    expect(pricePhase({approval: approval('APPROVED'), events, catalogPriceMinor: 2000}).kind).toBe('awaiting_catalog');
    expect(pricePhase({approval: approval('APPROVED'), events, catalogPriceMinor: 2100}).kind).toBe('verified');
  });

  it('does not count a catalog that already has the new price before the sync step succeeded', () => {
    const events = [started('exe_a', SQ), ok('exe_a', SQ)];
    expect(pricePhase({approval: approval('APPROVED'), events, catalogPriceMinor: 2100}).kind).toBe('updating');
  });

  it('says Square is unchanged when the Square step failed for good, and unknown when it needs review', () => {
    const refused = pricePhase({approval: approval('APPROVED'), events: [started('exe_a', SQ), failed('exe_a', SQ)], catalogPriceMinor: 2000});
    expect(refused).toMatchObject({kind: 'square_failed', squarePrice: 'unchanged', errorCode: 'INTEGRATION_UNAVAILABLE'});
    const unknown = pricePhase({
      approval: approval('APPROVED'),
      events: [started('exe_a', SQ), failed('exe_a', SQ, 'NEEDS_REVIEW')],
      catalogPriceMinor: 2000,
    });
    expect(unknown).toMatchObject({kind: 'square_failed', squarePrice: 'unknown'});
  });

  it('treats a failure that goes back to QUEUED as a retry, not an end state', () => {
    const events = [started('exe_a', SQ), failed('exe_a', SQ, 'QUEUED')];
    expect(pricePhase({approval: approval('APPROVED'), events, catalogPriceMinor: 2000}).kind).toBe('updating');
    const after = [...events, started('exe_a', SQ), ok('exe_a', SQ)];
    expect(stepOutcome(after, 'apv_1', SQ).status).toBe('succeeded');
  });

  it('reports a failed sync step after Square took the price', () => {
    const events = [started('exe_a', SQ), ok('exe_a', SQ), started('exe_b', SYNC), failed('exe_b', SYNC, 'FAILED', 'INTERNAL')];
    expect(pricePhase({approval: approval('APPROVED'), events, catalogPriceMinor: 2000})).toMatchObject({kind: 'sync_failed', errorCode: 'INTERNAL'});
  });

  it('ignores steps of other approvals', () => {
    const events = [started('exe_x', SQ, 'apv_other'), ok('exe_x', SQ), started('exe_y', SYNC, 'apv_other'), ok('exe_y', SYNC)];
    expect(pricePhase({approval: approval('APPROVED'), events, catalogPriceMinor: 2100}).kind).toBe('updating');
  });

  it('leaves the price unchanged on reject and expiry', () => {
    for (const state of ['REJECTED', 'EXPIRED'] as const) {
      const phase = pricePhase({approval: approval(state), events: [], catalogPriceMinor: 2000});
      expect(phase.kind).toBe(state === 'REJECTED' ? 'rejected' : 'expired');
      expect(phaseBadge(phase)).toMatchObject({tone: 'neutral'});
      expect(canProposeAgain(phase)).toBe(true);
    }
  });
});

describe('phaseBadge', () => {
  it('uses info while updating and green only once verified', () => {
    const base = {events: [] as ActivityEvent[], catalogPriceMinor: 2000};
    expect(phaseBadge(pricePhase({...base, approval: approval('APPROVED')}))).toEqual({label: 'Change approved, updating Square', tone: 'info'});
    expect(phaseBadge(pricePhase({...base, approval: approval('PENDING')}))?.tone).toBe('warning');
    const events = [started('exe_a', SQ), ok('exe_a', SQ), started('exe_b', SYNC), ok('exe_b', SYNC)];
    expect(phaseBadge(pricePhase({events, catalogPriceMinor: 2000, approval: approval('APPROVED')}))?.tone).toBe('info');
    expect(phaseBadge(pricePhase({events, catalogPriceMinor: 2100, approval: approval('APPROVED')}))?.tone).toBe('success');
  });
});

describe('mergeExecutionEvents', () => {
  it('drops duplicates and non-execution events and sorts by time', () => {
    const a = started('exe_a', SQ);
    const b = ok('exe_a', SQ);
    const other = ev('approval.decided', {approvalId: 'apv_1'});
    const merged = mergeExecutionEvents([b, other], [a, b]);
    expect(merged.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('keeps step order when several events share one second (lists come newest first)', () => {
    const at = '2026-11-14T20:05:00Z';
    const steps = [started('exe_a', SQ), ok('exe_a', SQ), started('exe_b', SYNC), ok('exe_b', SYNC)].map((e) => ({...e, occurredAt: at}));
    const newestFirst = [...steps].reverse();
    const merged = mergeExecutionEvents(newestFirst, []);
    expect(merged.map((e) => e.id)).toEqual(steps.map((e) => e.id));
    expect(pricePhase({approval: approval('APPROVED'), events: merged, catalogPriceMinor: 2100}).kind).toBe('verified');
    // Even out of order, a succeeded step stays succeeded.
    expect(stepOutcome(newestFirst, 'apv_1', SYNC).status).toBe('succeeded');
  });
});

describe('approvalByVariation', () => {
  it('prefers the approval proposed here, else the newest pending one', () => {
    const older = approval('PENDING', {id: 'apv_old', createdAt: '2026-11-14T19:00:00.000Z'});
    const newer = approval('PENDING', {id: 'apv_new', createdAt: '2026-11-14T19:30:00.000Z'});
    expect(approvalByVariation({}, [older, newer])).toEqual({SQ_VAR_MARG_LG: 'apv_new'});
    expect(approvalByVariation({SQ_VAR_MARG_LG: 'apv_here'}, [older, newer])).toEqual({SQ_VAR_MARG_LG: 'apv_here'});
  });
});

describe('priceConflictFor', () => {
  const conflict: FactConflict = {
    id: 'cfl_1',
    businessId: 'biz_pizza_01',
    kind: 'menu_item',
    key: 'SQ_VAR_MARG_LG',
    required: true,
    candidates: [
      {factId: 'fact_1', sourceType: 'upload', value: {priceMinor: 2100}},
      {sourceType: 'square', sourceRef: 'cat_sq_var_marg_lg', value: {priceMinor: 2000}},
    ],
    state: 'open',
    createdAt: '2026-11-14T19:00:00.000Z',
  };
  const fact = {id: 'fact_1', value: {item: 'Margherita', variation: 'Large', priceMinor: 2100}} as unknown as BusinessFact;

  it('matches by key and returns the uploaded price', () => {
    expect(priceConflictFor({name: 'Margherita'}, {id: 'SQ_VAR_MARG_LG', name: 'Large'}, [conflict], [])).toEqual({
      conflictId: 'cfl_1',
      uploadedPriceMinor: 2100,
    });
  });

  it('matches by the draft fact item and variation names', () => {
    const other = {...conflict, key: 'margherita-large'};
    expect(priceConflictFor({name: 'margherita '}, {id: 'X', name: 'LARGE'}, [other], [fact])?.conflictId).toBe('cfl_1');
  });

  it('ignores resolved conflicts, other kinds and other variations', () => {
    expect(priceConflictFor({name: 'Margherita'}, {id: 'SQ_VAR_MARG_LG', name: 'Large'}, [{...conflict, state: 'resolved'}], [])).toBeNull();
    expect(priceConflictFor({name: 'Margherita'}, {id: 'SQ_VAR_MARG_LG', name: 'Large'}, [{...conflict, kind: 'policy'}], [])).toBeNull();
    expect(priceConflictFor({name: 'Pepperoni'}, {id: 'SQ_VAR_PEP_LG', name: 'Large'}, [conflict], [fact])).toBeNull();
  });
});
