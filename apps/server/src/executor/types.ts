import type {
  ActionExecution, ActivityEvent, ApprovalPayload, AvailabilitySlot, Booking,
  BookingApprovalPayload, ErrorCode, ExecutionStatus, FactEditApprovalPayload,
  MessageDispatchStatus, Order, OrderApprovalPayload, SyncJobState, SyncRecordType,
} from '@abos/contracts';

export type CheckoutResult = { squareOrderId: string; paymentLinkId: string; url: string };
export type CalendarEvent = { id: string };
export type MessageResult = Extract<MessageDispatchStatus, 'SENT' | 'FAILED' | 'UNKNOWN'> | 'skipped';

/** Ports use shared contract records; provider implementations stay outside this directory. */
export interface SubjectsPort {
  loadOrder(businessId: string, subjectId: string): Promise<Order>;
  loadBooking(businessId: string, subjectId: string): Promise<Booking>;
  saveCheckout(businessId: string, subjectId: string, refs: CheckoutResult): Promise<void>;
  saveEvent(businessId: string, subjectId: string, eventId: string): Promise<void>;
  moveOrder(businessId: string, subjectId: string, status: Order['status']): Promise<void>;
  moveBooking(businessId: string, subjectId: string, status: Booking['status'], alternatives?: AvailabilitySlot[]): Promise<void>;
  updateFact(businessId: string, payload: FactEditApprovalPayload): Promise<void>;
}

export type StepOutcome = {
  status: Exclude<ExecutionStatus, 'RUNNING'>;
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
    createCheckout(input: { order: Order; idempotencyKey: string; approvedTotalMinor: number; currency: Order['currency'] }): Promise<CheckoutResult>;
  };
  messages: { sendOnce(input: { dispatchKey: string; to: string; body: string }): Promise<MessageResult> };
  calendar: {
    createEvent(input: { bookingId: string; calendarId: string; startUtc: string; endUtc: string; summary: string; description: string }): Promise<CalendarEvent>;
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
  reporting: { appendOnce(input: { recordId: string; row: SyncJob['row'] }): Promise<'appended' | 'skipped'> };
  activity: ExecutorDeps['activity'];
  clock: ExecutorDeps['clock'];
  ids: ExecutorDeps['ids'];
}
