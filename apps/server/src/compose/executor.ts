// The executor seam (B-11) wired to the database and the provider adapters.
//
// The server connects as abos_app, which can only SELECT approval_requests, action_executions,
// message_dispatches and sync_jobs. Every change to those tables goes through a routine wrapper in
// @abos/db. Since migration 0005 the protected subject fields go through routines too:
//   APPROVED -> CREATING_CHECKOUT                  claim_execution (on the checkout claim)
//   checkout references, PAYMENT_LINK_READY        save_checkout (under the step's lease)
//   google_event_id, BOOKED_VERIFIED, Sheets job   verify_booking (also finishes the calendar step)
//   PAID_VERIFIED, FULFILLMENT_READY               mark_order_paid, fulfill_order (webhooks.ts)
//   stale RUNNING steps and sync jobs              recover_stale_executions, recover_stale_sync_jobs
// The remaining moves (MESSAGE_SENT, PAYMENT_PENDING, RECOVERY_REQUIRED, UNAVAILABLE, SLOT_CONFLICT,
// RETRY_REQUIRED) have no routine. 0005's orders_runtime_guard and bookings_runtime_guard triggers
// check every abos_app update against the contract machine and refuse protected fields, so those
// moves stay conditional updates under the guard, in `guardedMove` below and nowhere else.
//
// Idempotency keys always come from the database row. Nothing here creates or replaces a key.
import { createHash } from 'node:crypto';
import {
  BookingSchema, OrderSchema, canTransition, type ActivityEvent, type ApprovalPayload, type AvailabilitySlot,
  type Booking, type BookingApprovalPayload, type ErrorCode, type MessageChannel, type Order,
} from '@abos/contracts';
import {
  claimSyncJob, finishExecution, finishSyncJob, markStaleDispatchesUnknown, recordDispatch, recoverStaleExecutions, recoverStaleSyncJobs, runtimeClaimNextExecution,
  saveCheckout, updateDispatch, verifyBooking, type WorkerLease,
} from '@abos/db';
import { bookingRow, orderRow } from '../adapters/sheets/index';
import { renderBookingConfirmation, renderCheckoutMessage, sendOnce, type DispatchRecord, type MessageStore } from '../adapters/message/index';
import { orderFromCart } from '../adapters/square/index';
import { mapRow } from '../api/rows';
import type { Db, QueryDb } from '../db/index';
import { createExecutor, DEFAULT_STALE_AFTER_MS } from '../executor/index';
import { runSyncJob } from '../executor/jobs';
import type { ExecutorDeps, MessageResult, QueuePort, StepOutcome, SubjectsPort, SyncDeps, SyncJob } from '../executor/types';
import { emitActivity } from '../policy/activity';
import { approvalFromRow, executionFromRow } from '../policy/engine';
import { executeCatalogSyncStep, executePriceEditStep } from '../api/prices/index';
import type { Executor, SeamDeps } from './seams';

type Row = Record<string, unknown>;
const one = async (q: QueryDb, text: string, params: unknown[]) => (await q.query(text, params)).rows[0] as Row | undefined;
const all = async (q: QueryDb, text: string, params: unknown[]) => (await q.query(text, params)).rows as Row[];

/** The Sheets tabs the reporting rows go to. The tabs must already exist in the demo sheet. */
export const SHEETS_TABS = { order: 'Orders', booking: 'Bookings' } as const;
/** 0005 refuses a stale window under one minute. */
export const MIN_STALE_AFTER_MS = 60_000;

/** True when every cart line's item and variation is in this business's catalog and available (FLOWS B18). */
export async function cartAvailable(q: QueryDb, businessId: string, cart: Order['cart']): Promise<boolean> {
  for (const line of cart.lines) {
    const row = await one(q, `select is_available from public.catalog_items
      where business_id = $1 and square_item_id = $2 and square_variation_id = $3`, [businessId, line.catalogItemId, line.variationId]);
    if (!row || row.is_available !== true) return false;
  }
  return true;
}

