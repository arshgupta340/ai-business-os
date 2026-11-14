import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { ApprovalRow, ExecutionRow, ExpiredApproval, QueryExecutor } from './guarded-updates';

export interface DispatchRow {
  id: string; business_id: string; approval_id: string; execution_id: string;
  recipient: string; channel: string; body_hash: string; idempotency_key: string;
  status: string; provider_message_id: string | null; attempts: number;
  [column: string]: unknown;
}
export interface SyncJobRow {
  id: string; business_id: string; approval_id: string; record_type: string; record_id: string;
  idempotency_key: string; state: string; attempts: number; locked_by: string | null;
  [column: string]: unknown;
}
/** JSONB snapshots carry ISO timestamps, unlike pg's composite row timestamp decoder. */
export type JsonRow<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export interface DecisionResult { approval: JsonRow<ApprovalRow>; executions: ExecutionRow[] }

async function row<T>(db: QueryExecutor, sql: string, args: unknown[]): Promise<T> {
  const result = await db.query(sql, args);
  if (!result.rows[0]) throw new Error('Routine returned no row');
  return result.rows[0] as T;
}
async function optional<T>(db: QueryExecutor, sql: string, args: unknown[]): Promise<T | null> {
  return (await db.query(sql, args)).rows[0] as T | undefined ?? null;
}

/** Propose stored material. The database constructs and verifies the signed projection. */
export function createApproval(db: QueryExecutor, args: {
  businessId: string; bundleType: 'order_bundle' | 'booking_bundle' | 'fact_edit' | 'price_edit';
  subjectId: string; actorType: 'owner' | 'deployed_agent'; actorId: string | null;
  payload: Record<string, unknown>; canonical: string; payloadHash: string; actionBundle: string[]; expiresAt: string | Date;
}): Promise<ApprovalRow> {
  return row(db, 'select * from private.create_approval($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
    args.businessId,args.bundleType,args.subjectId,args.actorType,args.actorId,JSON.stringify(args.payload),
    args.canonical,args.payloadHash,args.actionBundle,args.expiresAt,
  ]);
}

/** Atomic decision, subject move, audit and exact enqueue. No caller-supplied keys. */
export async function runtimeDecideAndEnqueue(db: QueryExecutor, args: {
  businessId: string; approvalId: string; ownerUserId: string; payloadHash: string;
  decision: 'APPROVED' | 'REJECTED'; reason?: string | null;
}): Promise<DecisionResult> {
  const result = await row<{ result: DecisionResult }>(db,
    'select private.decide_and_enqueue($1,$2,$3,$4,$5,$6) as result',
    [args.businessId,args.approvalId,args.ownerUserId,args.payloadHash,args.decision,args.reason ?? null]);
  return result.result;
}
export function runtimeClaimExecution(db: QueryExecutor, args: {
  businessId: string; executionId: string; workerId: string;
}): Promise<ExecutionRow | null> {
  return optional(db, 'select * from private.claim_execution($1,$2,$3)', [args.businessId,args.executionId,args.workerId]);
}
export function runtimeClaimNextExecution(db: QueryExecutor, args: {
  businessId: string; workerId: string;
}): Promise<ExecutionRow | null> {
  return optional(db, 'select * from private.claim_next_execution($1,$2)', [args.businessId,args.workerId]);
}
export function finishExecution(db: QueryExecutor, args: {
  businessId: string; executionId: string; workerId: string; attempt: number;
  status: 'SUCCEEDED' | 'FAILED' | 'NEEDS_REVIEW' | 'QUEUED'; externalRef?: string | null;
  error?: string | null; retryAt?: string | Date | null;
}): Promise<ExecutionRow> {
  return row(db, 'select * from private.finish_execution($1,$2,$3,$4,$5,$6,$7,$8)',
    [args.businessId,args.executionId,args.workerId,args.attempt,args.status,args.externalRef ?? null,args.error ?? null,args.retryAt ?? null]);
}
export function recordDispatch(db: QueryExecutor, args: {
  businessId: string; executionId: string; workerId: string; attempt: number; bodyHash: string;
}): Promise<DispatchRow> {
  return row(db, 'select * from private.record_dispatch($1,$2,$3,$4,$5)',
    [args.businessId,args.executionId,args.workerId,args.attempt,args.bodyHash]);
}
export function updateDispatch(db: QueryExecutor, args: {
  businessId: string; dispatchId: string; workerId: string; attempt: number;
  status: 'SENT' | 'DELIVERED' | 'FAILED' | 'UNKNOWN'; providerMessageId?: string | null; error?: string | null;
}): Promise<DispatchRow> {
  return row(db, 'select * from private.update_dispatch($1,$2,$3,$4,$5,$6,$7)',
    [args.businessId,args.dispatchId,args.workerId,args.attempt,args.status,args.providerMessageId ?? null,args.error ?? null]);
}
export function enqueueSheetsSync(db: QueryExecutor, args: {
  businessId: string; recordType: 'order' | 'booking'; recordId: string;
}): Promise<SyncJobRow> {
  return row(db, 'select * from private.enqueue_sheets_sync($1,$2,$3)', [args.businessId,args.recordType,args.recordId]);
}
export function claimSyncJob(db: QueryExecutor, args: {
  businessId: string; syncJobId: string; workerId: string;
}): Promise<SyncJobRow | null> {
  return optional(db, 'select * from private.claim_sync_job($1,$2,$3)', [args.businessId,args.syncJobId,args.workerId]);
}
export function finishSyncJob(db: QueryExecutor, args: {
  businessId: string; syncJobId: string; workerId: string; attempt: number;
  state: 'DONE' | 'RETRYING' | 'FAILED'; externalRef?: string | null; error?: string | null; retryAt?: string | Date | null;
}): Promise<SyncJobRow> {
  return row(db, 'select * from private.finish_sync_job($1,$2,$3,$4,$5,$6,$7,$8)',
    [args.businessId,args.syncJobId,args.workerId,args.attempt,args.state,args.externalRef ?? null,args.error ?? null,args.retryAt ?? null]);
}
export async function runtimeExpireApprovals(db: QueryExecutor, businessId: string): Promise<ExpiredApproval[]> {
  return (await db.query('select * from private.expire_approvals($1)', [businessId])).rows as ExpiredApproval[];
}

