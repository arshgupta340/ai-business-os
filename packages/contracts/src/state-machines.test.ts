import { describe, expect, it } from 'vitest';
import {
  STATE_MACHINES,
  assertTransition,
  canTransition,
  isServerOnlyTransition,
  isTerminal,
  nextStates,
  type MachineName,
  type StateMachine,
} from './index';

// SPEC 2.4, written out. Order and booking include the conversation stages.
const SPEC_STATES: Record<string, string[]> = {
  order: ['CALL_STARTED', 'COLLECTING', 'VALIDATING', 'CUSTOMER_CONFIRMED', 'AWAITING_OWNER_APPROVAL', 'APPROVED', 'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY', 'REJECTED', 'APPROVAL_EXPIRED', 'UNAVAILABLE', 'PAYMENT_FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'],
  booking: ['INQUIRY', 'SLOT_SEARCH', 'PROPOSAL', 'CUSTOMER_CONFIRMED', 'AWAITING_OWNER_APPROVAL', 'RECHECKING_SLOT', 'BOOKED_VERIFIED', 'SLOT_CONFLICT', 'REJECTED', 'EXPIRED', 'RETRY_REQUIRED'],
  approval: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
  execution: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'NEEDS_REVIEW'],
  syncJob: ['PENDING', 'RUNNING', 'DONE', 'RETRYING', 'FAILED'],
  agent: ['draft', 'live', 'paused'],
  call: ['IN_PROGRESS', 'COMPLETED', 'DROPPED', 'FAILED'],
  messageDispatch: ['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNKNOWN'],
  fact: ['draft', 'verified', 'superseded'],
  factConflict: ['open', 'resolved'],
};

function statesOf(name: MachineName): string[] {
  return [...(STATE_MACHINES[name] as StateMachine<string>).states];
}

