import type {
  ActionExecution, ActivityEvent, ApprovalRequest, Booking, ErrorCode, MessageDispatch, Order,
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

export interface RecoveryTransaction {
  loadOrder(): Promise<Order | undefined>;
  loadExecution(): Promise<RecoveryRecord | undefined>;
  /** Durable receipt, scoped to business, execution, action and the stored idempotency key.
   * Return the CURRENT execution on replay, even if a worker has since advanced it.
   */
  replay(action: ResolveExecutionBody['action']): Promise<ActionExecution | undefined>;
  /** Local cancellation only. Fence queued work and refuse running/uncertain external effects.
   * Re-read the order under its lock; paid orders cannot be cancelled. No provider cancellation.
   */
  cancelOrder(order: Order): Promise<Order>;
  /** Checked routine: apply verified references and subject transitions, preserve the key and
   * attempts, and save the receipt atomically. Requeue only below EXECUTION_MAX_ATTEMPTS.
   * FAILED on abandon never fabricates success or deletes a provider object.
   */
  resolve(input: {
    record: RecoveryRecord;
    action: ResolveExecutionBody['action'];
    status: ActionExecution['status'];
    lookup: RecoveryLookup;
  }): Promise<ActionExecution>;
  /** Enqueue the original message execution using the EXISTING dispatch row and dispatch key.
   * Never send here, insert a second dispatch, or reset a delivered dispatch. The worker must
   * reauthorize the exact payload and use sendOnce with dispatchKey before any provider call.
   * Save the recovery receipt atomically with this enqueue.
   */
  retryMessage(input: { record: RecoveryRecord; dispatchKey: string; idempotencyKey: string }): Promise<ActionExecution>;
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
  /** Compare the stored approval against CURRENT subject, integration and dispatch material.
   * Same policy as executor authorization; no replacement approval or key may be created.
   * The executor rechecks once more immediately before making an external call.
   */
  authorizeRetry(record: RecoveryRecord): Promise<{ ok: true } | { ok: false; code: ErrorCode }>;
  clock: { now(): Date };
  ids: { next(prefix: 'evt_'): string };
}
