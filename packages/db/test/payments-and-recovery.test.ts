// Migration 0005: agents.spec_revision, checked payment outcomes and stale lease recovery, run as abos_app.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityEventFromRow, ORDER_MACHINE, BOOKING_MACHINE, canTransition } from '@abos/contracts';
import type { PGlite } from '@electric-sql/pglite';
import {
  BOOKING_BUNDLE, ORDER_BUNDLE, createBooking, createMigratedDb, createOrder, createOwner, createSupabaseLikeDb,
  migrateAsSupabaseOwner, migrationDb, insert, uniq,
} from './helpers';
import { applyMigrations, readMigrations } from '../src/migrate';
import * as runtime from '../src/runtime';

let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); }, 60_000);
afterAll(async () => { await db.close(); });
const hash = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
async function app<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('set role abos_app');
  try { return await fn(); } finally { await db.exec('reset role'); }
}

async function approved(type: 'order_bundle' | 'booking_bundle' = 'order_bundle', decision: 'APPROVED' | 'REJECTED' | 'PENDING' = 'APPROVED', lifetime = 600_000) {
  const owner = await createOwner(db);
  const expiresAt = new Date(Date.now() + lifetime).toISOString();
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
      actorType: 'owner', actorId: owner.userId, payload, canonical, payloadHash: hash(canonical), actionBundle, expiresAt });
    const d = decision === 'PENDING' ? { executions: [] } : await runtime.runtimeDecideAndEnqueue(db, { businessId: owner.businessId, approvalId: a.id, ownerUserId: owner.userId,
      payloadHash: a.payload_hash, decision });
    return { owner, businessId: owner.businessId, subjectId: String(subject.id), approvalId: a.id, executions: d.executions };
  });
}

/** Creates checkout through the checked worker path, then records the unpaid local state. */
async function pending() {
  const p = await approved();
  await insert(db, 'integrations', { business_id: p.businessId, provider: 'square', alias: 'main', config: { locationId: 'loc-' + p.businessId } });
  await app(async () => {
    await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'checkout' });
    await runtime.saveCheckout(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'checkout', attempt: 1,
      squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/checkout' });
    await runtime.finishExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'checkout', attempt: 1, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
    await db.query("update public.orders set status='PAYMENT_PENDING' where id=$1", [p.subjectId]);
  });
  return p;
}
function evidence(p: { businessId: string; subjectId: string }, paymentStatus = 'COMPLETED') {
  return { squareOrderId: 'sq-' + p.subjectId, locationId: 'loc-' + p.businessId, paymentStatus, environment: 'sandbox', amountMinor: 1200, currency: 'USD' };
}
const status = async (table: string, id: string) =>
  (await db.query<{ status: string }>(`select status from public.${table} where id=$1`, [id])).rows[0]!.status;
const events = async (correlationId: string) =>
  (await db.query<{ type: string; actor_type: string; payload: Record<string, unknown> }>(
    'select type,actor_type,payload from public.activity_events where business_id=(select business_id from public.approval_requests where id=$1) order by occurred_at,id', [correlationId])).rows;
const syncCount = async (id: string) =>
  (await db.query<{ n: number }>("select count(*)::int n from public.sync_jobs where record_type='order' and record_id=$1", [id])).rows[0]!.n;

describe('0005 migration', () => {
  it('applies the full set cleanly from empty as the non-superuser owner', async () => {
    const fresh = await createSupabaseLikeDb();
    try {
      await migrateAsSupabaseOwner(fresh);
      const q = await fresh.query<{ name: string }>('select name from public.schema_migrations order by name');
      expect(q.rows.map(r => r.name)).toEqual(readMigrations().map(f => f.name));
      expect(q.rows.map(r => r.name)).toContain('0005_payments_and_stale_leases.sql');
      expect(q.rows.at(-1)?.name).toBe('0008_owner_recovery.sql');
      const owners = await fresh.query<{ o: string }>(`select distinct pg_get_userbyid(proowner) o from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and proname in ('mark_order_paid','mark_order_payment_failed','recover_stale_executions')`);
      expect(owners.rows).toEqual([{ o: 'supabase_postgres' }]);
    } finally { await fresh.close(); }
  }, 60_000);

  it('leaves the checksums of applied migrations 0001 to 0004 unchanged', () => {
    const sums = Object.fromEntries(readMigrations().map(f => [f.name, f.checksum]));
    expect(sums).toMatchObject({
      '0001_extensions_and_helpers.sql': '86b69cfab61380e99afc722e198f50c8a9eeb9f68c439209f2953a2bb53d03fb',
      '0002_core_tables.sql': '8a698b17fdae0ed6324a4af5458047788ee5d3a2988fc843788a17b27db4337f',
      '0003_realtime.sql': '66d88c8e844f40382f534198318b1e0ab26f8f184905ff45b6ec09b1795f73b3',
      '0004_runtime_role_and_routines.sql': 'cbf1f6397be4eacbcf7d0d5a6d13979bc65b16e97d5f933a6470422d3dc70aca',
    });
  });

  it('grants the new routines to abos_app only, as pinned security definers', async () => {
    const q = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[]; app: boolean; svc: boolean; auth: boolean; pub: boolean }>(`
      select p.proname,p.prosecdef,p.proconfig,has_function_privilege('abos_app',p.oid,'execute') app,
        has_function_privilege('service_role',p.oid,'execute') svc,has_function_privilege('authenticated',p.oid,'execute') auth,
        exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') pub
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and proname in ('mark_order_paid','mark_order_payment_failed','recover_stale_executions') order by 1`);
    expect(q.rows).toHaveLength(3);
    for (const r of q.rows) expect(r, r.proname).toMatchObject({ prosecdef: true, proconfig: ['search_path=""'], app: true, svc: false, auth: false, pub: false });
  });

  it('adds agents.spec_revision, defaulting to 1, writable by abos_app and never below 1', async () => {
    const o = await createOwner(db);
    await app(async () => {
      expect((await db.query('select spec_revision from public.agents where id=$1', [o.agentId])).rows[0]).toEqual({ spec_revision: 1 });
      await db.query('update public.agents set spec_revision=spec_revision+1 where id=$1', [o.agentId]);
      expect((await db.query('select spec_revision from public.agents where id=$1', [o.agentId])).rows[0]).toEqual({ spec_revision: 2 });
      await expect(db.query('update public.agents set spec_revision=0 where id=$1', [o.agentId])).rejects.toMatchObject({ code: '23514' });
    });
  });

  for (const table of ['approval_requests', 'action_executions', 'message_dispatches', 'sync_jobs']) {
    it(`still refuses direct writes on ${table} (42501)`, async () => {
      await app(async () => {
        for (const sql of [`insert into public.${table} default values`, `update public.${table} set id=id`, `delete from public.${table}`])
          await expect(db.query(sql)).rejects.toMatchObject({ code: '42501' });
      });
    });
  }
});

