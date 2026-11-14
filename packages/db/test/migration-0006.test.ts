// Migration 0006: ownership and subject material guards, saved checkout references, service_role
// revokes, webhook and delivery receipt routines and the runtime role check. Runs on local PGlite as abos_app.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { BOOKING_BUNDLE, ORDER_BUNDLE, createBooking, createMigratedDb, createOrder, createOwner, createSupabaseLikeDb, insert, migrationDb, uniq } from './helpers';
import { applyMigrations, readMigrations } from '../src/migrate';
import { seedDatabase, type AuthAdmin, type SeedDb, type SeedEnv } from '../src/seed';
import * as runtime from '../src/runtime';

let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); }, 60_000);
afterAll(async () => { await db.close(); });
const hash = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
async function as<T>(target: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await target.exec(`set role ${role}`);
  try { return await fn(); } finally { await target.exec('reset role'); }
}
const app = <T>(fn: () => Promise<T>) => as(db, 'abos_app', fn);

async function approvedOn(target: PGlite, type: 'order_bundle' | 'booking_bundle' = 'order_bundle', decide = true) {
  const owner = await createOwner(target);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const subject = type === 'order_bundle' ? await createOrder(target, owner) : await createBooking(target, owner, { call_id: owner.callId });
  const actionBundle = type === 'order_bundle' ? ORDER_BUNDLE : BOOKING_BUNDLE;
  const fields = type === 'order_bundle'
    ? { agentVersionId: owner.agentVersionId, cartHash: subject.cart_hash, totalMinor: 1200, currency: 'USD', pickupAt: null }
    : { agentVersionId: owner.agentVersionId, serviceId: subject.service_id, calendarId: subject.calendar_id,
        startUtc: (subject.start_utc as Date).toISOString(), endUtc: (subject.end_utc as Date).toISOString(), timezone: subject.timezone };
  const payload = { businessId: owner.businessId, subjectId: String(subject.id), ...fields,
    messageRecipient: '+15555550123', messageChannel: 'surge', actionBundle, expiresAt };
  const canonical = JSON.stringify(payload);
  return as(target, 'abos_app', async () => {
    const a = await runtime.createApproval(target, { businessId: owner.businessId, bundleType: type, subjectId: String(subject.id),
      actorType: 'deployed_agent', actorId: owner.agentVersionId, payload, canonical, payloadHash: hash(canonical), actionBundle, expiresAt });
    const executions = decide ? (await runtime.runtimeDecideAndEnqueue(target, { businessId: owner.businessId, approvalId: a.id,
      ownerUserId: owner.userId, payloadHash: a.payload_hash, decision: 'APPROVED' })).executions : [];
    return { owner, businessId: owner.businessId, subjectId: String(subject.id), approvalId: a.id, executions };
  });
}
/** An approved order whose checkout and message steps both finished; returns the SENT dispatch. */
async function sentOn(target: PGlite) {
  const p = await approvedOn(target);
  const checkout = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
  const message = { businessId: p.businessId, executionId: p.executions[1]!.id, workerId: 'm', attempt: 1 };
  const providerId = 'pm-' + uniq();
  const dispatch = await as(target, 'abos_app', async () => {
    await runtime.runtimeClaimExecution(target, checkout);
    await runtime.saveCheckout(target, { ...checkout, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
    await runtime.finishExecution(target, { ...checkout, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
    await runtime.runtimeClaimExecution(target, message);
    const d = await runtime.recordDispatch(target, { ...message, bodyHash: hash('body') });
    await runtime.updateDispatch(target, { ...message, dispatchId: d.id, status: 'SENT', providerMessageId: providerId });
    await runtime.finishExecution(target, { ...message, status: 'SUCCEEDED', externalRef: providerId });
    return d;
  });
  return { ...p, dispatchId: dispatch.id, providerId };
}
const one = async (sql: string, args: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, args)).rows[0];

describe('ownership: businesses and users', () => {
  it('refuses an owner, ID or creation-time change and keeps the server profile update working', async () => {
    const o = await createOwner(db); const other = await createOwner(db);
    await app(async () => {
      for (const sql of ['update public.businesses set owner_id=$2 where id=$1', "update public.businesses set id=id||'x' where id=$1 and $2::text is not null",
        'update public.businesses set created_at=now()-interval \'1 day\' where id=$1 and $2::text is not null',
        'with x as (update public.businesses set owner_id=$2 where id=$1 returning 1) select * from x'])
        await expect(db.query(sql, [o.businessId, other.userId]), sql).rejects.toThrow(/protected ownership/);
      // The exact updateBusiness statement in apps/server/src/api/routes.ts.
      const r = await db.query<{ name: string; owner_id: string }>(`update public.businesses set name = coalesce($3, name), contact = coalesce($4::jsonb, contact),
        settings = coalesce($5::jsonb, settings) where id = $1 and owner_id = $2 returning *`, [o.businessId, o.userId, 'Renamed', '{"phone":"+15555550100"}', '{"a":1}']);
      expect(r.rows[0]).toMatchObject({ name: 'Renamed', owner_id: o.userId });
    });
    expect(await one('select owner_id from public.businesses where id=$1', [o.businessId])).toEqual({ owner_id: o.userId });
  });

  it('refuses creating a business or user, and any users write, by permission', async () => {
    const o = await createOwner(db);
    await app(async () => {
      await expect(db.query("insert into public.businesses(owner_id,name,category,timezone) values($1,'Mine','salon','UTC')", [o.userId])).rejects.toMatchObject({ code: '42501' });
      await expect(db.query("insert into public.users(auth_user_id,email) values($1,'x@example.test')", [randomUUID()])).rejects.toMatchObject({ code: '42501' });
      for (const sql of ['update public.users set auth_user_id=gen_random_uuid() where id=$1', "update public.users set display_name='x' where id=$1",
        "insert into public.users select * from public.users where id=$1 on conflict (id) do update set role='admin'"])
        await expect(db.query(sql, [o.userId]), sql).rejects.toMatchObject({ code: '42501' });
      expect((await db.query('select id from public.users where id=$1', [o.userId])).rows).toHaveLength(1);
    });
    // The decision routine still finds the unchanged owner.
    const p = await approvedOn(db);
    expect(p.executions).toHaveLength(3);
  });

  it('keeps identity columns frozen by trigger even if the grants were ever restored', async () => {
    const o = await createOwner(db);
    await db.exec('begin');
    try {
      await db.exec('set local role supabase_postgres');
      await db.exec('grant insert, update on public.users, public.businesses to abos_app');
      await db.exec("create policy t_ins_u on public.users for insert to abos_app with check (true); create policy t_upd_u on public.users for update to abos_app using (true) with check (true); create policy t_ins_b on public.businesses for insert to abos_app with check (true)");
      await db.exec('set local role abos_app');
      await db.exec('savepoint s');
      for (const [sql, args, re] of [
        ['update public.users set auth_user_id=$2 where id=$1', [o.userId, randomUUID()], /protected identity/],
        ["update public.users set email='new@example.test', role='admin' where id=$1", [o.userId], /protected identity/],
        ["insert into public.users(auth_user_id,email) values($1,'y@example.test')", [o.authUserId], /protected identity/],
        ["insert into public.businesses(owner_id,name,category,timezone) values($1,'x','salon','UTC')", [o.userId], /protected ownership/],
      ] as const) {
        await expect(db.query(sql, [...args]), sql).rejects.toThrow(re);
        await db.exec('rollback to savepoint s');
      }
      await db.query("update public.users set display_name='Sam' where id=$1", [o.userId]);
    } finally { await db.exec('rollback'); }
  });
});

describe('subject material', () => {
  it('refuses every order material edit after approval, through a CTE and ON CONFLICT DO UPDATE', async () => {
    const p = await approvedOn(db);
    await app(async () => {
      for (const set of ["cart='{\"lines\":[{\"variationId\":\"other\"}]}'", `cart_hash='${hash('x')}'`, "quote='{}'", 'total_minor=1', "contact='{\"firstName\":\"Eve\"}'",
        "fulfillment='{\"type\":\"pickup\",\"pickupAt\":\"2030-01-01T00:00:00.000Z\"}'", 'created_at=now()'])
        await expect(db.query(`update public.orders set ${set} where id=$1`, [p.subjectId]), set).rejects.toThrow(/protected order material/);
      await expect(db.query("with x as (update public.orders set cart='{}' where id=$1 returning 1) select * from x", [p.subjectId])).rejects.toThrow(/protected order material/);
      // A proposed row that passes the insert guard still reaches the update guard on conflict.
      await expect(db.query(`insert into public.orders select * from jsonb_populate_record(null::public.orders,
        (select to_jsonb(o) || '{"status":"AWAITING_OWNER_APPROVAL","approval_id":null}' from public.orders o where id=$1))
        on conflict (id) do update set cart='{}'`, [p.subjectId])).rejects.toThrow(/protected order material/);
      // The claim still passes: material is unchanged.
      expect((await runtime.runtimeClaimExecution(db, { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w' }))?.status).toBe('RUNNING');
    });
  });

  it('refuses cart edits on a pending proposal too, and allows the contract status moves', async () => {
    const pending = await approvedOn(db, 'order_bundle', false);
    await app(() => expect(db.query("update public.orders set cart='{}' where id=$1", [pending.subjectId])).rejects.toThrow(/protected order material/));
    // The cancel in apps/server/src/compose/recovery.ts is a status-only move and still works.
    const p = await approvedOn(db);
    const lease = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    await app(() => runtime.runtimeClaimExecution(db, lease));
    await db.query("update public.action_executions set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [lease.executionId]);
    await app(async () => {
      await runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 });
      expect((await db.query("update public.orders set status = 'CANCELLED' where id = $1 and business_id = $2 and status = $3 returning status",
        [p.subjectId, p.businessId, 'RECOVERY_REQUIRED'])).rows).toEqual([{ status: 'CANCELLED' }]);
    });
  });

  it('accepts the propose_order insert and refuses an order inserted past AWAITING_OWNER_APPROVAL or with references', async () => {
    const o = await createOwner(db);
    await app(async () => {
      const id = 'ord_' + uniq();
      // The insert in apps/server/src/policy/engine.ts.
      await db.query(`insert into public.orders (id, business_id, call_id, status, cart, cart_hash, quote, total_minor, currency, contact, fulfillment, created_at, updated_at)
        values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12,$12)`,
      [id, o.businessId, o.callId, 'AWAITING_OWNER_APPROVAL', '{"lines":[]}', hash(id), '{}', 1200, 'USD', '{}', '{"type":"pickup"}', new Date()]);
      for (const extra of [{ status: 'APPROVED' }, { status: 'PAYMENT_PENDING', square_order_id: 's', square_payment_link_id: 'l', checkout_url: 'https://x.test' },
        { square_order_id: 'forged' }, { checkout_url: 'https://x.test' }])
        await expect(createOrder(db, o, extra), JSON.stringify(extra)).rejects.toThrow(/protected proposal state/);
    });
  });

  it('freezes booking material and its proposal state on insert', async () => {
    const p = await approvedOn(db, 'booking_bundle');
    await app(async () => {
      for (const set of ["start_utc=start_utc+interval '1 hour'", "end_utc=end_utc+interval '1 hour'", "service_id='svc_x'", "service_name='x'",
        "calendar_id='cal_x'", "timezone='UTC'", "customer='{\"firstName\":\"Eve\"}'"])
        await expect(db.query(`update public.bookings set ${set} where id=$1`, [p.subjectId]), set).rejects.toThrow(/protected booking material/);
      await expect(createBooking(db, p.owner, { status: 'RECHECKING_SLOT', start_utc: '2027-01-01T10:00:00Z', end_utc: '2027-01-01T10:30:00Z' })).rejects.toThrow(/protected proposal state/);
      await createBooking(db, p.owner, { call_id: p.owner.callId, start_utc: '2027-01-02T10:00:00Z', end_utc: '2027-01-02T10:30:00Z' });
    });
  });
});

describe('checkout completion needs saved references', () => {
  it('refuses SUCCEEDED for a checkout step with no saved references, then succeeds once they are saved', async () => {
    const p = await approvedOn(db);
    const lease = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    await app(async () => {
      await runtime.runtimeClaimExecution(db, lease);
      await expect(runtime.finishExecution(db, { ...lease, status: 'SUCCEEDED', externalRef: 'sq-invented' })).rejects.toThrow(/RESULT: checkout step needs its saved/);
      await runtime.saveCheckout(db, { ...lease, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
      expect((await runtime.finishExecution(db, { ...lease, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId })).status).toBe('SUCCEEDED');
    });
    expect(await one('select status from public.orders where id=$1', [p.subjectId])).toEqual({ status: 'PAYMENT_LINK_READY' });
  });

  it('still lets a checkout step without references fail or retry', async () => {
    const p = await approvedOn(db);
    const lease = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    await app(async () => {
      await runtime.runtimeClaimExecution(db, lease);
      expect((await runtime.finishExecution(db, { ...lease, status: 'QUEUED', retryAt: new Date(0), error: 'timeout' })).status).toBe('QUEUED');
      await runtime.runtimeClaimExecution(db, lease);
      expect((await runtime.finishExecution(db, { ...lease, attempt: 2, status: 'FAILED', error: 'declined' })).status).toBe('FAILED');
    });
  });
});

describe('service_role', () => {
  it('has no direct write on orders or bookings and cannot run the runtime routines', async () => {
    const p = await approvedOn(db);
    for (const t of ['orders', 'bookings'])
      expect(await one(`select has_table_privilege('service_role','public.${t}','INSERT') i,has_table_privilege('service_role','public.${t}','UPDATE') u,
        has_table_privilege('service_role','public.${t}','DELETE') d,has_table_privilege('service_role','public.${t}','TRUNCATE') t`), t).toEqual({ i: false, u: false, d: false, t: false });
    await as(db, 'service_role', async () => {
      await expect(db.query("update public.orders set status='PAID_VERIFIED',square_payment_id='forged' where id=$1", [p.subjectId])).rejects.toMatchObject({ code: '42501' });
      await expect(db.query('select * from private.claim_next_execution($1,$2)', [p.businessId, 'w'])).rejects.toMatchObject({ code: '42501' });
    });
    const q = await db.query<{ proname: string }>(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and has_function_privilege('service_role',p.oid,'execute')`);
    expect(q.rows).toEqual([]);
  });
});

describe('mark_webhook_processed', () => {
  it('sets the marker once, never clears it, keeps the first error and checks the business', async () => {
    const o = await createOwner(db); const other = await createOwner(db);
    const w = await app(() => insert(db, 'webhook_events', { source: 'square', provider_event_id: 'ev-' + uniq(), event_type: 'payment.updated', business_id: o.businessId }));
    const id = String(w.id);
    await app(async () => {
      await expect(runtime.markWebhookProcessed(db, { businessId: other.businessId, webhookEventId: id })).rejects.toThrow(/SCOPE/);
      await expect(runtime.markWebhookProcessed(db, { businessId: null, webhookEventId: id })).rejects.toThrow(/SCOPE/);
      await expect(runtime.markWebhookProcessed(db, { businessId: o.businessId, webhookEventId: 'whk_missing' })).rejects.toThrow(/SCOPE/);
      const first = await runtime.markWebhookProcessed(db, { businessId: o.businessId, webhookEventId: id, error: 'x'.repeat(600) });
      expect(first.processed_at).not.toBeNull(); expect(first.process_error).toHaveLength(500);
      const again = await runtime.markWebhookProcessed(db, { businessId: o.businessId, webhookEventId: id });
      expect(again).toEqual(first);
      await expect(db.query('update public.webhook_events set processed_at=null where id=$1', [id])).rejects.toMatchObject({ code: '42501' });
    });
    // A row stored without a business is marked with a null business.
    const anon = await app(() => insert(db, 'webhook_events', { source: 'twilio_status', provider_event_id: 'ev-' + uniq(), event_type: 'delivered' }));
    const marked = await app(() => runtime.markWebhookProcessed(db, { businessId: null, webhookEventId: String(anon.id) }));
    expect(marked).toMatchObject({ process_error: null }); expect(marked.processed_at).not.toBeNull();
  });
});

describe('update_dispatch_status', () => {
  it('moves SENT to DELIVERED without a lease and ignores repeats and stale receipts', async () => {
    const p = await sentOn(db);
    await app(async () => {
      const args = { businessId: p.businessId, dispatchId: p.dispatchId };
      expect((await runtime.updateDispatchStatus(db, { ...args, status: 'SENT' })).status).toBe('SENT');
      const delivered = await runtime.updateDispatchStatus(db, { ...args, status: 'DELIVERED' });
      expect(delivered).toMatchObject({ status: 'DELIVERED', provider_message_id: p.providerId }); expect(delivered.delivered_at).not.toBeNull();
      expect(await runtime.updateDispatchStatus(db, { ...args, status: 'DELIVERED' })).toEqual(delivered);
      expect(await runtime.updateDispatchStatus(db, { ...args, status: 'SENT' })).toEqual(delivered);
      expect(await runtime.updateDispatchStatus(db, { ...args, status: 'FAILED' })).toEqual(delivered);
      await expect(db.query("update public.message_dispatches set status='FAILED' where id=$1", [p.dispatchId])).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('moves SENT to FAILED, which is terminal, and refuses wrong scope, bad status and an unsent dispatch', async () => {
    const p = await sentOn(db); const other = await createOwner(db);
    await app(async () => {
      await expect(runtime.updateDispatchStatus(db, { businessId: other.businessId, dispatchId: p.dispatchId, status: 'DELIVERED' })).rejects.toThrow(/SCOPE/);
      await expect(runtime.updateDispatchStatus(db, { businessId: p.businessId, dispatchId: p.dispatchId, status: 'UNKNOWN' as 'SENT' })).rejects.toThrow(/TRANSITION/);
      const failed = await runtime.updateDispatchStatus(db, { businessId: p.businessId, dispatchId: p.dispatchId, status: 'FAILED' });
      expect(failed.status).toBe('FAILED');
      expect((await runtime.updateDispatchStatus(db, { businessId: p.businessId, dispatchId: p.dispatchId, status: 'DELIVERED' })).status).toBe('FAILED');
    });
    // A recorded but not yet sent dispatch has no provider ID and cannot take a receipt.
    const q = await approvedOn(db);
    const checkout = { businessId: q.businessId, executionId: q.executions[0]!.id, workerId: 'w', attempt: 1 };
    const message = { businessId: q.businessId, executionId: q.executions[1]!.id, workerId: 'm', attempt: 1 };
    await app(async () => {
      await runtime.runtimeClaimExecution(db, checkout);
      await runtime.saveCheckout(db, { ...checkout, squareOrderId: 'sq-' + q.subjectId, paymentLinkId: 'link-' + q.subjectId, url: 'https://example.test/c' });
      await runtime.finishExecution(db, { ...checkout, status: 'SUCCEEDED', externalRef: 'sq-' + q.subjectId });
      await runtime.runtimeClaimExecution(db, message);
      const d = await runtime.recordDispatch(db, { ...message, bodyHash: hash('body') });
      await expect(runtime.updateDispatchStatus(db, { businessId: q.businessId, dispatchId: d.id, status: 'DELIVERED' })).rejects.toThrow(/^RETRY: receipt deferred/);
      await runtime.finishExecution(db, { ...message, status: 'FAILED', error: 'provider refused' });
      await expect(runtime.updateDispatchStatus(db, { businessId: q.businessId, dispatchId: d.id, status: 'DELIVERED' })).rejects.toThrow(/provider message ID/);
    });
  });
});

describe('receipt during the send', () => {
  it('defers a FAILED receipt that arrives between the SENT commit and the finish, then applies it after', async () => {
    const p = await approvedOn(db);
    const checkout = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    const message = { businessId: p.businessId, executionId: p.executions[1]!.id, workerId: 'm', attempt: 1 };
    const providerId = 'pm-' + uniq();
    await app(async () => {
      await runtime.runtimeClaimExecution(db, checkout);
      await runtime.saveCheckout(db, { ...checkout, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
      await runtime.finishExecution(db, { ...checkout, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
      await runtime.runtimeClaimExecution(db, message);
      const d = await runtime.recordDispatch(db, { ...message, bodyHash: hash('body') });
      await runtime.updateDispatch(db, { ...message, dispatchId: d.id, status: 'SENT', providerMessageId: providerId });
      // The receipt arrives before the sender finishes: deferred, nothing changes.
      const deferred = await runtime.updateDispatchStatus(db, { businessId: p.businessId, dispatchId: d.id, status: 'FAILED' }).catch((e: unknown) => e);
      expect(runtime.isRetryableReceiptError(deferred)).toBe(true);
      expect((deferred as Error).message).toBe('RETRY: receipt deferred until the send step finishes');
      expect(await one('select status from public.message_dispatches where id=$1', [d.id])).toEqual({ status: 'SENT' });
      expect((await runtime.finishExecution(db, { ...message, status: 'SUCCEEDED', externalRef: providerId })).status).toBe('SUCCEEDED');
      // The retried receipt now applies and reopens nothing.
      expect((await runtime.updateDispatchStatus(db, { businessId: p.businessId, dispatchId: d.id, status: 'FAILED' })).status).toBe('FAILED');
      expect(await one('select status,external_ref from public.action_executions where id=$1', [message.executionId])).toEqual({ status: 'SUCCEEDED', external_ref: providerId });
      expect((await runtime.runtimeClaimNextExecution(db, { businessId: p.businessId, workerId: 'w' }))?.action_type).toBe('local.order.record');
    });
    expect(runtime.isRetryableReceiptError(new Error('SCOPE: dispatch not found'))).toBe(false);
  });
});

describe('runtime_role_check', () => {
  // PGlite always logs in as its superuser, so SET SESSION AUTHORIZATION stands in for authenticating as a role.
  async function session<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`set session authorization ${role}`);
    try { return await fn(); } finally { await db.exec('set session authorization postgres; reset role'); }
  }

  it('reports a session authenticated as abos_app as restricted', async () => {
    const check = await session('abos_app', () => runtime.assertRestrictedRuntimeRole(db));
    expect(check).toEqual({ role_name: 'abos_app', session_role_name: 'abos_app', superuser: false, bypass_rls: false, other_roles: 0,
      writes_approvals: false, writes_executions: false, writes_dispatches: false, writes_sync_jobs: false, writes_receipts: false, restricted: true });
  });

  it('refuses an owner or administrator login that only SET ROLE abos_app', async () => {
    // The test superuser stands for the owner connection; after RESET ROLE it has every right again.
    const p = await approvedOn(db, 'order_bundle', false);
    await db.exec('set role abos_app');
    try {
      expect(await runtime.runtimeRoleCheck(db)).toMatchObject({ role_name: 'abos_app', restricted: false });
      expect((await runtime.runtimeRoleCheck(db)).session_role_name).not.toBe('abos_app');
      await expect(runtime.assertRestrictedRuntimeRole(db)).rejects.toThrow(/both must be abos_app/);
    } finally { await db.exec('reset role'); }
    expect((await db.query("update public.orders set cart='{\"evil\":true}' where id=$1 returning id", [p.subjectId])).rows).toHaveLength(1);
  });

  it('refuses an inheriting login that SET ROLE abos_app', async () => {
    const p = await approvedOn(db, 'order_bundle', false);
    await db.exec('create role inheritor login inherit; grant abos_app to inheritor');
    try {
      await session('inheritor', async () => {
        await db.exec('set role abos_app');
        expect(await runtime.runtimeRoleCheck(db)).toMatchObject({ role_name: 'abos_app', session_role_name: 'inheritor', restricted: false });
        await expect(runtime.assertRestrictedRuntimeRole(db)).rejects.toThrow(/connected as inheritor with role abos_app/);
        await db.exec('reset role');
        // Why the check must refuse: after RESET ROLE the guards no longer apply to this login.
        expect((await runtime.runtimeRoleCheck(db)).restricted).toBe(false);
        expect((await db.query("update public.orders set cart='{\"evil\":true}' where id=$1 returning id", [p.subjectId])).rows).toHaveLength(1);
      });
    } finally { await db.exec('drop owned by inheritor; drop role inheritor'); }
  });

  it('fails closed for the migration owner, a superuser and service_role', async () => {
    const owner = await as(db, 'supabase_postgres', () => runtime.runtimeRoleCheck(db));
    expect(owner).toMatchObject({ role_name: 'supabase_postgres', bypass_rls: true, writes_approvals: true, restricted: false });
    await as(db, 'supabase_postgres', () => expect(runtime.assertRestrictedRuntimeRole(db)).rejects.toThrow(/with role supabase_postgres; both must be abos_app/));
    expect(await runtime.runtimeRoleCheck(db)).toMatchObject({ superuser: true, restricted: false });
    await as(db, 'service_role', () => expect(runtime.assertRestrictedRuntimeRole(db)).rejects.toThrow(/not the restricted abos_app role/));
  });

  it('grants the new entry points to abos_app only, with pinned search paths', async () => {
    const q = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[]; app: boolean; svc: boolean; auth: boolean; anon: boolean; pub: boolean }>(`
      select p.proname,p.prosecdef,p.proconfig,has_function_privilege('abos_app',p.oid,'execute') app,
        has_function_privilege('service_role',p.oid,'execute') svc,has_function_privilege('authenticated',p.oid,'execute') auth,
        has_function_privilege('anon',p.oid,'execute') anon,
        exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) where grantee=0 and privilege_type='EXECUTE') pub
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and proname in
      ('mark_webhook_processed','update_dispatch_status','runtime_role_check','finish_execution',
       'businesses_runtime_guard','users_runtime_guard','orders_material_guard','bookings_material_guard') order by 1`);
    expect(q.rows).toHaveLength(8);
    const entry = ['mark_webhook_processed', 'update_dispatch_status', 'runtime_role_check', 'finish_execution'];
    for (const r of q.rows) {
      expect(r, r.proname).toMatchObject({ app: entry.includes(r.proname), svc: false, auth: false, anon: false, pub: false, proconfig: ['search_path=""'] });
      if (r.app) expect(r.prosecdef, r.proname).toBe(r.proname !== 'runtime_role_check');
    }
    const triggers = await db.query<{ tgname: string; tgenabled: string }>(`select tgname,tgenabled from pg_trigger where tgname in
      ('businesses_runtime_guard','users_runtime_guard','orders_material_guard','bookings_material_guard') order by 1`);
    expect(triggers.rows.map(t => t.tgenabled)).toEqual(['A', 'A', 'A', 'A']);
  });
});

function fakeAuth(target: PGlite): AuthAdmin {
  const users = new Map<string, string>();
  return {
    async findUserByEmail(email: string) { const id = users.get(email); return id ? { id } : undefined; },
    async createUser(email: string) {
      const id = randomUUID(); users.set(email, id);
      await target.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      return { id };
    },
  };
}
const SEED_ENV: SeedEnv = {
  SUPABASE_URL: 'http://fake.test', SUPABASE_SERVICE_ROLE_KEY: 'fake-key', SEED_OWNER_EMAIL: 'owner@demo.test',
  SEED_OWNER_PASSWORD: 'fixed-test-password-1', TWILIO_PHONE_NUMBER: '+15555550199', SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_ACCESS_TOKEN: 'fake-square-token', SQUARE_LOCATION_ID: 'LOC_FAKE', MESSAGE_CHANNEL: 'qr_only',
};

it('applies to a database populated under 0001 to 0005 and the existing data keeps working', async () => {
  const fresh = await createSupabaseLikeDb();
  const sdb: SeedDb = { query: async <R,>(text: string, params?: unknown[]) => ({ rows: (await fresh.query<R>(text, params)).rows }) };
  try {
    await fresh.exec('set role supabase_postgres');
    await applyMigrations(migrationDb(fresh), readMigrations().slice(0, 5));
    await fresh.exec('reset role');
    await seedDatabase(sdb, { env: SEED_ENV, auth: fakeAuth(fresh), envFilePath: undefined });
    const ownerId = (await fresh.query<{ id: string }>('select id from public.users limit 1')).rows[0]!.id;
    const businesses = (await fresh.query<{ id: string }>('select id from public.businesses order by id')).rows.map(r => r.id);
    if (businesses.length < 2) {
      const id = 'biz_second_' + uniq();
      await insert(fresh, 'businesses', { id, owner_id: ownerId, name: 'Second', category: 'salon', timezone: 'America/Los_Angeles' });
      businesses.push(id);
    }
    for (let i = (await fresh.query<{ n: number }>('select count(*)::int n from public.business_facts')).rows[0]!.n; i < 33; i++)
      await insert(fresh, 'business_facts', { business_id: businesses[1], kind: 'faq', key: 'q6-' + i, value: { text: 'A' + i }, source_type: 'seed' });
    for (let i = (await fresh.query<{ n: number }>('select count(*)::int n from public.catalog_items')).rows[0]!.n; i < 6; i++)
      await insert(fresh, 'catalog_items', { business_id: businesses[0], square_item_id: 'SQI' + i, square_variation_id: 'SQV6' + i,
        square_item_version: 1, square_variation_version: 1, item_name: 'Item ' + i, variation_name: 'Regular', price_minor: 1000 + i, synced_at: new Date() });
    // Live work created under 0005: a pending proposal, an approved order mid-flight, a sent message and webhook rows.
    const pending = await approvedOn(fresh, 'order_bundle', false);
    const inflight = await approvedOn(fresh);
    const sent = await sentOn(fresh);
    const hook = await as(fresh, 'abos_app', () => insert(fresh, 'webhook_events', { source: 'square', provider_event_id: 'ev-' + uniq(), event_type: 'payment.updated', business_id: sent.businessId }));
    await as(fresh, 'abos_app', () => insert(fresh, 'webhook_events', { source: 'twilio_status', provider_event_id: 'ev-' + uniq(), event_type: 'delivered' }));
    const counts = `select (select count(*)::int from public.businesses) b,(select count(*)::int from public.users) u,(select count(*)::int from public.business_facts) f,
      (select count(*)::int from public.catalog_items) c,(select count(*)::int from public.orders) o,(select count(*)::int from public.webhook_events) w,
      (select count(*)::int from public.agent_versions where published_at is not null) v`;
    const before = (await fresh.query(counts)).rows[0] as Record<string, number>;
    expect(before.f).toBeGreaterThanOrEqual(33); expect(before.c).toBeGreaterThanOrEqual(6); expect(before.v).toBeGreaterThan(0);

    await fresh.exec('set role supabase_postgres');
    expect((await applyMigrations(migrationDb(fresh))).applied).toEqual(['0006_ownership_material_and_receipts.sql']);
    await fresh.exec('reset role');
    expect((await fresh.query(counts)).rows[0]).toEqual(before);

    // SET SESSION AUTHORIZATION stands in for logging in as abos_app.
    expect(await (async () => { await fresh.exec('set session authorization abos_app');
      try { return (await runtime.assertRestrictedRuntimeRole(fresh)).restricted; } finally { await fresh.exec('set session authorization postgres; reset role'); } })()).toBe(true);
    await as(fresh, 'abos_app', async () => {
      // The pending proposal is decided, its checkout completes with saved references.
      const d = await runtime.runtimeDecideAndEnqueue(fresh, { businessId: pending.businessId, approvalId: pending.approvalId, ownerUserId: pending.owner.userId,
        payloadHash: (await fresh.query<{ h: string }>('select payload_hash h from public.approval_requests where id=$1', [pending.approvalId])).rows[0]!.h, decision: 'APPROVED' });
      for (const p of [{ ...pending, executions: d.executions }, inflight]) {
        const lease = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
        await runtime.runtimeClaimExecution(fresh, lease);
        await runtime.saveCheckout(fresh, { ...lease, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
        expect((await runtime.finishExecution(fresh, { ...lease, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId })).status).toBe('SUCCEEDED');
      }
      expect((await runtime.updateDispatchStatus(fresh, { businessId: sent.businessId, dispatchId: sent.dispatchId, status: 'DELIVERED' })).status).toBe('DELIVERED');
      expect((await runtime.markWebhookProcessed(fresh, { businessId: sent.businessId, webhookEventId: String(hook.id) })).processed_at).not.toBeNull();
      await expect(fresh.query("update public.orders set cart='{}' where id=$1", [inflight.subjectId])).rejects.toThrow(/protected order material/);
      await expect(fresh.query('update public.businesses set owner_id=owner_id||$2 where id=$1', [businesses[0], 'x'])).rejects.toThrow(/protected ownership/);
    });
  } finally { await fresh.close(); }
}, 120_000);
