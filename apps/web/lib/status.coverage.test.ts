/**
 * Proves that no state from the contracts reaches the owner as a raw value
 * through statusView, conflictView or factView.
 *
 * The state lists are read from the contract schemas (`Schema.options`) and
 * from the contract state machines, never copied by hand. When a value is
 * added to a contract enum and not labelled in status.ts, a test here fails.
 */
import {describe, expect, it} from 'vitest';
import {
  AgentStatusSchema,
  ApprovalStateSchema,
  BookingMachineStateSchema,
  BookingStageSchema,
  BookingStatusSchema,
  BuilderSessionStatusSchema,
  CallStageSchema,
  CallStatusSchema,
  ExecutionStatusSchema,
  ExtractionStateSchema,
  FactConflictStateSchema,
  FactKindSchema,
  FactStatusSchema,
  IntegrationStateSchema,
  MessageDispatchStatusSchema,
  MessageSendOutputSchema,
  OrderMachineStateSchema,
  OrderStageSchema,
  OrderStatusSchema,
  STATE_MACHINES,
  SyncJobStateSchema,
  type MachineName,
} from '@abos/contracts';
import {expectOwnerLabel, FUTURE_VALUES, NOT_TEXT} from './owner-label.test-helpers';
import {MENU_ITEM_DRAFT_VIEW, TONES, conflictView, factView, hasStatusLabel, readableLabel, statusView, type StatusMachine} from './status';

/** The message step reports a dispatch status or SKIPPED. The list is read from the contract union. */
const MESSAGE_STEP_STATUSES: string[] = MessageSendOutputSchema.shape.status.options.flatMap((option) =>
  'options' in option ? [...option.options] : [...option.values],
);

/**
 * The contract values each machine can be given. `feed` is left out: it is the
 * state of this browser's live connection, not a contract value. It is typed
 * against ActivityFeedStatus in status.ts and tested in status.test.ts.
 */
const CONTRACT_STATES: Record<Exclude<StatusMachine, 'feed'>, readonly string[]> = {
  // order.status_changed and booking.status_changed carry a stage or a status.
  order: OrderMachineStateSchema.options,
  booking: BookingMachineStateSchema.options,
  approval: ApprovalStateSchema.options,
  execution: ExecutionStatusSchema.options,
  syncJob: SyncJobStateSchema.options,
  catalogSync: SyncJobStateSchema.options,
  messageDispatch: MESSAGE_STEP_STATUSES,
  call: CallStatusSchema.options,
  callStage: CallStageSchema.options,
  agent: AgentStatusSchema.options,
  fact: FactStatusSchema.options,
  fileExtraction: ExtractionStateSchema.options,
  integration: IntegrationStateSchema.options,
  builderSession: BuilderSessionStatusSchema.options,
};

/** Which statusView machines show each contract state machine. */
const MACHINES_FOR_CONTRACT: Record<MachineName, StatusMachine[]> = {
  orderStage: ['callStage', 'order'],
  order: ['order'],
  bookingStage: ['callStage', 'booking'],
  booking: ['booking'],
  approval: ['approval'],
  execution: ['execution'],
  syncJob: ['syncJob', 'catalogSync'],
  agent: ['agent'],
  call: ['call'],
  messageDispatch: ['messageDispatch'],
  fact: ['fact'],
  // Fact conflicts go through conflictView, tested below.
  factConflict: [],
};

const MACHINES = Object.keys(CONTRACT_STATES) as Exclude<StatusMachine, 'feed'>[];
const ALL_MACHINES: StatusMachine[] = [...MACHINES, 'feed'];

const cases = MACHINES.flatMap((machine) => CONTRACT_STATES[machine].map((state) => [machine, state] as const));

describe('the lists under test come from the contracts', () => {
  it('reads a non-empty list for every machine', () => {
    for (const machine of MACHINES) expect(CONTRACT_STATES[machine].length, machine).toBeGreaterThan(0);
    expect(MESSAGE_STEP_STATUSES).toEqual([...MessageDispatchStatusSchema.options, 'SKIPPED']);
  });

  it('covers every state of every contract state machine', () => {
    for (const name of Object.keys(STATE_MACHINES) as MachineName[]) {
      for (const machine of MACHINES_FOR_CONTRACT[name]) {
        for (const state of STATE_MACHINES[name].states) {
          expect(CONTRACT_STATES[machine as Exclude<StatusMachine, 'feed'>], `${name} ${state} in ${machine}`).toContain(state);
        }
      }
    }
    // The stage lists and the status lists together make the machine-state lists.
    expect(new Set(OrderMachineStateSchema.options)).toEqual(new Set([...OrderStageSchema.options, ...OrderStatusSchema.options]));
    expect(new Set(BookingMachineStateSchema.options)).toEqual(new Set([...BookingStageSchema.options, ...BookingStatusSchema.options]));
    expect(new Set(CallStageSchema.options)).toEqual(new Set([...OrderStageSchema.options, ...BookingStageSchema.options]));
  });
});

