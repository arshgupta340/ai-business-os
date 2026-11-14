import {describe, expect, it} from 'vitest';
import type {ActivityEvent, BusinessFact, FactConflict} from '@/lib/api';
import {
  LOW_CONFIDENCE_THRESHOLD,
  MAX_UPLOAD_BYTES,
  applyEdits,
  catalogSyncState,
  checkUpload,
  conflictByFactId,
  describeValue,
  editableFields,
  factKeyLabel,
  formatClock,
  formatHours,
  groupKnowledge,
  isLowConfidence,
  isPriceConflict,
  knownFileIds,
  splitCandidates,
  summarizeConflicts,
} from './knowledge-model';

const at = '2026-11-13T08:00:00.000Z';

function fact(partial: Partial<BusinessFact> & Pick<BusinessFact, 'id' | 'kind' | 'key'>): BusinessFact {
  return {
    businessId: 'biz_pizza_01',
    value: null,
    sourceType: 'seed',
    status: 'verified',
    confidence: 1,
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
}

function conflict(partial: Partial<FactConflict> & Pick<FactConflict, 'id'>): FactConflict {
  return {
    businessId: 'biz_pizza_01',
    kind: 'policy',
    key: 'pickup_window',
    required: false,
    candidates: [],
    state: 'open',
    createdAt: at,
    ...partial,
  };
}

function event(type: ActivityEvent['type'], payload: Record<string, unknown>, id = `evt_${Math.random()}`): ActivityEvent {
  return {id, businessId: 'biz_pizza_01', type, correlationId: 'x', actorType: 'system', occurredAt: at, payload} as ActivityEvent;
}

describe('checkUpload', () => {
  it('accepts every documented type', () => {
    for (const type of [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(checkUpload({name: 'f', type, size: 100})).toEqual({ok: true, mime: type});
    }
  });

  it('refuses another type with a clear message', () => {
    const result = checkUpload({name: 'notes.txt', type: 'text/plain', size: 10});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('type');
      expect(result.message).toContain('notes.txt was not uploaded');
      expect(result.message).toContain('PDF');
    }
  });

  it('refuses a declared type even when the extension looks right', () => {
    expect(checkUpload({name: 'menu.pdf', type: 'text/html', size: 10}).ok).toBe(false);
  });

  it('uses the extension only when the browser gives no type', () => {
    expect(checkUpload({name: 'prices.CSV', type: '', size: 10})).toEqual({ok: true, mime: 'text/csv'});
    expect(checkUpload({name: 'sheet.xlsx', type: '', size: 10})).toEqual({
      ok: true,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(checkUpload({name: 'run.exe', type: '', size: 10}).ok).toBe(false);
    expect(checkUpload({name: 'noextension', type: '', size: 10}).ok).toBe(false);
  });

  it('allows exactly 10 MB and refuses one byte more', () => {
    expect(checkUpload({name: 'a.pdf', type: 'application/pdf', size: MAX_UPLOAD_BYTES}).ok).toBe(true);
    const over = checkUpload({name: 'a.pdf', type: 'application/pdf', size: MAX_UPLOAD_BYTES + 1});
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe('size');
      expect(over.message).toContain('the limit is 10 MB');
    }
  });

  it('refuses an empty file', () => {
    expect(checkUpload({name: 'a.pdf', type: 'application/pdf', size: 0}).ok).toBe(false);
  });
});

describe('low confidence', () => {
  it('marks drafts below 0.8 only', () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(isLowConfidence({status: 'draft', confidence: 0.79})).toBe(true);
    expect(isLowConfidence({status: 'draft', confidence: 0.8})).toBe(false);
    expect(isLowConfidence({status: 'draft', confidence: 0.93})).toBe(false);
    expect(isLowConfidence({status: 'verified', confidence: 0.5})).toBe(false);
  });
});

describe('groupKnowledge', () => {
  const facts: BusinessFact[] = [
    fact({id: 'h_sun', kind: 'hours', key: 'sun', value: {open: '12:00', close: '21:00'}}),
    fact({id: 'h_mon', kind: 'hours', key: 'mon', value: {closed: true}}),
    fact({id: 'h_fri_v1', kind: 'hours', key: 'fri', value: {open: '11:00', close: '21:00'}, status: 'superseded'}),
    fact({id: 'h_fri_v2', kind: 'hours', key: 'fri', value: {open: '11:00', close: '22:00'}, version: 2}),
    fact({id: 'h_sun_draft', kind: 'hours', key: 'sun', value: {open: '12:00', close: '22:00'}, status: 'draft', sourceType: 'owner_chat'}),
    fact({id: 'menu', kind: 'menu_item', key: 'SQ_VAR_MARG_LG', value: {priceMinor: 2100}, status: 'draft', sourceType: 'upload', fileId: 'file_1'}),
    fact({id: 'up', kind: 'policy', key: 'pickup_window', value: {minutes: 25}, status: 'draft', sourceType: 'upload', fileId: 'file_1'}),
    fact({id: 'pw', kind: 'policy', key: 'pickup_window', value: {minutes: 20}}),
    fact({id: 'sr', kind: 'policy', key: 'special_requests', value: {allowed: true}}),
    fact({id: 'faq', kind: 'faq', key: 'parking', value: {question: 'Is there parking?', answer: 'Street parking.'}}),
  ];
  const groups = groupKnowledge(facts);

  it('orders opening hours mon to sun, one row per weekday', () => {
    expect(groups.hours.map((h) => h.day)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(groups.hours[1].verified).toBeUndefined();
  });

  it('keeps the verified fact and leaves superseded ones out', () => {
    expect(groups.hours[4].verified?.id).toBe('h_fri_v2');
  });

  it('lists a non-upload draft next to the key it would change', () => {
    expect(groups.hours[6].verified?.id).toBe('h_sun');
    expect(groups.hours[6].pending.map((f) => f.id)).toEqual(['h_sun_draft']);
  });

  it('never puts menu_item facts or upload drafts in the knowledge groups', () => {
    const all = [...groups.policy, ...groups.service, ...groups.contact, ...groups.faq].flatMap((r) => [
      r.verified?.id,
      ...r.pending.map((p) => p.id),
    ]);
    expect(all).not.toContain('menu');
    expect(all).not.toContain('up');
    expect(groups.policy.map((r) => r.key)).toEqual(['pickup_window', 'special_requests']);
    expect(groups.faq[0].verified?.id).toBe('faq');
  });
});

describe('knownFileIds', () => {
  it('merges session uploads, extraction events and facts without duplicates', () => {
    const facts = [fact({id: 'a', kind: 'policy', key: 'k', fileId: 'file_old'}), fact({id: 'b', kind: 'policy', key: 'k2', fileId: 'file_new'})];
    const events = [event('extraction.completed', {fileId: 'file_evt'}), event('fact.changed', {fileId: 'nope'})];
    expect(knownFileIds(['file_new'], events, facts)).toEqual(['file_new', 'file_evt', 'file_old']);
  });
});

describe('conflicts', () => {
  const priceConflict = conflict({
    id: 'cfl_1',
    kind: 'menu_item',
    key: 'SQ_VAR_MARG_LG',
    required: true,
    candidates: [
      {factId: 'f_up', sourceType: 'upload', value: {priceMinor: 2100}},
      {sourceType: 'square', sourceRef: 'cat_x', value: {priceMinor: 2000}},
    ],
  });
  const policyConflict = conflict({id: 'cfl_2'});

  it('counts open conflicts and blocks publish only for a required one', () => {
    expect(summarizeConflicts([priceConflict, policyConflict])).toEqual({openCount: 2, requiredOpenCount: 1, blocksPublish: true});
    expect(summarizeConflicts([policyConflict])).toEqual({openCount: 1, requiredOpenCount: 0, blocksPublish: false});
    expect(summarizeConflicts([{...priceConflict, state: 'resolved'}, policyConflict]).blocksPublish).toBe(false);
    expect(summarizeConflicts([])).toEqual({openCount: 0, requiredOpenCount: 0, blocksPublish: false});
  });

  it('splits the uploaded candidate from the authority', () => {
    const {uploaded, authority} = splitCandidates(priceConflict);
    expect(uploaded?.factId).toBe('f_up');
    expect(authority?.sourceType).toBe('square');
    expect(isPriceConflict(priceConflict)).toBe(true);
    expect(isPriceConflict(policyConflict)).toBe(false);
  });

  it('maps draft facts to their open conflict', () => {
    const map = conflictByFactId([priceConflict, {...policyConflict, state: 'resolved', candidates: [{factId: 'f_x', sourceType: 'upload', value: 1}]}]);
    expect(map.get('f_up')?.id).toBe('cfl_1');
    expect(map.has('f_x')).toBe(false);
  });
});

describe('value text', () => {
  it('formats hours as wall times', () => {
    expect(formatClock('22:00')).toBe('10:00 PM');
    expect(formatClock('00:30')).toBe('12:30 AM');
    expect(formatClock('12:00')).toBe('12:00 PM');
    expect(formatHours({closed: true})).toBe('Closed');
    expect(formatHours({open: '11:00', close: '22:00'})).toBe('11:00 AM to 10:00 PM');
  });

  it('describes common shapes and flags money', () => {
    expect(describeValue('menu_item', {item: 'Margherita', variation: 'Large', priceMinor: 2100})).toEqual({
      text: 'Margherita, Large, $21.00',
      hasMoney: true,
    });
    expect(describeValue('menu_item', {priceMinor: 2000})).toEqual({text: '$20.00', hasMoney: true});
    expect(describeValue('policy', {minutes: 20}).text).toBe('20 minutes');
    expect(describeValue('policy', {allowed: false}).text).toBe('Not allowed');
    expect(describeValue('service', {id: 's', name: 'Haircut', durationMinutes: 30, priceMinor: 3500, currency: 'USD'})).toEqual({
      text: 'Haircut, 30 min, $35.00',
      hasMoney: true,
    });
    expect(describeValue('contact', {phone: '+15555550100'}).text).toBe('+15555550100');
  });

  it('keeps markup in a value as plain text', () => {
    expect(describeValue('policy', '<script>alert(1)</script>').text).toBe('<script>alert(1)</script>');
  });

  it('labels keys', () => {
    expect(factKeyLabel('hours', 'wed')).toBe('Wednesday');
    expect(factKeyLabel('policy', 'pickup_window')).toBe('Pickup window');
    expect(factKeyLabel('service', 'svc_1', {name: 'Beard trim'})).toBe('Beard trim');
    expect(factKeyLabel('menu_item', 'SQ_X', {item: 'Pepperoni', variation: 'Medium'})).toBe('Pepperoni, Medium');
  });
});

describe('corrections', () => {
  it('offers flat fields and skips locked ones', () => {
    const fields = editableFields({id: 'svc', businessId: 'b', name: 'Kids cut', durationMinutes: 20, priceMinor: 2000, currency: 'USD'});
    expect(fields?.map((f) => f.name)).toEqual(['name', 'durationMinutes', 'priceMinor']);
    expect(editableFields({nested: {a: 1}})).toBeNull();
  });

  it('applies edits, keeps types and locked fields, and rejects bad numbers', () => {
    const original = {id: 'svc', name: 'Kids cut', durationMinutes: 20, currency: 'USD'};
    expect(applyEdits(original, {durationMinutes: '25'})).toEqual({ok: true, value: {...original, durationMinutes: 25}});
    expect(applyEdits(original, {durationMinutes: 'abc'})).toEqual({ok: false, errors: {durationMinutes: 'Enter a number.'}});
    expect(applyEdits(original, {name: '  '})).toEqual({ok: false, errors: {name: 'Enter a value.'}});
    expect(applyEdits({allowed: true}, {allowed: false})).toEqual({ok: true, value: {allowed: false}});
    expect(applyEdits('text', {'': 'new'})).toEqual({ok: true, value: 'new'});
  });
});

describe('catalogSyncState', () => {
  it('reads the newest event for the job', () => {
    const queued = event('sync.queued', {target: 'catalog', jobId: 'job_1'});
    const other = event('sync.succeeded', {target: 'catalog', jobId: 'job_2'});
    const sheets = event('sync.succeeded', {target: 'google_sheets', jobId: 'job_1'});
    expect(catalogSyncState([], 'job_1')).toBe('PENDING');
    expect(catalogSyncState([other, sheets, queued], 'job_1')).toBe('PENDING');
    expect(catalogSyncState([event('sync.succeeded', {target: 'catalog', jobId: 'job_1'}), queued], 'job_1')).toBe('DONE');
    expect(catalogSyncState([event('sync.failed', {target: 'catalog', jobId: 'job_1', final: false}), queued], 'job_1')).toBe('RETRYING');
    expect(catalogSyncState([event('sync.failed', {target: 'catalog', jobId: 'job_1', final: true})], 'job_1')).toBe('FAILED');
  });
});
