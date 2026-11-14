import type {
  AgentStatus,
  ApprovalState,
  BookingStage,
  BookingStatus,
  CallStatus,
  ExecutionStatus,
  FactConflictState,
  FactStatus,
  MessageDispatchStatus,
  OrderStage,
  OrderStatus,
  SyncJobState,
} from './enums';

/**
 * One allowed move. `serverOnly` (CONTRACTS 6): the server makes it only after it verified the provider's
 * answer (signed webhook plus API read, or a direct API response). No client and no model output can cause it.
 * Rule used: every move whose cause is a provider result or a verified webhook is server only. A move that an
 * owner can also cause (cancel, retry, abandon, mark failed) is not, and says so.
 */
export type Transition<S extends string> = { from: S; to: S; event: string; serverOnly?: true };

export type StateMachine<S extends string> = {
  states: readonly S[];
  initial: readonly S[];
  terminal: readonly S[];
  transitions: readonly Transition<S>[];
};

function machine<S extends string>(m: StateMachine<S>): StateMachine<S> {
  return m;
}

/** Conversation states of an order call, kept in `Call.stage` (SPEC 2.4 rulings). */
export const ORDER_STAGE_MACHINE = machine<OrderStage>({
  states: ['CALL_STARTED', 'COLLECTING', 'VALIDATING', 'UNAVAILABLE', 'CUSTOMER_CONFIRMED'],
  initial: ['CALL_STARTED'],
  // The stage stays CUSTOMER_CONFIRMED once propose_order creates the order in AWAITING_OWNER_APPROVAL.
  terminal: ['CUSTOMER_CONFIRMED'],
  transitions: [
    { from: 'CALL_STARTED', to: 'COLLECTING', event: 'caller starts an order' },
    { from: 'COLLECTING', to: 'VALIDATING', event: 'quote_order called' },
    { from: 'VALIDATING', to: 'UNAVAILABLE', event: 'quote reports ITEM_UNAVAILABLE' },
    { from: 'UNAVAILABLE', to: 'COLLECTING', event: 'caller picks another item' },
    { from: 'VALIDATING', to: 'COLLECTING', event: 'caller changes the cart' },
    { from: 'VALIDATING', to: 'CUSTOMER_CONFIRMED', event: 'caller confirms read-back and consent' },
  ],
});

/** The `orders` row. It is created by propose_order already in AWAITING_OWNER_APPROVAL. */
export const ORDER_MACHINE = machine<OrderStatus>({
  states: [
    'AWAITING_OWNER_APPROVAL', 'APPROVED', 'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING',
    'PAID_VERIFIED', 'FULFILLMENT_READY', 'REJECTED', 'APPROVAL_EXPIRED', 'UNAVAILABLE', 'PAYMENT_FAILED', 'CANCELLED',
    'RECOVERY_REQUIRED',
  ],
  initial: ['AWAITING_OWNER_APPROVAL'],
  terminal: ['REJECTED', 'APPROVAL_EXPIRED', 'UNAVAILABLE', 'CANCELLED', 'FULFILLMENT_READY'],
  transitions: [
    { from: 'AWAITING_OWNER_APPROVAL', to: 'APPROVED', event: 'approval APPROVED' },
    { from: 'AWAITING_OWNER_APPROVAL', to: 'REJECTED', event: 'approval REJECTED' },
    { from: 'AWAITING_OWNER_APPROVAL', to: 'APPROVAL_EXPIRED', event: 'approval EXPIRED' },
    { from: 'APPROVED', to: 'CREATING_CHECKOUT', event: 'executor starts square.checkout.create' },
    { from: 'CREATING_CHECKOUT', to: 'PAYMENT_LINK_READY', event: 'Square returns link and order id', serverOnly: true },
    { from: 'CREATING_CHECKOUT', to: 'UNAVAILABLE', event: 'availability re-check finds an item gone; no Square call' },
    { from: 'CREATING_CHECKOUT', to: 'RECOVERY_REQUIRED', event: 'step FAILED or NEEDS_REVIEW for any other reason', serverOnly: true },
    { from: 'RECOVERY_REQUIRED', to: 'PAYMENT_LINK_READY', event: 'reconciliation finds the link', serverOnly: true },
    { from: 'PAYMENT_LINK_READY', to: 'MESSAGE_SENT', event: 'dispatch reaches SENT', serverOnly: true },
    { from: 'MESSAGE_SENT', to: 'PAYMENT_PENDING', event: 'local.order.record runs' },
    // SPEC 2.4: qr_only, a failed send or an unknown result skips MESSAGE_SENT.
    { from: 'PAYMENT_LINK_READY', to: 'PAYMENT_PENDING', event: 'local.order.record runs after qr_only, a failed send or an unknown result' },
    { from: 'PAYMENT_PENDING', to: 'PAID_VERIFIED', event: 'verified COMPLETED payment matching order id, amount, currency, location', serverOnly: true },
    { from: 'PAYMENT_PENDING', to: 'PAYMENT_FAILED', event: 'verified failed or canceled payment', serverOnly: true },
    { from: 'PAYMENT_FAILED', to: 'PAID_VERIFIED', event: 'later verified COMPLETED payment', serverOnly: true },
    { from: 'PAYMENT_PENDING', to: 'RECOVERY_REQUIRED', event: 'payment amount or order id mismatch', serverOnly: true },
    { from: 'PAYMENT_PENDING', to: 'CANCELLED', event: 'owner cancels' },
    { from: 'PAYMENT_FAILED', to: 'CANCELLED', event: 'owner cancels' },
    { from: 'RECOVERY_REQUIRED', to: 'CANCELLED', event: 'owner cancels' },
    { from: 'PAID_VERIFIED', to: 'FULFILLMENT_READY', event: 'server queues the paid order for the kitchen', serverOnly: true },
  ],
});