describe('statusView labels every contract state', () => {
  it.each(cases)('%s %s has its own owner-facing label and an allowed tone', (machine, state) => {
    // Its own label, not the readable fallback for an unknown value.
    expect(hasStatusLabel(machine, state), 'no label in status.ts').toBe(true);
    const view = statusView(machine, state);
    expectOwnerLabel(view.label, state);
    expect(TONES).toContain(view.tone);
  });

  it('gives the same view on every call', () => {
    for (const [machine, state] of cases) expect(statusView(machine, state)).toEqual(statusView(machine, state));
  });

  it('labels an order stage and a booking stage as the call stage does', () => {
    for (const stage of OrderStageSchema.options) {
      // UNAVAILABLE is also an order status (SPEC 2.9, Unavailable items), with its own wording.
      if (stage === 'UNAVAILABLE') continue;
      expect(statusView('order', stage), stage).toEqual(statusView('callStage', stage));
    }
    for (const stage of BookingStageSchema.options) expect(statusView('booking', stage), stage).toEqual(statusView('callStage', stage));
  });
});

describe('green is only for what the server or the provider confirmed', () => {
  /**
   * Every state that may be green. Each one is confirmed by a provider or by
   * the server after it verified the provider (docs/SPEC.md 2.4 and 2.9).
   * Adding a green state means adding it here on purpose.
   */
  const CONFIRMED: Record<Exclude<StatusMachine, 'feed'>, readonly string[]> = {
    // PAID_VERIFIED: a verified COMPLETED payment. FULFILLMENT_READY: set by the server once the order is PAID_VERIFIED and recorded.
    order: ['PAID_VERIFIED', 'FULFILLMENT_READY'],
    // The calendar event insert returned an id after a clear free/busy read.
    booking: ['BOOKED_VERIFIED'],
    approval: [],
    // "provider confirms the result".
    execution: ['SUCCEEDED'],
    // The report row was appended, or the catalog sync finished.
    syncJob: ['DONE'],
    catalogSync: ['DONE'],
    // A verified delivery callback. SENT is only accepted by the channel.
    messageDispatch: ['DELIVERED'],
    call: [],
    callStage: [],
    agent: [],
    fact: [],
    fileExtraction: [],
    // The health check reached the provider.
    integration: ['connected'],
    builderSession: [],
  };

  it.each(cases)('%s %s is green only when it is a confirmed state', (machine, state) => {
    const isGreen = statusView(machine, state).tone === 'success';
    if (isGreen) expect(CONFIRMED[machine], 'green for a state that is not in the confirmed list').toContain(state);
  });

  it('keeps the confirmed list inside the contract lists', () => {
    for (const machine of MACHINES) {
      for (const state of CONFIRMED[machine]) expect(CONTRACT_STATES[machine], `${machine} ${state}`).toContain(state);
    }
  });

  it('is green only for a state that every move into is made by the server after provider verification', () => {
    for (const name of Object.keys(STATE_MACHINES) as MachineName[]) {
      const contract = STATE_MACHINES[name];
      for (const machine of MACHINES_FOR_CONTRACT[name]) {
        for (const state of contract.states) {
          if (statusView(machine, state).tone !== 'success') continue;
          const into = contract.transitions.filter((t) => t.to === state);
          expect(into.length, `${machine} ${state} has no move into it`).toBeGreaterThan(0);
          for (const move of into) {
            expect(move.serverOnly, `${machine} ${state} is green, and "${move.event}" is not a server only move`).toBe(true);
          }
        }
      }
    }
  });

  it('is never green for a state that waits, asks or is only requested', () => {
    for (const [machine, state] of cases) {
      if (!/PENDING|AWAITING|QUEUED|RUNNING|RETRY|RECHECKING|CREATING|REQUESTED|IN_PROGRESS|UNKNOWN|NEEDS_REVIEW|draft/.test(state)) continue;
      expect(statusView(machine, state).tone, `${machine} ${state}`).not.toBe('success');
    }
    // Approved by the owner is not confirmed by a provider. Sent is not delivered. Link ready is not paid.
    const notConfirmed: [StatusMachine, string][] = [
      ['approval', 'APPROVED'],
      ['order', 'APPROVED'],
      ['order', 'PAYMENT_LINK_READY'],
      ['order', 'MESSAGE_SENT'],
      ['messageDispatch', 'SENT'],
      ['agent', 'live'],
      ['fact', 'verified'],
      ['fileExtraction', 'EXTRACTED'],
      ['call', 'COMPLETED'],
    ];
    for (const [machine, state] of notConfirmed) {
      expect(hasStatusLabel(machine, state), `${machine} ${state}`).toBe(true);
      expect(statusView(machine, state).tone, `${machine} ${state}`).not.toBe('success');
    }
  });

  it('says sandbox on every order label that speaks of a payment or a link', () => {
    for (const state of OrderStatusSchema.options) {
      const {label} = statusView('order', state);
      if (/paid|payment|link/i.test(label)) expect(label, state).toContain('sandbox');
    }
    for (const state of ['PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY', 'PAYMENT_FAILED']) {
      expect(statusView('order', state).label, state).toContain('sandbox');
    }
  });
});

