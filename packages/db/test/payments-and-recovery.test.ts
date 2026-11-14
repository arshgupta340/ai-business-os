// Migration 0005: agents.spec_revision, checked payment outcomes and stale lease recovery, run as abos_app.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  BOOKING_BUNDLE, ORDER_BUNDLE, createBooking, createMigratedDb, createOrder, createOwner, createSupabaseLikeDb,
  migrateAsSupabaseOwner, uniq,
} from './helpers';
import { readMigrations } from '../src/migrate';
import * as runtime from '../src/runtime';

let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); }, 60_000);
afterAll(async () => { await db.close(); });
const hash = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
async function app<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('set role abos_app');
  try { return await fn(); } finally { await db.exec('reset role'); }
}

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
      actorType: 'owner', actorId: owner.userId, payload, canonical, payloadHash: hash(canonical), actionBundle, expiresAt });
    const d = await runtime.runtimeDecideAndEnqueue(db, { businessId: owner.businessId, approvalId: a.id, ownerUserId: owner.userId,
      payloadHash: a.payload_hash, decision: 'APPROVED' });
    return { owner, businessId: owner.businessId, subjectId: String(subject.id), approvalId: a.id, executions: d.executions };
  });
}

/** An approved order whose checkout ran: PAYMENT_PENDING with its Square references. */
async function pending() {
  const p = await approved();
  await app(() => db.query(`update public.orders set status='PAYMENT_PENDING',square_order_id='sq-'||id,
    square_payment_link_id='link-'||id,checkout_url='https://example.test/checkout' where id=$1`, [p.subjectId]));
  return p;
}
const status = async (table: string, id: string) =>
  (await db.query<{ status: string }>(`select status from public.${table} where id=$1`, [id])).rows[0]!.status;
const events = async (correlationId: string) =>
  (await db.query<{ type: string; actor_type: string; payload: Record<string, unknown> }>(
    'select type,actor_type,payload from public.activity_events where correlation_id=$1 order by occurred_at,id', [correlationId])).rows;
const syncCount = async (id: string) =>
  (await db.query<{ n: number }>("select count(*)::int n from public.sync_jobs where record_type='order' and record_id=$1", [id])).rows[0]!.n;

describe('0005 migration', () => {
  it('applies the full set cleanly from empty as the non-superuser owner', async () => {
    const fresh = await createSupabaseLikeDb();
    try {
      await migrateAsSupabaseOwner(fresh);
      const q = await fresh.query<{ name: string }>('select name from public.schema_migrations order by name');
      expect(q.rows.map(r => r.name)).toEqual(readMigrations().map(f => f.name));
      expect(q.rows.at(-1)?.name).toBe('0005_payments_and_stale_leases.sql');
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
    const r = await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }));
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
    const args = { businessId: p.businessId, orderId: p.subjectId, paymentId, amountMinor: 1200, currency: 'USD' };
    const first = await app(() => runtime.markOrderPaid(db, args));
    const before = (await events(p.approvalId)).length;
    expect(await app(() => runtime.markOrderPaid(db, args))).toEqual(first);
    expect((await events(p.approvalId)).length).toBe(before);
    expect(await syncCount(p.subjectId)).toBe(1);
    await app(() => db.query("update public.orders set status='FULFILLMENT_READY' where id=$1", [p.subjectId]));
    const again = await app(() => runtime.markOrderPaid(db, args));
    expect(again.order.status).toBe('FULFILLMENT_READY'); expect(again.syncJob.id).toBe(first.syncJob.id);
    expect((await events(p.approvalId)).length).toBe(before);
  });

  it('refuses a different payment ID on an already paid order and changes nothing', async () => {
    const p = await pending(); const paymentId = 'pay-' + uniq();
    await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId, amountMinor: 1200, currency: 'USD' }));
    await app(() => expect(runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'other-' + uniq(), amountMinor: 1200, currency: 'USD' }))
      .rejects.toThrow(/IDENTITY: order already paid/));
    expect((await db.query('select square_payment_id from public.orders where id=$1', [p.subjectId])).rows[0]).toEqual({ square_payment_id: paymentId });
  });

  it('refuses a payment ID already recorded on another order', async () => {
    const a = await pending(); const b = await pending(); const paymentId = 'pay-' + uniq();
    await app(() => runtime.markOrderPaid(db, { businessId: a.businessId, orderId: a.subjectId, paymentId, amountMinor: 1200, currency: 'USD' }));
    await app(() => expect(runtime.markOrderPaid(db, { businessId: b.businessId, orderId: b.subjectId, paymentId, amountMinor: 1200, currency: 'USD' }))
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
    await app(() => expect(runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD', ...change }))
      .rejects.toThrow(pattern));
    expect(await status('orders', p.subjectId)).toBe('PAYMENT_PENDING');
    expect((await events(p.approvalId)).length).toBe(before);
    expect(await syncCount(p.subjectId)).toBe(0);
  });

  it('refuses another business even with that business ID and a real order of its own', async () => {
    const p = await pending(); const other = await pending();
    await app(() => expect(runtime.markOrderPaid(db, { businessId: other.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }))
      .rejects.toThrow(/SCOPE/));
    expect(await status('orders', p.subjectId)).toBe('PAYMENT_PENDING');
  });

  for (const state of ['APPROVED', 'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'MESSAGE_SENT', 'CANCELLED', 'RECOVERY_REQUIRED'])
    it(`refuses an order in ${state}`, async () => {
      const p = await pending();
      await app(() => db.query('update public.orders set status=$2 where id=$1', [p.subjectId, state]));
      await app(() => expect(runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }))
        .rejects.toThrow(/SUBJECT: order requires/));
      expect(await status('orders', p.subjectId)).toBe(state);
      expect(await syncCount(p.subjectId)).toBe(0);
    });

  it('refuses an order with no approval', async () => {
    const o = await createOwner(db); const order = await createOrder(db, o);
    await app(() => expect(runtime.markOrderPaid(db, { businessId: o.businessId, orderId: String(order.id), paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }))
      .rejects.toThrow(/SUBJECT/));
  });

  it('pays an order after a failed payment (failed then paid)', async () => {
    const p = await pending();
    await app(() => runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'declined-' + uniq(), reason: 'FAILED' }));
    const r = await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }));
    expect(r.order.status).toBe('PAID_VERIFIED');
    const changed = (await events(p.approvalId)).filter(e => e.type === 'order.status_changed').map(e => [e.payload.from, e.payload.to]);
    expect(changed.slice(-2)).toEqual([['PAYMENT_PENDING', 'PAYMENT_FAILED'], ['PAYMENT_FAILED', 'PAID_VERIFIED']]);
  });
});

