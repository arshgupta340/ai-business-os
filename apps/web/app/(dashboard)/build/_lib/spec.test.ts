import {describe, expect, it} from 'vitest';
import {ApiError, type BuilderTurnResponse} from '@/lib/api';
import {
  builderSendErrorView,
  continueState,
  EMPTY_NOTES,
  groupStopConditions,
  groupCapabilities,
  humanizeKey,
  mergeTurn,
  missingFieldQuestion,
  parseNotes,
  stopConditionLabel,
  stopConditionLink,
} from './spec';

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

  it('is disabled by an open conflict', () => {
    const state = continueState({...ready, stopConditions: [{code: 'open_conflict'}]});
    expect(state.canContinue).toBe(false);
    expect(state.reasons).toEqual(['One issue blocks the draft.']);
  });

  it('is not blocked by stop conditions that only block publish', () => {
    const stopConditions = [
      {code: 'missing_required_fact'},
      {code: 'missing_required_fact'},
      {code: 'missing_required_fact'},
      {code: 'missing_message_consent_policy'},
      {code: 'empty_catalog'},
    ];
    expect(continueState({...ready, stopConditions})).toEqual({canContinue: true, reasons: []});
  });

  it('counts only the blocking stop conditions in the reason', () => {
    const stopConditions = [
      {code: 'missing_timezone'},
      {code: 'open_conflict'},
      {code: 'missing_required_fact'},
      {code: 'missing_required_fact'},
      {code: 'empty_catalog'},
    ];
    const state = continueState({...ready, stopConditions});
    expect(state.canContinue).toBe(false);
    expect(state.reasons).toEqual(['2 issues block the draft.']);
  });

  it('still blocks on a missing field when only publish stop conditions are present', () => {
    const state = continueState({...ready, missingFields: ['hours.mon'], stopConditions: [{code: 'missing_required_fact'}]});
    expect(state.canContinue).toBe(false);
    expect(state.reasons).toEqual(['One question is still open.']);
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

// Real server answers on origin/arsh/integration:
// apps/server/src/builder/session/requirements.ts stopConditions() and RULES,
// apps/server/src/builder/session/service.ts turn() (INVALID_STATE and INTEGRATION_UNAVAILABLE).
describe('builder turn answers from the real server', () => {
  it('gives every stop condition code the builder sends an owner-readable line and a place to fix it', () => {
    for (const code of ['missing_timezone', 'open_conflict', 'missing_message_consent_policy', 'empty_catalog']) {
      const label = stopConditionLabel(code);
      expect(label).not.toBe(humanizeKey(code));
      expect(label).toMatch(/\.$/);
      expect(label).not.toMatch(/_/);
      expect(stopConditionLink(code)?.href).toMatch(/^\/(settings|knowledge)$/);
    }
    expect(stopConditionLink('open_conflict')?.href).toBe('/knowledge');
    expect(stopConditionLink('missing_required_fact')?.href).toBe('/approvals');
    expect(stopConditionLabel('missing_required_fact')).not.toMatch(/_/);
    expect(stopConditionLink('brand_new_code')).toBeNull();
  });

  it('asks a real question for each missing field key the builder uses', () => {
    for (const key of ['hours.mon', 'hours.sun', 'catalog.items', 'policy.min_notice', 'policy.message_consent', 'services', 'name', 'goal']) {
      expect(missingFieldQuestion(key)).toMatch(/\?$/);
    }
    expect(missingFieldQuestion('hours.tue')).toMatch(/Tuesday/);
  });

  it('passes the approval id of a proposed fact_edit through unchanged', () => {
    const notes = mergeTurn(EMPTY_NOTES, turn({proposedChange: {approvalId: 'apv_01JD8Q7Z9X', bundleType: 'fact_edit'}}));
    expect(notes.proposedChanges).toEqual([{approvalId: 'apv_01JD8Q7Z9X', bundleType: 'fact_edit'}]);
    expect(parseNotes(JSON.stringify(notes)).proposedChanges[0].approvalId).toBe('apv_01JD8Q7Z9X');
  });

  const err = (code: ApiError['code'], message: string, details: Record<string, unknown>, status: number, retryable: boolean) =>
    new ApiError({code, message, status, retryable, details, kind: 'http', correlationId: 'cor_b_1'});

  it('says a message hit by a session change was not lost and can be sent again', () => {
    const view = builderSendErrorView(
      err('INVALID_STATE', 'This builder session changed while the message was handled. Send it again.', {state: 'active'}, 409, false),
    );
    expect(view.canRetry).toBe(true);
    expect(view.refreshSession).toBe(true);
    expect(view.sessionBroken).toBe(false);
    expect(view.tone).toBe('warning');
    expect(view.description).toMatch(/not lost/);
    expect(view.description).toMatch(/send it again/i);
  });

  it('treats a closed session as closed, not as a retry', () => {
    const view = builderSendErrorView(err('INVALID_STATE', 'This builder session is closed.', {state: 'closed'}, 409, false));
    expect(view.canRetry).toBe(false);
    expect(view.sessionBroken).toBe(true);
  });

  it('names the builder model when OpenAI is not available', () => {
    const view = builderSendErrorView(
      err('INTEGRATION_UNAVAILABLE', 'The builder model is not available right now. Try again.', {provider: 'openai'}, 503, true),
    );
    expect(view.description).toMatch(/^OpenAI is not responding\./);
    expect(view.description).toMatch(/kept/);
    expect(view.canRetry).toBe(true);
  });

  it('falls back to the server message for anything else', () => {
    const view = builderSendErrorView(err('INTERNAL', 'Something went wrong.', {}, 500, true));
    expect(view.description).toBe('Something went wrong.');
    expect(view.canRetry).toBe(true);
  });
});

describe('groupStopConditions', () => {
  it('collapses every missing_required_fact into one counted line under before publish', () => {
    const groups = groupStopConditions([
      {code: 'missing_required_fact'},
      {code: 'empty_catalog'},
      {code: 'missing_required_fact'},
      {code: 'missing_required_fact'},
    ]);
    expect(groups.blocking).toEqual([]);
    expect(groups.beforePublish.map((l) => l.label)).toEqual([
      '3 required answers are not confirmed yet. Confirm each one in the chat or in Approvals.',
      stopConditionLabel('empty_catalog'),
    ]);
    expect(groups.beforePublish[0].link).toEqual({label: 'Open Approvals', href: '/approvals'});
    expect(new Set(groups.beforePublish.map((l) => l.key)).size).toBe(2);
  });

  it('uses the singular for one required answer', () => {
    const {beforePublish} = groupStopConditions([{code: 'missing_required_fact'}]);
    expect(beforePublish[0].label).toBe('1 required answer is not confirmed yet. Confirm it in the chat or in Approvals.');
  });

  it('puts the timezone and an open conflict under blocking, once each', () => {
    const groups = groupStopConditions([{code: 'open_conflict'}, {code: 'missing_timezone'}, {code: 'open_conflict'}]);
    expect(groups.blocking.map((l) => l.code)).toEqual(['open_conflict', 'missing_timezone']);
    expect(groups.blocking[0].link?.href).toBe('/knowledge');
    expect(groups.beforePublish).toEqual([]);
  });
});