/** Conversation states of a booking call, kept in `Call.stage`. */
export const BOOKING_STAGE_MACHINE = machine<BookingStage>({
  states: ['INQUIRY', 'SLOT_SEARCH', 'PROPOSAL', 'CUSTOMER_CONFIRMED'],
  initial: ['INQUIRY'],
  terminal: ['CUSTOMER_CONFIRMED'],
  transitions: [
    { from: 'INQUIRY', to: 'SLOT_SEARCH', event: 'read_calendar_availability called' },
    { from: 'SLOT_SEARCH', to: 'PROPOSAL', event: 'agent offers a slot' },
    { from: 'PROPOSAL', to: 'SLOT_SEARCH', event: 'caller wants another time' },
    { from: 'PROPOSAL', to: 'CUSTOMER_CONFIRMED', event: 'caller confirms slot and contact' },
  ],
});

/** The `bookings` row. There is no APPROVED state; the expired branch is EXPIRED (SPEC 2.4). */
export const BOOKING_MACHINE = machine<BookingStatus>({
  states: ['AWAITING_OWNER_APPROVAL', 'RECHECKING_SLOT', 'BOOKED_VERIFIED', 'SLOT_CONFLICT', 'REJECTED', 'EXPIRED', 'RETRY_REQUIRED'],
  initial: ['AWAITING_OWNER_APPROVAL'],
  terminal: ['BOOKED_VERIFIED', 'SLOT_CONFLICT', 'REJECTED', 'EXPIRED'],
  transitions: [
    { from: 'AWAITING_OWNER_APPROVAL', to: 'RECHECKING_SLOT', event: 'approval APPROVED; takes the local slot lock' },
    { from: 'AWAITING_OWNER_APPROVAL', to: 'SLOT_CONFLICT', event: 'approval APPROVED but bookings_no_overlap refuses RECHECKING_SLOT' },
    { from: 'AWAITING_OWNER_APPROVAL', to: 'REJECTED', event: 'approval REJECTED' },
    { from: 'AWAITING_OWNER_APPROVAL', to: 'EXPIRED', event: 'approval EXPIRED' },
    { from: 'RECHECKING_SLOT', to: 'BOOKED_VERIFIED', event: 'event insert returned an id after a clear free/busy read', serverOnly: true },
    { from: 'RECHECKING_SLOT', to: 'SLOT_CONFLICT', event: 'fresh free/busy shows the slot busy', serverOnly: true },
    { from: 'RECHECKING_SLOT', to: 'RETRY_REQUIRED', event: 'calendar step FAILED or NEEDS_REVIEW', serverOnly: true },
    { from: 'RETRY_REQUIRED', to: 'RECHECKING_SLOT', event: 'owner retries, approval still valid, same key' },
    { from: 'RETRY_REQUIRED', to: 'BOOKED_VERIFIED', event: 'reconciliation finds the event by id', serverOnly: true },
  ],
});