describe('mark_order_paid', () => {
  it('records the payment, moves to PAID_VERIFIED, enqueues one Sheets job and audits, all at once', async () => {
    const p = await pending();
    const r = await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p), paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }));
    expect(r.order).toMatchObject({ id: p.subjectId, status: 'PAID_VERIFIED', square_payment_id: expect.stringMatching(/^pay-/) });
    expect(r.syncJob).toMatchObject({ record_type: 'order', record_id: p.subjectId, approval_id: p.approvalId, state: 'PENDING',
      idempotency_key: createHash('sha256').update(`${p.businessId}:${p.subjectId}:sheets.order.append:${p.approvalId}`).digest('hex') });
    // One transaction gives the three events the same occurred_at, so compare them in type order.
    const tail = (await events(p.approvalId)).filter(e => ['payment.verified', 'sync.queued'].includes(e.type) || e.payload.to === 'PAID_VERIFIED')
      .sort((x, y) => x.type.localeCompare(y.type));
    expect(tail).toEqual([
      { type: 'order.status_changed', actor_type: 'system', payload: { subjectId: p.subjectId, orderId: p.subjectId, callId: p.owner.callId, from: 'PAYMENT_PENDING', to: 'PAID_VERIFIED' } },
      { type: 'payment.verified', actor_type: 'provider', payload: { orderId: p.subjectId, squarePaymentId: r.order.square_payment_id, amountMinor: 1200, currency: 'USD', sandbox: true } },
      { type: 'sync.queued', actor_type: 'system', payload: { target: 'google_sheets', syncJobId: r.syncJob.id, recordType: 'order', recordId: p.subjectId } },
    ]);
  });

  it('is an idempotent no-op on a repeat with the same payment ID, also after FULFILLMENT_READY', async () => {
    const p = await pending(); const paymentId = 'pay-' + uniq();
    const args = { businessId: p.businessId, orderId: p.subjectId, ...evidence(p), paymentId, amountMinor: 1200, currency: 'USD' };
    const first = await app(() => runtime.markOrderPaid(db, args));
    const before = (await events(p.approvalId)).length;
    expect(await app(() => runtime.markOrderPaid(db, args))).toEqual(first);
    expect((await events(p.approvalId)).length).toBe(before);
    expect(await syncCount(p.subjectId)).toBe(1);
    await app(() => runtime.fulfillOrder(db, { businessId: p.businessId, orderId: p.subjectId }));
    const again = await app(() => runtime.markOrderPaid(db, args));
    expect(again.order.status).toBe('FULFILLMENT_READY'); expect(again.syncJob.id).toBe(first.syncJob.id);
    expect((await events(p.approvalId)).length).toBe(before + 1);
  });

  it('refuses a different payment ID on an already paid order and changes nothing', async () => {
    const p = await pending(); const paymentId = 'pay-' + uniq();
    await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p), paymentId, amountMinor: 1200, currency: 'USD' }));
    await app(() => expect(runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p), paymentId: 'other-' + uniq(), amountMinor: 1200, currency: 'USD' }))
      .rejects.toThrow(/IDENTITY: order already paid/));
    expect((await db.query('select square_payment_id from public.orders where id=$1', [p.subjectId])).rows[0]).toEqual({ square_payment_id: paymentId });
  });

  it('refuses a payment ID already recorded on another order', async () => {
    const a = await pending(); const b = await pending(); const paymentId = 'pay-' + uniq();
    await app(() => runtime.markOrderPaid(db, { businessId: a.businessId, orderId: a.subjectId, ...evidence(a), paymentId, amountMinor: 1200, currency: 'USD' }));
    await app(() => expect(runtime.markOrderPaid(db, { businessId: b.businessId, orderId: b.subjectId, ...evidence(b), paymentId, amountMinor: 1200, currency: 'USD' }))
      .rejects.toThrow(/IDENTITY: payment already recorded/));
    expect(await status('orders', b.subjectId)).toBe('PAYMENT_PENDING');
  });

  for (const [name, change, pattern] of [
    ['wrong business', { businessId: 'biz_other' }, /SCOPE/],
    ['amount mismatch', { amountMinor: 1199 }, /PAYMENT: amount/],
    ['currency mismatch', { currency: 'EUR' }, /PAYMENT: currency/],
    ['missing payment ID', { paymentId: '' }, /PAYMENT: payment ID/],
  ] as const) it(`refuses a ${name} and changes nothing`, async () => {
    const p = await pending(); const before = (await events(p.approvalId)).length;
    await app(() => expect(runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p), paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD', ...change }))
      .rejects.toThrow(pattern));
    expect(await status('orders', p.subjectId)).toBe('PAYMENT_PENDING');
    expect((await events(p.approvalId)).length).toBe(before);
    expect(await syncCount(p.subjectId)).toBe(0);
  });

  it('refuses a mismatched local business and order pair', async () => {
    const p = await pending(); const other = await pending();
    await app(() => expect(runtime.markOrderPaid(db, { businessId: other.businessId, orderId: p.subjectId, ...evidence(p), paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }))
      .rejects.toThrow(/SCOPE/));
    expect(await status('orders', p.subjectId)).toBe('PAYMENT_PENDING');
  });

  for (const state of ['APPROVED', 'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'MESSAGE_SENT', 'CANCELLED', 'RECOVERY_REQUIRED'])
    it(`refuses an order in ${state}`, async () => {
      const p = await pending();
      // Owner fixture installs a state to isolate the payment routine's admission check.
      await db.query('update public.orders set status=$2 where id=$1', [p.subjectId, state]);
      await app(() => expect(runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p), paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }))
        .rejects.toThrow(/SUBJECT: order requires/));
      expect(await status('orders', p.subjectId)).toBe(state);
      expect(await syncCount(p.subjectId)).toBe(0);
    });

  it('refuses an order with no approval', async () => {
    const o = await createOwner(db); const order = await createOrder(db, o);
    await app(() => expect(runtime.markOrderPaid(db, { businessId: o.businessId, orderId: String(order.id), ...evidence({ businessId: o.businessId, subjectId: String(order.id) }), paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }))
      .rejects.toThrow(/SUBJECT/));
  });

  it('pays an order after a failed payment (failed then paid)', async () => {
    const p = await pending();
    await app(() => runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p, 'FAILED'), paymentId: 'declined-' + uniq(), reason: 'FAILED' }));
    const r = await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p), paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }));
    expect(r.order.status).toBe('PAID_VERIFIED');
    const changed = (await events(p.approvalId)).filter(e => e.type === 'order.status_changed').map(e => [e.payload.from, e.payload.to]);
    expect(changed.slice(-2)).toEqual([['PAYMENT_PENDING', 'PAYMENT_FAILED'], ['PAYMENT_FAILED', 'PAID_VERIFIED']]);
  });
});

describe('mark_order_payment_failed', () => {
  it('moves PAYMENT_PENDING to PAYMENT_FAILED with its audit, and a repeat changes nothing', async () => {
    const p = await pending(); const args = { businessId: p.businessId, orderId: p.subjectId, ...evidence(p, 'CANCELED'), paymentId: 'declined-' + uniq(), reason: 'CANCELED' };
    const first = await app(() => runtime.markOrderPaymentFailed(db, args));
    expect(first.status).toBe('PAYMENT_FAILED');
    expect((await events(p.approvalId)).slice(-2).sort((x, y) => x.type.localeCompare(y.type))).toEqual([
      { type: 'order.status_changed', actor_type: 'system', payload: { subjectId: p.subjectId, orderId: p.subjectId, callId: p.owner.callId, from: 'PAYMENT_PENDING', to: 'PAYMENT_FAILED' } },
      { type: 'payment.failed', actor_type: 'provider', payload: { orderId: p.subjectId, squarePaymentId: args.paymentId, reason: 'CANCELED', sandbox: true } },
    ]);
    const before = (await events(p.approvalId)).length;
    expect((await app(() => runtime.markOrderPaymentFailed(db, args))).status).toBe('PAYMENT_FAILED');
    expect((await events(p.approvalId)).length).toBe(before);
  });

  it('returns a paid order unchanged for an obsolete failure observation', async () => {
    const p = await pending();
    await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p), paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }));
    const before = (await events(p.approvalId)).length;
    expect((await app(() => runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p, 'FAILED'), paymentId: 'late-' + uniq(), reason: 'FAILED' }))).status).toBe('PAID_VERIFIED');
    expect((await events(p.approvalId)).length).toBe(before);
    expect(await status('orders', p.subjectId)).toBe('PAID_VERIFIED');
  });

  it('refuses the wrong business, other states and a missing reason', async () => {
    const p = await pending();
    await app(async () => {
      await expect(runtime.markOrderPaymentFailed(db, { businessId: 'biz_other', orderId: p.subjectId, ...evidence(p, 'FAILED'), paymentId: 'x', reason: 'FAILED' })).rejects.toThrow(/SCOPE/);
      await expect(runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p, 'FAILED'), paymentId: 'x', reason: '' })).rejects.toThrow(/PAYMENT: reason/);
      await db.exec('reset role');
      await db.query("update public.orders set status='MESSAGE_SENT' where id=$1", [p.subjectId]);
      await db.exec('set role abos_app');
      await expect(runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, ...evidence(p, 'FAILED'), paymentId: 'x', reason: 'FAILED' })).rejects.toThrow(/SUBJECT/);
    });
    expect(await status('orders', p.subjectId)).toBe('MESSAGE_SENT');
  });
});

