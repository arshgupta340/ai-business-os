import {describe, expect, it} from 'vitest';
import {conflictView, statusView, type StatusMachine} from './status';
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

  it('shows an unknown state as itself', () => {
    expect(statusView('order', 'SOMETHING_NEW')).toEqual({label: 'SOMETHING_NEW', tone: 'neutral'});
  });

  it('marks a required open conflict as blocking', () => {
    expect(conflictView('open', true).tone).toBe('danger');
    expect(conflictView('resolved', true).tone).toBe('neutral');
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
