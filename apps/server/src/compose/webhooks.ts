// The webhooks seam (B-13) and payment reconciliation wired to the database and the Square adapter.
//
// Order of work for a provider webhook (AGENTS rules 2 and 5): the plugin captures the raw bytes in
// its own parser scope, checks the signature against the exact public URL (PUBLIC_SERVER_URL plus the
// route path), parses only routing IDs, and inserts the row into webhook_events with
// "on conflict do nothing". Only a newly inserted row is processed, after the response. Processing
// reads the payment from Square afresh; the webhook body is never trusted for status or amount.
import { PAYMENT_POLL_INTERVAL_MS, PAYMENT_POLL_DURATION_MS, WEBHOOK_ENDPOINTS, type ActivityEvent, type Call, type MessageChannel } from '@abos/contracts';
import { fulfillOrder, markOrderPaid, markOrderPaymentFailed, isRetryableReceiptError, markWebhookProcessed, updateDispatchStatus } from '@abos/db';
import type { FastifyPluginAsync } from 'fastify';
import { verifyWebhookSignature } from '../adapters/square/index';
import { unavailableDb, type QueryDb } from '../db/index';
import { AppError } from '../errors';
import { emitActivity } from '../policy/activity';
import { pollPendingPayments } from '../reconcile/index';
import { webhooksPlugin } from '../webhooks/plugin';
import { processSquareEvent } from '../webhooks/square';
import { processTwilioStatus } from '../webhooks/twilio-status';
import type { PaymentOrder, PaymentVerification, StoredWebhook, WebhookDependencies } from '../webhooks/types';
import { orderFromDbRow } from './executor';
import type { SeamDeps } from './seams';
import type { TelemetryPort } from '../telemetry/index';

type Row = Record<string, unknown>;
const one = async (q: QueryDb, text: string, params: unknown[]) => (await q.query(text, params)).rows[0] as Row | undefined;

/** A Square payment read that does not answer in time is a retry, never a verdict. */
export const SQUARE_READ_TIMEOUT_MS = 8000;

async function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Square read timed out'), { name: 'TimeoutError' })), ms); });
  try { return await Promise.race([fn(), timeout]); } finally { clearTimeout(timer); }
}

/** Maps the adapter's failed fields to the webhook port: a mismatch field wins over a status. */
export function toPaymentVerification(failed: readonly string[], status: string | undefined): PaymentVerification {
  if (failed.length === 0) return { verified: true };
  if (failed.includes('amountMinor')) return { verified: false, field: 'amount' };
  if (failed.includes('currency')) return { verified: false, field: 'currency' };
  if (failed.includes('locationId')) return { verified: false, field: 'location' };
  if (failed.includes('squareOrderId') || failed.includes('paymentId')) return { verified: false, field: 'order' };
  // A refund, full or partial, never verifies and is not a failed payment either: it stays unpaid.
  if (failed.includes('refunded')) return { verified: false, field: 'status', status: 'REFUNDED' };
  return { verified: false, field: 'status', status: status ?? 'UNKNOWN' };
}

/** The payment.failed reason the webhook module built: Square's status, at most 200 characters. */
function failedReason(events: ActivityEvent[]): string {
  const failed = events.find((e) => e.type === 'payment.failed');
  const reason = String((failed?.payload as { reason?: unknown } | undefined)?.reason ?? 'FAILED').slice(0, 200);
  return reason || 'FAILED';
}

/**
 * Codes for the reconcile failure log: a contract error code, a SQLSTATE with the routine's fixed reason
 * when it is words only, or the error name and HTTP status. Never an ID, a provider body or a secret.
 */