describe('recover_stale_executions', () => {
  const FIFTEEN_MIN = 15 * 60_000;
  /** Ages a lease as the owner; abos_app cannot write action_executions. */
  const age = (id: string, minutes: number) =>
    db.query(`update public.action_executions set lease_deadline=clock_timestamp()-($2::int*interval '1 minute') where id=$1`, [id, minutes]);

  it('moves a stale checkout step to NEEDS_REVIEW, the order to RECOVERY_REQUIRED, and never requeues', async () => {
    const p = await approved(); const step = p.executions[0]!;
    await app(async () => {
      expect((await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: step.id, workerId: 'dead' }))?.status).toBe('RUNNING');
    });
    await age(step.id, 20);
    const moved = await app(() => runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: FIFTEEN_MIN }));
    expect(moved.map(x => [x.id, x.status, x.locked_by, x.idempotency_key, x.attempts])).toEqual([[step.id, 'NEEDS_REVIEW', null, step.idempotency_key, 1]]);
    expect(await status('orders', p.subjectId)).toBe('RECOVERY_REQUIRED');
    expect((await events(p.approvalId)).filter(e => e.type === 'order.status_changed').at(-1)).toEqual({ type: 'order.status_changed', actor_type: 'system',
      payload: { subjectId: p.subjectId, orderId: p.subjectId, callId: p.owner.callId, from: 'CREATING_CHECKOUT', to: 'RECOVERY_REQUIRED' } });
    await app(async () => {
      expect(await runtime.runtimeClaimNextExecution(db, { businessId: p.businessId, workerId: 'new' })).toBeNull();
      await expect(runtime.finishExecution(db, { businessId: p.businessId, executionId: step.id, workerId: 'dead', attempt: 1, status: 'SUCCEEDED', externalRef: 'late' }))
        .rejects.toThrow(/LEASE/);
      expect(await runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: FIFTEEN_MIN })).toEqual([]);
    });
  });

  it('picks only stale RUNNING rows of its own business and leaves fresh leases and other states alone', async () => {
    const stale = await approved('booking_bundle'); const fresh = await approved(); const other = await approved();
    await app(async () => {
      for (const p of [stale, fresh, other])
        await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w' });
    });
    await age(stale.executions[0]!.id, 20); // The fresh worker keeps its deadline even if its claim is old.
    await db.query("update public.action_executions set locked_at=clock_timestamp()-interval '1 hour' where id=$1", [fresh.executions[0]!.id]); await age(other.executions[0]!.id, 20);
    const moved = await app(() => runtime.recoverStaleExecutions(db, { businessId: stale.businessId, staleAfterMs: FIFTEEN_MIN }));
    expect(moved.map(x => x.id)).toEqual([stale.executions[0]!.id]);
    expect(await status('bookings', stale.subjectId)).toBe('RETRY_REQUIRED');
    const states = async (p: typeof stale) => (await db.query<{ status: string }>('select status from public.action_executions where approval_id=$1 order by step_index', [p.approvalId])).rows.map(r => r.status);
    expect(await states(stale)).toEqual(['NEEDS_REVIEW', 'QUEUED', 'QUEUED']);
    expect(await states(fresh)).toEqual(['RUNNING', 'QUEUED', 'QUEUED']);
    expect(await states(other)).toEqual(['RUNNING', 'QUEUED', 'QUEUED']);
    expect(await status('orders', other.subjectId)).toBe('CREATING_CHECKOUT');
    expect(await app(() => runtime.recoverStaleExecutions(db, { businessId: fresh.businessId, staleAfterMs: FIFTEEN_MIN }))).toEqual([]);
  });

  it('lets local recording run after a stale message step, without moving the subject', async () => {
    const p = await approved();
    await app(async () => {
      await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w' });
      // 0006: a checkout step succeeds only with its saved references.
      await runtime.saveCheckout(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1,
        squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
      await runtime.finishExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
      await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: p.executions[1]!.id, workerId: 'dead' });
    });
    await age(p.executions[1]!.id, 30);
    const moved = await app(() => runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: FIFTEEN_MIN }));
    expect(moved.map(x => [x.action_type, x.status])).toEqual([['message.checkout.send', 'NEEDS_REVIEW']]);
    expect(await status('orders', p.subjectId)).toBe('PAYMENT_LINK_READY');
    expect((await app(() => runtime.runtimeClaimNextExecution(db, { businessId: p.businessId, workerId: 'new' })))?.action_type).toBe('local.order.record');
  });

  it('refuses an interval shorter than one minute and a missing business', async () => {
    await app(async () => {
      await expect(runtime.recoverStaleExecutions(db, { businessId: 'biz_x', staleAfterMs: 59_000 })).rejects.toThrow(/LEASE/);
      await expect(runtime.recoverStaleExecutions(db, { businessId: '', staleAfterMs: FIFTEEN_MIN })).rejects.toThrow(/SCOPE/);
    });
  });
});

it('refuses direct payment identity replacement by the runtime role', async () => {
  const p = await pending();
  await app(() => expect(db.query("update public.orders set square_payment_id='forged' where id=$1", [p.subjectId])).rejects.toThrow(/protected|PAYMENT/));
});