describe('a value this app has never seen', () => {
  const unseen = ALL_MACHINES.flatMap((machine) => FUTURE_VALUES.map((value) => [machine, value] as const));

  it.each(unseen)('%s "%s" gets a readable neutral label', (machine, value) => {
    expect(hasStatusLabel(machine, value)).toBe(false);
    const view = statusView(machine, value);
    expect(view.tone).toBe('neutral');
    expectOwnerLabel(view.label, value);
  });

  it('does not crash and is not green for a value that is not text', () => {
    for (const machine of ALL_MACHINES) {
      for (const value of NOT_TEXT) {
        const view = statusView(machine, value as string);
        expect(view, `${machine} ${String(value)}`).toEqual({label: 'Unknown status', tone: 'neutral'});
        expect(hasStatusLabel(machine, value as string)).toBe(false);
      }
    }
  });

  it('does not crash for a machine it does not know', () => {
    expect(statusView('refund' as StatusMachine, 'REFUND_PENDING')).toEqual({label: 'Refund pending', tone: 'neutral'});
    expect(statusView('constructor' as StatusMachine, 'name')).toEqual({label: 'Name', tone: 'neutral'});
  });

  it('never mutates or shares the fallback with a known state', () => {
    const before = statusView('order', 'PAID_VERIFIED');
    statusView('order', 'PAID_VERIFIED_AGAIN');
    expect(statusView('order', 'PAID_VERIFIED')).toEqual(before);
    expect(statusView('order', 'PAID_VERIFIED_AGAIN')).toEqual({label: 'Paid verified again', tone: 'neutral'});
  });
});

describe('readableLabel', () => {
  it('turns a raw key into plain words', () => {
    expect(readableLabel('PAYMENT_PENDING')).toBe('Payment pending');
    expect(readableLabel('google_sheets')).toBe('Google sheets');
    expect(readableLabel('square.checkout.create')).toBe('Square checkout create');
    expect(readableLabel('needsReview')).toBe('Needs review');
    expect(readableLabel('  qr-only  ')).toBe('Qr only');
  });

  it('returns the given text when there is nothing to read', () => {
    expect(readableLabel('')).toBe('Unknown');
    expect(readableLabel('___', 'Unknown status')).toBe('Unknown status');
    expect(readableLabel(undefined, 'Unknown status')).toBe('Unknown status');
    expect(readableLabel(null)).toBe('Unknown');
    expect(readableLabel(7)).toBe('Unknown');
  });
});

describe('conflictView', () => {
  it.each(FactConflictStateSchema.options.flatMap((state) => [[state, true] as const, [state, false] as const]))(
    '%s (required %s) has an owner-facing label and is never green',
    (state, required) => {
      const view = conflictView(state, required);
      expectOwnerLabel(view.label, state);
      expect(TONES).toContain(view.tone);
      expect(view.tone).not.toBe('success');
    },
  );

  it('shows only an open required conflict as blocking', () => {
    expect(conflictView('open', true)).toEqual({label: 'Conflict, blocks publish', tone: 'danger'});
    expect(conflictView('open', false).tone).toBe('warning');
    expect(conflictView('resolved', true).tone).toBe('neutral');
  });

  it('shows a conflict state it has never seen as a readable neutral label, not as open', () => {
    for (const value of FUTURE_VALUES) {
      for (const required of [true, false]) {
        const view = conflictView(value as 'open', required);
        expect(view.tone, value).toBe('neutral');
        expectOwnerLabel(view.label, value);
        expect(view.label).not.toMatch(/blocks publish/);
      }
    }
    expect(conflictView(undefined as unknown as 'open', true)).toEqual({label: 'Unknown status', tone: 'neutral'});
  });
});

describe('factView', () => {
  const factCases = FactKindSchema.options.flatMap((kind) => FactStatusSchema.options.map((status) => [kind, status] as const));

  it.each(factCases)('%s %s has an owner-facing label and is never green', (kind, status) => {
    const view = factView(kind, status);
    expectOwnerLabel(view.label, status);
    expectOwnerLabel(view.label, kind);
    expect(TONES).toContain(view.tone);
    expect(view.tone).not.toBe('success');
  });

  it('shows a menu_item draft as a draft for comparison, and every other fact by its status', () => {
    for (const [kind, status] of factCases) {
      const expected = kind === 'menu_item' && status === 'draft' ? MENU_ITEM_DRAFT_VIEW : statusView('fact', status);
      expect(factView(kind, status), `${kind} ${status}`).toEqual(expected);
    }
  });

  it('shows a kind or a status it has never seen as a readable neutral label', () => {
    for (const value of FUTURE_VALUES) {
      expect(factView(value, 'verified'), value).toEqual(statusView('fact', 'verified'));
      const view = factView('hours', value);
      expect(view.tone, value).toBe('neutral');
      expectOwnerLabel(view.label, value);
    }
  });
});