describe('state machines', () => {
  it('cover every SPEC 2.4 state', () => {
    expect(new Set([...statesOf('orderStage'), ...statesOf('order')])).toEqual(new Set(SPEC_STATES.order));
    expect(new Set([...statesOf('bookingStage'), ...statesOf('booking')])).toEqual(new Set(SPEC_STATES.booking));
    for (const name of ['approval', 'execution', 'syncJob', 'agent', 'call', 'messageDispatch', 'fact', 'factConflict'] as const) {
      expect(new Set(statesOf(name))).toEqual(new Set(SPEC_STATES[name]));
    }
  });

  it('use only declared states, and terminal states have no exits', () => {
    for (const name of Object.keys(STATE_MACHINES) as MachineName[]) {
      const m = STATE_MACHINES[name] as StateMachine<string>;
      for (const t of m.transitions) {
        expect(m.states).toContain(t.from);
        expect(m.states).toContain(t.to);
      }
      for (const s of m.terminal) expect(m.transitions.filter((t) => t.from === s)).toEqual([]);
    }
    expect(STATE_MACHINES.agent.terminal).toEqual([]);
  });

  it('order: legal and illegal moves', () => {
    expect(canTransition('order', 'AWAITING_OWNER_APPROVAL', 'APPROVED')).toBe(true);
    expect(canTransition('order', 'APPROVED', 'CREATING_CHECKOUT')).toBe(true);
    expect(canTransition('order', 'PAYMENT_FAILED', 'PAID_VERIFIED')).toBe(true);
    expect(canTransition('order', 'AWAITING_OWNER_APPROVAL', 'PAID_VERIFIED')).toBe(false);
    expect(canTransition('order', 'REJECTED', 'APPROVED')).toBe(false);
    expect(canTransition('order', 'PAID_VERIFIED', 'CANCELLED')).toBe(false);
    expect(() => assertTransition('order', 'CANCELLED', 'PAYMENT_PENDING')).toThrow(/not an allowed transition/);
    expect(isTerminal('order', 'FULFILLMENT_READY')).toBe(true);
  });

  it('order message path: PAYMENT_LINK_READY goes to MESSAGE_SENT or straight to PAYMENT_PENDING', () => {
    expect(new Set(nextStates('order', 'PAYMENT_LINK_READY'))).toEqual(new Set(['MESSAGE_SENT', 'PAYMENT_PENDING']));
    expect(nextStates('order', 'MESSAGE_SENT')).toEqual(['PAYMENT_PENDING']);
  });

  it('order stage: UNAVAILABLE loops back to COLLECTING while the order status UNAVAILABLE is terminal', () => {
    expect(canTransition('orderStage', 'UNAVAILABLE', 'COLLECTING')).toBe(true);
    expect(isTerminal('order', 'UNAVAILABLE')).toBe(true);
    expect(nextStates('order', 'UNAVAILABLE')).toEqual([]);
  });

  it('marks provider-verified moves as server only', () => {
    expect(isServerOnlyTransition('order', 'PAYMENT_PENDING', 'PAID_VERIFIED')).toBe(true);
    expect(isServerOnlyTransition('order', 'CREATING_CHECKOUT', 'PAYMENT_LINK_READY')).toBe(true);
    expect(isServerOnlyTransition('order', 'PAID_VERIFIED', 'FULFILLMENT_READY')).toBe(true);
    expect(isServerOnlyTransition('order', 'PAYMENT_PENDING', 'CANCELLED')).toBe(false);
    expect(isServerOnlyTransition('booking', 'RECHECKING_SLOT', 'BOOKED_VERIFIED')).toBe(true);
    expect(isServerOnlyTransition('execution', 'RUNNING', 'SUCCEEDED')).toBe(true);
    expect(isServerOnlyTransition('messageDispatch', 'QUEUED', 'SENT')).toBe(true);
    expect(isServerOnlyTransition('order', 'REJECTED', 'APPROVED')).toBe(false);
  });

  it('every provider-derived move is server only; owner-caused moves are not', () => {
    const serverOnly: [MachineName, string, string][] = [
      ['order', 'CREATING_CHECKOUT', 'RECOVERY_REQUIRED'],
      ['booking', 'RECHECKING_SLOT', 'SLOT_CONFLICT'],
      ['booking', 'RECHECKING_SLOT', 'RETRY_REQUIRED'],
      ['execution', 'RUNNING', 'QUEUED'],
      ['execution', 'RUNNING', 'FAILED'],
      ['execution', 'RUNNING', 'NEEDS_REVIEW'],
      ['execution', 'NEEDS_REVIEW', 'QUEUED'],
      ['syncJob', 'RUNNING', 'DONE'],
      ['syncJob', 'RUNNING', 'RETRYING'],
      ['syncJob', 'RUNNING', 'FAILED'],
      ['call', 'IN_PROGRESS', 'DROPPED'],
      ['call', 'IN_PROGRESS', 'FAILED'],
      ['messageDispatch', 'QUEUED', 'FAILED'],
      ['messageDispatch', 'QUEUED', 'UNKNOWN'],
      ['messageDispatch', 'UNKNOWN', 'SENT'],
      ['messageDispatch', 'SENT', 'FAILED'],
    ];
    for (const [m, from, to] of serverOnly) expect(isServerOnlyTransition(m, from as never, to as never), `${m} ${from}->${to}`).toBe(true);
    const ownerCaused: [MachineName, string, string][] = [
      ['order', 'PAYMENT_PENDING', 'CANCELLED'],
      ['booking', 'RETRY_REQUIRED', 'RECHECKING_SLOT'],
      ['execution', 'NEEDS_REVIEW', 'FAILED'],
      ['messageDispatch', 'UNKNOWN', 'FAILED'],
      ['call', 'IN_PROGRESS', 'COMPLETED'],
      ['approval', 'PENDING', 'APPROVED'],
    ];
    for (const [m, from, to] of ownerCaused) expect(isServerOnlyTransition(m, from as never, to as never), `${m} ${from}->${to}`).toBe(false);
  });

  it('booking: no APPROVED state, expired branch is EXPIRED', () => {
    expect(statesOf('booking')).not.toContain('APPROVED');
    expect(canTransition('booking', 'AWAITING_OWNER_APPROVAL', 'EXPIRED')).toBe(true);
    expect(canTransition('booking', 'RETRY_REQUIRED', 'RECHECKING_SLOT')).toBe(true);
    expect(canTransition('booking', 'BOOKED_VERIFIED', 'RECHECKING_SLOT')).toBe(false);
    expect(canTransition('bookingStage', 'PROPOSAL', 'SLOT_SEARCH')).toBe(true);
  });

  it('approval, execution, sync job, dispatch, agent, call, fact', () => {
    expect(nextStates('approval', 'PENDING').sort()).toEqual(['APPROVED', 'EXPIRED', 'REJECTED']);
    expect(canTransition('approval', 'APPROVED', 'REJECTED')).toBe(false);
    expect(canTransition('execution', 'RUNNING', 'QUEUED')).toBe(true); // no retry state
    expect(canTransition('execution', 'QUEUED', 'SKIPPED')).toBe(true);
    expect(canTransition('execution', 'FAILED', 'QUEUED')).toBe(false);
    expect(canTransition('syncJob', 'RETRYING', 'RUNNING')).toBe(true);
    expect(canTransition('syncJob', 'DONE', 'RUNNING')).toBe(false);
    expect(canTransition('messageDispatch', 'UNKNOWN', 'SENT')).toBe(true);
    expect(canTransition('messageDispatch', 'UNKNOWN', 'QUEUED')).toBe(false); // no automatic resend
    expect(canTransition('agent', 'live', 'live')).toBe(true);
    expect(canTransition('agent', 'draft', 'paused')).toBe(false);
    expect(canTransition('call', 'COMPLETED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('fact', 'verified', 'superseded')).toBe(true);
    expect(canTransition('fact', 'superseded', 'verified')).toBe(false);
  });
});