export function reconcileErrorCodes(error: unknown): string[] {
  const all = error instanceof AggregateError ? error.errors : [error];
  return all.map((e) => {
    if (!(e instanceof Error)) return 'unknown';
    const x = e as Error & { code?: unknown; statusCode?: unknown };
    if (e instanceof AppError) return e.code;
    if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) {
      const reason = /^[A-Z_]+: [a-z ]+$/.test(e.message) ? e.message : /^([A-Z_]+):/.exec(e.message)?.[1];
      return reason ? `${x.code} ${reason}` : x.code;
    }
    const name = /^[A-Za-z]+$/.test(e.name) ? e.name : 'Error';
    return typeof x.statusCode === 'number' ? `${name} ${x.statusCode}` : name;
  });
}

export type DbWebhooks = {
  plugin: FastifyPluginAsync;
  /** True when the routes verify and store events; false when they answer 503 (missing settings). */
  enabled: boolean;
  missing: string[];
  start(): void;
  stop(): Promise<void>;
  /** Resolves when queued webhook jobs have settled (tests). */
  idle(): Promise<void>;
  /** One reconciliation pass over orders waiting for payment. */
  reconcileNow(): Promise<void>;
  /** Re-runs stored webhook rows that were never processed (after a crash or a failed job). */
  recoverNow(): Promise<number>;
};

