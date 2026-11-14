// Migration 0008: the owner's retry or abandon of a NEEDS_REVIEW step (issue #54, SPEC P-19), and the
// dispatch of a crashed message step marked UNKNOWN (issue #93). Local PGlite only, migrated by the
// non-superuser owner; every routine call runs as abos_app. The admin statements (no role) only move a
// lease deadline into the past, standing in for a worker that died.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { activityEventFromRow } from '@abos/contracts';
import { BOOKING_BUNDLE, ORDER_BUNDLE, asOwner, createBooking, createMigratedDb, createOrder, createOwner, createSupabaseLikeDb, migrationDb, uniq } from './helpers';
import { applyMigrations, readMigrations } from '../src/migrate';
import * as runtime from '../src/runtime';
import * as pkg from '../src/index';

let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); }, 60_000);
afterAll(async () => { await db.close(); });

const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
async function as<T>(target: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await target.exec(`set role ${role}`);
  try { return await fn(); } finally { await target.exec('reset role'); }
}
const app = <T>(fn: () => Promise<T>) => as(db, 'abos_app', fn);
type Row = Record<string, unknown>;
const one = async (sql: string, args: unknown[] = []) => (await db.query<Row>(sql, args)).rows[0]!;
const step = (id: string) => one('select * from public.action_executions where id=$1', [id]);
const dispatchOf = (executionId: string) => one('select * from public.message_dispatches where execution_id=$1', [executionId]);
const events = async (businessId: string) => (await db.query<Row>('select * from public.activity_events where business_id=$1 order by occurred_at, id', [businessId])).rows
  .map((r) => ({ ...r, occurred_at: (r.occurred_at as Date).toISOString() }));

async function approved(type: 'order_bundle' | 'booking_bundle' = 'order_bundle') {
  const owner = await createOwner(db);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const subject = type === 'order_bundle' ? await createOrder(db, owner) : await createBooking(db, owner, { call_id: owner.callId });
  const actionBundle = type === 'order_bundle' ? ORDER_BUNDLE : BOOKING_BUNDLE;
  const fields = type === 'order_bundle'
    ? { agentVersionId: owner.agentVersionId, cartHash: subject.cart_hash, totalMinor: 1200, currency: 'USD', pickupAt: null }
    : { agentVersionId: owner.agentVersionId, serviceId: subject.service_id, calendarId: subject.calendar_id,
        startUtc: (subject.start_utc as Date).toISOString(), endUtc: (subject.end_utc as Date).toISOString(), timezone: subject.timezone };
  const payload = { businessId: owner.businessId, subjectId: String(subject.id), ...fields,
    messageRecipient: '+15555550123', messageChannel: 'surge', actionBundle, expiresAt };
  const canonical = JSON.stringify(payload);
  return app(async () => {
    const a = await runtime.createApproval(db, { businessId: owner.businessId, bundleType: type, subjectId: String(subject.id),
      actorType: 'deployed_agent', actorId: owner.agentVersionId, payload, canonical, payloadHash: sha(canonical), actionBundle, expiresAt });
    const { executions } = await runtime.runtimeDecideAndEnqueue(db, { businessId: owner.businessId, approvalId: a.id,
      ownerUserId: owner.userId, payloadHash: a.payload_hash, decision: 'APPROVED' });
    return { owner, businessId: owner.businessId, ownerUserId: owner.userId, subjectId: String(subject.id), approvalId: a.id, executions };
  });
}
type Approved = Awaited<ReturnType<typeof approved>>;
const lease = (p: Approved, i: number, workerId: string, attempt = 1) => ({ businessId: p.businessId, executionId: p.executions[i]!.id, workerId, attempt });