describe('provider observation regression cases', () => {
  for (const [name, change] of [
    ['another Square order', { squareOrderId: 'sq-other' }],
    ['another location', { locationId: 'loc-other' }],
    ['no location', { locationId: '' }],
    ['no environment', { environment: '' }],
    ['production', { environment: 'production' }],
    ['pending status', { paymentStatus: 'PENDING' }],
    ['approved status', { paymentStatus: 'APPROVED' }],
    ['no status', { paymentStatus: '' }],
    ['failed status on success', { paymentStatus: 'FAILED' }],
  ] as const) it(`refuses ${name} without a receipt, job or event`, async () => {
    const p = await pending(); const before = (await events(p.approvalId)).length;
    await app(() => expect(runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId,
      paymentId: 'pay-' + uniq(), ...evidence(p), ...change })).rejects.toThrow(/PAYMENT/));
    expect(await status('orders', p.subjectId)).toBe('PAYMENT_PENDING');
    expect((await events(p.approvalId)).length).toBe(before);
    expect((await db.query('select * from public.payment_receipts where order_id=$1', [p.subjectId])).rows).toEqual([]);
    expect(await syncCount(p.subjectId)).toBe(0);
  });

  for (const change of [
    { paymentStatus: 'COMPLETED' }, { paymentStatus: 'PENDING' }, { environment: 'production' },
    { squareOrderId: 'wrong' }, { locationId: 'wrong' }, { amountMinor: 1199 }, { currency: 'EUR' },
  ]) it(`refuses inconsistent failure evidence ${JSON.stringify(change)}`, async () => {
    const p = await pending();
    await app(() => expect(runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId,
      paymentId: 'declined-' + uniq(), reason: 'Declined', ...evidence(p, 'FAILED'), ...change })).rejects.toThrow(/PAYMENT/));
    expect(await status('orders', p.subjectId)).toBe('PAYMENT_PENDING');
  });

  it('refuses another business payment identity even when the target has its own matching checkout', async () => {
    const a = await pending(); const b = await pending(); const paymentId = 'pay-' + uniq();
    await app(() => runtime.markOrderPaid(db, { businessId: a.businessId, orderId: a.subjectId, paymentId, ...evidence(a) }));
    await app(() => expect(runtime.markOrderPaid(db, { businessId: b.businessId, orderId: b.subjectId, paymentId, ...evidence(b) })).rejects.toThrow(/IDENTITY/));
    // The test owner clears the current orders column to reproduce the historical ledger bypass.
    await db.query("update public.orders set status='PAYMENT_PENDING',square_payment_id=null where id=$1", [a.subjectId]);
    await app(() => expect(runtime.markOrderPaid(db, { businessId: b.businessId, orderId: b.subjectId, paymentId, ...evidence(b) })).rejects.toThrow(/IDENTITY/));
    expect((await db.query('select order_id from public.payment_receipts where payment_id=$1', [paymentId])).rows).toEqual([{ order_id: a.subjectId }]);
    await db.query('delete from public.orders where id=$1', [a.subjectId]);
    await app(() => expect(runtime.markOrderPaid(db, { businessId: b.businessId, orderId: b.subjectId, paymentId, ...evidence(b) })).rejects.toThrow(/IDENTITY/));
  });

  it('stores an immutable redacted receipt and refuses direct receipt DML in replica mode', async () => {
    const p = await pending(); const paymentId = 'pay-' + uniq();
    await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId, ...evidence(p) }));
    await app(async () => {
      const receipt = (await db.query('select * from public.payment_receipts where payment_id=$1', [paymentId])).rows[0];
      expect(receipt).toMatchObject({ payment_id: paymentId, business_id: p.businessId, order_id: p.subjectId,
        square_order_id: 'sq-' + p.subjectId, location_id: 'loc-' + p.businessId, amount_minor: 1200, currency: 'USD', status: 'COMPLETED', environment: 'sandbox' });
      for (const sql of ['insert into public.payment_receipts default values', 'update public.payment_receipts set status=status', 'delete from public.payment_receipts', 'truncate public.payment_receipts'])
        await expect(db.query(sql)).rejects.toMatchObject({ code: '42501' });
    });
    await db.exec('set session_replication_role=replica');
    try {
      await expect(db.query('update public.payment_receipts set payment_id=$2 where payment_id=$1', [paymentId, 'other'])).rejects.toThrow(/append only/);
      await expect(db.query('delete from public.payment_receipts where payment_id=$1', [paymentId])).rejects.toThrow(/append only/);
    } finally { await db.exec('set session_replication_role=origin'); }
  });

  it('makes the failure, success, repeated failure sequence a no-op in both later paid states', async () => {
    const p = await pending();
    const failed = { businessId: p.businessId, orderId: p.subjectId, paymentId: 'declined-' + uniq(), reason: 'Declined', ...evidence(p, 'FAILED') };
    await app(() => runtime.markOrderPaymentFailed(db, failed));
    await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'paid-' + uniq(), ...evidence(p) }));
    for (const state of ['PAID_VERIFIED', 'FULFILLMENT_READY']) {
      if (state === 'FULFILLMENT_READY') await app(() => runtime.fulfillOrder(db, { businessId: p.businessId, orderId: p.subjectId }));
      const before = (await events(p.approvalId)).length;
      expect((await app(() => runtime.markOrderPaymentFailed(db, failed))).status).toBe(state);
      expect((await events(p.approvalId)).length).toBe(before);
    }
  });

  it('rechecks order totals and signed approval material on both success and failure', async () => {
    const p = await pending();
    // 0006 freezes order material for abos_app, so the drift is an owner-side write.
    await app(() => expect(db.query('update public.orders set total_minor=1199 where id=$1', [p.subjectId])).rejects.toThrow(/protected order material/));
    await db.query('update public.orders set total_minor=1199 where id=$1', [p.subjectId]);
    for (const amountMinor of [1200, 1199]) {
      await app(() => expect(runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'x', ...evidence(p), amountMinor })).rejects.toThrow(/SUBJECT|PAYMENT/));
      await app(() => expect(runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'x', reason: 'Declined', ...evidence(p, 'FAILED'), amountMinor })).rejects.toThrow(/SUBJECT|PAYMENT/));
    }
    expect(await syncCount(p.subjectId)).toBe(0);
  });
});

describe('direct subject write guards', () => {
  it('refuses payment identity set, replacement, clearing and every direct paid state move', async () => {
    const p = await pending();
    await app(() => expect(db.query("update public.orders set status='PAID_VERIFIED',square_payment_id='forged' where id=$1", [p.subjectId])).rejects.toThrow(/protected/));
    await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), ...evidence(p) }));
    await app(async () => {
      await db.query("select set_config('app.allow_reset','on',false),set_config('app.in_definer','true',false)");
      for (const assignment of ["square_payment_id='replacement'", 'square_payment_id=null', 'approval_id=null', "id=id||'x'", "business_id='biz_other'", "status='PAYMENT_PENDING',square_payment_id=null", "status='FULFILLMENT_READY'", "status='CANCELLED'"])
        await expect(db.query(`update public.orders set ${assignment} where id=$1`, [p.subjectId])).rejects.toThrow(/protected/);
      await expect(createOrder(db, p.owner, { status: 'PAID_VERIFIED', square_payment_id: 'forged' })).rejects.toThrow(/protected/);
      await expect(createOrder(db, p.owner, { square_payment_id: 'forged' })).rejects.toThrow(/protected/);
      await expect(createOrder(db, p.owner, { status: 'FULFILLMENT_READY' })).rejects.toThrow(/protected/);
    });
  });

  it('compares every SQL order and booking pair and direct runtime move with the contracts', async () => {
    const owner = await createOwner(db);
    const order = await createOrder(db, owner, { square_order_id: 'sq-' + uniq(), square_payment_link_id: 'link-' + uniq(), checkout_url: 'https://example.test', square_payment_id: 'pay-' + uniq() });
    const booking = await createBooking(db, owner, { google_event_id: 'event-' + uniq() });
    for (const [table, machine, id, protectedStates] of [
      ['orders', ORDER_MACHINE, order.id, ['PAID_VERIFIED', 'FULFILLMENT_READY']],
      ['bookings', BOOKING_MACHINE, booking.id, ['BOOKED_VERIFIED']],
    ] as const) {
      for (const from of machine.states) for (const to of machine.states) {
        const expected = machine.transitions.some(t => t.from === from && t.to === to);
        expect((await db.query<{ ok: boolean }>(`select private.${table}_transition($1,$2) ok`, [from, to])).rows[0]!.ok, `${table} ${from} to ${to}`).toBe(expected);
        await db.query(`update public.${table} set status=$2 where id=$1`, [id, from]);
        const allowed = from === to || expected && !protectedStates.some(s => s === from || s === to);
        await app(async () => {
          const move = db.query(`update public.${table} set status=$2 where id=$1`, [id, to]);
          if (allowed) await move;
          else await expect(move).rejects.toThrow(/protected|TRANSITION/);
        });
      }
    }
  });

  it('refuses direct calendar identity writes and already verified inserts', async () => {
    const p = await approved('booking_bundle');
    await app(async () => {
      await expect(db.query("update public.bookings set google_event_id='forged',status='BOOKED_VERIFIED' where id=$1", [p.subjectId])).rejects.toThrow(/protected/);
      await expect(createBooking(db, p.owner, { google_event_id: 'forged' })).rejects.toThrow(/protected/);
      await expect(createBooking(db, p.owner, { status: 'BOOKED_VERIFIED', google_event_id: 'forged' })).rejects.toThrow(/protected/);
    });
    await app(() => runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w' }));
    await app(() => runtime.verifyBooking(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1, googleEventId: 'event-' + uniq() }));
    await app(async () => {
      for (const sql of ["google_event_id='replacement'", 'google_event_id=null', "status='RETRY_REQUIRED'"])
        await expect(db.query(`update public.bookings set ${sql} where id=$1`, [p.subjectId])).rejects.toThrow(/protected/);
    });
  });
});

const leaseArgs = (p: Awaited<ReturnType<typeof approved>>, workerId = 'worker') => ({ businessId: p.businessId, executionId: p.executions[0]!.id, workerId, attempt: 1 });
async function expiredExecution(p: Awaited<ReturnType<typeof approved>>) {
  await app(() => runtime.runtimeClaimExecution(db, leaseArgs(p)));
  await db.query("update public.action_executions set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [p.executions[0]!.id]);
  return app(() => runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 }));
}

