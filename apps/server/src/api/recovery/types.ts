import type {
  ActionExecution, ActivityEvent, ApprovalRequest, Booking, MessageDispatch, Order,
  ResolveExecutionBody,
} from '@abos/contracts';

export type RecoveryScope = { businessId: string; ownerUserId: string; id: string };
export type RecoveryRecord = {
  execution: ActionExecution;
  approval: ApprovalRequest;
  order?: Order;
  booking?: Booking;
  dispatch?: MessageDispatch;
};

/** Read only. "exists" means the provider object matches the approved material, not just its ID.
 * "absent" is positive proof of no effect. A timeout or unsupported lookup is "unknown".
 */
export type RecoveryLookup =
  | { outcome: 'exists'; externalRef: string }
  | { outcome: 'absent' }
  | { outcome: 'unknown' };

/** One durable decision per execution attempt. A new generation begins only when a worker
 * later reaches NEEDS_REVIEW again with a new attempt number. */
export type RecoveryDecision = {
  action: ResolveExecutionBody['action'];
  generation: number;
  execution: ActionExecution;
};

export interface RecoveryTransaction {
  loadOrder(): Promise<Order | undefined>;
  loadExecution(): Promise<RecoveryRecord | undefined>;
  /** Durable receipt, scoped to business, execution and the current attempt. It is not keyed
   * by owner action: the opposite action must be refused for the same recovery generation.
   * Return the current execution only when the stored generation equals the current attempt.
   */
  recoveryDecision(): Promise<RecoveryDecision | undefined>;
  /** Local cancellation only. Fence queued work and refuse running/uncertain external effects.
   * Re-read the order under its lock; paid orders cannot be cancelled. No provider cancellation.
   */
  cancelOrder(order: Order): Promise<Order>;
  /** Direct wrapper for the migration's checked NEEDS_REVIEW recovery routine. The routine
   * locks the execution, verifies owner, business, approval material, key and attempts, writes
   * the one recovery decision and audit event atomically, then returns the current execution.
   * It cannot be implemented with private.finish_execution because that routine needs a worker
   * lease on RUNNING. This module uses it only for abandon until downstream recovery routines
   * and contract transitions are available.
   */
  resolveNeedsReview(input: {
    record: RecoveryRecord;
    action: ResolveExecutionBody['action'];
    status: Extract<ActionExecution['status'], 'SUCCEEDED' | 'QUEUED' | 'FAILED'>;
    lookup: RecoveryLookup;
    event: ActivityEvent;
  }): Promise<RecoveryDecision>;
  /** Transaction-scoped activity writer. Rolls back with the mutation and receipt on failure. */
  activity: { write(event: ActivityEvent): Promise<void> };
}

export interface RecoveryPorts {
  ownsBusiness(input: { businessId: string; ownerUserId: string }): Promise<boolean>;
  /** Durable serialization across processes, shared with executor, cancel and webhook paths.
   * Lock the subject as well as the execution; rollback mutations, receipt and activity on throw.
   * Provider reads below need bounded timeouts. No provider WRITE occurs inside this callback.
   */
  withRecovery<T>(scope: RecoveryScope, fn: (tx: RecoveryTransaction) => Promise<T>): Promise<T>;
  lookup(record: RecoveryRecord): Promise<RecoveryLookup>;
  /** Runs the B-13 payment verifier, including fresh Square reads. Its checked payment routine
   * owns and commits all paid-state changes and sync jobs before returning the current order.
   * Called outside the recovery lock. Throw if verification is unavailable or ambiguous.
   */
  reconcilePayment(order: Order): Promise<Order>;
  clock: { now(): Date };
  ids: { next(prefix: 'evt_'): string };
}