export const APPROVAL_MACHINE = machine<ApprovalState>({
  states: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
  initial: ['PENDING'],
  terminal: ['APPROVED', 'REJECTED', 'EXPIRED'],
  transitions: [
    { from: 'PENDING', to: 'APPROVED', event: 'owner approves with matching hash before expiresAt' },
    { from: 'PENDING', to: 'REJECTED', event: 'owner rejects' },
    { from: 'PENDING', to: 'EXPIRED', event: 'expiresAt passes' },
  ],
});

/** No retry state: a retryable failure goes back to QUEUED (SPEC 2.9). */
export const EXECUTION_MACHINE = machine<ExecutionStatus>({
  states: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'NEEDS_REVIEW'],
  initial: ['QUEUED'],
  terminal: ['SUCCEEDED', 'SKIPPED', 'FAILED'],
  transitions: [
    { from: 'QUEUED', to: 'SKIPPED', event: 'message step claimed while MESSAGE_CHANNEL is qr_only' },
    { from: 'QUEUED', to: 'RUNNING', event: 'worker claims the row' },
    { from: 'RUNNING', to: 'SUCCEEDED', event: 'provider confirms the result', serverOnly: true },
    { from: 'RUNNING', to: 'QUEUED', event: 'retryable error, attempts below 3', serverOnly: true },
    { from: 'RUNNING', to: 'FAILED', event: 'non-retryable error, or third attempt failed', serverOnly: true },
    { from: 'RUNNING', to: 'NEEDS_REVIEW', event: 'outcome unknown', serverOnly: true },
    { from: 'NEEDS_REVIEW', to: 'SUCCEEDED', event: 'reconciliation finds the external object', serverOnly: true },
    { from: 'NEEDS_REVIEW', to: 'QUEUED', event: 'reconciliation proves nothing happened (same key)', serverOnly: true },
    { from: 'NEEDS_REVIEW', to: 'FAILED', event: 'owner abandons the step' },
  ],
});

export const SYNC_JOB_MACHINE = machine<SyncJobState>({
  states: ['PENDING', 'RUNNING', 'DONE', 'RETRYING', 'FAILED'],
  initial: ['PENDING'],
  terminal: ['DONE', 'FAILED'],
  transitions: [
    { from: 'PENDING', to: 'RUNNING', event: 'runner picks it up' },
    { from: 'RUNNING', to: 'DONE', event: 'row appended or recordId already present', serverOnly: true },
    { from: 'RUNNING', to: 'RETRYING', event: 'error with attempts below 5', serverOnly: true },
    { from: 'RETRYING', to: 'RUNNING', event: 'nextRetryAt reached' },
    { from: 'RUNNING', to: 'FAILED', event: 'fifth attempt failed', serverOnly: true },
  ],
});

/** No terminal state. live to live is a published update (atomic swap). */
export const AGENT_MACHINE = machine<AgentStatus>({
  states: ['draft', 'live', 'paused'],
  initial: ['draft'],
  terminal: [],
  transitions: [
    { from: 'draft', to: 'live', event: 'owner publishes a validated spec' },
    { from: 'live', to: 'live', event: 'published update' },
    { from: 'live', to: 'paused', event: 'owner pauses' },
    { from: 'paused', to: 'live', event: 'owner resumes or publishes' },
  ],
});

export const CALL_MACHINE = machine<CallStatus>({
  states: ['IN_PROGRESS', 'COMPLETED', 'DROPPED', 'FAILED'],
  initial: ['IN_PROGRESS'],
  terminal: ['COMPLETED', 'DROPPED', 'FAILED'],
  transitions: [
    // Not server only: a simulated call is also completed by the owner's `end: true` (P-18).
    { from: 'IN_PROGRESS', to: 'COMPLETED', event: 'call ends normally' },
    { from: 'IN_PROGRESS', to: 'DROPPED', event: 'stream closed unexpectedly', serverOnly: true },
    { from: 'IN_PROGRESS', to: 'FAILED', event: 'setup, model or relay error', serverOnly: true },
  ],
});