describe('lease deadlines and evidence resolution', () => {
  it('moves APPROVED to CREATING_CHECKOUT during the claim and writes a call-correlated event', async () => {
    const p = await approved();
    await app(() => runtime.runtimeClaimExecution(db, leaseArgs(p)));
    expect(await status('orders', p.subjectId)).toBe('CREATING_CHECKOUT');
    expect((await events(p.approvalId)).at(-1)?.payload).toMatchObject({ callId: p.owner.callId, orderId: p.subjectId, from: 'APPROVED', to: 'CREATING_CHECKOUT' });
  });

  it('renews only the current live worker and attempt and recovers by deadline, not claim time', async () => {
    const p = await approved(); const args = leaseArgs(p);
    await app(() => runtime.runtimeClaimExecution(db, args));
    await db.query("update public.action_executions set locked_at=clock_timestamp()-interval '1 day',lease_deadline=clock_timestamp()+interval '1 minute' where id=$1", [args.executionId]);
    await app(async () => {
      for (const change of [{ workerId: 'other' }, { attempt: 2 }, { businessId: 'biz_wrong' }, { durationMs: 59_000 }, { durationMs: 901_000 }])
        await expect(runtime.renewExecutionLease(db, { ...args, durationMs: 900_000, ...change })).rejects.toThrow(/LEASE|SCOPE/);
      const renewed = await runtime.renewExecutionLease(db, { ...args, durationMs: 900_000 });
      expect(new Date(String(renewed.lease_deadline)).getTime()).toBeGreaterThan(Date.now() + 800_000);
      expect(await runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 })).toEqual([]);
    });
    await db.query("update public.action_executions set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [args.executionId]);
    await app(() => expect(runtime.renewExecutionLease(db, { ...args, durationMs: 900_000 })).rejects.toThrow(/LEASE/));
    await app(() => expect(runtime.finishExecution(db, { ...args, status: 'SUCCEEDED', externalRef: 'late' })).rejects.toThrow(/LEASE/));
  });

  it('recovery winning fences the worker, audits once and permits only evidence-based resolution', async () => {
    const p = await approved('booking_bundle'); const args = leaseArgs(p);
    const moved = await expiredExecution(p);
    expect(moved.map(x => x.status)).toEqual(['NEEDS_REVIEW']);
    const before = (await events(p.approvalId)).length;
    await app(async () => {
      await expect(runtime.finishExecution(db, { ...args, status: 'SUCCEEDED', externalRef: 'real-event' })).rejects.toThrow(/LEASE/);
      expect(await runtime.runtimeClaimExecution(db, args)).toBeNull();
      await expect(runtime.resolveExecution(db, { ...args, status: 'SUCCEEDED', nothingWritten: false })).rejects.toThrow(/reference/);
      await expect(runtime.resolveExecution(db, { ...args, businessId: 'biz_wrong', status: 'SUCCEEDED', externalRef: 'real-event', nothingWritten: false })).rejects.toThrow(/SCOPE/);
      expect(await runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 })).toEqual([]);
    });
    expect((await events(p.approvalId)).length).toBe(before);
    const audits = (await events(p.approvalId)).filter(e => e.type === 'execution.failed');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({ executionId: args.executionId, nextStatus: 'NEEDS_REVIEW', retryable: false, errorCode: 'INTERNAL' });
    const resolved = await app(() => runtime.resolveExecution(db, { ...args, status: 'SUCCEEDED', externalRef: 'real-event', nothingWritten: false }));
    expect(resolved.status).toBe('SUCCEEDED'); expect(resolved.idempotency_key).toBe(p.executions[0]!.idempotency_key);
    expect(await status('bookings', p.subjectId)).toBe('BOOKED_VERIFIED');
    expect((await db.query("select * from public.sync_jobs where record_id=$1", [p.subjectId])).rows).toHaveLength(1);
  });

  it('finish winning leaves no stale work and refuses later resolution', async () => {
    const p = await approved('booking_bundle'); const args = leaseArgs(p);
    await app(async () => {
      await runtime.runtimeClaimExecution(db, args);
      await runtime.verifyBooking(db, { ...args, googleEventId: 'event-' + uniq() });
      expect(await runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 })).toEqual([]);
      await expect(runtime.resolveExecution(db, { ...args, status: 'FAILED', nothingWritten: false })).rejects.toThrow(/NEEDS_REVIEW/);
    });
  });

  for (const bundle of ['order_bundle', 'booking_bundle'] as const) it(`requeues ${bundle} only after proved absence, preserving its key and next attempt`, async () => {
    const p = await approved(bundle); const args = leaseArgs(p);
    await expiredExecution(p);
    await app(async () => {
      await expect(runtime.resolveExecution(db, { ...args, status: 'QUEUED', nothingWritten: false })).rejects.toThrow(/proved absent/);
      const resolved = await runtime.resolveExecution(db, { ...args, status: 'QUEUED', nothingWritten: true });
      expect(resolved.idempotency_key).toBe(p.executions[0]!.idempotency_key);
      expect(resolved.attempts).toBe(1);
      expect((await runtime.runtimeClaimExecution(db, { ...args, workerId: 'replacement' }))?.attempts).toBe(2);
    });
    expect(await status(bundle === 'order_bundle' ? 'orders' : 'bookings', p.subjectId)).toBe(bundle === 'order_bundle' ? 'RECOVERY_REQUIRED' : 'RECHECKING_SLOT');
  });

  it('abandons an unresolved step without requeueing or erasing its key', async () => {
    const p = await approved(); await expiredExecution(p);
    const resolved = await app(() => runtime.resolveExecution(db, { ...leaseArgs(p), status: 'FAILED', nothingWritten: false }));
    expect(resolved.status).toBe('FAILED'); expect(resolved.idempotency_key).toBe(p.executions[0]!.idempotency_key);
    expect(await status('orders', p.subjectId)).toBe('RECOVERY_REQUIRED');
  });

  it('reconciles a found checkout atomically and refuses a safe retry when a link was saved', async () => {
    const p = await approved(); const args = leaseArgs(p);
    await expiredExecution(p);
    const checkout = { squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/checkout' };
    await app(() => expect(runtime.resolveExecution(db, { ...args, status: 'SUCCEEDED', externalRef: checkout.squareOrderId, nothingWritten: false })).rejects.toThrow(/evidence/));
    const x = await app(() => runtime.resolveExecution(db, { ...args, status: 'SUCCEEDED', externalRef: checkout.squareOrderId, nothingWritten: false, checkout }));
    expect(x.square_order_id).toBe(checkout.squareOrderId);
    expect(await status('orders', p.subjectId)).toBe('PAYMENT_LINK_READY');
    const saved = await approved(); const savedArgs = leaseArgs(saved);
    await app(async () => {
      await runtime.runtimeClaimExecution(db, savedArgs);
      await runtime.saveCheckout(db, { ...savedArgs, ...checkout, squareOrderId: 'sq-' + saved.subjectId, paymentLinkId: 'link-' + saved.subjectId });
    });
    await db.query("update public.action_executions set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [savedArgs.executionId]);
    await app(async () => {
      await runtime.recoverStaleExecutions(db, { businessId: saved.businessId, staleAfterMs: 60_000 });
      await expect(runtime.resolveExecution(db, { ...savedArgs, status: 'QUEUED', nothingWritten: true })).rejects.toThrow(/proved absent/);
      await runtime.resolveExecution(db, { ...savedArgs, status: 'SUCCEEDED', externalRef: 'sq-' + saved.subjectId, nothingWritten: false });
    });
  });
});