export function createDbWebhooks(deps: SeamDeps, fallback: FastifyPluginAsync, hooks: { afterJob?(): void; telemetry?: TelemetryPort } = {}): DbWebhooks {
  const { env, db, providers, log } = deps;
  const base = env.PUBLIC_SERVER_URL?.replace(/\/+$/, '');
  const missing = [
    ...(base ? [] : ['PUBLIC_SERVER_URL']),
    ...(env.SQUARE_WEBHOOK_SIGNATURE_KEY ? [] : ['SQUARE_WEBHOOK_SIGNATURE_KEY']),
    ...(db !== unavailableDb ? [] : ['DATABASE_URL']),
  ];

  async function paymentOrder(q: QueryDb, row: Row): Promise<PaymentOrder> {
    const order = orderFromDbRow(row);
    // The location comes from the stored Square integration of this business, then from configuration.
    const integration = await one(q, "select config from public.integrations where business_id = $1 and provider = 'square' order by alias limit 1", [order.businessId]);
    const configured = integration?.config && typeof integration.config === 'object' ? (integration.config as Record<string, unknown>).locationId : undefined;
    const locationId = typeof configured === 'string' && configured ? configured : providers.squareLocationId ?? '';
    // Link creation time: orders.link_ready_at, set by save_checkout (or resolve_execution) when the
    // verified link was stored. Never updated_at.
    const ready = row.link_ready_at;
    const linkReadyAt = ready instanceof Date ? ready.toISOString() : typeof ready === 'string' ? ready : '';
    return { ...order, locationId, linkReadyAt };
  }

  // The routines refuse anything but sandbox; the server passes the configured environment as is.
  const squareEnvironment = () => env.SQUARE_ENVIRONMENT ?? 'unset';

  const storedAt = new Map<string, { businessId: string; at: number }>();
  const pending = new Set<string>();
  // The business each row was stored with, until its job runs (mark_webhook_processed checks it).
  const businessOf = new Map<string, string | null>();
  let flights: Promise<void> = Promise.resolve();

  async function runJob(webhookId: string, businessId: string | null, run: () => Promise<void>) {
    pending.add(webhookId);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await run();
          break;
        } catch {
          if (attempt >= 3) { log.warn({ job: 'webhook', webhookId }, 'webhook job failed; left pending for recovery'); return; }
          await new Promise((r) => setTimeout(r, 200 * attempt));
        }
      }
      // webhook_delay: from the verified row being stored to its job finishing (rows stored in this process).
      const stored = storedAt.get(webhookId);
      if (stored) { storedAt.delete(webhookId); hooks.telemetry?.record('webhook_delay', { businessId: stored.businessId, correlationId: webhookId, ms: Math.max(0, deps.now().getTime() - stored.at) }); }
      // processed_at is stored through mark_webhook_processed (0006), so recovery skips the row after a restart.
      // If the mark fails the row stays a recovery candidate; re-running it is idempotent.
      await markWebhookProcessed(db, { businessId, webhookEventId: webhookId })
        .catch(() => log.warn({ job: 'webhook', webhookId }, 'webhook processed mark failed; left for recovery'));
      // A payment that just verified has a Sheets job waiting: let the executor pick it up now.
      hooks.afterJob?.();
    } finally {
      pending.delete(webhookId);
      businessOf.delete(webhookId);
    }
  }

  const deps13: WebhookDependencies = {
    config: {
      squareNotificationUrl: `${base ?? ''}${WEBHOOK_ENDPOINTS.square.path}`,
      squareSignatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? '',
      twilioStatusUrl: `${base ?? ''}${WEBHOOK_ENDPOINTS.twilioStatus.path}`,
    },
    square: {
      verifyWebhookSignature: (input) => verifyWebhookSignature(input),
      async verifyPayment(input) {
        if (!providers.square) throw new Error('Square is not configured');
        const square = providers.square;
        const result = await withTimeout(SQUARE_READ_TIMEOUT_MS, () => square.verifyPayment(input));
        if (result.verified) return { verified: true };
        const onlyStatus = result.failedFields.every((f) => f === 'status');
        const status = onlyStatus && providers.squarePaymentStatus
          ? await withTimeout(SQUARE_READ_TIMEOUT_MS, () => providers.squarePaymentStatus!(input.paymentId)) : undefined;
        return toPaymentVerification(result.failedFields, status);
      },
      async findPaymentsForOrder(squareOrderId) {
        if (!providers.square) throw new Error('Square is not configured');
        const square = providers.square;
        return withTimeout(SQUARE_READ_TIMEOUT_MS, () => square.findPaymentForOrder(squareOrderId));
      },
    },
    store: {
      async recordOnce(input) {
        // Dedupe on (source, provider event ID) before anything else changes.
        const row = await one(db, `insert into public.webhook_events (source, provider_event_id, event_type, business_id, payload)
          values ($1,$2,$3,$4,$5::jsonb) on conflict (source, provider_event_id) do nothing returning id`,
        [input.source, input.providerEventId, input.eventType, input.businessId, JSON.stringify(input.payload)]);
        if (row) businessOf.set(String(row.id), input.businessId ?? null);
        if (row && input.businessId) storedAt.set(String(row.id), { businessId: input.businessId, at: deps.now().getTime() });
        return row ? { ...input, id: String(row.id) } : undefined;
      },
    },
    orders: {
      async findBySquareOrderId(businessId, squareOrderId) {
        const row = await one(db, 'select * from public.orders where business_id = $1 and square_order_id = $2', [businessId, squareOrderId]);
        return row ? paymentOrder(db, row) : undefined;
      },
      async listWaitingForPayment() {
        const rows = (await db.query("select * from public.orders where status in ('PAYMENT_PENDING','PAYMENT_FAILED') and square_order_id is not null order by created_at", [])).rows as Row[];
        const out: PaymentOrder[] = [];
        for (const row of rows) out.push(await paymentOrder(db, row));
        return out;
      },
      async withLockedOrder(orderId, fn) {
        await db.transaction(async (tx) => {
          const row = await one(tx, 'select * from public.orders where id = $1 for update', [orderId]);
          const order = row ? await paymentOrder(tx, row) : undefined;
          await fn({
            order,
            // Square's answer was verified against this order before these run (webhooks/square.ts). The
            // routines check the observation again against the signed approval and the order, record the
            // receipt, and write their own status, payment and sync events.
            markPaid: async ({ paymentId }) => {
              if (!order?.squareOrderId) throw new Error('order not found');
              await markOrderPaid(tx, { businessId: order.businessId, orderId: order.id, paymentId, amountMinor: order.totalMinor, currency: order.currency,
                squareOrderId: order.squareOrderId, locationId: order.locationId, paymentStatus: 'COMPLETED', environment: squareEnvironment() });
              // SPEC 2.9 Fulfillment: the server sets FULFILLMENT_READY itself once the paid order is recorded.
              await fulfillOrder(tx, { businessId: order.businessId, orderId: order.id });
            },
            markFailed: async ({ paymentId, events }) => {
              if (!order?.squareOrderId) throw new Error('order not found');
              const reason = failedReason(events);
              await markOrderPaymentFailed(tx, { businessId: order.businessId, orderId: order.id, paymentId, reason, amountMinor: order.totalMinor, currency: order.currency,
                squareOrderId: order.squareOrderId, locationId: order.locationId, paymentStatus: reason === 'CANCELED' ? 'CANCELED' : 'FAILED', environment: squareEnvironment() });
            },
          });
        });
      },
    },
    integrations: {
      async findOwner(provider) {
        if (provider === 'square') {
          // The one Square location's catalog is cached for the business that sells from it.
          const row = await one(db, 'select business_id from public.catalog_items group by business_id order by count(*) desc, business_id limit 1', []);
          return row ? { businessId: String(row.business_id) } : undefined;
        }
        if (provider === 'twilio' && env.TWILIO_PHONE_NUMBER) {
          const row = await one(db, 'select business_id from public.live_agent where phone_number = $1', [env.TWILIO_PHONE_NUMBER]);
          return row ? { businessId: String(row.business_id) } : undefined;
        }
        return undefined;
      },
    },
    twilio: {
      validate: ({ notificationUrl, signatureHeader, params }) =>
        !!providers.twilioValidator && typeof signatureHeader === 'string' && providers.twilioValidator.validate(signatureHeader, notificationUrl, params),
    },
    calls: {
      async findByProviderId(id) {
        const row = await one(db, 'select id, business_id, started_at from public.calls where provider_call_id = $1', [id]);
        if (!row) return undefined;
        const startedAt = row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at);
        return { id: String(row.id), businessId: String(row.business_id), startedAt } as Pick<Call, 'id' | 'businessId' | 'startedAt'>;
      },
      async endOnce(id, status, endedAt) {
        const reason = status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'dropped';
        // The same conditional terminal update the stream stop uses: only the first end wins.
        const r = await db.query(`update public.calls set status = $2, end_reason = $3, ended_at = greatest($4::timestamptz, started_at)
          where id = $1 and status = 'IN_PROGRESS' returning id`, [id, status, reason, endedAt]);
        return r.rows.length === 1;
      },
    },
    dispatch: {
      async findByProviderId(id) {
        const row = await one(db, 'select id, business_id, subject_id, channel from public.message_dispatches where provider_message_id = $1', [id]);
        return row ? { id: String(row.id), businessId: String(row.business_id), subjectId: String(row.subject_id), channel: row.channel as MessageChannel } : undefined;
      },
      // A delivery receipt moves SENT forward through update_dispatch_status (0006, no lease). It reports a
      // move only when the dispatch was SENT and is now the receipt's status, so a repeated receipt is a no-op.
      async updateStatus(id, status) {
        if (status !== 'DELIVERED' && status !== 'FAILED') return false;
        const before = await one(db, 'select business_id, status from public.message_dispatches where id = $1', [id]);
        if (!before || before.status !== 'SENT') return false;
        try {
          const after = await updateDispatchStatus(db, { businessId: String(before.business_id), dispatchId: id, status });
          return after.status === status;
        } catch (error) {
          // The send step is still QUEUED or RUNNING: the receipt is deferred. Throwing leaves the webhook
          // row unprocessed, so stored-row recovery applies it later, also after a restart.
          if (isRetryableReceiptError(error)) log.info({ job: 'webhook', dispatchId: id }, 'delivery receipt deferred until the send step finishes');
          throw error;
        }
      },
    },
    activity: { write: (event) => emitActivity(db, event) },
    clock: { now: deps.now },
    jobs: {
      async enqueue(webhookId, run) {
        flights = flights.then(() => runJob(webhookId, businessOf.get(webhookId) ?? null, run));
      },
    },
  };

  /** Rebuilds the job for a stored row, exactly as the plugin would after the response. */
  function jobFor(stored: StoredWebhook): () => Promise<void> {
    return stored.source === 'square'
      ? () => processSquareEvent(deps13, stored.eventType, stored.payload, stored.businessId)
      : () => processTwilioStatus(deps13, stored);
  }

  /** Rows per recovery page. Every unprocessed row is reached across pages, whatever its age. */
  const RECOVERY_PAGE = 200;

  async function recoverNow(): Promise<number> {
    // Review finding 7: every stored row without processed_at is a candidate, whatever its age (the
    // 15 minute payment poll window is a separate thing). A finished job marks its row, so a row seen
    // here again is one whose job failed or was deferred. Re-running is safe: a paid order is never
    // paid twice, a call ends once, a receipt moves a dispatch forward once. Rows older than the
    // payment window are logged so a stuck event is visible, never dropped silently.
    const staleBefore = new Date(deps.now().getTime() - PAYMENT_POLL_DURATION_MS);
    let n = 0;
    let after = '';
    for (;;) {
      const rows = (await db.query(`select id, source, provider_event_id, event_type, business_id, payload, received_at from public.webhook_events
        where processed_at is null and source in ('square','twilio_status') and id > $1 order by id limit $2`, [after, RECOVERY_PAGE])).rows as Row[];
      for (const r of rows) {
        const id = String(r.id);
        after = id;
        if (pending.has(id) || typeof r.business_id !== 'string') continue;
        const received = r.received_at instanceof Date ? r.received_at : new Date(String(r.received_at));
        if (received < staleBefore) log.warn({ job: 'webhook-recovery', webhookId: id }, 'webhook event still unprocessed after the payment window; retrying');
        const stored: StoredWebhook = { id, source: r.source as StoredWebhook['source'], providerEventId: String(r.provider_event_id), eventType: String(r.event_type),
          businessId: r.business_id, payload: (r.payload ?? {}) as Record<string, string> };
        n++;
        flights = flights.then(() => runJob(id, stored.businessId, jobFor(stored)));
      }
      if (rows.length < RECOVERY_PAGE) break;
    }
    await flights;
    return n;
  }

  async function reconcileNow() {
    if (!providers.square) return;
    await pollPendingPayments(deps13).catch((error: unknown) => log.warn({ job: 'reconcile', codes: reconcileErrorCodes(error) }, 'payment reconciliation will retry'));
  }

  let timers: ReturnType<typeof setInterval>[] = [];
  let reconciling: Promise<void> | undefined;
  const enabled = missing.length === 0;
  const plugin: FastifyPluginAsync = enabled ? async (app) => { await app.register(webhooksPlugin, deps13); } : fallback;
  if (!enabled) log.warn({ missing }, 'provider webhooks answer 503: missing settings');

  return {
    plugin, enabled, missing, reconcileNow, recoverNow,
    idle: async () => { await flights; },
    start() {
      if (timers.length || db === unavailableDb) return;
      // The payment poll is a Square read loop, independent of the webhook routes: without
      // PUBLIC_SERVER_URL (local runs, a misregistered webhook) it is the only path to PAID_VERIFIED.
      if (providers.square) {
        timers.push(setInterval(() => { if (!reconciling) reconciling = reconcileNow().finally(() => { reconciling = undefined; }); }, PAYMENT_POLL_INTERVAL_MS));
      }
      // Stored-row recovery only has rows to re-run when the routes store verified events.
      if (enabled) {
        void recoverNow().catch(() => log.warn({ job: 'webhook-recovery' }, 'webhook recovery will retry'));
        timers.push(setInterval(() => { void recoverNow().catch(() => undefined); }, PAYMENT_POLL_INTERVAL_MS * 4));
      }
      for (const t of timers) t.unref?.();
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      await reconciling;
      await flights;
    },
  };
}