export interface OrderRow {
  id: string; business_id: string; call_id: string; status: string; total_minor: number; currency: string;
  approval_id: string | null; square_order_id: string | null; square_payment_link_id: string | null;
  checkout_url: string | null; square_payment_id: string | null; link_ready_at: string | Date | null;
  [column: string]: unknown;
}
export interface MarkOrderPaidResult { order: JsonRow<OrderRow>; syncJob: JsonRow<SyncJobRow> }

/**
 * Square verified a COMPLETED payment. Checks amount and currency against the signed approval and the
 * order, records the payment ID, moves PAYMENT_PENDING or PAYMENT_FAILED to PAID_VERIFIED and enqueues
 * the Sheets job, with order.status_changed, payment.verified and sync.queued events. A repeat with the
 * same payment ID changes nothing and returns the current snapshots; a different payment ID is refused.
 * It does not move the order to FULFILLMENT_READY.
 */
export async function markOrderPaid(db: QueryExecutor, args: {
  businessId: string; orderId: string; paymentId: string; amountMinor: number; currency: string;
  squareOrderId: string; locationId: string; paymentStatus: string; environment: string;
}): Promise<MarkOrderPaidResult> {
  const result = await row<{ result: MarkOrderPaidResult }>(db,
    'select private.mark_order_paid($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
    [args.businessId,args.orderId,args.paymentId,args.amountMinor,args.currency,args.squareOrderId,args.locationId,args.paymentStatus,args.environment]);
  return result.result;
}
/** Square reported a final failed payment. PAYMENT_PENDING to PAYMENT_FAILED; a repeat is a no-op; obsolete observations on paid orders return the current order. */
export function markOrderPaymentFailed(db: QueryExecutor, args: {
  businessId: string; orderId: string; paymentId: string; reason: string; amountMinor: number; currency: string;
  squareOrderId: string; locationId: string; paymentStatus: string; environment: string;
}): Promise<OrderRow> {
  return row(db, 'select * from private.mark_order_payment_failed($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [args.businessId,args.orderId,args.paymentId,args.reason,args.amountMinor,args.currency,args.squareOrderId,args.locationId,args.paymentStatus,args.environment]);
}
/**
 * Moves every RUNNING step in the business past its renewable deadline (database clock).
 * staleAfterMs (at least 60000) supplies the fallback age for legacy rows without a deadline to NEEDS_REVIEW, moving the subject as a failed step would. Returns the moved steps.
 */
export async function recoverStaleExecutions(db: QueryExecutor, args: {
  businessId: string; staleAfterMs: number;
}): Promise<ExecutionRow[]> {
  if (!Number.isFinite(args.staleAfterMs)) throw new RangeError('staleAfterMs must be finite');
  return (await db.query("select * from private.recover_stale_executions($1, $2::double precision * interval '1 millisecond')",
    [args.businessId,args.staleAfterMs])).rows as ExecutionRow[];
}

/**
 * The PostgreSQL SCRAM-SHA-256 verifier for a password (RFC 7677, as stored in pg_authid).
 * Valid for printable ASCII passwords, which SASLprep leaves unchanged.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Operator only; pass an administrator client. The password never leaves this process: the
 * statement carries only its SCRAM verifier, so server statement logs and pg_stat_statements
 * cannot capture it. Never log the password.
 */
export async function enableRuntimeLogin(adminClient: QueryExecutor, password: string): Promise<void> {
  // Printable ASCII only: the verifier must match the server's SASLprep exactly.
  if (!/^[\x20-\x7e]{16,}$/.test(password)) throw new Error('Password must be at least 16 printable ASCII characters');
  const verifier = scramSha256Verifier(password);
  // Utility statements cannot bind parameters. The verifier is base64, digits, ':' and '$' only.
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error('Could not enable runtime login');
  try {
    await adminClient.query(`ALTER ROLE abos_app LOGIN PASSWORD '${verifier}'`);
  } catch {
    // Some drivers echo the statement in errors. Do not propagate credential-bearing errors.
    throw new Error('Could not enable runtime login');
  }
}

export interface BookingRow {
  id: string; business_id: string; call_id: string | null; status: string; google_event_id: string | null;
  [column: string]: unknown;
}
export interface FactRow {
  id: string; business_id: string; status: string; version: number; value: unknown;
  [column: string]: unknown;
}
export interface WorkerLease {
  businessId: string; executionId: string; workerId: string; attempt: number;
}
export interface CheckoutReferences { squareOrderId: string; paymentLinkId: string; url: string }

/** Stores the provider checkout response and its state event under the current lease. */
export function saveCheckout(db: QueryExecutor, args: WorkerLease & CheckoutReferences): Promise<OrderRow> {
  return row(db, 'select * from private.save_checkout($1,$2,$3,$4,$5,$6,$7)',
    [args.businessId,args.executionId,args.workerId,args.attempt,args.squareOrderId,args.paymentLinkId,args.url]);
}
export function fulfillOrder(db: QueryExecutor, args: { businessId: string; orderId: string }): Promise<OrderRow> {
  return row(db, 'select * from private.fulfill_order($1,$2)', [args.businessId,args.orderId]);
}
/** Applies the event, completes the calendar execution and enqueues reporting atomically. */
export function verifyBooking(db: QueryExecutor, args: WorkerLease & { googleEventId: string }): Promise<BookingRow> {
  return row(db, 'select * from private.verify_booking($1,$2,$3,$4,$5)',
    [args.businessId,args.executionId,args.workerId,args.attempt,args.googleEventId]);
}
export function renewExecutionLease(db: QueryExecutor, args: WorkerLease & { durationMs: number }): Promise<ExecutionRow> {
  if (!Number.isFinite(args.durationMs)) throw new RangeError('durationMs must be finite');
  return row(db, "select * from private.renew_execution_lease($1,$2,$3,$4,$5::double precision * interval '1 millisecond')",
    [args.businessId,args.executionId,args.workerId,args.attempt,args.durationMs]);
}
/** Provider lookup evidence is a server assertion. A safe retry explicitly proves no write occurred. */
export function resolveExecution(db: QueryExecutor, args: {
  businessId: string; executionId: string; status: 'SUCCEEDED' | 'QUEUED' | 'FAILED';
  externalRef?: string | null; nothingWritten: boolean; checkout?: CheckoutReferences;
}): Promise<ExecutionRow> {
  return row(db, 'select * from private.resolve_execution($1,$2,$3,$4,$5,$6)',
    [args.businessId,args.executionId,args.status,args.externalRef ?? null,args.nothingWritten,args.checkout ? JSON.stringify(args.checkout) : null]);
}
export function renewSyncLease(db: QueryExecutor, args: {
  businessId: string; syncJobId: string; workerId: string; attempt: number; durationMs: number;
}): Promise<SyncJobRow> {
  if (!Number.isFinite(args.durationMs)) throw new RangeError('durationMs must be finite');
  return row(db, "select * from private.renew_sync_lease($1,$2,$3,$4,$5::double precision * interval '1 millisecond')",
    [args.businessId,args.syncJobId,args.workerId,args.attempt,args.durationMs]);
}
export async function recoverStaleSyncJobs(db: QueryExecutor, args: { businessId: string }): Promise<SyncJobRow[]> {
  return (await db.query('select * from private.recover_stale_sync_jobs($1)', [args.businessId])).rows as SyncJobRow[];
}
export function applyFactUpdate(db: QueryExecutor, args: WorkerLease): Promise<FactRow> {
  return row(db, 'select * from private.apply_fact_update($1,$2,$3,$4)',
    [args.businessId,args.executionId,args.workerId,args.attempt]);
}

export interface WebhookEventProcessedRow {
  id: string; source: string; provider_event_id: string; business_id: string | null;
  processed_at: string | Date | null; process_error: string | null;
  [column: string]: unknown;
}
/**
 * Sets the processed marker on a stored webhook row. businessId must equal the row's business (null
 * matches only a row stored without one). A processed row is returned unchanged: the marker is never
 * cleared and the first error text is kept. Error text is cut to 500 characters.
 */
export function markWebhookProcessed(db: QueryExecutor, args: {
  businessId: string | null; webhookEventId: string; error?: string | null;
}): Promise<WebhookEventProcessedRow> {
  return row(db, 'select * from private.mark_webhook_processed($1,$2,$3)', [args.businessId,args.webhookEventId,args.error ?? null]);
}
/** Prefix of the error update_dispatch_status raises while the send step is still QUEUED or RUNNING. */
export const RETRYABLE_RECEIPT_ERROR_PREFIX = 'RETRY: receipt deferred';
/**
 * True for the deferred-receipt error: nothing changed, keep the webhook unprocessed and retry it after
 * the sender finished (including after a restart). Do not mark that webhook processed.
 */
export function isRetryableReceiptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  return message.startsWith(RETRYABLE_RECEIPT_ERROR_PREFIX);
}
/**
 * A provider delivery receipt for a recorded dispatch, with no worker lease. While the send step is still
 * QUEUED or RUNNING it throws an error for which isRetryableReceiptError is true and changes nothing.
 * Otherwise it moves SENT to DELIVERED or FAILED. A repeated, stale or out-of-order receipt, or one for a
 * DELIVERED, FAILED or UNKNOWN dispatch, returns the row unchanged; compare the returned status.
 */