describe('checked provider result writes', () => {
  it('saves checkout references on both rows once and refuses changed values, scope and stale workers', async () => {
    const p = await approved(); const args = { ...leaseArgs(p), squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/checkout' };
    await app(async () => {
      await expect(runtime.saveCheckout(db, args)).rejects.toThrow(/LEASE/);
      await runtime.runtimeClaimExecution(db, args);
      for (const change of [{ businessId: 'biz_wrong' }, { workerId: 'other' }, { attempt: 2 }, { url: '' }, { squareOrderId: '' }, { paymentLinkId: '' }])
        await expect(runtime.saveCheckout(db, { ...args, ...change })).rejects.toThrow(/LEASE|SCOPE|RESULT/);
      const first = await runtime.saveCheckout(db, args);
      expect(first.status).toBe('PAYMENT_LINK_READY'); expect(first.link_ready_at).not.toBeNull();
      const before = (await events(p.approvalId)).length;
      expect(await runtime.saveCheckout(db, args)).toEqual(first);
      for (const change of [{ squareOrderId: 'different' }, { paymentLinkId: 'different' }, { url: 'https://example.test/different' }])
        await expect(runtime.saveCheckout(db, { ...args, ...change })).rejects.toThrow(/IDENTITY/);
      expect((await events(p.approvalId)).length).toBe(before);
      await runtime.finishExecution(db, { ...args, status: 'SUCCEEDED', externalRef: args.squareOrderId });
      expect((await runtime.saveCheckout(db, args)).status).toBe('PAYMENT_LINK_READY');
    });
    expect((await db.query('select square_order_id,square_payment_link_id,checkout_url from public.action_executions where id=$1', [args.executionId])).rows[0])
      .toEqual({ square_order_id: args.squareOrderId, square_payment_link_id: args.paymentLinkId, checkout_url: args.url });
  });

  it('verifies a booking with one sync job, refuses a different event and repeats unchanged', async () => {
    const p = await approved('booking_bundle'); const args = { ...leaseArgs(p), googleEventId: 'event-' + uniq() };
    await app(async () => {
      await expect(runtime.verifyBooking(db, args)).rejects.toThrow(/LEASE/);
      await runtime.runtimeClaimExecution(db, args);
      for (const change of [{ businessId: 'biz_wrong' }, { workerId: 'other' }, { attempt: 2 }, { googleEventId: '' }])
        await expect(runtime.verifyBooking(db, { ...args, ...change })).rejects.toThrow(/SCOPE|LEASE|RESULT/);
      const first = await runtime.verifyBooking(db, args);
      expect(first.status).toBe('BOOKED_VERIFIED'); expect(first.google_event_id).toBe(args.googleEventId);
      const before = (await events(p.approvalId)).length;
      expect(await runtime.verifyBooking(db, args)).toEqual(first);
      await expect(runtime.verifyBooking(db, { ...args, googleEventId: 'different' })).rejects.toThrow(/IDENTITY|LEASE/);
      expect((await events(p.approvalId)).length).toBe(before);
    });
    expect((await db.query("select * from public.sync_jobs where record_type='booking' and record_id=$1", [p.subjectId])).rows).toHaveLength(1);
  });

  it('moves only paid orders to fulfillment and repeats without another event', async () => {
    const p = await pending();
    await app(async () => {
      await expect(runtime.fulfillOrder(db, { businessId: 'biz_wrong', orderId: p.subjectId })).rejects.toThrow(/SCOPE/);
      await expect(runtime.fulfillOrder(db, { businessId: p.businessId, orderId: p.subjectId })).rejects.toThrow(/paid order/);
      await runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), ...evidence(p) });
      expect((await runtime.fulfillOrder(db, { businessId: p.businessId, orderId: p.subjectId })).status).toBe('FULFILLMENT_READY');
      const before = (await events(p.approvalId)).length;
      await runtime.fulfillOrder(db, { businessId: p.businessId, orderId: p.subjectId });
      expect((await events(p.approvalId)).length).toBe(before);
    });
  });

  it('renews and recovers sync jobs by deadline with attempt fencing and a retained key', async () => {
    const p = await pending();
    const paid = await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), ...evidence(p) }));
    const args = { businessId: p.businessId, syncJobId: paid.syncJob.id, workerId: 'worker', attempt: 1 };
    await app(async () => {
      await runtime.claimSyncJob(db, args);
      for (const change of [{ businessId: 'biz_wrong' }, { workerId: 'other' }, { attempt: 2 }, { durationMs: 1 }])
        await expect(runtime.renewSyncLease(db, { ...args, durationMs: 900_000, ...change })).rejects.toThrow(/SCOPE|LEASE/);
      await runtime.renewSyncLease(db, { ...args, durationMs: 900_000 });
      expect(await runtime.recoverStaleSyncJobs(db, { businessId: p.businessId })).toEqual([]);
      expect(await runtime.recoverStaleSyncJobs(db, { businessId: 'biz_wrong' })).toEqual([]);
    });
    await db.query("update public.sync_jobs set locked_at=clock_timestamp(),lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [args.syncJobId]);
    await app(async () => {
      await expect(runtime.renewSyncLease(db, { ...args, durationMs: 900_000 })).rejects.toThrow(/LEASE/);
      await expect(runtime.finishSyncJob(db, { ...args, state: 'DONE', externalRef: 'late' })).rejects.toThrow(/LEASE/);
      const moved = await runtime.recoverStaleSyncJobs(db, { businessId: p.businessId });
      expect(moved.map(j => [j.state,j.idempotency_key,j.attempts])).toEqual([['RETRYING',paid.syncJob.idempotency_key,1]]);
      expect(await runtime.recoverStaleSyncJobs(db, { businessId: p.businessId })).toEqual([]);
      const second = await runtime.claimSyncJob(db, { ...args, workerId: 'replacement' });
      expect(second?.attempts).toBe(2);
      await expect(runtime.finishSyncJob(db, { ...args, state: 'DONE', externalRef: 'late' })).rejects.toThrow(/LEASE/);
      await runtime.finishSyncJob(db, { ...args, workerId: 'replacement', attempt: 2, state: 'DONE', externalRef: 'found-row' });
      expect(await runtime.recoverStaleSyncJobs(db, { businessId: p.businessId })).toEqual([]);
    });
    expect(await status('orders', p.subjectId)).toBe('PAID_VERIFIED');
  });
});

async function factProposal(options: { fromVersion?: number; value?: unknown; before?: unknown; after?: unknown; owner?: Awaited<ReturnType<typeof createOwner>>; key?: string } = {}) {
  const owner = options.owner ?? await createOwner(db);
  const fromVersion = options.fromVersion ?? 0;
  const after = options.after ?? { text: 'New hours' };
  const value = options.value ?? (fromVersion === 0 ? after : { text: 'Old hours' });
  const fact = await insert(db, 'business_facts', { business_id: owner.businessId, kind: 'hours', key: options.key ?? 'fri', value,
    source_type: 'owner_ui', ...(fromVersion > 0 ? { status: 'verified', verified_at: new Date(), verified_by: owner.userId, version: fromVersion } : {}) });
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const payload = { businessId: owner.businessId, subjectId: String(fact.id), kind: 'hours', key: fact.key,
    fromVersion, before: options.before ?? (fromVersion === 0 ? null : value), after, actionBundle: ['local.fact.update'], expiresAt };
  const canonical = JSON.stringify(payload);
  return { owner, fact, args: { businessId: owner.businessId, subjectId: String(fact.id), bundleType: 'fact_edit' as const,
    actorType: 'owner' as const, actorId: owner.userId, payload, canonical, payloadHash: hash(canonical), actionBundle: ['local.fact.update'], expiresAt } };
}
async function approveFact(p: Awaited<ReturnType<typeof factProposal>>) {
  const a = await app(() => runtime.createApproval(db, p.args));
  const result = await app(() => runtime.runtimeDecideAndEnqueue(db, { businessId: p.owner.businessId, approvalId: a.id,
    ownerUserId: p.owner.userId, payloadHash: a.payload_hash, decision: 'APPROVED' }));
  return { ...p, ...result, lease: { businessId: p.owner.businessId, executionId: result.executions[0]!.id, workerId: 'fact-worker', attempt: 1 } };
}

