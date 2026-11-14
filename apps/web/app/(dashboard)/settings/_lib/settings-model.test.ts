import {describe, expect, it} from 'vitest';
import type {ActivityEvent, ApprovalRequest, BusinessFact} from '@/lib/api';
import {
  changeLogEntries,
  checkHoursInput,
  checkMinutesInput,
  checkProfileInput,
  editPhase,
  hoursRows,
  initialHoursInput,
  normalizeClock,
  pendingEditFor,
  policyShape,
  sameHours,
} from './settings-model';

const at = '2026-11-13T08:00:00.000Z';

function fact(over: Partial<BusinessFact>): BusinessFact {
  return {
    id: 'fact_x',
    businessId: 'biz_pizza_01',
    kind: 'hours',
    key: 'mon',
    value: {open: '11:00', close: '21:00'},
    sourceType: 'seed',
    status: 'verified',
    confidence: 1,
    version: 1,
    verifiedAt: at,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

describe('hoursRows', () => {
  it('lists Monday to Sunday in order from verified facts only, keeping the closed state', () => {
    const rows = hoursRows([
      fact({id: 'f_sun', key: 'sun', value: {closed: true}}),
      fact({id: 'f_fri_old', key: 'fri', status: 'superseded', value: {open: '11:00', close: '21:00'}}),
      fact({id: 'f_fri', key: 'fri', version: 2, value: {open: '11:00', close: '22:00'}}),
      fact({id: 'f_fri_draft', key: 'fri', status: 'draft', value: {open: '11:00', close: '23:00'}}),
      fact({id: 'f_mon', key: 'mon'}),
    ]);
    expect(rows.map((r) => r.label)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    expect(rows[0].verified?.id).toBe('f_mon');
    expect(rows[1].verified).toBeUndefined();
    expect(rows[4].verified?.id).toBe('f_fri');
    expect(rows[6].verified?.value).toEqual({closed: true});
  });
});

describe('time validation', () => {
  it('normalizes 24-hour times and refuses anything else', () => {
    expect(normalizeClock('9:05')).toBe('09:05');
    expect(normalizeClock('23:00:00')).toBe('23:00');
    expect(normalizeClock('24:00')).toBeUndefined();
    expect(normalizeClock('11 pm')).toBeUndefined();
    expect(normalizeClock(undefined)).toBeUndefined();
  });

  it('builds the open and close value in the contract shape', () => {
    expect(checkHoursInput({closed: false, open: '11:00', close: '23:00'}, {open: '11:00', close: '22:00'})).toEqual({
      ok: true,
      value: {open: '11:00', close: '23:00'},
    });
    expect(checkHoursInput({closed: true}, {open: '11:00', close: '22:00'})).toEqual({ok: true, value: {closed: true}});
  });

  it('needs both times, close after open, and a real change', () => {
    expect(checkHoursInput({closed: false, open: '11:00'})).toEqual({ok: false, errors: {close: 'Enter a closing time.'}});
    const late = checkHoursInput({closed: false, open: '11:00', close: '10:00'});
    expect(late.ok).toBe(false);
    expect(!late.ok && late.errors.close).toMatch(/later than the opening time/);
    expect(checkHoursInput({closed: false, open: '11:00', close: '11:00'}).ok).toBe(false);
    const same = checkHoursInput({closed: false, open: '11:00', close: '22:00'}, {open: '11:00', close: '22:00'});
    expect(!same.ok && same.errors.form).toBe('These are already the hours for this day.');
    expect(checkHoursInput({closed: true}, {closed: true}).ok).toBe(false);
  });

  it('compares and seeds editor values', () => {
    expect(sameHours({open: '9:00', close: '18:00'}, {open: '09:00', close: '18:00'})).toBe(true);
    expect(sameHours({closed: true}, {open: '09:00', close: '18:00'})).toBe(false);
    expect(initialHoursInput({closed: true})).toEqual({closed: true, open: undefined, close: undefined});
    expect(initialHoursInput({open: '11:00', close: '22:00'})).toEqual({closed: false, open: '11:00', close: '22:00'});
  });
});

function approval(over: Partial<Omit<ApprovalRequest, "payload">> & {payload?: Record<string, unknown>}): ApprovalRequest {
  return {
    id: 'apv_1',
    businessId: 'biz_pizza_01',
    actorType: 'owner',
    bundleType: 'fact_edit',
    actionBundle: ['local.fact.update'],
    subjectId: 'fact_d',
    payloadHash: 'h',
    state: 'PENDING',
    expiresAt: '2026-11-13T09:00:00.000Z',
    createdAt: at,
    ...over,
    payload: {
      businessId: 'biz_pizza_01',
      subjectId: 'fact_d',
      kind: 'hours',
      key: 'fri',
      fromVersion: 2,
      before: {open: '11:00', close: '22:00'},
      after: {open: '11:00', close: '23:00'},
      actionBundle: ['local.fact.update'],
      expiresAt: '2026-11-13T09:00:00.000Z',
      ...over.payload,
    },
  } as ApprovalRequest;
}

describe('fact edit state', () => {
  it('finds the newest pending edit for a kind and key', () => {
    const list = [
      approval({id: 'a', createdAt: '2026-11-13T08:00:00.000Z'}),
      approval({id: 'b', createdAt: '2026-11-13T08:05:00.000Z'}),
      approval({id: 'c', state: 'REJECTED'}),
      approval({id: 'd', payload: {key: 'sat'}}),
    ];
    expect(pendingEditFor(list, 'hours', 'fri')?.id).toBe('b');
    expect(pendingEditFor(list, 'hours', 'sat')?.id).toBe('d');
    expect(pendingEditFor(list, 'policy', 'fri')).toBeUndefined();
  });

  it('shows saved only once the verified fact is the new version', () => {
    const payload = {fromVersion: 2, after: {open: '11:00', close: '23:00'}};
    expect(editPhase('PENDING', payload, fact({version: 2}))).toBe('waiting');
    expect(editPhase('APPROVED', payload, fact({version: 2}))).toBe('saving');
    expect(editPhase('APPROVED', payload, fact({version: 3}))).toBe('saved');
    expect(editPhase('REJECTED', payload, fact({version: 2}))).toBe('discarded');
    expect(editPhase('EXPIRED', payload, fact({version: 2}))).toBe('expired');
  });
});

describe('policies', () => {
  it('edits only the simple shapes', () => {
    expect(policyShape({minutes: 20})).toEqual({type: 'minutes', minutes: 20});
    expect(policyShape({allowed: true})).toEqual({type: 'allowed', allowed: true});
    expect(policyShape({minutes: 20, note: 'x'})).toBeUndefined();
    expect(policyShape('text')).toBeUndefined();
    expect(checkMinutesInput('25', 20)).toEqual({ok: true, value: {minutes: 25}});
    expect(checkMinutesInput('20', 20).ok).toBe(false);
    expect(checkMinutesInput('2.5').ok).toBe(false);
    expect(checkMinutesInput('0').ok).toBe(false);
  });
});

describe('changeLogEntries', () => {
  it('says what changed, from what to what, who and when, newest first', () => {
    const facts = [
      fact({id: 'fri_v1', key: 'fri', status: 'superseded', value: {open: '11:00', close: '21:00'}}),
      fact({id: 'fri_v2', key: 'fri', version: 2, supersedesId: 'fri_v1', sourceType: 'owner_chat', value: {open: '11:00', close: '22:00'}}),
      fact({id: 'pw', kind: 'policy', key: 'pickup_window', version: 2, value: {minutes: 25}, sourceType: 'owner_ui'}),
    ];
    const event = (id: string, occurredAt: string, payload: Record<string, unknown>): ActivityEvent => ({
      id,
      businessId: 'biz_pizza_01',
      type: 'fact.changed',
      correlationId: 'apv',
      actorType: 'system',
      occurredAt,
      payload,
    });
    const entries = changeLogEntries(
      [
        event('e1', '2026-11-13T08:00:00.000Z', {factId: 'fri_v2', kind: 'hours', key: 'fri', fromVersion: 1, toVersion: 2, sourceType: 'owner_chat'}),
        event('e2', '2026-11-13T09:00:00.000Z', {factId: 'pw', kind: 'policy', key: 'pickup_window', fromVersion: 1, toVersion: 2, sourceType: 'owner_ui'}),
      ],
      facts,
    );
    expect(entries.map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(entries[1]).toMatchObject({
      what: 'Friday opening hours',
      before: '11:00 AM to 9:00 PM',
      after: '11:00 AM to 10:00 PM',
      versions: 'Version 1 to 2',
      who: 'You, in the builder chat',
    });
    // The old pickup window row is not in the list, so only the new value is known.
    expect(entries[0]).toMatchObject({what: 'Pickup window', before: undefined, after: '25 minutes', who: 'You, in the dashboard'});
  });
});

describe('profile', () => {
  it('sends name and contact only and leaves empty contact fields out', () => {
    expect(checkProfileInput({name: ' Demo Pizza ', phone: '', email: 'a@b.co', address: '1 Main St'})).toEqual({
      ok: true,
      patch: {name: 'Demo Pizza', contact: {email: 'a@b.co', address: '1 Main St'}},
    });
    const bad = checkProfileInput({name: '', phone: 'abc', email: 'nope', address: ''});
    expect(bad.ok).toBe(false);
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(['email', 'name', 'phone']);
  });
});
