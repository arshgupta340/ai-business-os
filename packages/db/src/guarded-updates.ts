import type { PoolClient } from 'pg';

// The few queries whose exact form is the rule. The server calls these functions instead of
// writing its own version of the SQL. decideAndEnqueue requires a transaction client.
// The other helpers accept any pg-style query executor.
// Source: docs/DATA-MODEL.md sections 2.14, 2.17 and 2.19, and docs/CONTRACTS.md sections 4 to 6.

/** Anything with a pg-style query method: `query(text, params) -> { rows }`. */
export interface QueryExecutor {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export interface ApprovalRow {
  id: string;
  business_id: string;
  bundle_type: string;
  subject_id: string;
  state: string;
  payload_hash: string;
  payload_canonical: string;
  payload: Record<string, unknown>;
  action_bundle: string[];
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  [column: string]: unknown;
}

export interface ExecutionRow {
  id: string;
  business_id: string;
  approval_id: string;
  action_type: string;
  step_index: number;
  idempotency_key: string;
  status: string;
  attempts: number;
  locked_by: string | null;
  [column: string]: unknown;
}

export interface WebhookEventRow {
  id: string;
  source: string;
  provider_event_id: string;
  [column: string]: unknown;
}

export interface ExpiredApproval {
  id: string;
  business_id: string;
  bundle_type: string;
  subject_id: string;
  /** True when the order moved to APPROVAL_EXPIRED or the booking moved to EXPIRED in the same statement. */
  subject_moved: boolean;
}

/**
 * One-use approval. The only move out of PENDING. Zero rows means the request was already
 * decided, has expired, belongs to another business, the deciding user does not own the business,
 * or the hash the owner saw no longer matches. The caller then reads the row to return
 * APPROVAL_ALREADY_DECIDED, APPROVAL_EXPIRED, PAYLOAD_HASH_MISMATCH or a permission error.
 * decided_by is taken from businesses.owner_id, so it is always the business's owner.
 * The payload, hash, bundle and expiry are frozen by the approval_requests_guard trigger.
 */
/** @deprecated Direct SQL is unavailable to abos_app. Use runtimeDecideAndEnqueue. */
export const DECIDE_APPROVAL_SQL = `
update public.approval_requests r
set    state = $3, decided_by = b.owner_id, decided_at = now(), decision_reason = $6
from   public.businesses b
where  r.id = $1 and r.business_id = $2 and b.id = r.business_id and b.owner_id = $4
  and  r.payload_hash = $5 and r.state = 'PENDING' and r.expires_at > now()
returning r.*`;

/** @deprecated Use runtimeDecideAndEnqueue with abos_app. */
export async function decideApproval(
  db: QueryExecutor,
  args: {
    approvalId: string;
    businessId: string;
    decision: ApprovalDecision;
    ownerUserId: string;
    payloadHash: string;
    reason?: string | null;
  },
): Promise<ApprovalRow | null> {
  if (args.decision !== 'APPROVED' && args.decision !== 'REJECTED') {
    throw new Error(`decision must be APPROVED or REJECTED, got ${String(args.decision)}`);
  }
  const { rows } = await db.query(DECIDE_APPROVAL_SQL, [
    args.approvalId,
    args.businessId,
    args.decision,
    args.ownerUserId,
    args.payloadHash,
    args.reason ?? null,
  ]);
  return (rows[0] as ApprovalRow | undefined) ?? null;
}

/** A checked-out pg client. A Pool lacks release and cannot satisfy this interface. */
export type TransactionClient = QueryExecutor & Pick<PoolClient, 'release'>;
export type DecideAndEnqueueArgs = Parameters<typeof decideApproval>[1] & {
  /** One stable key per non-deferred step, in bundle order. Empty for rejection. */
  stepIdempotencyKeys: readonly string[];
};

/**
 * The caller owns BEGIN and COMMIT (and connection release). Pass the same checked-out client
 * for the whole transaction. A savepoint makes a failed enqueue undo its decision even if the
 * caller catches the error and later commits. No provider calls belong in this transaction.
 * Identical retries return existing rows; conflicting decisions or keys return null.
 */
/** @deprecated Use runtimeDecideAndEnqueue with abos_app. */
export async function decideAndEnqueue(
  tx: TransactionClient,
  args: DecideAndEnqueueArgs,
): Promise<{ approval: ApprovalRow; executions: ExecutionRow[] } | null> {
  await tx.query('savepoint decide_and_enqueue');
  try {
    const { rows } = await tx.query(`
      select r.* from public.approval_requests r
      join public.businesses b on b.id = r.business_id
      where r.id = $1 and r.business_id = $2 and b.owner_id = $3 and r.payload_hash = $4
      for update of r`, [args.approvalId, args.businessId, args.ownerUserId, args.payloadHash]);
    const existing = rows[0] as ApprovalRow | undefined;
    let result: { approval: ApprovalRow; executions: ExecutionRow[] } | null = null;
    if (existing) {
      const steps = existing.action_bundle.filter(step => !step.startsWith('sheets.'));
      if (existing.state === 'PENDING') {
        const expected = args.decision === 'APPROVED' ? steps.length : 0;
        if (args.stepIdempotencyKeys.length !== expected) throw new Error(`expected ${expected} step idempotency keys`);
        const approval = await decideApproval(tx, args);
        if (approval) {
          const executions: ExecutionRow[] = [];
          if (approval.state === 'APPROVED') {
            for (const [index, action] of steps.entries()) {
              const status = action.startsWith('message.') && approval.payload.messageChannel === 'qr_only' ? 'SKIPPED' : 'QUEUED';
              const inserted = await tx.query(`
                insert into public.action_executions (business_id, approval_id, action_type, step_index, idempotency_key, status)
                values ($1, $2, $3, $4, $5, $6) returning *`,
                [approval.business_id, approval.id, action, index, args.stepIdempotencyKeys[index], status]);
              executions.push(inserted.rows[0] as ExecutionRow);
            }
          }
          result = { approval, executions };
        }
      } else if (existing.state === args.decision && existing.decided_by === args.ownerUserId
                 && (existing.decision_reason ?? null) === (args.reason ?? null)) {
        const stored = await tx.query('select * from public.action_executions where approval_id = $1 order by step_index', [existing.id]);
        const executions = stored.rows as ExecutionRow[];
        const expected = args.decision === 'APPROVED' ? steps.length : 0;
        if (executions.length === expected && args.stepIdempotencyKeys.length === expected
            && executions.every((e, i) => e.step_index === i && e.action_type === steps[i]
                 && e.idempotency_key === args.stepIdempotencyKeys[i])) {
          result = { approval: existing, executions };
        }
      }
    }
    await tx.query('release savepoint decide_and_enqueue');
    return result;
  } catch (error) {
    await tx.query('rollback to savepoint decide_and_enqueue');
    await tx.query('release savepoint decide_and_enqueue');
    throw error;
  }
}

/**
 * A row x of action_executions may be claimed only when all of these hold:
 * - its approval a is APPROVED, was decided before it expired, and is in the same business;
 * - x is the step the approval lists at x.step_index (Sheets steps left out, SPEC 2.9);
 * - every earlier step the approval lists has a row that is SUCCEEDED, or is a message step that
 *   ended SKIPPED, FAILED or NEEDS_REVIEW (CONTRACTS.md section 6, Execution). A missing earlier
 *   row blocks the claim, because the check walks the approval's list, not the rows that exist.
 * The trigger action_executions_match_approval enforces the first two at insert as well.
 */
const CLAIMABLE = `
     x.status = 'QUEUED' and x.next_attempt_at <= now()
 and public.execution_claim_allowed(x.approval_id, x.business_id, x.step_index, x.action_type)`;

/**
 * Claims one execution so only one worker owns it. Zero rows means another worker holds it,
 * it is not due yet, it is not QUEUED, its approval is not a valid APPROVED approval, or an
 * earlier step has not finished. attempts is checked to stay within 0 to 3, so a fourth claim
 * fails at the database.
 */
/** @deprecated Use runtimeClaimExecution with abos_app. */
export const CLAIM_EXECUTION_SQL = `
update public.action_executions x
set    status = 'RUNNING', attempts = x.attempts + 1, locked_by = $1, locked_at = now(),
       started_at = coalesce(x.started_at, now())
where  x.id = $2 and ${CLAIMABLE}
returning x.*`;

/** @deprecated Use runtimeClaimExecution with abos_app. */
export async function claimExecution(
  db: QueryExecutor,
  args: { executionId: string; workerId: string },
): Promise<ExecutionRow | null> {
  const { rows } = await db.query(CLAIM_EXECUTION_SQL, [args.workerId, args.executionId]);
  return (rows[0] as ExecutionRow | undefined) ?? null;
}

/** Claims the next claimable execution without blocking other workers (FOR UPDATE SKIP LOCKED). */
/** @deprecated Use runtimeClaimNextExecution with abos_app. */
export const CLAIM_NEXT_EXECUTION_SQL = `
with next as (
  select x.id
  from   public.action_executions x
  where  ${CLAIMABLE}
  order by x.next_attempt_at, x.created_at
  limit 1
  for update of x skip locked
)
update public.action_executions x
set    status = 'RUNNING', attempts = x.attempts + 1, locked_by = $1, locked_at = now(),
       started_at = coalesce(x.started_at, now())
from   next
where  x.id = next.id and x.status = 'QUEUED'
returning x.*`;

/** @deprecated Use runtimeClaimNextExecution with abos_app. */
export async function claimNextExecution(
  db: QueryExecutor,
  args: { workerId: string },
): Promise<ExecutionRow | null> {
  const { rows } = await db.query(CLAIM_NEXT_EXECUTION_SQL, [args.workerId]);
  return (rows[0] as ExecutionRow | undefined) ?? null;
}

/**
 * Records a signature-verified webhook event once. Returns the new row, or null when the
 * same (source, provider_event_id) was already stored. Process the event only when a row is returned.
 * Call this only after the signature check passed; strip card_details from payload first.
 */
export const RECORD_WEBHOOK_EVENT_SQL = `
insert into public.webhook_events (source, provider_event_id, event_type, business_id, payload)
values ($1, $2, $3, $4, $5)
on conflict (source, provider_event_id) do nothing
returning *`;

export async function recordWebhookEvent(
  db: QueryExecutor,
  args: {
    source: 'square' | 'twilio_voice' | 'twilio_status';
    providerEventId: string;
    eventType: string;
    businessId?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<WebhookEventRow | null> {
  const { rows } = await db.query(RECORD_WEBHOOK_EVENT_SQL, [
    args.source,
    args.providerEventId,
    args.eventType,
    args.businessId ?? null,
    JSON.stringify(args.payload ?? {}),
  ]);
  return (rows[0] as WebhookEventRow | undefined) ?? null;
}

/**
 * The expiry sweep, run every 30 seconds. In one statement it moves every PENDING approval
 * past expires_at to EXPIRED, moves its order from AWAITING_OWNER_APPROVAL to APPROVAL_EXPIRED
 * and its booking from AWAITING_OWNER_APPROVAL to EXPIRED. The caller writes approval.expired
 * and the status_changed events for the rows returned.
 */
/** @deprecated Use runtimeExpireApprovals with abos_app. */
export const EXPIRE_APPROVALS_SQL = `
with expired as (
  update public.approval_requests
  set    state = 'EXPIRED', decided_at = now()
  where  state = 'PENDING' and expires_at <= now()
  returning id, business_id, bundle_type, subject_id
), expired_orders as (
  update public.orders o
  set    status = 'APPROVAL_EXPIRED'
  from   expired e
  where  e.bundle_type = 'order_bundle' and o.id = e.subject_id and o.business_id = e.business_id
    and  o.status = 'AWAITING_OWNER_APPROVAL'
  returning o.id
), expired_bookings as (
  update public.bookings b
  set    status = 'EXPIRED'
  from   expired e
  where  e.bundle_type = 'booking_bundle' and b.id = e.subject_id and b.business_id = e.business_id
    and  b.status = 'AWAITING_OWNER_APPROVAL'
  returning b.id
)
select e.id, e.business_id, e.bundle_type, e.subject_id,
       (e.subject_id in (select id from expired_orders) or e.subject_id in (select id from expired_bookings)) as subject_moved
from   expired e
order by e.id`;

/** @deprecated Use runtimeExpireApprovals with abos_app. */
export async function expireApprovals(db: QueryExecutor): Promise<ExpiredApproval[]> {
  const { rows } = await db.query(EXPIRE_APPROVALS_SQL);
  return rows as ExpiredApproval[];
}