describe('new and existing fact keys', () => {
  it('promotes the approved draft as version 1 and completes its local step atomically', async () => {
    const p = await approveFact(await factProposal());
    await app(async () => {
      await runtime.runtimeClaimExecution(db, p.lease);
      for (const change of [{ businessId: 'biz_wrong' }, { workerId: 'other' }, { attempt: 2 }])
        await expect(runtime.applyFactUpdate(db, { ...p.lease, ...change })).rejects.toThrow(/SCOPE|LEASE/);
      const fact = await runtime.applyFactUpdate(db, p.lease);
      expect(fact).toMatchObject({ id: p.fact.id, status: 'verified', version: 1, value: p.args.payload.after });
      await expect(runtime.applyFactUpdate(db, p.lease)).rejects.toThrow(/LEASE/);
    });
    expect((await db.query('select status from public.action_executions where id=$1', [p.lease.executionId])).rows[0]).toEqual({ status: 'SUCCEEDED' });
    const changed = (await events(p.approval.id)).filter(e => e.type === 'fact.changed');
    expect(changed).toHaveLength(1); expect(changed[0]?.payload).toMatchObject({ fromVersion: 0, toVersion: 1 });
  });

  it('supersedes an existing verified fact and creates the approved next version', async () => {
    const p = await approveFact(await factProposal({ fromVersion: 1 }));
    await app(async () => {
      await runtime.runtimeClaimExecution(db, p.lease);
      expect(await runtime.applyFactUpdate(db, p.lease)).toMatchObject({ status: 'verified', version: 2, value: p.args.payload.after, supersedes_id: p.fact.id });
    });
    expect((await db.query('select status from public.business_facts where id=$1', [p.fact.id])).rows[0]).toEqual({ status: 'superseded' });
  });

  for (const [name, options] of [
    ['wrong draft value', { value: { text: 'Other hours' } }],
    ['non-null before for a new key', { before: { text: 'Old hours' } }],
    ['draft used as an existing version', { fromVersion: 0, before: { text: 'Old hours' } }],
  ] as const) it(`refuses ${name}`, async () => {
    const p = await factProposal(options);
    await app(() => expect(runtime.createApproval(db, p.args)).rejects.toThrow(/SUBJECT/));
  });

  it('refuses a new-key proposal when the key already has a verified fact', async () => {
    const owner = await createOwner(db);
    await factProposal({ owner, fromVersion: 1 });
    const p = await factProposal({ owner });
    await app(() => expect(runtime.createApproval(db, p.args)).rejects.toThrow(/SUBJECT/));
  });

  it('refuses the wrong before value or version on an existing verified key', async () => {
    const p = await factProposal({ fromVersion: 1 });
    for (const change of [{ before: { text: 'Wrong' } }, { fromVersion: 2 }]) {
      const payload = { ...p.args.payload, ...change }; const canonical = JSON.stringify(payload);
      await app(() => expect(runtime.createApproval(db, { ...p.args, payload, canonical, payloadHash: hash(canonical) })).rejects.toThrow(/SUBJECT/));
    }
  });

  it('refuses a draft from another business even with re-signed scope', async () => {
    const p = await factProposal(); const other = await createOwner(db);
    const payload = { ...p.args.payload, businessId: other.businessId }; const canonical = JSON.stringify(payload);
    await app(() => expect(runtime.createApproval(db, { ...p.args, businessId: other.businessId, actorId: other.userId,
      payload, canonical, payloadHash: hash(canonical) })).rejects.toThrow(/SUBJECT/));
  });

  it('allows two new-key proposals but never two verified rows after either approved draft wins', async () => {
    const owner = await createOwner(db);
    const a = await approveFact(await factProposal({ owner }));
    const b = await approveFact(await factProposal({ owner }));
    await app(async () => {
      await runtime.runtimeClaimExecution(db, a.lease);
      await runtime.runtimeClaimExecution(db, b.lease);
      await runtime.applyFactUpdate(db, a.lease);
      await expect(runtime.applyFactUpdate(db, b.lease)).rejects.toThrow(/SUBJECT/);
    });
    expect((await db.query("select id,version from public.business_facts where business_id=$1 and kind='hours' and key='fri' and status='verified'", [owner.businessId])).rows)
      .toEqual([{ id: a.fact.id, version: 1 }]);
    const c = await factProposal({ owner });
    await app(() => expect(runtime.createApproval(db, c.args)).rejects.toThrow(/SUBJECT/));
  });
});

it('cannot fake definer authority from a runtime session using SET ROLE or caller settings', async () => {
  const p = await pending();
  await db.exec('set session authorization abos_app');
  try {
    await expect(db.exec('set role supabase_postgres')).rejects.toMatchObject({ code: '42501' });
    await db.query("select set_config('app.in_definer','true',false)");
    await expect(db.query("update public.orders set square_payment_id='forged' where id=$1", [p.subjectId])).rejects.toThrow(/protected/);
  } finally { await db.exec('set session authorization postgres; reset role'); }
});

it('revokes API execution for every new entry point and internal helper, including anon', async () => {
  const q = await db.query<{ proname: string; app: boolean; svc: boolean; auth: boolean; anon: boolean; pub: boolean; prosecdef: boolean; proconfig: string[] }>(`
    select p.proname,p.prosecdef,p.proconfig,has_function_privilege('abos_app',p.oid,'execute') app,
      has_function_privilege('service_role',p.oid,'execute') svc,has_function_privilege('authenticated',p.oid,'execute') auth,
      has_function_privilege('anon',p.oid,'execute') anon,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') pub
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and proname in
    ('mark_order_paid','mark_order_payment_failed','recover_stale_executions','save_checkout','fulfill_order','verify_booking',
      'renew_execution_lease','resolve_execution','renew_sync_lease','recover_stale_sync_jobs','apply_fact_update',
      'journey','subject_event','orders_transition','orders_runtime_guard','bookings_transition','bookings_runtime_guard','check_payment','insert_receipt','apply_booking')`);
  expect(q.rows).toHaveLength(20);
  const internal = ['journey','subject_event','orders_transition','orders_runtime_guard','bookings_transition','bookings_runtime_guard','check_payment','insert_receipt','apply_booking'];
  for (const r of q.rows) {
    expect(r).toMatchObject({ app: !internal.includes(r.proname), svc: false, auth: false, anon: false, pub: false, proconfig: ['search_path=""'] });
    if (r.app) expect(r.prosecdef).toBe(true);
  }
});

it('upgrades populated 0004 with a legacy APPROVED running checkout using only allowed intermediate moves', async () => {
  const fresh = await createSupabaseLikeDb();
  try {
    await fresh.exec('set role supabase_postgres');
    await applyMigrations(migrationDb(fresh), readMigrations().slice(0, 4));
    await fresh.exec('reset role');
    const owner = await createOwner(fresh); const order = await createOrder(fresh, owner);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const payload = { businessId: owner.businessId, subjectId: String(order.id), agentVersionId: owner.agentVersionId,
      cartHash: order.cart_hash, totalMinor: 1200, currency: 'USD', pickupAt: null, messageRecipient: '+15555550123',
      messageChannel: 'surge', actionBundle: ORDER_BUNDLE, expiresAt };
    const canonical = JSON.stringify(payload);
    await fresh.exec('set role abos_app');
    const approval = await runtime.createApproval(fresh, { businessId: owner.businessId, subjectId: String(order.id), bundleType: 'order_bundle',
      actorType: 'owner', actorId: owner.userId, payload, canonical, payloadHash: hash(canonical), actionBundle: ORDER_BUNDLE, expiresAt });
    const decided = await runtime.runtimeDecideAndEnqueue(fresh, { businessId: owner.businessId, approvalId: approval.id, ownerUserId: owner.userId,
      payloadHash: approval.payload_hash, decision: 'APPROVED' });
    await runtime.runtimeClaimExecution(fresh, { businessId: owner.businessId, executionId: decided.executions[0]!.id, workerId: 'legacy' });
    await fresh.exec('reset role');
    await fresh.query("update public.action_executions set locked_at=clock_timestamp()-interval '1 hour' where id=$1", [decided.executions[0]!.id]);
    const originalChecksums = (await fresh.query('select name,checksum from public.schema_migrations order by name')).rows;
    await fresh.exec('set role supabase_postgres');
    const result = await applyMigrations(migrationDb(fresh));
    expect(result.applied).toEqual(['0005_payments_and_stale_leases.sql', '0006_ownership_material_and_receipts.sql', '0007_agentphone_channel.sql', '0008_owner_recovery.sql']);
    await fresh.exec('reset role');
    expect((await fresh.query('select name,checksum from public.schema_migrations order by name limit 4')).rows).toEqual(originalChecksums);
    await fresh.exec('set role abos_app');
    expect((await runtime.recoverStaleExecutions(fresh, { businessId: owner.businessId, staleAfterMs: 60_000 })).map(x => x.status)).toEqual(['NEEDS_REVIEW']);
    await fresh.exec('reset role');
    const rows = (await fresh.query<{ payload: { from: typeof ORDER_MACHINE.states[number]; to: typeof ORDER_MACHINE.states[number] } }>(
      "select payload from public.activity_events where type='order.status_changed' and correlation_id=$1 order by occurred_at,id", [owner.callId])).rows;
    expect(rows.map(r => [r.payload.from,r.payload.to])).toEqual([['APPROVED','CREATING_CHECKOUT'],['CREATING_CHECKOUT','RECOVERY_REQUIRED']]);
    for (const r of rows) expect(canTransition('order', r.payload.from, r.payload.to)).toBe(true);
    const audit = (await fresh.query<{ payload: Record<string, unknown> }>("select payload from public.activity_events where type='execution.failed' and correlation_id=$1", [owner.callId])).rows;
    expect(audit).toHaveLength(1); expect(audit[0]?.payload.nextStatus).toBe('NEEDS_REVIEW');
  } finally { await fresh.close(); }
}, 60_000);