export function updateDispatchStatus(db: QueryExecutor, args: {
  businessId: string; dispatchId: string; status: 'SENT' | 'DELIVERED' | 'FAILED';
}): Promise<DispatchRow> {
  return row(db, 'select * from private.update_dispatch_status($1,$2,$3)', [args.businessId,args.dispatchId,args.status]);
}

export interface RuntimeRoleCheck {
  role_name: string; session_role_name: string; superuser: boolean; bypass_rls: boolean; other_roles: number;
  writes_approvals: boolean; writes_executions: boolean; writes_dispatches: boolean; writes_sync_jobs: boolean;
  writes_receipts: boolean; restricted: boolean;
}
/** The connected role and whether it can write the protected tables directly. Only abos_app may call it. */
export function runtimeRoleCheck(db: QueryExecutor): Promise<RuntimeRoleCheck> {
  return row(db, 'select * from private.runtime_role_check()', []);
}
/**
 * Call at server startup. Throws unless both the login (session_user) and current role are abos_app and it
 * is restricted. Any other role,
 * including one refused permission to run the check, fails closed. The message names roles only.
 */
export async function assertRestrictedRuntimeRole(db: QueryExecutor): Promise<RuntimeRoleCheck> {
  let check: RuntimeRoleCheck;
  try { check = await runtimeRoleCheck(db); } catch {
    throw new Error('Runtime role check failed: the database connection is not the restricted abos_app role');
  }
  if (check.role_name !== 'abos_app' || check.session_role_name !== 'abos_app')
    throw new Error(`Runtime role check failed: connected as ${check.session_role_name} with role ${check.role_name}; both must be abos_app`);
  if (!check.restricted) throw new Error(`Runtime role check failed: connected as ${check.role_name}, which is not the restricted abos_app role`);
  return check;
}