/** No row exists under qr_only. No automatic resend from UNKNOWN. */
export const MESSAGE_DISPATCH_MACHINE = machine<MessageDispatchStatus>({
  states: ['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNKNOWN'],
  initial: ['QUEUED'],
  terminal: ['DELIVERED', 'FAILED'],
  transitions: [
    { from: 'QUEUED', to: 'SENT', event: 'provider accepts and returns a message id', serverOnly: true },
    { from: 'QUEUED', to: 'FAILED', event: 'provider rejects', serverOnly: true },
    { from: 'QUEUED', to: 'UNKNOWN', event: 'timeout, result unknown', serverOnly: true },
    { from: 'UNKNOWN', to: 'SENT', event: 'provider lookup shows accepted', serverOnly: true },
    // Not server only: the owner may also mark an UNKNOWN dispatch failed.
    { from: 'UNKNOWN', to: 'FAILED', event: 'lookup shows nothing sent, or owner marks failed' },
    { from: 'SENT', to: 'DELIVERED', event: 'verified delivery callback: delivered', serverOnly: true },
    { from: 'SENT', to: 'FAILED', event: 'verified delivery callback: failed', serverOnly: true },
  ],
});

export const FACT_MACHINE = machine<FactStatus>({
  states: ['draft', 'verified', 'superseded'],
  initial: ['draft'],
  terminal: ['superseded'],
  transitions: [
    { from: 'draft', to: 'verified', event: 'approved fact_edit runs local.fact.update' },
    { from: 'verified', to: 'superseded', event: 'a newer verified row replaces it, same transaction' },
    // Issue #56: POST /api/conflicts/:id/resolve with keep_authoritative supersedes the losing draft.
    { from: 'draft', to: 'superseded', event: 'conflict resolved keeping the authoritative value' },
  ],
});

export const FACT_CONFLICT_MACHINE = machine<FactConflictState>({
  states: ['open', 'resolved'],
  initial: ['open'],
  terminal: ['resolved'],
  transitions: [{ from: 'open', to: 'resolved', event: 'owner picks a candidate, or an approved edit carries resolvesConflictId' }],
});

export const STATE_MACHINES = {
  orderStage: ORDER_STAGE_MACHINE,
  order: ORDER_MACHINE,
  bookingStage: BOOKING_STAGE_MACHINE,
  booking: BOOKING_MACHINE,
  approval: APPROVAL_MACHINE,
  execution: EXECUTION_MACHINE,
  syncJob: SYNC_JOB_MACHINE,
  agent: AGENT_MACHINE,
  call: CALL_MACHINE,
  messageDispatch: MESSAGE_DISPATCH_MACHINE,
  fact: FACT_MACHINE,
  factConflict: FACT_CONFLICT_MACHINE,
} as const;

export type MachineName = keyof typeof STATE_MACHINES;
export type MachineState<M extends MachineName> = (typeof STATE_MACHINES)[M]['states'][number];

function find<M extends MachineName>(name: M, from: MachineState<M>, to: MachineState<M>): Transition<string> | undefined {
  const m = STATE_MACHINES[name] as StateMachine<string>;
  return m.transitions.find((t) => t.from === from && t.to === to);
}

export function canTransition<M extends MachineName>(name: M, from: MachineState<M>, to: MachineState<M>): boolean {
  return find(name, from, to) !== undefined;
}

export function nextStates<M extends MachineName>(name: M, from: MachineState<M>): MachineState<M>[] {
  const m = STATE_MACHINES[name] as StateMachine<string>;
  return m.transitions.filter((t) => t.from === from).map((t) => t.to as MachineState<M>);
}

/** True when only the server may make this move, after provider verification. False if the move is not allowed at all. */
export function isServerOnlyTransition<M extends MachineName>(name: M, from: MachineState<M>, to: MachineState<M>): boolean {
  return find(name, from, to)?.serverOnly === true;
}

export function isTerminal<M extends MachineName>(name: M, state: MachineState<M>): boolean {
  return (STATE_MACHINES[name].terminal as readonly string[]).includes(state);
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_STATE' as const;
  constructor(
    readonly machine: MachineName,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${machine}: ${from} -> ${to} is not an allowed transition`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition<M extends MachineName>(name: M, from: MachineState<M>, to: MachineState<M>): void {
  if (!canTransition(name, from, to)) throw new InvalidTransitionError(name, from, to);
}