it('writes full rejection and expiry payloads with call correlation and nullable booking fallback', async () => {
  for (const type of ['order_bundle','booking_bundle'] as const) {
    const rejected = await approved(type, 'REJECTED');
    const rows = (await db.query<{ correlation_id: string }>('select correlation_id from public.activity_events where business_id=$1', [rejected.businessId])).rows;
    expect(rows).toHaveLength(2); expect(rows.every(r => r.correlation_id === rejected.owner.callId)).toBe(true);
    const pending = await approved(type, 'PENDING', 500);
    await db.query('select pg_sleep(0.55)');
    await app(() => runtime.runtimeExpireApprovals(db, pending.businessId));
    const expired = (await db.query<{ correlation_id: string }>('select correlation_id from public.activity_events where business_id=$1', [pending.businessId])).rows;
    expect(expired).toHaveLength(2); expect(expired.every(r => r.correlation_id === pending.owner.callId)).toBe(true);
  }
  const nullable = await approved('booking_bundle', 'PENDING', 500);
  await db.query('update public.bookings set call_id=null where id=$1', [nullable.subjectId]);
  await db.query('select pg_sleep(0.55)');
  await app(() => runtime.runtimeExpireApprovals(db, nullable.businessId));
  expect((await db.query<{ correlation_id: string }>('select correlation_id from public.activity_events where business_id=$1', [nullable.businessId])).rows.every(r => r.correlation_id === nullable.approvalId)).toBe(true);
});

it('marks a sync lease on its fifth attempt FAILED and audits the final result', async () => {
  const p = await pending();
  const paid = await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), ...evidence(p) }));
  const args = { businessId: p.businessId, syncJobId: paid.syncJob.id, workerId: 'worker' };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await app(() => runtime.claimSyncJob(db, args));
    if (attempt < 5) await app(() => runtime.finishSyncJob(db, { ...args, attempt, state: 'RETRYING', retryAt: new Date(0) }));
  }
  await db.query("update public.sync_jobs set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [args.syncJobId]);
  const moved = await app(() => runtime.recoverStaleSyncJobs(db, { businessId: p.businessId }));
  expect(moved.map(j => [j.state,j.attempts,j.idempotency_key])).toEqual([['FAILED',5,paid.syncJob.idempotency_key]]);
  expect((await events(p.approvalId)).filter(e => e.type === 'sync.failed').at(-1)?.payload).toMatchObject({ attempts: 5, final: true });
  expect(await status('orders', p.subjectId)).toBe('PAID_VERIFIED');
});

it('reconciles an unknown message after local recording has already started without rerunning the send', async () => {
  const p = await pending();
  const message = { businessId: p.businessId, executionId: p.executions[1]!.id, workerId: 'message-worker', attempt: 1 };
  const dispatch = await app(async () => {
    await runtime.runtimeClaimExecution(db, message);
    const d = await runtime.recordDispatch(db, { ...message, bodyHash: hash('message') });
    await runtime.updateDispatch(db, { ...message, dispatchId: d.id, status: 'UNKNOWN' });
    return d;
  });
  await db.query("update public.action_executions set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [message.executionId]);
  await app(async () => {
    await runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 });
    await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: p.executions[2]!.id, workerId: 'local-worker' });
    await expect(runtime.resolveExecution(db, { ...message, status: 'QUEUED', nothingWritten: true })).rejects.toThrow(/PREDECESSOR/);
    const resolved = await runtime.resolveExecution(db, { ...message, status: 'SUCCEEDED', externalRef: 'found-message-' + uniq(), nothingWritten: false });
    expect(resolved.status).toBe('SUCCEEDED');
    expect(resolved.idempotency_key).toBe(p.executions[1]!.idempotency_key);
  });
  expect((await db.query('select status from public.message_dispatches where id=$1', [dispatch.id])).rows[0]).toEqual({ status: 'SENT' });
  expect(await status('orders', p.subjectId)).toBe('PAYMENT_PENDING');
});

it('rolls back 0005 atomically when populated 0004 has duplicate payment IDs', async () => {
  const fresh = await createSupabaseLikeDb();
  try {
    await fresh.exec('set role supabase_postgres');
    await applyMigrations(migrationDb(fresh), readMigrations().slice(0, 4));
    await fresh.exec('reset role');
    const owner = await createOwner(fresh);
    await createOrder(fresh, owner, { square_payment_id: 'duplicate' });
    await createOrder(fresh, owner, { square_payment_id: 'duplicate' });
    await fresh.exec('set role supabase_postgres');
    await expect(applyMigrations(migrationDb(fresh))).rejects.toThrow(/0005.*rolled back/);
    expect((await fresh.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='agents' and column_name='spec_revision'")).rows[0]).toEqual({ n: 0 });
    expect((await fresh.query("select to_regclass('public.payment_receipts') t")).rows[0]).toEqual({ t: null });
    expect((await fresh.query('select name from public.schema_migrations order by name')).rows).toHaveLength(4);
  } finally { await fresh.close(); }
}, 60_000);

it('parses all routine-written event rows with activityEventFromRow and validates every subject transition and journey correlation', async () => {
  // This database contains only routine-written events, including decision, expiry, recovery and owner edits.
  const rows = (await db.query<{ id: string; occurred_at: Date; [key: string]: unknown }>('select * from public.activity_events order by occurred_at,id')).rows;
  expect(rows.length).toBeGreaterThan(100);
  const types = new Set<string>();
  for (const row of rows) {
    const parsed = activityEventFromRow({ ...row, occurred_at: row.occurred_at.toISOString() });
    types.add(parsed.type);
    if (parsed.type === 'order.status_changed' && parsed.payload.from) {
      expect(canTransition('order', parsed.payload.from as typeof ORDER_MACHINE.states[number], parsed.payload.to as typeof ORDER_MACHINE.states[number]), row.id).toBe(true);
      expect(parsed.correlationId).toBe(parsed.payload.callId);
    } else if (parsed.type === 'booking.status_changed' && parsed.payload.from) {
      expect(canTransition('booking', parsed.payload.from as typeof BOOKING_MACHINE.states[number], parsed.payload.to as typeof BOOKING_MACHINE.states[number]), row.id).toBe(true);
      if (parsed.payload.callId) expect(parsed.correlationId).toBe(parsed.payload.callId);
    }
    if (parsed.type === 'fact.changed') expect(parsed.correlationId).toMatch(/^apv_/);
  }
  for (const type of ['approval.decided','approval.expired','order.status_changed','booking.status_changed','checkout.created','booking.verified','payment.verified','payment.failed','execution.failed','execution.succeeded','sync.queued','sync.failed','fact.changed'])
    expect(types.has(type), type).toBe(true);
});
