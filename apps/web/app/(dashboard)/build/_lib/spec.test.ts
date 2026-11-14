import {describe, expect, it} from 'vitest';
import type {BuilderTurnResponse} from '@/lib/api';
import {continueState, EMPTY_NOTES, groupCapabilities, mergeTurn, missingFieldQuestion, parseNotes} from './spec';

function turn(over: Partial<BuilderTurnResponse> = {}): BuilderTurnResponse {
  return {
    reply: {id: 'bmsg_1', sessionId: 'bld_1', role: 'assistant', inputMode: 'text', text: 'Okay.', createdAt: '2026-11-13T19:00:00Z'},
    draftSpec: {},
    missingFields: [],
    suggestions: [],
    stopConditions: [],
    progress: {answered: 1, required: 6},
    unsupportedRequests: [],
    ...over,
  };
}

describe('groupCapabilities', () => {
  it('groups by effect from the registry, with write and external_message together', () => {
    const {groups, unknownCount} = groupCapabilities([
      'catalog.read',
      'order.propose',
      'order.checkout.prepare',
      'message.checkout.send',
      'business.facts.read',
    ]);
    expect(unknownCount).toBe(0);
    expect(groups.map((g) => g.title)).toEqual(['Reads only', 'Proposes, you approve', 'Runs only after your approval']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['catalog.read', 'business.facts.read']);
    expect(groups[1].items.map((i) => i.id)).toEqual(['order.propose']);
    expect(groups[2].items.map((i) => i.id)).toEqual(['order.checkout.prepare', 'message.checkout.send']);
    expect(groups.map((g) => g.tone)).toEqual(['neutral', 'info', 'warning']);
  });

  it('uses the registry description and never lists an unknown capability', () => {
    const {groups, unknownCount} = groupCapabilities(['catalog.read', 'sms.marketing.blast', 'catalog.read']);
    expect(unknownCount).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toEqual([
      {id: 'catalog.read', description: 'Search the cached catalog for items, variations and modifiers', effect: 'read'},
    ]);
    expect(JSON.stringify(groups)).not.toContain('sms.marketing.blast');
  });

  it('leaves out empty groups', () => {
    expect(groupCapabilities(undefined).groups).toEqual([]);
    expect(groupCapabilities(['booking.propose']).groups.map((g) => g.key)).toEqual(['proposes']);
  });
});

describe('continueState', () => {
  const ready = {
    draftSpec: {template: 'restaurant_order_taker' as const, name: 'Pizza Order Assistant'},
    missingFields: [],
    stopConditions: [],
    progress: {answered: 6, required: 6},
    hasOwnerTurn: true,
  };

  it('is enabled with no missing field and no stop condition', () => {
    expect(continueState(ready)).toEqual({canContinue: true, reasons: []});
  });

  it('is disabled while a required field is missing', () => {
    const state = continueState({...ready, missingFields: ['policy.pickup_window'], progress: {answered: 5, required: 6}});
    expect(state.canContinue).toBe(false);
    expect(state.reasons).toContain('One question is still open.');
  });

  it('is disabled by a stop condition even when nothing is missing', () => {
    const state = continueState({...ready, stopConditions: [{code: 'missing_timezone'}]});
    expect(state.canContinue).toBe(false);
    expect(state.reasons).toContain('One issue blocks the draft.');
  });

  it('is disabled for a brand new session that reports nothing missing yet', () => {
    const state = continueState({draftSpec: {}, missingFields: [], stopConditions: [], progress: {answered: 0, required: 6}, hasOwnerTurn: false});
    expect(state.canContinue).toBe(false);
  });
});

describe('mergeTurn', () => {
  it('keeps every unsupported request across turns, without duplicates', () => {
    let notes = mergeTurn(EMPTY_NOTES, turn({unsupportedRequests: ['delivery orders']}));
    notes = mergeTurn(notes, turn({unsupportedRequests: []}));
    notes = mergeTurn(notes, turn({unsupportedRequests: ['refunds', 'delivery orders']}));
    expect(notes.unsupportedRequests).toEqual(['delivery orders', 'refunds']);
  });

  it('replaces stop conditions and suggestions with the latest turn, and keeps proposed changes', () => {
    let notes = mergeTurn(
      EMPTY_NOTES,
      turn({stopConditions: [{code: 'missing_timezone'}], suggestions: ['Upload menu'], proposedChange: {approvalId: 'apv_1', bundleType: 'fact_edit'}}),
    );
    notes = mergeTurn(notes, turn({progress: {answered: 2, required: 6}}));
    expect(notes.stopConditions).toEqual([]);
    expect(notes.suggestions).toEqual([]);
    expect(notes.proposedChanges).toEqual([{approvalId: 'apv_1', bundleType: 'fact_edit'}]);
    expect(notes.progress).toEqual({answered: 2, required: 6});
  });
});

describe('parseNotes', () => {
  it('round-trips stored notes and rejects malformed input', () => {
    const notes = mergeTurn(EMPTY_NOTES, turn({unsupportedRequests: ['refunds']}));
    expect(parseNotes(JSON.stringify(notes))).toEqual(notes);
    expect(parseNotes('not json')).toEqual(EMPTY_NOTES);
    expect(parseNotes(JSON.stringify({unsupportedRequests: [1, 'x'], stopConditions: [{nope: 1}]}))).toEqual({
      ...EMPTY_NOTES,
      unsupportedRequests: ['x'],
    });
  });
});

describe('missingFieldQuestion', () => {
  it('asks a question for known keys and falls back to a readable key', () => {
    expect(missingFieldQuestion('policy.pickup_window')).toBe('How long until an order is ready for pickup?');
    expect(missingFieldQuestion('policy.after_hours')).toBe('Policy after hours');
  });
});
