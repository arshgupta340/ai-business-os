import type {
  ActionExecution, ActivityEvent, ApprovalPayload, AvailabilitySlot, Booking,
  BookingApprovalPayload, ErrorCode, ExecutionStatus, FactEditApprovalPayload,
  MessageDispatchStatus, Order, OrderApprovalPayload, SyncJobState, SyncRecordType,
} from '@abos/contracts';

export type CheckoutResult = { squareOrderId: string; paymentLinkId: string; url: string };
/** The calendar adapter's own result shape (adapters/calendar): it reports failures, it does not throw them. */
export type CalendarResult =
  | { ok: true; googleEventId: string }
  | { ok: false; reason: ErrorCode; retryable: boolean; alternatives?: AvailabilitySlot[] };
/** The message layer's sendOnce result (adapters/message). A replay of an existing dispatch reports its stored state. */
export type MessageResult = {
  status: MessageDispatchStatus | 'SKIPPED';
  providerMessageId?: string;
  errorCode?: ErrorCode;
  needsReview?: boolean;
};
/** The Sheets adapter's result shape (adapters/sheets). */
export type ReportingResult = { ok: true; status: 'appended' | 'skipped' } | { ok: false; reason: ErrorCode; retryable: boolean };
/** Square checkout errors. `outcome` says what happened at Square; `orderState` marks a total mismatch. */
export type CheckoutOutcome = 'not_created' | 'unknown' | 'created_unverified';

/** Ports use shared contract records; provider implementations stay outside this directory. */
export interface SubjectsPort {
  loadOrder(businessId: string, subjectId: string): Promise<Order>;
  loadBooking(businessId: string, subjectId: string): Promise<Booking>;
  /** Called from onLinkCreated, before the total is verified: one transaction that stores the Square order ID and
   * payment link ID on the order and the step's execution row (the URL on the execution row only). No state change,
   * and the URL is not exposed to the customer or the dashboard. */
  saveCheckoutLink(businessId: string, subjectId: string, executionId: string, refs: CheckoutResult): Promise<void>;
  /** After a verified total: write the references and the URL on the order and move it to PAYMENT_LINK_READY.
   * Runs inside finish (outcome.apply), so it shares the transaction that marks the step SUCCEEDED. */
  completeCheckout(businessId: string, subjectId: string, refs: CheckoutResult): Promise<void>;
  saveEvent(businessId: string, subjectId: string, eventId: string): Promise<void>;
  moveOrder(businessId: string, subjectId: string, status: Order['status']): Promise<void>;
  moveBooking(businessId: string, subjectId: string, status: Booking['status'], alternatives?: AvailabilitySlot[]): Promise<void>;
  updateFact(businessId: string, payload: FactEditApprovalPayload): Promise<void>;
}

export type StepOutcome = {
  /** The database finishes a step only as one of these. SKIPPED is set at approval time, never by a worker. */
  status: Exclude<ExecutionStatus, 'RUNNING' | 'SKIPPED'>;
  errorCode?: ErrorCode;
  /** Fixed diagnostic text only. Never copy a provider exception message. */
  reason?: string;
  delayMs?: number;
  externalRef?: string;
  /** Message failures can continue; other failures stop the bundle. */
  continueBundle?: boolean;
  events?: ActivityEvent[];
  /** The queue runs this with transaction-scoped subjects, atomically with finish. */
  apply?: (subjects: SubjectsPort) => Promise<void>;
};

export interface QueuePort {
  /** Atomic claim, due time, lease, ordering, and EXECUTION_MAX_ATTEMPTS are enforced here.
   * attempts includes the current claim. SKIPPED steps are never claimed.
   */
  claimNext(workerId: string): Promise<ActionExecution | undefined>;
  /** Fence by worker/lease. Apply subject changes and finish in one transaction.
   * Only terminal message outcomes with continueBundle may unblock the next step.
   * A rejected transaction rolls back both the outcome and subject changes.
   */
  finish(executionId: string, workerId: string, outcome: StepOutcome): Promise<void>;
  /** Leases have no timeout, so a crash leaves a step RUNNING. One conditional update moves every step RUNNING under a
   * lease claimed before olderThan to NEEDS_REVIEW (never back to QUEUED), with continueBundle for message steps and
   * the subject moved as a failed step would move it (checkout: RECOVERY_REQUIRED, calendar: RETRY_REQUIRED).
   * Returns the steps it moved. */
  recoverStale(input: { olderThan: Date }): Promise<ActionExecution[]>;
}