export function orderFromDbRow(row: unknown): Order { return OrderSchema.parse(mapRow(row)); }
export function bookingFromDbRow(row: unknown): Booking { return BookingSchema.parse(mapRow(row)); }

export async function loadOrder(q: QueryDb, businessId: string, orderId: string): Promise<Order> {
  const row = await one(q, 'select * from public.orders where id = $1 and business_id = $2', [orderId, businessId]);
  if (!row) throw { code: 'NOT_FOUND', requestSent: false };
  return orderFromDbRow(row);
}
export async function loadBooking(q: QueryDb, businessId: string, bookingId: string): Promise<Booking> {
  const row = await one(q, 'select * from public.bookings where id = $1 and business_id = $2', [bookingId, businessId]);
  if (!row) throw { code: 'NOT_FOUND', requestSent: false };
  return bookingFromDbRow(row);
}

/** Order and booking moves only a routine may make. A request for one outside its routine fails closed. */
const ROUTINE_ORDER_STATES: readonly Order['status'][] = ['CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'PAID_VERIFIED', 'FULFILLMENT_READY'];
const ROUTINE_BOOKING_STATES: readonly Booking['status'][] = ['BOOKED_VERIFIED'];

/**
 * Subject moves for one query scope (the pool, or the transaction `finish` opens). `lease` is the
 * step being finished: the lease-checked routines (save_checkout, verify_booking) need it, and
 * without it they fail closed. `state.finished` is set when a routine already finished the step.
 */
export function dbSubjects(q: QueryDb, deps: Pick<SeamDeps, 'newId' | 'now'>, lease?: WorkerLease, state: { finished: boolean } = { finished: false }): SubjectsPort {
  const event = (businessId: string, correlationId: string, e: Pick<ActivityEvent, 'type' | 'payload'>) =>
    emitActivity(q, { ...e, id: deps.newId('evt_'), businessId, correlationId, actorType: 'system', occurredAt: deps.now().toISOString() });
  const needLease = (): WorkerLease => { if (!lease) throw { code: 'INVALID_STATE', requestSent: false }; return lease; };

  async function lockOrder(businessId: string, orderId: string): Promise<Order> {
    const row = await one(q, 'select * from public.orders where id = $1 and business_id = $2 for update', [orderId, businessId]);
    if (!row) throw { code: 'NOT_FOUND', requestSent: false };
    return orderFromDbRow(row);
  }
  async function lockBooking(businessId: string, bookingId: string): Promise<Booking> {
    const row = await one(q, 'select * from public.bookings where id = $1 and business_id = $2 for update', [bookingId, businessId]);
    if (!row) throw { code: 'NOT_FOUND', requestSent: false };
    return bookingFromDbRow(row);
  }
  /** The one place a subject status is written directly: a move no routine serves, under 0005's guard trigger. */
  async function guardedMove(table: 'orders' | 'bookings', subject: { id: string; businessId: string; status: string }, to: string) {
    const updated = await q.query(`update public.${table} set status = $3 where id = $1 and business_id = $2 and status = $4 returning id`,
      [subject.id, subject.businessId, to, subject.status]);
    if (updated.rows.length !== 1) throw { code: 'INVALID_STATE', requestSent: false };
  }

  return {
    loadOrder: (businessId, id) => loadOrder(q, businessId, id),
    loadBooking: (businessId, id) => loadBooking(q, businessId, id),
    async saveCheckoutLink() {
      // Called before Square's total is verified. save_checkout moves the order to PAYMENT_LINK_READY,
      // which must not happen for a link whose total may not match, so nothing is stored here. If the
      // process stops before completeCheckout, stale recovery moves the step to NEEDS_REVIEW and the
      // order to RECOVERY_REQUIRED, and recovery resolves it from Square evidence.
    },
    async completeCheckout(_businessId, _orderId, refs) {
      // save_checkout (0005): under this step's lease it stores the references on the execution row and
      // the order, sets link_ready_at, moves to PAYMENT_LINK_READY and writes checkout.created.
      await saveCheckout(q, { ...needLease(), squareOrderId: refs.squareOrderId, paymentLinkId: refs.paymentLinkId, url: refs.url });
    },
    async saveEvent(_businessId, _bookingId, eventId) {
      // verify_booking (0005): stores the event ID, moves to BOOKED_VERIFIED, writes booking.verified and
      // sync.queued, enqueues the one Sheets job and finishes the calendar step, all under the lease.
      await verifyBooking(q, { ...needLease(), googleEventId: eventId });
      state.finished = true;
    },
    async moveOrder(businessId, orderId, status) {
      const order = await lockOrder(businessId, orderId);
      if (order.status === status) return;
      if (ROUTINE_ORDER_STATES.includes(status) || !canTransition('order', order.status, status)) throw { code: 'INVALID_STATE', requestSent: false };
      await guardedMove('orders', order, status);
      await event(businessId, order.callId, { type: 'order.status_changed', payload: { subjectId: order.id, orderId: order.id, callId: order.callId, from: order.status, to: status } });
    },
    async moveBooking(businessId, bookingId, status, alternatives?: AvailabilitySlot[]) {
      void alternatives; // carried on the booking.slot_conflict event the handler writes
      const booking = await lockBooking(businessId, bookingId);
      if (booking.status === status) return;
      if (ROUTINE_BOOKING_STATES.includes(status) || !canTransition('booking', booking.status, status)) throw { code: 'INVALID_STATE', requestSent: false };
      await guardedMove('bookings', booking, status);
      await event(businessId, booking.callId ?? booking.id, { type: 'booking.status_changed', payload: { subjectId: booking.id, bookingId: booking.id, ...(booking.callId ? { callId: booking.callId } : {}), from: booking.status, to: status } });
    },
    async updateFact() {
      // local.fact.update runs only through the policy engine's runFactUpdate (one claim, one transaction).
      throw { code: 'CAPABILITY_NOT_ALLOWED', requestSent: false };
    },
  };
}

const bodyHash = (body: string) => `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
const last4 = (e164: string) => e164.slice(-4);

/** The message layer's durable store over record_dispatch and update_dispatch, for one execution and lease. */
function dispatchStore(db: Db, deps: Pick<SeamDeps, 'newId' | 'now'>, step: { businessId: string; executionId: string; workerId: string; attempt: number; subjectId: string; template: 'checkout_link' | 'booking_confirmed' }): MessageStore {
  const find = async (key: string) => one(db, 'select * from public.message_dispatches where idempotency_key = $1 and business_id = $2', [key, step.businessId]);
  return {
    async findByKey(key) {
      const row = await find(key);
      if (!row) return undefined;
      const record: DispatchRecord = { idempotencyKey: String(row.idempotency_key), channel: row.channel as MessageChannel, status: row.status as DispatchRecord['status'],
        ...(typeof row.provider_message_id === 'string' ? { providerMessageId: row.provider_message_id } : {}),
        ...(typeof row.error_code === 'string' ? { errorCode: row.error_code as ErrorCode } : {}) };
      return record;
    },
    async recordAttempt(attempt) {
      // The routine derives the recipient, channel and key from the approved row. It returns an existing
      // row for this execution, so "inserted" means no row existed before the call.
      const before = await find(attempt.idempotencyKey);
      if (before) return false;
      const row = await recordDispatch(db, { businessId: step.businessId, executionId: step.executionId, workerId: step.workerId, attempt: step.attempt, bodyHash: bodyHash(attempt.body) });
      if (row.idempotency_key !== attempt.idempotencyKey || row.channel !== attempt.channel || row.recipient !== attempt.to) throw new Error('dispatch does not match the approved routing');
      return true;
    },
    async recordOutcome(key, outcome) {
      const row = await find(key);
      if (!row) throw new Error('dispatch row is missing');
      await db.transaction(async (tx) => {
        await updateDispatch(tx, { businessId: step.businessId, dispatchId: String(row.id), workerId: step.workerId, attempt: step.attempt,
          status: outcome.status, providerMessageId: outcome.providerMessageId ?? null, error: outcome.errorCode ?? null });
        const base = { id: deps.newId('evt_'), businessId: step.businessId, correlationId: String(row.approval_id), actorType: 'system' as const, occurredAt: deps.now().toISOString() };
        if (outcome.status === 'SENT') {
          await emitActivity(tx, { ...base, type: 'message.sent', payload: { dispatchId: String(row.id), subjectId: step.subjectId, channel: row.channel, template: step.template, recipientLast4: last4(String(row.recipient)) } });
        } else {
          await emitActivity(tx, { ...base, type: 'message.failed', payload: { dispatchId: String(row.id), subjectId: step.subjectId, channel: row.channel,
            status: outcome.status === 'FAILED' ? 'FAILED' : 'UNKNOWN', ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}) } });
        }
      });
    },
  };
}

export type DbExecutor = Executor & {
  /** One executor step (tests). */
  tick(): Promise<boolean>;
  /** Runs execution steps and Sheets jobs until nothing is claimable. */
  drain(): Promise<void>;
};

export type DbExecutorOptions = { workerId?: string; intervalMs?: number; staleAfterMs?: number };

/** The executor and the Sheets job runner over the database and the configured adapters. */
export function createDbExecutor(deps: SeamDeps, options: DbExecutorOptions = {}): DbExecutor {
  const { db, providers, engine, log } = deps;
  const workerId = options.workerId ?? deps.newId('wrk_');
  const businessNames = new Map<string, string>();
  const nameOf = (businessId: string) => {
    const name = businessNames.get(businessId);
    if (!name) throw new Error('business name was not loaded');
    return name;
  };

  const queue: QueuePort = {
    async claimNext(worker) {
      // local.fact.update is owned by the policy engine; run any left QUEUED (for example after a failed decide) first.
      for (const fact of await all(db, `select id, business_id from public.action_executions where status = 'QUEUED' and action_type = 'local.fact.update'
        and attempts < 3 and next_attempt_at <= now() order by created_at limit 10`, [])) {
        try { await engine.runFactUpdate({ businessId: String(fact.business_id), executionId: String(fact.id) }); }
        catch { log.warn({ job: 'executor', executionId: String(fact.id) }, 'fact update step failed'); }
      }
      const businesses = await all(db, `select distinct business_id from public.action_executions where status = 'QUEUED' and attempts < 3
        and next_attempt_at <= now() and action_type <> 'local.fact.update' order by business_id`, []);
      for (const b of businesses) {
        const businessId = String(b.business_id);
        const row = await runtimeClaimNextExecution(db, { businessId, workerId: worker });
        if (!row) continue;
        const business = await one(db, 'select name from public.businesses where id = $1', [businessId]);
        if (business) businessNames.set(businessId, String(business.name));
        return executionFromRow(row);
      }
      return undefined;
    },
    async finish(executionId, worker, outcome: StepOutcome) {
      await db.transaction(async (tx) => {
        const row = await one(tx, 'select business_id, attempts from public.action_executions where id = $1', [executionId]);
        if (!row) throw new Error('execution not found');
        const businessId = String(row.business_id);
        const lease: WorkerLease = { businessId, executionId, workerId: worker, attempt: Number(row.attempts) };
        const state = { finished: false };
        if (outcome.apply) await outcome.apply(dbSubjects(tx, deps, lease, state));
        // verify_booking finishes the calendar step itself, in this transaction.
        if (state.finished) return;
        await finishExecution(tx, {
          businessId, executionId, workerId: worker, attempt: Number(row.attempts), status: outcome.status,
          externalRef: outcome.externalRef ?? null,
          error: outcome.errorCode ? `${outcome.errorCode}${outcome.reason ? `: ${outcome.reason}` : ''}` : (outcome.reason ?? null),
          retryAt: outcome.status === 'QUEUED' ? new Date(deps.now().getTime() + (outcome.delayMs ?? 1000)) : null,
        });
      });
    },
    async recoverStale({ olderThan }) {
      // private.recover_stale_executions, per business, on the database clock. It moves the subject as a
      // failed step would and writes execution.failed itself, so nothing is returned for the executor to
      // audit again. The routine wants a window (at least one minute), not a cutoff.
      const staleAfterMs = Math.max(MIN_STALE_AFTER_MS, deps.now().getTime() - olderThan.getTime());
      for (const b of await all(db, "select distinct business_id from public.action_executions where status = 'RUNNING' order by business_id", [])) {
        const moved = await recoverStaleExecutions(db, { businessId: String(b.business_id), staleAfterMs });
        for (const m of moved) log.warn({ job: 'executor', executionId: m.id }, 'stale step moved to NEEDS_REVIEW');
      }
      // Issue #93 (0008): a message step recovered above may have reached the provider, so its dispatch,
      // still QUEUED, becomes UNKNOWN (CONTRACTS: timeout, result unknown). The sweep also settles rows
      // recovered before 0008. It never resends: nothing sends from QUEUED or UNKNOWN once the step left RUNNING.
      for (const b of await all(db, `select distinct d.business_id from public.message_dispatches d join public.action_executions e on e.id = d.execution_id
        where d.status = 'QUEUED' and d.provider_message_id is null and e.status = 'NEEDS_REVIEW' order by d.business_id`, [])) {
        for (const d of await markStaleDispatchesUnknown(db, { businessId: String(b.business_id) })) log.warn({ job: 'executor', dispatchId: d.id }, 'dispatch of a recovered step marked UNKNOWN');
      }
      return [];
    },
  };

  const executorDeps: ExecutorDeps = {
    workerId,
    queue,
    policy: {
      async authorizeStep(input) {
        const r = await engine.authorizeStep(input);
        return r.ok ? { ok: true, execution: r.execution, material: r.approval.payload as ApprovalPayload } : { ok: false, code: r.code };
      },
    },
    subjects: dbSubjects(db, deps),
    checkout: {
      async createCheckout({ order, idempotencyKey, approvedTotalMinor, currency, onLinkCreated }) {
        if (!providers.square || !providers.squareLocationId) throw { code: 'INTEGRATION_UNAVAILABLE', outcome: 'not_created', retryable: true };
        // FLOWS B18: re-check that every approved line is still sold before the Square call. An item that
        // is gone (or no longer in the catalog) fails the step with no request made; the executor then
        // moves the order CREATING_CHECKOUT -> UNAVAILABLE (FLOWS 4, "Item unavailable").
        if (!await cartAvailable(db, order.businessId, order.cart)) throw { code: 'ITEM_UNAVAILABLE', outcome: 'not_created', retryable: false };
        return providers.square.createCheckout({ order: orderFromCart(order.cart, providers.squareLocationId), idempotencyKey, approvedTotalMinor, currency,
          ...(onLinkCreated ? { onLinkCreated } : {}) });
      },
      async resumeCheckout(input) {
        if (!providers.square) throw { code: 'INTEGRATION_UNAVAILABLE', outcome: 'created_unverified' };
        return providers.square.resumeCheckout(input);
      },
    },
    messages: {
      async sendOnce({ executionId, workerId: worker, dispatchKey, to, body }): Promise<MessageResult> {
        const step = await one(db, `select e.business_id, e.attempts, e.action_type, e.idempotency_key, a.subject_id, a.payload_canonical
          from public.action_executions e join public.approval_requests a on a.id = e.approval_id where e.id = $1`, [executionId]);
        if (!step || step.idempotency_key !== dispatchKey) return { status: 'UNKNOWN', needsReview: true };
        const approvedChannel = (JSON.parse(String(step.payload_canonical)) as { messageChannel?: string }).messageChannel;
        // The server's channel changed since approval, or no channel is configured: nothing is sent and the
        // bundle goes on with the QR code at the counter.
        if (!providers.message || providers.message.channel !== approvedChannel) return { status: 'SKIPPED' };
        const store = dispatchStore(db, deps, { businessId: String(step.business_id), executionId, workerId: worker, attempt: Number(step.attempts),
          subjectId: String(step.subject_id), template: step.action_type === 'message.checkout.send' ? 'checkout_link' : 'booking_confirmed' });
        const result = await sendOnce(store, providers.message, { dispatchKey, to, body });
        return result.status === 'SKIPPED' ? { status: 'SKIPPED' } : {
          status: result.status, ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}), needsReview: result.needsReview };
      },
    },
    calendar: {
      async createEvent(input) {
        if (!providers.calendar) throw { code: 'INTEGRATION_UNAVAILABLE', requestSent: false, retryable: true };
        const r = await providers.calendar.createEvent(input);
        if (r.ok) return { ok: true, googleEventId: r.googleEventId };
        return { ok: false, reason: r.reason, retryable: r.retryable, ...(r.alternatives ? { alternatives: r.alternatives } : {}), ...(r.outcome ? { outcome: r.outcome } : {}) };
      },
    },
    prices: {
      async update({ executionId, approvalId, idempotencyKey, attempt }) {
        if (!providers.prices) throw { code: 'INTEGRATION_UNAVAILABLE', requestSent: false, retryable: true };
        const row = await one(db, 'select a.* from public.approval_requests a join public.action_executions e on e.approval_id = a.id where e.id = $1 and a.id = $2', [executionId, approvalId]);
        if (!row) throw { code: 'NOT_FOUND', requestSent: false };
        const approval = approvalFromRow(row);
        if (approval.bundleType !== 'price_edit') throw { code: 'INVALID_STATE', requestSent: false };
        return executePriceEditStep({ approval, idempotencyKey, attempt }, { square: providers.prices });
      },
      async sync({ businessId, attempt }) {
        const square = providers.square;
        return executeCatalogSyncStep({ businessId, attempt }, { sync: async (id) => { if (!square) throw new Error('Square is not configured'); await square.syncCatalog(db, id); } });
      },
    },
    templates: {
      checkout: ({ order, url }) => renderCheckoutMessage({ businessName: nameOf(order.businessId), url }).body,
      booking: ({ booking, approved }: { booking: Booking; approved: BookingApprovalPayload }) => renderBookingConfirmation({
        businessName: nameOf(booking.businessId), serviceName: booking.serviceName, timezone: approved.timezone,
        startLocal: new Intl.DateTimeFormat('en-US', { timeZone: approved.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(approved.startUtc)),
      }).body,
    },
    activity: { write: (event) => emitActivity(db, event) },
    clock: { now: deps.now },
    ids: { next: (prefix) => deps.newId(prefix) },
    onError: (code) => log.error({ job: 'executor', code }, 'executor tick failed'),
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  };
  const executor = createExecutor(executorDeps);

  const sync: SyncDeps = {
    workerId,
    queue: {
      async claimNext(worker) {
        // A Sheets job left RUNNING past its lease goes back to RETRYING (or FAILED at the limit); the
        // runner looks the record ID up before appending, so a retry never writes a second row.
        for (const b of await all(db, "select distinct business_id from public.sync_jobs where state = 'RUNNING' and lease_deadline <= now() order by business_id", [])) {
          await recoverStaleSyncJobs(db, { businessId: String(b.business_id) });
        }
        for (const j of await all(db, `select id, business_id from public.sync_jobs where state in ('PENDING','RETRYING') and attempts < 5
          and next_retry_at <= now() order by next_retry_at, id limit 20`, [])) {
          const row = await claimSyncJob(db, { businessId: String(j.business_id), syncJobId: String(j.id), workerId: worker });
          if (!row) continue;
          const recordType = row.record_type === 'booking' ? 'booking' : 'order';
          const subject = recordType === 'order' ? orderRow(await loadOrder(db, row.business_id, row.record_id)) : bookingRow(await loadBooking(db, row.business_id, row.record_id));
          const job: SyncJob = { id: row.id, businessId: row.business_id, approvalId: row.approval_id, recordId: row.record_id, recordType, attempts: row.attempts, row: subject };
          return job;
        }
        return undefined;
      },
      async finish(jobId, worker, outcome) {
        const row = await one(db, 'select business_id, attempts, record_id from public.sync_jobs where id = $1', [jobId]);
        if (!row) throw new Error('sync job not found');
        await finishSyncJob(db, { businessId: String(row.business_id), syncJobId: jobId, workerId: worker, attempt: Number(row.attempts), state: outcome.status,
          // The Sheets row is found by its record ID in column A (FLOWS B29).
          externalRef: outcome.status === 'DONE' ? String(row.record_id) : null, error: outcome.errorCode ?? null,
          retryAt: outcome.status === 'RETRYING' ? new Date(deps.now().getTime() + (outcome.delayMs ?? 1000)) : null });
      },
    },
    policy: {
      async authorizeSync(job) {
        // claim_sync_job already re-checked the approval, the Sheets action and the dedupe key. Recheck the verified state and the row.
        const verified = job.recordType === 'order'
          ? await one(db, "select 1 from public.orders where id = $1 and business_id = $2 and status in ('PAID_VERIFIED','FULFILLMENT_READY')", [job.recordId, job.businessId])
          : await one(db, "select 1 from public.bookings where id = $1 and business_id = $2 and status = 'BOOKED_VERIFIED'", [job.recordId, job.businessId]);
        if (!verified) return { ok: false, code: 'INVALID_STATE' };
        if (job.row[0] !== job.recordId) return { ok: false, code: 'VALIDATION_FAILED' };
        return { ok: true };
      },
    },
    reporting: {
      async appendOnce({ recordId, row }) {
        if (!providers.sheets || !providers.sheetId) return { ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true };
        const job = await one(db, 'select record_type from public.sync_jobs where record_id = $1', [recordId]);
        const tab = job?.record_type === 'booking' ? SHEETS_TABS.booking : SHEETS_TABS.order;
        const r = await providers.sheets.appendOnce({ sheetId: providers.sheetId, tab, recordId, row: row.map((c) => (typeof c === 'number' ? c : c === null ? '' : String(c))) });
        return r.ok ? r : { ok: false, reason: r.reason, retryable: r.retryable };
      },
    },
    activity: executorDeps.activity,
    clock: executorDeps.clock,
    ids: executorDeps.ids,
  };

  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  async function drain() {
    // Bounded, so a step that keeps requeueing with no delay cannot spin forever.
    for (let i = 0; i < 200; i++) {
      const ranStep = await executor.tick();
      const ranSync = await runSyncJob(sync);
      if (!ranStep && !ranSync) return;
    }
  }
  const schedule = () => {
    chain = chain.then(drain).catch(() => log.error({ job: 'executor' }, 'executor drain failed'));
    return chain;
  };
  return {
    tick: () => executor.tick(),
    drain: () => schedule(),
    start() {
      if (timer) return;
      timer = setInterval(() => { void schedule(); }, options.intervalMs ?? 2000);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await chain;
      await executor.stop();
    },
    kick() { void schedule(); },
    idle: () => chain,
  };
}