/** The worker holding step i dies: its lease runs out and stale recovery sends the step to NEEDS_REVIEW. */
async function crash(p: Approved, i: number) {
  await db.query("update public.action_executions set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [p.executions[i]!.id]);
  return app(() => runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 }));
}
async function checkoutDone(p: Approved) {
  const l = lease(p, 0, 'w-checkout');
  await app(async () => {
    await runtime.runtimeClaimExecution(db, l);
    await runtime.saveCheckout(db, { ...l, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
    await runtime.finishExecution(db, { ...l, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
  });
}
/** An approved order whose checkout is done and whose message worker died after recording its dispatch. */
async function crashedMessage() {
  const p = await approved();
  await checkoutDone(p);
  const l = lease(p, 1, 'w-message');
  const d = await app(async () => {
    await runtime.runtimeClaimExecution(db, l);
    return runtime.recordDispatch(db, { ...l, bodyHash: sha('body') });
  });
  await crash(p, 1);
  return { ...p, dispatchId: d.id, messageId: p.executions[1]!.id };
}
const resolve = (p: Approved, executionId: string, action: 'retry' | 'abandon', providerRead: runtime.RecoveryProviderRead,
  extra: { ownerUserId?: string; businessId?: string; externalRef?: string; checkout?: runtime.CheckoutReferences } = {}) =>
  app(() => runtime.ownerResolveExecution(db, { businessId: extra.businessId ?? p.businessId, executionId, ownerUserId: extra.ownerUserId ?? p.ownerUserId, action, providerRead,
    ...(extra.externalRef ? { externalRef: extra.externalRef } : {}), ...(extra.checkout ? { checkout: extra.checkout } : {}) }));
const decisions = async (executionId: string) => (await db.query<Row>('select * from public.recovery_decisions where execution_id=$1 order by attempt', [executionId])).rows;
async function crashedCheckout() {
  const p = await approved();
  await app(() => runtime.runtimeClaimExecution(db, lease(p, 0, 'w-dead')));
  await crash(p, 0);
  expect((await one('select status from public.orders where id=$1', [p.subjectId])).status).toBe('RECOVERY_REQUIRED');
  return p;
}
async function crashedBooking() {
  const p = await approved('booking_bundle');
  await app(() => runtime.runtimeClaimExecution(db, lease(p, 0, 'w-cal')));
  await crash(p, 0);
  expect((await one('select status from public.bookings where id=$1', [p.subjectId])).status).toBe('RETRY_REQUIRED');
  return p;
}

describe('mark_stale_dispatches_unknown (issue #93)', () => {
  it('marks the QUEUED dispatch of a crashed message step UNKNOWN, once, with a message.failed event', async () => {
    const p = await crashedMessage();
    expect((await step(p.messageId)).status).toBe('NEEDS_REVIEW');
    expect((await dispatchOf(p.messageId)).status).toBe('QUEUED');
    const before = (await events(p.businessId)).length;
    const moved = await app(() => runtime.markStaleDispatchesUnknown(db, { businessId: p.businessId }));
    expect(moved.map((d) => [d.id, d.status, d.provider_message_id])).toEqual([[p.dispatchId, 'UNKNOWN', null]]);
    const after = await events(p.businessId);
    expect(after).toHaveLength(before + 1);
    const e = activityEventFromRow(after.at(-1)!);
    expect(e).toMatchObject({ type: 'message.failed', actorType: 'system', payload: { dispatchId: p.dispatchId, subjectId: p.subjectId, channel: 'surge', status: 'UNKNOWN' } });
    // The key and routing of the dispatch are untouched.
    expect(await dispatchOf(p.messageId)).toMatchObject({ idempotency_key: (await step(p.messageId)).idempotency_key, recipient: '+15555550123', channel: 'surge' });
    // A repeat moves nothing and writes nothing.
    expect(await app(() => runtime.markStaleDispatchesUnknown(db, { businessId: p.businessId }))).toEqual([]);
    expect(await events(p.businessId)).toHaveLength(before + 1);
  });

  it('leaves a dispatch alone while its step still holds a live lease, and a SENT dispatch alone', async () => {
    const p = await approved();
    await checkoutDone(p);
    const l = lease(p, 1, 'w-live');
    await app(async () => { await runtime.runtimeClaimExecution(db, l); await runtime.recordDispatch(db, { ...l, bodyHash: sha('body') }); });
    expect(await app(() => runtime.markStaleDispatchesUnknown(db, { businessId: p.businessId }))).toEqual([]);
    expect((await dispatchOf(p.executions[1]!.id)).status).toBe('QUEUED');
    // Sent, then the step went to review: the provider message ID proves the send, so it stays SENT.
    const d = await dispatchOf(p.executions[1]!.id);
    await app(async () => {
      await runtime.updateDispatch(db, { ...l, dispatchId: String(d.id), status: 'SENT', providerMessageId: 'pm-' + uniq() });
      await runtime.finishExecution(db, { ...l, status: 'NEEDS_REVIEW', error: 'test' });
    });
    expect(await app(() => runtime.markStaleDispatchesUnknown(db, { businessId: p.businessId }))).toEqual([]);
    expect((await dispatchOf(p.executions[1]!.id)).status).toBe('SENT');
  });

  it('is scoped to one business and needs one', async () => {
    const p = await crashedMessage();
    const other = await approved();
    expect(await app(() => runtime.markStaleDispatchesUnknown(db, { businessId: other.businessId }))).toEqual([]);
    expect((await dispatchOf(p.messageId)).status).toBe('QUEUED');
    await expect(app(() => runtime.markStaleDispatchesUnknown(db, { businessId: '' }))).rejects.toThrow(/SCOPE: business required/);
  });
});

describe('owner_resolve_execution: one recorded decision per step attempt (review finding 3)', () => {
  it('refuses an ordinary worker QUEUED step and an ordinary FAILED step: neither was ever in review', async () => {
    const p = await approved('booking_bundle');
    const l = lease(p, 0, 'w-retryable');
    await app(async () => { await runtime.runtimeClaimExecution(db, l); await runtime.finishExecution(db, { ...l, status: 'QUEUED', retryAt: new Date() }); });
    await expect(resolve(p, l.executionId, 'retry', 'calendar_event_absent')).rejects.toThrow(/LEASE: NEEDS_REVIEW required/);
    const f = await approved('booking_bundle');
    const lf = lease(f, 0, 'w-failed');
    await app(async () => { await runtime.runtimeClaimExecution(db, lf); await runtime.finishExecution(db, { ...lf, status: 'FAILED', error: 'refused' }); });
    await expect(resolve(f, lf.executionId, 'abandon', 'calendar_event_absent')).rejects.toThrow(/LEASE: NEEDS_REVIEW required/);
    expect(await decisions(lf.executionId)).toEqual([]);
  });

  it('an identical repeat returns the recorded result; another action or read for the same attempt is refused', async () => {
    const p = await crashedBooking();
    const id = p.executions[0]!.id;
    const n = (await events(p.businessId)).length;
    expect(await resolve(p, id, 'abandon', 'calendar_event_absent')).toMatchObject({ status: 'FAILED' });
    expect(await resolve(p, id, 'abandon', 'calendar_event_absent')).toMatchObject({ status: 'FAILED' });
    expect(await events(p.businessId)).toHaveLength(n + 1);
    expect(await decisions(id)).toEqual([expect.objectContaining({ attempt: 1, action: 'abandon', decided_by: p.ownerUserId, provider_read: 'calendar_event_absent', result_status: 'FAILED' })]);
    await expect(resolve(p, id, 'retry', 'calendar_event_absent')).rejects.toThrow(/another recovery decision was recorded/);
    await expect(resolve(p, id, 'abandon', 'none')).rejects.toThrow(/another recovery decision was recorded/);
  });

  it('a later NEEDS_REVIEW of the retried step is a new attempt with its own decision and the same key', async () => {
    const p = await crashedBooking();
    const id = p.executions[0]!.id;
    const key = (await step(id)).idempotency_key;
    expect(await resolve(p, id, 'retry', 'calendar_event_absent')).toMatchObject({ status: 'QUEUED', attempts: 1, idempotency_key: key });
    expect(await resolve(p, id, 'retry', 'calendar_event_absent')).toMatchObject({ status: 'QUEUED' });
    await app(() => runtime.runtimeClaimExecution(db, lease(p, 0, 'w-second', 2)));
    await crash(p, 0);
    expect(await resolve(p, id, 'abandon', 'calendar_event_absent')).toMatchObject({ status: 'FAILED', attempts: 2, idempotency_key: key });
    expect((await decisions(id)).map((d) => [d.attempt, d.action, d.result_status])).toEqual([[1, 'retry', 'QUEUED'], [2, 'abandon', 'FAILED']]);
  });
});

describe('owner_resolve_execution: one routine completes and records (second review)', () => {
  it('takes evidence only with a found read on retry, and only in the shape 0005 needs', async () => {
    const c = await crashedCheckout();
    const id = c.executions[0]!.id;
    const refs = { squareOrderId: 'sq-x', paymentLinkId: 'link-x', url: 'https://example.test/x' };
    await expect(resolve(c, id, 'retry', 'checkout_found')).rejects.toThrow(/RESULT: the provider read does not fit this step/);
    await expect(resolve(c, id, 'abandon', 'checkout_found', { externalRef: 'sq-x', checkout: refs })).rejects.toThrow(/RESULT: provider evidence is taken only with a found read on retry/);
    await expect(resolve(c, id, 'retry', 'none', { externalRef: 'sq-x' })).rejects.toThrow(/RESULT: provider evidence is taken only/);
    await expect(resolve(c, id, 'retry', 'calendar_event_found', { externalRef: 'sq-x' })).rejects.toThrow(/does not fit this step/);
    // The first 0008 signature (reference, absence flag, checkout JSON in other positions) is gone.
    await expect(app(() => db.query("select * from private.owner_resolve_execution($1,$2,$3,'retry','invented-order',false,'{}'::jsonb)", [c.businessId, id, c.ownerUserId])))
      .rejects.toThrow(/does not exist/);
    expect((await step(id)).status).toBe('NEEDS_REVIEW');
    expect((await one('select status from public.orders where id=$1', [c.subjectId])).status).toBe('RECOVERY_REQUIRED');
    expect(await decisions(id)).toEqual([]);
  });

  it('a step completed through 0005 directly gets no owner decision afterwards, in the same transaction or later', async () => {
    const b = await crashedBooking();
    const id = b.executions[0]!.id;
    const eventId = String((await step(id)).idempotency_key);
    await app(async () => {
      await db.exec('begin');
      try {
        await runtime.resolveExecution(db, { businessId: b.businessId, executionId: id, status: 'SUCCEEDED', externalRef: eventId, nothingWritten: false });
        await expect(runtime.ownerResolveExecution(db, { businessId: b.businessId, executionId: id, ownerUserId: b.ownerUserId, action: 'retry', providerRead: 'calendar_event_found', externalRef: eventId }))
          .rejects.toThrow(/LEASE: NEEDS_REVIEW required/);
      } finally { await db.exec('rollback'); }
    });
    await app(() => runtime.resolveExecution(db, { businessId: b.businessId, executionId: id, status: 'SUCCEEDED', externalRef: eventId, nothingWritten: false }));
    await expect(resolve(b, id, 'retry', 'calendar_event_found', { externalRef: eventId })).rejects.toThrow(/LEASE: NEEDS_REVIEW required/);
    await expect(resolve(b, id, 'retry', 'calendar_event_found')).rejects.toThrow(/LEASE: NEEDS_REVIEW required/);
    expect(await decisions(id)).toEqual([]);
  });

  it('a found read completes the step through 0005 and records it in the same call, also inside a savepoint; a repeat returns it with one row', async () => {
    const b = await crashedBooking();
    const id = b.executions[0]!.id;
    const eventId = String((await step(id)).idempotency_key);
    await app(async () => {
      await db.exec('begin');
      try {
        await db.exec('savepoint recovery');
        expect(await runtime.ownerResolveExecution(db, { businessId: b.businessId, executionId: id, ownerUserId: b.ownerUserId, action: 'retry', providerRead: 'calendar_event_found', externalRef: eventId }))
          .toMatchObject({ status: 'SUCCEEDED', external_ref: eventId });
        await db.exec('release savepoint recovery');
        await db.exec('commit');
      } catch (error) { await db.exec('rollback'); throw error; }
    });
    expect(await one('select status, google_event_id from public.bookings where id=$1', [b.subjectId])).toEqual({ status: 'BOOKED_VERIFIED', google_event_id: eventId });
    expect(await decisions(id)).toEqual([expect.objectContaining({ attempt: 1, action: 'retry', provider_read: 'calendar_event_found', result_status: 'SUCCEEDED', decided_by: b.ownerUserId })]);
    const n = (await events(b.businessId)).length;
    expect(await resolve(b, id, 'retry', 'calendar_event_found', { externalRef: eventId })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await resolve(b, id, 'retry', 'calendar_event_found')).toMatchObject({ status: 'SUCCEEDED' });
    expect(await decisions(id)).toHaveLength(1);
    expect(await events(b.businessId)).toHaveLength(n);
  });

  it('a found checkout passes the evidence to 0005, whose checks still apply', async () => {
    const c = await crashedCheckout();
    const id = c.executions[0]!.id;
    // 0005 refuses evidence whose order ID is not the reference, and a URL that is not https.
    await expect(resolve(c, id, 'retry', 'checkout_found', { externalRef: 'sq-a', checkout: { squareOrderId: 'sq-b', paymentLinkId: 'l', url: 'https://example.test/c' } }))
      .rejects.toThrow(/RESULT: checkout evidence required/);
    await expect(resolve(c, id, 'retry', 'checkout_found', { externalRef: 'sq-a', checkout: { squareOrderId: 'sq-a', paymentLinkId: 'l', url: 'http://example.test/c' } }))
      .rejects.toThrow(/RESULT: checkout evidence required/);
    expect(await decisions(id)).toEqual([]);
    const refs = { squareOrderId: 'sq-' + c.subjectId, paymentLinkId: 'link-' + c.subjectId, url: 'https://example.test/c' };
    expect(await resolve(c, id, 'retry', 'checkout_found', { externalRef: refs.squareOrderId, checkout: refs })).toMatchObject({ status: 'SUCCEEDED' });
    expect((await one('select status, square_order_id from public.orders where id=$1', [c.subjectId]))).toEqual({ status: 'PAYMENT_LINK_READY', square_order_id: refs.squareOrderId });
    expect((await decisions(id)).map((d) => d.provider_read)).toEqual(['checkout_found']);
  });
});

describe('owner_resolve_execution: booking in RETRY_REQUIRED (issue #54)', () => {
  it('retry after the server read the calendar and found nothing requeues the same step and key, back to RECHECKING_SLOT', async () => {
    const p = await crashedBooking();
    const id = p.executions[0]!.id;
    const key = String((await step(id)).idempotency_key);
    const n = (await events(p.businessId)).length;
    expect(await resolve(p, id, 'retry', 'calendar_event_absent')).toMatchObject({ id, status: 'QUEUED', idempotency_key: key, attempts: 1 });
    expect((await one('select status from public.bookings where id=$1', [p.subjectId])).status).toBe('RECHECKING_SLOT');
    const audit = (await events(p.businessId)).slice(n).map((e) => activityEventFromRow(e));
    expect(audit.map((e) => e.type).sort()).toEqual(['booking.status_changed', 'execution.failed']);
    // The next worker claims attempt 2 with the original key and verifies the booking.
    const l = lease(p, 0, 'w-retry', 2);
    expect(await app(() => runtime.runtimeClaimExecution(db, l))).toMatchObject({ attempts: 2, idempotency_key: key });
    await app(() => runtime.verifyBooking(db, { ...l, googleEventId: key }));
    expect((await one('select status from public.bookings where id=$1', [p.subjectId])).status).toBe('BOOKED_VERIFIED');
  });

  it('abandon leaves the booking in RETRY_REQUIRED, which has no failed state of its own; both actions need the absence read', async () => {
    const p = await crashedBooking();
    await expect(resolve(p, p.executions[0]!.id, 'retry', 'none')).rejects.toThrow(/RESULT: this step needs a provider read/);
    await expect(resolve(p, p.executions[0]!.id, 'abandon', 'none')).rejects.toThrow(/RESULT: this step needs a provider read/);
    expect(await resolve(p, p.executions[0]!.id, 'abandon', 'calendar_event_absent')).toMatchObject({ status: 'FAILED' });
    expect((await one('select status from public.bookings where id=$1', [p.subjectId])).status).toBe('RETRY_REQUIRED');
  });

  it('refuses another owner, another business, an invalid action or read, and a step that is not in review', async () => {
    const p = await crashedBooking();
    const other = await approved('booking_bundle');
    const id = p.executions[0]!.id;
    await expect(resolve(p, id, 'abandon', 'calendar_event_absent', { ownerUserId: other.ownerUserId })).rejects.toThrow(/OWNER: business owner required/);
    await expect(resolve(p, id, 'abandon', 'calendar_event_absent', { ownerUserId: '' })).rejects.toThrow(/OWNER: business owner required/);
    await expect(resolve(p, id, 'abandon', 'calendar_event_absent', { businessId: other.businessId, ownerUserId: other.ownerUserId })).rejects.toThrow(/SCOPE: execution not found/);
    await expect(app(() => db.query("select * from private.owner_resolve_execution($1,$2,$3,'resend','none')", [p.businessId, id, p.ownerUserId]))).rejects.toThrow(/TRANSITION/);
    await expect(app(() => db.query("select * from private.owner_resolve_execution($1,$2,$3,'retry','looked_twice')", [p.businessId, id, p.ownerUserId]))).rejects.toThrow(/TRANSITION/);
    await expect(resolve(other, other.executions[0]!.id, 'retry', 'calendar_event_absent')).rejects.toThrow(/LEASE: NEEDS_REVIEW required/);
    expect((await step(id)).status).toBe('NEEDS_REVIEW');
    expect(await decisions(id)).toEqual([]);
  });
});

describe('owner_resolve_execution: checkout', () => {
  it('is neither requeued nor abandoned: absence cannot be proven, the owner cancels the order', async () => {
    const p = await crashedCheckout();
    for (const action of ['retry', 'abandon'] as const) {
      await expect(resolve(p, p.executions[0]!.id, action, 'calendar_event_absent')).rejects.toThrow(/a checkout cannot be proven absent/);
    }
    expect((await step(p.executions[0]!.id)).status).toBe('NEEDS_REVIEW');
    expect((await one('select status from public.orders where id=$1', [p.subjectId])).status).toBe('RECOVERY_REQUIRED');
  });
});

describe('owner_resolve_execution: message whose delivery is unknown', () => {
  it('never resends: retry is refused and changes nothing', async () => {
    const p = await crashedMessage();
    await app(() => runtime.markStaleDispatchesUnknown(db, { businessId: p.businessId }));
    const n = (await events(p.businessId)).length;
    for (const read of ['none', 'calendar_event_absent'] as const) await expect(resolve(p, p.messageId, 'retry', read)).rejects.toThrow(/never sent again/);
    expect((await step(p.messageId)).status).toBe('NEEDS_REVIEW');
    expect((await dispatchOf(p.messageId)).status).toBe('UNKNOWN');
    expect(await events(p.businessId)).toHaveLength(n);
  });

  it('abandon marks the dispatch and the step FAILED, writes both events once, and the bundle goes on', async () => {
    const p = await crashedMessage();
    await app(() => runtime.markStaleDispatchesUnknown(db, { businessId: p.businessId }));
    const n = (await events(p.businessId)).length;
    expect(await resolve(p, p.messageId, 'abandon', 'none')).toMatchObject({ id: p.messageId, status: 'FAILED' });
    expect(await dispatchOf(p.messageId)).toMatchObject({ status: 'FAILED', provider_message_id: null });
    const audit = (await events(p.businessId)).slice(n).map((e) => activityEventFromRow(e));
    expect(audit.map((e) => `${e.type}/${e.actorType}`).sort()).toEqual(['execution.failed/system', 'message.failed/owner']);
    expect(audit.find((e) => e.type === 'message.failed')!.payload).toMatchObject({ dispatchId: p.dispatchId, status: 'FAILED' });
    expect(await resolve(p, p.messageId, 'abandon', 'none')).toMatchObject({ status: 'FAILED' });
    expect(await events(p.businessId)).toHaveLength(n + 2);
    expect(await app(() => runtime.runtimeClaimExecution(db, lease(p, 2, 'w-record')))).toMatchObject({ status: 'RUNNING' });
  });

  it('abandon also settles a dispatch still QUEUED from before 0008', async () => {
    const p = await crashedMessage();
    expect((await dispatchOf(p.messageId)).status).toBe('QUEUED');
    expect(await resolve(p, p.messageId, 'abandon', 'none')).toMatchObject({ status: 'FAILED' });
    expect((await dispatchOf(p.messageId)).status).toBe('FAILED');
  });

  it('a sent message in review is completed through resolve_execution, never abandoned; the same retry twice gives the same answer', async () => {
    const p = await approved();
    await checkoutDone(p);
    const l = lease(p, 1, 'w-sent');
    const providerId = 'pm-' + uniq();
    await app(async () => {
      await runtime.runtimeClaimExecution(db, l);
      const d = await runtime.recordDispatch(db, { ...l, bodyHash: sha('body') });
      await runtime.updateDispatch(db, { ...l, dispatchId: d.id, status: 'SENT', providerMessageId: providerId });
      await runtime.finishExecution(db, { ...l, status: 'NEEDS_REVIEW', error: 'test' });
    });
    const id = p.executions[1]!.id;
    await expect(resolve(p, id, 'abandon', 'none')).rejects.toThrow(/SUBJECT: a sent message is completed/);
    await expect(resolve(p, id, 'retry', 'message_sent', { externalRef: 'pm-other' })).rejects.toThrow(/does not fit this step/);
    const first = await resolve(p, id, 'retry', 'message_sent');
    const second = await resolve(p, id, 'retry', 'message_sent');
    expect(first).toMatchObject({ status: 'SUCCEEDED', external_ref: providerId });
    expect(second).toEqual(first);
  });
});

describe('0008 privileges', () => {
  it('abos_app still cannot write the protected tables directly', async () => {
    const p = await crashedMessage();
    await app(async () => {
      for (const [sql, args] of [
        ["update public.action_executions set status='QUEUED' where id=$1", [p.messageId]],
        ["update public.message_dispatches set status='FAILED' where id=$1", [p.dispatchId]],
        ["insert into public.message_dispatches (business_id,approval_id,execution_id,order_id,channel,recipient,template,body_hash,idempotency_key) select business_id,approval_id,execution_id,order_id,channel,recipient,template,body_hash,idempotency_key||'x' from public.message_dispatches where id=$1", [p.dispatchId]],
        ["update public.approval_requests set state='APPROVED' where id=$1", [p.approvalId]],
        ['delete from public.action_executions where id=$1', [p.messageId]],
        // 0008's decision table: the routine is its only writer.
        ["insert into public.recovery_decisions (business_id,execution_id,attempt,action,decided_by,provider_read,result_status) values ($1,$2,1,'retry',$3,'calendar_event_absent','QUEUED')", [p.businessId, p.messageId, p.ownerUserId]],
        ["update public.recovery_decisions set action='retry' where execution_id=$1", [p.messageId]],
        ['delete from public.recovery_decisions where execution_id=$1', [p.messageId]],
        ['truncate public.recovery_decisions', []],
      ] as const) await expect(db.query(sql, [...args]), sql).rejects.toMatchObject({ code: '42501' });
    });
    // A recorded decision is append-only even for the table owner.
    await resolve(p, p.messageId, 'abandon', 'none');
    await expect(db.query("update public.recovery_decisions set action='retry' where execution_id=$1", [p.messageId])).rejects.toThrow(/append only/);
    await expect(db.query('delete from public.recovery_decisions where execution_id=$1', [p.messageId])).rejects.toThrow(/append only/);
    // abos_app reads it; an owner reads only their own business's rows.
    expect(await app(async () => (await db.query('select count(*)::int n from public.recovery_decisions where execution_id=$1', [p.messageId])).rows[0])).toEqual({ n: 1 });
    expect((await one("select has_table_privilege('abos_app','public.recovery_decisions','INSERT, UPDATE, DELETE, TRUNCATE') w")).w).toBe(false);
    expect((await one("select relrowsecurity r from pg_class where oid='public.recovery_decisions'::regclass")).r).toBe(true);
    const check = await app(() => runtime.runtimeRoleCheck(db));
    expect(check).toMatchObject({ writes_approvals: false, writes_executions: false, writes_dispatches: false, writes_sync_jobs: false, writes_receipts: false });
  });

  it('a signed-in owner (authenticated) reads only their own business decisions and writes none', async () => {
    const mine = await crashedBooking();
    const theirs = await crashedBooking();
    await resolve(mine, mine.executions[0]!.id, 'abandon', 'calendar_event_absent');
    await resolve(theirs, theirs.executions[0]!.id, 'abandon', 'calendar_event_absent');
    const seen = await asOwner(db, mine.owner.authUserId, async () => (await db.query<Row>('select business_id, execution_id from public.recovery_decisions')).rows);
    expect(seen).toEqual([{ business_id: mine.businessId, execution_id: mine.executions[0]!.id }]);
    await expect(asOwner(db, mine.owner.authUserId, () => db.query("update public.recovery_decisions set action='retry'"))).rejects.toMatchObject({ code: '42501' });
    await expect(asOwner(db, mine.owner.authUserId, () => db.query('select * from private.owner_resolve_execution($1,$2,$3,$4,$5)',
      [mine.businessId, mine.executions[0]!.id, mine.ownerUserId, 'abandon', 'calendar_event_absent']))).rejects.toMatchObject({ code: '42501' });
  });

  it('the two entry points are SECURITY DEFINER with an empty search_path, executable by abos_app only', async () => {
    for (const sig of ['private.mark_stale_dispatches_unknown(text)', 'private.owner_resolve_execution(text,text,text,text,text,text,jsonb)']) {
      const f = await one(`select prosecdef, proconfig::text config from pg_proc where oid=$1::regprocedure`, [sig]);
      expect(f, sig).toEqual({ prosecdef: true, config: '{"search_path=\\"\\""}' });
      for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
        expect((await one("select has_function_privilege($1,$2::regprocedure,'EXECUTE') ok", [role, sig])).ok, `${sig} ${role}`).toBe(false);
      }
      expect((await one("select has_function_privilege('abos_app',$1::regprocedure,'EXECUTE') ok", [sig])).ok).toBe(true);
    }
  });

  it('issue #93: the package no longer exports the direct-SQL helpers', () => {
    for (const name of ['decideAndEnqueue', 'decideApproval', 'claimExecution', 'claimNextExecution', 'expireApprovals',
      'DECIDE_APPROVAL_SQL', 'CLAIM_EXECUTION_SQL', 'CLAIM_NEXT_EXECUTION_SQL', 'EXPIRE_APPROVALS_SQL']) expect(pkg, name).not.toHaveProperty(name);
    expect(pkg).toHaveProperty('ownerResolveExecution');
    expect(pkg).toHaveProperty('markStaleDispatchesUnknown');
  });
});

describe('0008 on a database that already has 0001 to 0007', () => {
  const NAME = '0008_owner_recovery.sql';
  const files = readMigrations();
  const snapshot = async (target: PGlite) => {
    const q = async (sql: string) => (await target.query<{ k: string; v: string }>(sql)).rows.map((r) => `${r.k} = ${r.v}`);
    return [
      ...await q(`select p.oid::regprocedure::text k, md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text,'') || ' ' || p.prosecdef::text v
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'`),
      ...await q(`select c.conrelid::regclass::text || '.' || c.conname k, pg_get_constraintdef(c.oid) v from pg_constraint c
        join pg_namespace n on n.oid=c.connamespace where n.nspname='public'`),
      ...await q(`select c.oid::regclass::text k, coalesce(c.relacl::text,'') || ' rls=' || c.relrowsecurity::text v from pg_class c
        join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`),
      ...await q(`select t.tgrelid::regclass::text || '.' || t.tgname k, pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text v from pg_trigger t
        join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal`),
      ...await q(`select tablename || '.' || policyname k, roles::text || ' ' || cmd v from pg_policies`),
      ...await q(`select indexname k, indexdef v from pg_indexes where schemaname='public'`),
    ].sort();
  };

  it('adds its two routines and the recovery_decisions table, changes nothing else and writes no row', async () => {
    expect(files.at(-1)!.name).toBe(NAME);
    const fresh = await createSupabaseLikeDb();
    try {
      await as(fresh, 'supabase_postgres', () => applyMigrations(migrationDb(fresh), files.filter((f) => f.name < NAME)));
      const before = await snapshot(fresh);
      const rows = `select (select count(*)::int from public.activity_events) e, (select count(*)::int from public.message_dispatches) d,
        (select count(*)::int from public.action_executions) x`;
      const rowsBefore = (await fresh.query(rows)).rows[0];
      expect((await as(fresh, 'supabase_postgres', () => applyMigrations(migrationDb(fresh)))).applied).toEqual([NAME]);
      const after = await snapshot(fresh);
      expect(before.filter((x) => !after.includes(x))).toEqual([]);
      const added = after.filter((x) => !before.includes(x)).map((x) => x.split(' = ')[0]!);
      // Two routines, and the recovery_decisions table with its own constraints, policies, trigger and key.
      expect(added.filter((k) => !k.includes('recovery_decisions'))).toEqual([
        'private.mark_stale_dispatches_unknown(text)', 'private.owner_resolve_execution(text,text,text,text,text,text,jsonb)']);
      expect(added).toEqual(expect.arrayContaining(['recovery_decisions', 'recovery_decisions.recovery_decisions_append_only',
        'recovery_decisions.runtime_read', 'recovery_decisions.recovery_decisions_owner_read', 'recovery_decisions_pkey']));
      expect((await fresh.query(rows)).rows[0]).toEqual(rowsBefore);
      // abos_app cannot apply it.
      await expect(as(fresh, 'abos_app', () => fresh.exec(files.at(-1)!.sql))).rejects.toThrow(/must be owner|permission denied|already exists/);
    } finally { await fresh.close(); }
  }, 120_000);

  it('is all or nothing: a failure inside the file leaves no routine behind', async () => {
    const fresh = await createSupabaseLikeDb();
    try {
      await as(fresh, 'supabase_postgres', () => applyMigrations(migrationDb(fresh), files.filter((f) => f.name < NAME)));
      const broken = { ...files.at(-1)!, sql: `${files.at(-1)!.sql}\nselect 1 / 0;\n` };
      await expect(as(fresh, 'supabase_postgres', () => applyMigrations(migrationDb(fresh), [...files.filter((f) => f.name < NAME), broken]))).rejects.toThrow(/0008/);
      expect((await fresh.query("select count(*)::int n from pg_proc where proname in ('owner_resolve_execution','mark_stale_dispatches_unknown')")).rows[0]).toEqual({ n: 0 });
      expect((await fresh.query("select to_regclass('public.recovery_decisions') t")).rows[0]).toEqual({ t: null });
      expect((await fresh.query('select count(*)::int n from public.schema_migrations where name=$1', [NAME])).rows[0]).toEqual({ n: 0 });
    } finally { await fresh.close(); }
  }, 120_000);
});