export type Authorization =
  | { ok: true; execution: ActionExecution; material: ApprovalPayload }
  | { ok: false; code: ErrorCode };
export interface PolicyPort {
  authorizeStep(input: { executionId: string; businessId: string }): Promise<Authorization>;
}

export interface ExecutorDeps {
  workerId: string;
  queue: QueuePort;
  policy: PolicyPort;
  subjects: SubjectsPort;
  checkout: {
    /** Throws a typed error with `outcome` (CheckoutOutcome), or `orderState: 'RECOVERY_REQUIRED'` on a total mismatch. */
    createCheckout(input: {
      order: Order; idempotencyKey: string; approvedTotalMinor: number; currency: Order['currency'];
      onLinkCreated?: (link: CheckoutResult) => Promise<void>;
    }): Promise<CheckoutResult>;
    /** Read-only. Used when the order already holds a saved Square order ID: never create again. */
    resumeCheckout(input: {
      squareOrderId: string; paymentLinkId?: string; approvedTotalMinor: number; currency: Order['currency']; idempotencyKey?: string;
    }): Promise<CheckoutResult>;
  };
  /** The bridge builds the message store for this execution and lease, so the dispatch row is created while the step is
   * RUNNING under workerId, as the database requires. */
  messages: { sendOnce(input: { executionId: string; workerId: string; dispatchKey: string; to: string; body: string }): Promise<MessageResult> };
  calendar: {
    /** idempotencyKey is the step's stored key and becomes the Google event id; the adapter looks it up before inserting. */
    createEvent(input: { bookingId: string; calendarId: string; startUtc: string; endUtc: string; summary: string; description: string; idempotencyKey: string }): Promise<CalendarResult>;
  };
  templates: {
    checkout(input: { order: Order; approved: OrderApprovalPayload; url: string }): string;
    booking(input: { booking: Booking; approved: BookingApprovalPayload }): string;
  };
  activity: { write(event: ActivityEvent): Promise<void> };
  clock: { now(): Date };
  ids: { next(prefix: 'evt_'): string };
  /** Timer failures are observable without logging sensitive provider errors. */
  onError?(code: ErrorCode): void;
  /** A RUNNING step whose lease is older than this goes to NEEDS_REVIEW. Must exceed any provider timeout. Default 15 minutes. */
  staleAfterMs?: number;
}

export interface HandlerContext {
  execution: ActionExecution;
  material: ApprovalPayload;
  deps: ExecutorDeps;
  /** Reauthorizes immediately before a provider call and tracks uncertain effects. */
  external<T>(fn: () => Promise<T>): Promise<T>;
}

/** Provider bridges translate SDK errors into this structural type. Ambiguity wins over retryability. */
export interface ProviderFailure {
  code: ErrorCode;
  retryable?: boolean;
  requestSent?: boolean;
  ambiguous?: boolean;
}
export class TotalMismatchError extends Error {
  readonly kind = 'TOTAL_MISMATCH';
  readonly code: ErrorCode = 'INVALID_STATE';
  constructor() { super('Checkout total does not match approved material'); }
}
export class SlotConflictError extends Error {
  readonly code: ErrorCode = 'SLOT_CONFLICT';
  constructor(readonly alternatives: AvailabilitySlot[]) { super('Approved slot is no longer available'); }
}

/** No execution row exists for Sheets. The immutable row is covered by its original approval. */
export type SyncJob = {
  id: string;
  businessId: string;
  approvalId: string;
  recordId: string;
  recordType: SyncRecordType;
  attempts: number;
  row: readonly (string | number | boolean | null)[];
};
export type SyncOutcome = { status: Exclude<SyncJobState, 'PENDING' | 'RUNNING'>; delayMs?: number; errorCode?: ErrorCode };
export interface SyncDeps {
  workerId: string;
  queue: {
    /** Claim one due job, serializing claims for a record; attempts includes this claim. */
    claimNext(workerId: string): Promise<SyncJob | undefined>;
    finish(jobId: string, workerId: string, outcome: SyncOutcome): Promise<void>;
  };
  /** Rechecks the original approval, exact row and verified subject state before every append. */
  policy: { authorizeSync(job: SyncJob): Promise<{ ok: true } | { ok: false; code: ErrorCode }> };
  reporting: { appendOnce(input: { recordId: string; row: SyncJob['row'] }): Promise<ReportingResult> };
  activity: ExecutorDeps['activity'];
  clock: ExecutorDeps['clock'];
  ids: ExecutorDeps['ids'];
}