describe('mark_order_payment_failed', () => {
  it('moves PAYMENT_PENDING to PAYMENT_FAILED with its audit, and a repeat changes nothing', async () => {
    const p = await pending(); const args = { businessId: p.businessId, orderId: p.subjectId, paymentId: 'declined-' + uniq(), reason: 'CANCELED' };
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

  it('never moves a paid order backwards', async () => {
    const p = await pending();
    await app(() => runtime.markOrderPaid(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'pay-' + uniq(), amountMinor: 1200, currency: 'USD' }));
    await app(() => expect(runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'late-' + uniq(), reason: 'FAILED' }))
      .rejects.toThrow(/SUBJECT: order requires PAYMENT_PENDING/));
    expect(await status('orders', p.subjectId)).toBe('PAID_VERIFIED');
  });

  it('refuses the wrong business, other states and a missing reason', async () => {
    const p = await pending();
    await app(async () => {
      await expect(runtime.markOrderPaymentFailed(db, { businessId: 'biz_other', orderId: p.subjectId, paymentId: 'x', reason: 'FAILED' })).rejects.toThrow(/SCOPE/);
      await expect(runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'x', reason: '' })).rejects.toThrow(/PAYMENT: reason/);
      await db.query("update public.orders set status='MESSAGE_SENT' where id=$1", [p.subjectId]);
      await expect(runtime.markOrderPaymentFailed(db, { businessId: p.businessId, orderId: p.subjectId, paymentId: 'x', reason: 'FAILED' })).rejects.toThrow(/SUBJECT/);
    });
    expect(await status('orders', p.subjectId)).toBe('MESSAGE_SENT');
  });
});

describe('recover_stale_executions', () => {
  const FIFTEEN_MIN = 15 * 60_000;
  /** Ages a lease as the owner; abos_app cannot write action_executions. */
  const age = (id: string, minutes: number) =>
    db.query(`update public.action_executions set locked_at=clock_timestamp()-($2::int*interval '1 minute') where id=$1`, [id, minutes]);

  it('moves a stale checkout step to NEEDS_REVIEW, the order to RECOVERY_REQUIRED, and never requeues', async () => {
    const p = await approved(); const step = p.executions[0]!;
    await app(async () => {
      await db.query("update public.orders set status='CREATING_CHECKOUT' where id=$1", [p.subjectId]);
      expect((await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: step.id, workerId: 'dead' }))?.status).toBe('RUNNING');
    });
    await age(step.id, 20);
    const moved = await app(() => runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: FIFTEEN_MIN }));
    expect(moved.map(x => [x.id, x.status, x.locked_by, x.idempotency_key, x.attempts])).toEqual([[step.id, 'NEEDS_REVIEW', null, step.idempotency_key, 1]]);
    expect(await status('orders', p.subjectId)).toBe('RECOVERY_REQUIRED');
    expect((await events(p.approvalId)).at(-1)).toEqual({ type: 'order.status_changed', actor_type: 'system',
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
    await age(stale.executions[0]!.id, 20); await age(fresh.executions[0]!.id, 5); await age(other.executions[0]!.id, 20);
    const moved = await app(() => runtime.recoverStaleExecutions(db, { businessId: stale.businessId, staleAfterMs: FIFTEEN_MIN }));
    expect(moved.map(x => x.id)).toEqual([stale.executions[0]!.id]);
    expect(await status('bookings', stale.subjectId)).toBe('RETRY_REQUIRED');
    const states = async (p: typeof stale) => (await db.query<{ status: string }>('select status from public.action_executions where approval_id=$1 order by step_index', [p.approvalId])).rows.map(r => r.status);
    expect(await states(stale)).toEqual(['NEEDS_REVIEW', 'QUEUED', 'QUEUED']);
    expect(await states(fresh)).toEqual(['RUNNING', 'QUEUED', 'QUEUED']);
    expect(await states(other)).toEqual(['RUNNING', 'QUEUED', 'QUEUED']);
    expect(await status('orders', other.subjectId)).toBe('APPROVED');
    expect(await app(() => runtime.recoverStaleExecutions(db, { businessId: fresh.businessId, staleAfterMs: FIFTEEN_MIN }))).toEqual([]);
  });

  it('lets local recording run after a stale message step, without moving the subject', async () => {
    const p = await approved();
    await app(async () => {
      await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w' });
      await runtime.finishExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1, status: 'SUCCEEDED', externalRef: 'sq-order' });
      await db.query("update public.orders set status='PAYMENT_LINK_READY',square_order_id='sq-'||id,square_payment_link_id='link-'||id,checkout_url='https://example.test/c' where id=$1", [p.subjectId]);
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
