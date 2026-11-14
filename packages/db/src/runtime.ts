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

/** Operator only. Never log the query or credentials; pass an administrator client. */
export async function enableRuntimeLogin(adminClient: QueryExecutor, password: string): Promise<void> {
  if (!password || password.includes('\0')) throw new Error('Password must be nonempty and contain no NUL');
  // Utility statements cannot bind parameters. E-literals are safe with either setting of
  // standard_conforming_strings. Escape backslashes before quotes; never interpolate raw input.
  const literal = "E'" + password.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  try {
    await adminClient.query('ALTER ROLE abos_app LOGIN PASSWORD ' + literal);
  } catch {
    // Some drivers echo the statement in errors. Do not propagate credential-bearing errors.
    throw new Error('Could not enable runtime login');
  }
}
