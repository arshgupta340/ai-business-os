// The few queries whose exact form is the rule. The server calls these functions instead of
// writing its own version of the SQL. Each takes a query executor: a pg Pool, a pg Client,
// a transaction client or a PGlite instance all fit.
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
 * decided, has expired, belongs to another business, or the hash the owner saw no longer matches.
 * The caller then reads the row to return APPROVAL_ALREADY_DECIDED, APPROVAL_EXPIRED or
 * PAYLOAD_HASH_MISMATCH. The payload column is never touched.
 */
export const DECIDE_APPROVAL_SQL = `
update public.approval_requests
set    state = $3, decided_by = $4, decided_at = now(), decision_reason = $6
where  id = $1 and business_id = $2 and payload_hash = $5
  and  state = 'PENDING' and expires_at > now()
returning *`;

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

/**
 * Steps run in bundle order (CONTRACTS.md section 6, Execution). A step may start only when every
 * earlier step of the same approval is SUCCEEDED, except that a message step that ended SKIPPED,
 * FAILED or NEEDS_REVIEW does not block the steps after it.
 */
const EARLIER_STEPS_DONE = `
not exists (
  select 1 from public.action_executions p
  where p.approval_id = x.approval_id and p.step_index < x.step_index
    and not (p.status = 'SUCCEEDED'
             or (p.action_type like 'message.%' and p.status in ('SKIPPED', 'FAILED', 'NEEDS_REVIEW'))))`;

/**
 * Claims one execution so only one worker owns it. Zero rows means another worker holds it,
 * it is not due yet, it is not QUEUED, or an earlier step has not finished.
 * attempts is checked to stay within 0 to 3, so a fourth claim fails at the database.
 */
export const CLAIM_EXECUTION_SQL = `
update public.action_executions x
set    status = 'RUNNING', attempts = x.attempts + 1, locked_by = $1, locked_at = now(),
       started_at = coalesce(x.started_at, now())
where  x.id = $2 and x.status = 'QUEUED' and x.next_attempt_at <= now()
  and  ${EARLIER_STEPS_DONE}
returning x.*`;

export async function claimExecution(
  db: QueryExecutor,
  args: { executionId: string; workerId: string },
): Promise<ExecutionRow | null> {
  const { rows } = await db.query(CLAIM_EXECUTION_SQL, [args.workerId, args.executionId]);
  return (rows[0] as ExecutionRow | undefined) ?? null;
}

/** Claims the next due execution without blocking other workers (FOR UPDATE SKIP LOCKED). */
export const CLAIM_NEXT_EXECUTION_SQL = `
with next as (
  select x.id from public.action_executions x
  where  x.status = 'QUEUED' and x.next_attempt_at <= now()
    and  ${EARLIER_STEPS_DONE}
  order by x.next_attempt_at, x.created_at
  limit 1
  for update skip locked
)
update public.action_executions x
set    status = 'RUNNING', attempts = x.attempts + 1, locked_by = $1, locked_at = now(),
       started_at = coalesce(x.started_at, now())
from   next
where  x.id = next.id and x.status = 'QUEUED'
returning x.*`;

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

export async function expireApprovals(db: QueryExecutor): Promise<ExpiredApproval[]> {
  const { rows } = await db.query(EXPIRE_APPROVALS_SQL);
  return rows as ExpiredApproval[];
}
