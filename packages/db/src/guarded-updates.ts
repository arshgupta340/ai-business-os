// Row types shared by the routine wrappers (runtime.ts), and the webhook insert. The direct-SQL
// approval, claim and expiry helpers were deprecated in 0004 and removed in issue #93: abos_app cannot
// run them, and their decideAndEnqueue accepted caller-chosen idempotency keys. The server uses the
// routine wrappers in runtime.ts. The tests keep the old SQL in test/legacy-admin-sql.ts, as the
// administrator-only path the triggers must still guard.
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
