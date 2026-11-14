import {describe, expect, it} from 'vitest';
import {MENU_ITEM_DRAFT_VIEW, conflictView, factView, statusView, type StatusMachine} from './status';
import {formatCountdown, formatMoney, secondsUntil} from './format';

describe('statusView', () => {
  it('is green only for states the server or provider confirmed', () => {
    const waiting: [StatusMachine, string][] = [
      ['order', 'AWAITING_OWNER_APPROVAL'],
      ['order', 'APPROVED'],
      ['order', 'PAYMENT_LINK_READY'],
      ['order', 'MESSAGE_SENT'],
      ['order', 'PAYMENT_PENDING'],
      ['booking', 'RECHECKING_SLOT'],
      ['approval', 'APPROVED'],
      ['execution', 'RUNNING'],
      ['messageDispatch', 'SENT'],
      ['agent', 'live'],
    ];
    for (const [machine, state] of waiting) {
      expect(statusView(machine, state).tone, `${machine} ${state}`).not.toBe('success');
    }
    expect(statusView('order', 'PAID_VERIFIED').tone).toBe('success');
    expect(statusView('booking', 'BOOKED_VERIFIED').tone).toBe('success');
  });

  it('labels every payment state as sandbox', () => {
    for (const state of ['PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'PAYMENT_FAILED']) {
      expect(statusView('order', state).label).toContain('sandbox');
    }
  });

  it('shows an unknown state in a readable form, in neutral, never as the raw value', () => {
    expect(statusView('order', 'SOMETHING_NEW')).toEqual({label: 'Something new', tone: 'neutral'});
  });

  it('marks a required open conflict as blocking', () => {
    expect(conflictView('open', true).tone).toBe('danger');
    expect(conflictView('resolved', true).tone).toBe('neutral');
  });
});

describe('added machines', () => {
  it('never shows the feed as green', () => {
    for (const state of ['connecting', 'connected', 'disconnected', 'unavailable', 'idle']) {
      expect(statusView('feed', state).tone, state).not.toBe('success');
    }
    expect(statusView('feed', 'connected')).toEqual({label: 'Live updates: on', tone: 'info'});
    expect(statusView('feed', 'disconnected').tone).toBe('warning');
  });

  it('words catalog sync about the Square catalog and leaves the Sheets labels alone', () => {
    for (const state of ['PENDING', 'RUNNING', 'RETRYING', 'DONE', 'FAILED']) {
      expect(statusView('catalogSync', state).label.toLowerCase(), state).toContain('catalog');
    }
    expect(statusView('catalogSync', 'PENDING').tone).not.toBe('success');
    expect(statusView('catalogSync', 'RETRYING').tone).toBe('warning');
    expect(statusView('catalogSync', 'FAILED').tone).toBe('danger');
    expect(statusView('syncJob', 'DONE')).toEqual({label: 'Report written', tone: 'success'});
    expect(statusView('syncJob', 'PENDING')).toEqual({label: 'Report pending', tone: 'info'});
  });

  it('labels builder sessions without green', () => {
    expect(statusView('builderSession', 'active').label).toBe('In progress');
    for (const state of ['active', 'completed', 'abandoned']) {
      expect(statusView('builderSession', state).tone, state).not.toBe('success');
    }
  });

  it('says a menu_item draft is for comparison only', () => {
    expect(factView('menu_item', 'draft')).toEqual(MENU_ITEM_DRAFT_VIEW);
    expect(MENU_ITEM_DRAFT_VIEW.label).toContain('comparison only');
    expect(factView('hours', 'draft')).toEqual(statusView('fact', 'draft'));
    expect(factView('menu_item', 'superseded')).toEqual(statusView('fact', 'superseded'));
  });
});

describe('format', () => {
  it('formats minor units as money', () => {
    expect(formatMoney(4731)).toBe('$47.31');
  });
  it('counts down and never goes negative', () => {
    const now = Date.parse('2026-11-14T19:00:00Z');
    expect(secondsUntil('2026-11-14T19:09:41Z', now)).toBe(581);
    expect(formatCountdown(581)).toBe('9:41');
    expect(secondsUntil('2026-11-14T18:00:00Z', now)).toBe(0);
    expect(formatCountdown(0)).toBe('0:00');
  });
});
