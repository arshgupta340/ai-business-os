// Delivery receipts for agentphone dispatches (D-12). AgentPhone sends no delivery-status webhook; its
// message history carries status sent, delivered or failed (https://docs.agentphone.ai/documentation/guides/webhooks.md,
// "Delivery status"; .../guides/messages.md). So the server polls that history, read only, and applies a
// changed status through update_dispatch_status (0006): forward only, SENT to DELIVERED or FAILED.
// While the send step is still QUEUED or RUNNING the routine raises a retryable error; that receipt is
// deferred to the next poll, like a deferred WhatsApp receipt is left for webhook recovery.
import { isRetryableReceiptError, updateDispatchStatus } from '@abos/db';
import type { QueryDb } from '../../db/index';
import { emitActivity } from '../../policy/activity';
import type { AgentPhoneClient } from './client';

export const RECEIPT_POLL_PAGE = 100;
export const RECEIPT_POLL_MAX_PAGES = 3;
/** Dispatches older than this are no longer polled (how long history keeps a message is not documented). */
export const RECEIPT_POLL_WINDOW_HOURS = 24;

const MAPPED: Record<string, 'DELIVERED' | 'FAILED' | undefined> = { delivered: 'DELIVERED', failed: 'FAILED' };

export type ReceiptPollResult = { checked: number; applied: number; deferred: number };

export async function pollAgentPhoneReceipts(deps: {
  db: QueryDb;
  client: AgentPhoneClient;
  now(): Date;
  newId(prefix: string): string;
  log: { info(data: Record<string, unknown>, msg: string): void; warn(data: Record<string, unknown>, msg: string): void };
}): Promise<ReceiptPollResult> {
  const pending = (await deps.db.query(`select id, business_id, subject_id, provider_message_id from public.message_dispatches
    where channel = 'agentphone' and status = 'SENT' and provider_message_id is not null
      and coalesce(sent_at, created_at) > now() - make_interval(hours => $1) order by created_at limit 200`, [RECEIPT_POLL_WINDOW_HOURS])).rows as
    { id: string; business_id: string; subject_id: string; provider_message_id: string }[];
  const result: ReceiptPollResult = { checked: pending.length, applied: 0, deferred: 0 };
  if (pending.length === 0) return result;

  const wanted = new Map(pending.map((d) => [d.provider_message_id, d]));
  const seen = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < RECEIPT_POLL_MAX_PAGES && seen.size < wanted.size; page++) {
    const { messages, nextCursor } = await deps.client.listMessages({ limit: RECEIPT_POLL_PAGE, cursor });
    for (const m of messages) if (wanted.has(m.id)) seen.set(m.id, m.status);
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  for (const [providerId, status] of seen) {
    const mapped = Object.hasOwn(MAPPED, status) ? MAPPED[status] : undefined;
    const d = wanted.get(providerId);
    if (!mapped || !d) continue;
    try {
      const after = await updateDispatchStatus(deps.db, { businessId: d.business_id, dispatchId: d.id, status: mapped });
      if (after.status !== mapped) continue;
      result.applied += 1;
      if (mapped === 'FAILED') {
        await emitActivity(deps.db, { id: deps.newId('evt_'), businessId: d.business_id, correlationId: d.id, type: 'message.failed', actorType: 'provider',
          occurredAt: deps.now().toISOString(), payload: { dispatchId: d.id, subjectId: d.subject_id, channel: 'agentphone', status: 'FAILED' } });
      }
    } catch (error) {
      if (isRetryableReceiptError(error)) { result.deferred += 1; deps.log.info({ job: 'agentphone-receipts', dispatchId: d.id }, 'delivery status deferred until the send step finishes'); continue; }
      deps.log.warn({ job: 'agentphone-receipts', dispatchId: d.id }, 'delivery status not applied; next poll retries');
    }
  }
  return result;
}
