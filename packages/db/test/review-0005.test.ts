// Independent review of migration 0005: bypass attempts on the subject guards, a populated upgrade
// and regression cases for defects found in review. Everything runs on local PGlite as abos_app.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { BOOKING_BUNDLE, ORDER_BUNDLE, createBooking, createOrder, createOwner, createMigratedDb, createSupabaseLikeDb, insert, migrationDb, uniq } from './helpers';
import { applyMigrations, readMigrations } from '../src/migrate';
import { runReset, seedDatabase, type AuthAdmin, type SeedDb, type SeedEnv } from '../src/seed';
import * as runtime from '../src/runtime';

let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); }, 60_000);
afterAll(async () => { await db.close(); });
const hash = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
async function as<T>(target: PGlite, fn: () => Promise<T>): Promise<T> {
  await target.exec('set role abos_app');
  try { return await fn(); } finally { await target.exec('reset role'); }
}
const app = <T>(fn: () => Promise<T>) => as(db, fn);

async function approvedOn(target: PGlite, type: 'order_bundle' | 'booking_bundle' = 'order_bundle') {
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
  return as(target, async () => {
    const a = await runtime.createApproval(target, { businessId: owner.businessId, bundleType: type, subjectId: String(subject.id),
      actorType: 'owner', actorId: owner.userId, payload, canonical, payloadHash: hash(canonical), actionBundle, expiresAt });
    const d = await runtime.runtimeDecideAndEnqueue(target, { businessId: owner.businessId, approvalId: a.id, ownerUserId: owner.userId,
      payloadHash: a.payload_hash, decision: 'APPROVED' });
    return { owner, businessId: owner.businessId, subjectId: String(subject.id), approvalId: a.id, executions: d.executions };
  });
}
async function paidOn(target: PGlite) {
  const p = await approvedOn(target);
  await insert(target, 'integrations', { business_id: p.businessId, provider: 'square', alias: 'main', config: { locationId: 'loc-' + p.businessId } });
  const lease = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'checkout', attempt: 1 };
  const paymentId = 'pay-' + uniq();
  await as(target, async () => {
    await runtime.runtimeClaimExecution(target, lease);
    await runtime.saveCheckout(target, { ...lease, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
    await runtime.finishExecution(target, { ...lease, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
    await target.query("update public.orders set status='PAYMENT_PENDING' where id=$1", [p.subjectId]);
    await runtime.markOrderPaid(target, { businessId: p.businessId, orderId: p.subjectId, paymentId, amountMinor: 1200, currency: 'USD',
      squareOrderId: 'sq-' + p.subjectId, locationId: 'loc-' + p.businessId, paymentStatus: 'COMPLETED', environment: 'sandbox' });
  });
  return { ...p, paymentId };
}
const row = async (table: string, id: string) =>
  (await db.query<Record<string, unknown>>(`select status,square_payment_id from public.${table} where id=$1`, [id])).rows[0];

describe('the subject guards cannot be bypassed by abos_app', () => {
  it('refuses session settings, trigger control and calling the guard functions', async () => {
    const p = await paidOn(db);
    await app(async () => {
      await expect(db.exec('set session_replication_role = replica')).rejects.toMatchObject({ code: '42501' });
      // SET SESSION AUTHORIZATION is checked against the login user, which in PGlite is always the test superuser,
      // so it cannot be exercised here. In production abos_app logs in as itself and is refused.
      for (const sql of ['alter table public.orders disable trigger orders_runtime_guard', 'alter table public.orders disable trigger all',
        'alter table public.bookings disable trigger bookings_runtime_guard', 'drop trigger orders_runtime_guard on public.orders',
        'alter table public.payment_receipts disable trigger payment_receipts_append_only'])
        await expect(db.exec(sql)).rejects.toMatchObject({ code: '42501' });
      for (const sql of ['select private.orders_runtime_guard()', 'select private.bookings_runtime_guard()',
        "select private.orders_transition('PAYMENT_PENDING','PAID_VERIFIED')"])
        await expect(db.query(sql)).rejects.toMatchObject({ code: '42501' });
      // abos_app cannot create a function anywhere it would run with another role's rights.
      await expect(db.exec("create function private.f() returns int language sql as 'select 1'")).rejects.toMatchObject({ code: '42501' });
    });
    expect(await row('orders', p.subjectId)).toEqual({ status: 'PAID_VERIFIED', square_payment_id: p.paymentId });
  });

  it('refuses paid-state and identity changes through a writable CTE, ON CONFLICT DO UPDATE and COPY', async () => {
    const p = await paidOn(db);
    const pendingOrder = await approvedOn(db);
    await app(async () => {
      await expect(db.query("with x as (update public.orders set status='PAYMENT_PENDING',square_payment_id=null where id=$1 returning 1) select * from x", [p.subjectId]))
        .rejects.toThrow(/protected/);
      await expect(db.query("with x as (update public.orders set square_payment_id='forged' where id=$1 returning 1) select * from x", [pendingOrder.subjectId]))
        .rejects.toThrow(/protected/);
      // The proposed row passes the insert guard; the conflict path must still be guarded.
      await expect(db.query("insert into public.orders select * from public.orders where id=$1 on conflict (id) do update set status='PAID_VERIFIED',square_payment_id='forged'", [pendingOrder.subjectId]))
        .rejects.toThrow(/protected/);
      await expect(db.query("insert into public.orders select * from public.orders where id=$1 on conflict (id) do update set status='PAYMENT_PENDING'", [p.subjectId]))
        .rejects.toThrow(/protected/);
      await expect(db.query("insert into public.orders select * from public.orders where id=$1 on conflict (id) do update set square_payment_id=null", [p.subjectId]))
        .rejects.toThrow(/protected/);
      // COPY from a server file needs a privilege abos_app lacks. COPY FROM STDIN fires the same row triggers (not runnable in PGlite).
      await expect(db.query("copy public.orders from '/dev/blob'")).rejects.toMatchObject({ code: '42501' });
    });
    expect(await row('orders', p.subjectId)).toEqual({ status: 'PAID_VERIFIED', square_payment_id: p.paymentId });
    expect((await row('orders', pendingOrder.subjectId))?.square_payment_id).toBeNull();
  });

  it('refuses a verified booking move and event ID change through a writable CTE and ON CONFLICT DO UPDATE', async () => {
    const p = await approvedOn(db, 'booking_bundle');
    const lease = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    await app(async () => {
      await runtime.runtimeClaimExecution(db, lease);
      await runtime.verifyBooking(db, { ...lease, googleEventId: 'evt-' + p.subjectId });
      await expect(db.query("with x as (update public.bookings set status='RETRY_REQUIRED' where id=$1 returning 1) select * from x", [p.subjectId])).rejects.toThrow(/protected/);
      await expect(db.query("insert into public.bookings select * from public.bookings where id=$1 on conflict (id) do update set google_event_id='forged'", [p.subjectId]))
        .rejects.toThrow(/protected/);
    });
  });

  it('refuses receipts DML for every API role, including the owner-side service role', async () => {
    const p = await paidOn(db);
    for (const role of ['abos_app', 'service_role', 'authenticated', 'anon']) {
      await db.exec(`set role ${role}`);
      try {
        for (const sql of ["update public.payment_receipts set status='FAILED'", 'delete from public.payment_receipts', 'truncate public.payment_receipts',
          `insert into public.payment_receipts(payment_id,business_id,order_id,square_order_id,location_id,amount_minor,currency,status,environment) values ('x','${p.businessId}','o','s','l',1,'USD','COMPLETED','sandbox')`])
          await expect(db.query(sql), `${role}: ${sql}`).rejects.toMatchObject({ code: '42501' });
      } finally { await db.exec('reset role'); }
    }
  });
});

// A fake Supabase Auth admin that writes auth.users like the real one.
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

it('upgrades a database shaped like the real one (seeded world, two businesses, facts, published agents, catalog) and keeps working', async () => {
  const fresh = await createSupabaseLikeDb();
  const sdb: SeedDb = { query: async <R,>(text: string, params?: unknown[]) => ({ rows: (await fresh.query<R>(text, params)).rows }) };
  try {
    await fresh.exec('set role supabase_postgres');
    await applyMigrations(migrationDb(fresh), readMigrations().slice(0, 4));
    await fresh.exec('reset role');
    await seedDatabase(sdb, { env: SEED_ENV, auth: fakeAuth(fresh), envFilePath: undefined });
    const counts0 = (await fresh.query<{ b: number; f: number; v: number; a: number }>(`select (select count(*)::int from public.businesses) b,
      (select count(*)::int from public.business_facts) f,(select count(*)::int from public.agent_versions where published_at is not null) v,
      (select count(*)::int from public.agents) a`)).rows[0]!;
    // Pad to the real shape: two businesses under one owner, 33 facts, published agents and 6 catalog items.
    const ownerId = (await fresh.query<{ id: string }>('select id from public.users limit 1')).rows[0]!.id;
    const businesses = (await fresh.query<{ id: string }>('select id from public.businesses order by id')).rows.map(r => r.id);
    if (businesses.length < 2) {
      const id = 'biz_second_' + uniq();
      await insert(fresh, 'businesses', { id, owner_id: ownerId, name: 'Second', category: 'salon', timezone: 'America/Los_Angeles' });
      const agentId = 'agt_' + uniq(); const versionId = 'agv_' + uniq();
      await insert(fresh, 'agents', { id: agentId, business_id: id, name: 'Salon', template: 'salon_booking' });
      await insert(fresh, 'agent_versions', { id: versionId, business_id: id, agent_id: agentId, version: 1, spec: { name: 'Salon' }, published_at: new Date() });
      await fresh.query("update public.agents set state='live',active_version_id=$1 where id=$2", [versionId, agentId]);
      businesses.push(id);
    }
    for (let i = (await fresh.query<{ n: number }>('select count(*)::int n from public.business_facts')).rows[0]!.n; i < 33; i++)
      await insert(fresh, 'business_facts', { business_id: businesses[1], kind: 'faq', key: 'q' + i, value: { text: 'A' + i }, source_type: 'seed',
        ...(i % 2 ? { status: 'verified', verified_at: new Date(), verified_by: ownerId } : {}) });
    for (let i = (await fresh.query<{ n: number }>('select count(*)::int n from public.catalog_items')).rows[0]!.n; i < 6; i++)
      await insert(fresh, 'catalog_items', { business_id: businesses[0], square_item_id: 'SQI' + i, square_variation_id: 'SQV' + i,
        square_item_version: 1, square_variation_version: 1, item_name: 'Item ' + i, variation_name: 'Regular', price_minor: 1000 + i, synced_at: new Date() });
    const before = (await fresh.query<{ f: number; c: number }>('select (select count(*)::int from public.business_facts) f,(select count(*)::int from public.catalog_items) c')).rows[0]!;
    expect(before.f).toBeGreaterThanOrEqual(33); expect(before.c).toBeGreaterThanOrEqual(6); expect(counts0.v).toBeGreaterThan(0);

    await fresh.exec('set role supabase_postgres');
    expect((await applyMigrations(migrationDb(fresh))).applied).toEqual(['0005_payments_and_stale_leases.sql', '0006_ownership_material_and_receipts.sql', '0007_agentphone_channel.sql', '0008_owner_recovery.sql']);
    await fresh.exec('reset role');
    expect((await fresh.query('select distinct spec_revision from public.agents')).rows).toEqual([{ spec_revision: 1 }]);
    expect((await fresh.query<{ f: number; c: number }>('select (select count(*)::int from public.business_facts) f,(select count(*)::int from public.catalog_items) c')).rows[0]).toEqual(before);

    // An owner edit of a pre-existing verified fact runs end to end after the upgrade.
    const fact = (await fresh.query<{ id: string; business_id: string; kind: string; key: string; version: number; value: unknown }>(
      "select id,business_id,kind,key,version,value from public.business_facts where status='verified' order by id limit 1")).rows[0]!;
    const owner = (await fresh.query<{ owner_id: string }>('select owner_id from public.businesses where id=$1', [fact.business_id])).rows[0]!.owner_id;
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const payload = { businessId: fact.business_id, subjectId: fact.id, kind: fact.kind, key: fact.key, fromVersion: fact.version,
      before: fact.value, after: { text: 'Changed after upgrade' }, actionBundle: ['local.fact.update'], expiresAt };
    const canonical = JSON.stringify(payload);
    const updated = await as(fresh, async () => {
      const a = await runtime.createApproval(fresh, { businessId: fact.business_id, bundleType: 'fact_edit', subjectId: fact.id, actorType: 'owner',
        actorId: owner, payload, canonical, payloadHash: hash(canonical), actionBundle: ['local.fact.update'], expiresAt });
      const d = await runtime.runtimeDecideAndEnqueue(fresh, { businessId: fact.business_id, approvalId: a.id, ownerUserId: owner, payloadHash: a.payload_hash, decision: 'APPROVED' });
      const lease = { businessId: fact.business_id, executionId: d.executions[0]!.id, workerId: 'w', attempt: 1 };
      await runtime.runtimeClaimExecution(fresh, lease);
      return runtime.applyFactUpdate(fresh, lease);
    });
    expect(updated).toMatchObject({ status: 'verified', version: fact.version + 1, supersedes_id: fact.id });

    // A full paid order on the upgraded data, then the operator demo reset still works and receipts survive it.
    const paid = await paidOn(fresh);
    expect((await fresh.query('select status from public.orders where id=$1', [paid.subjectId])).rows[0]).toEqual({ status: 'PAID_VERIFIED' });
    await runReset(sdb, { env: SEED_ENV, confirmed: true });
    expect((await fresh.query('select count(*)::int n from public.orders')).rows[0]).toEqual({ n: 0 });
    expect((await fresh.query('select order_id from public.payment_receipts where payment_id=$1', [paid.paymentId])).rows).toEqual([{ order_id: paid.subjectId }]);
  } finally { await fresh.close(); }
}, 120_000);

describe('review regression cases', () => {
  it('lets the owner abandon a NEEDS_REVIEW step even when its subject drifted from the approval', async () => {
    const p = await approvedOn(db);
    const lease = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    await app(() => runtime.runtimeClaimExecution(db, lease));
    await db.query("update public.action_executions set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [lease.executionId]);
    await app(() => runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 }));
    // 0006 freezes order material for abos_app, so the drift is an owner-side write.
    await app(() => expect(db.query('update public.orders set total_minor=999 where id=$1', [p.subjectId])).rejects.toThrow(/protected order material/));
    await db.query('update public.orders set total_minor=999 where id=$1', [p.subjectId]);
    await app(async () => {
      await expect(runtime.resolveExecution(db, { ...lease, status: 'SUCCEEDED', externalRef: 'sq', nothingWritten: false })).rejects.toThrow(/SUBJECT/);
      await expect(runtime.resolveExecution(db, { ...lease, status: 'QUEUED', nothingWritten: true })).rejects.toThrow(/SUBJECT/);
      expect((await runtime.resolveExecution(db, { ...lease, status: 'FAILED', nothingWritten: false })).status).toBe('FAILED');
    });
  });

  it('refuses a checkout completion that differs from the saved Square order and a calendar completion without its verified booking', async () => {
    const p = await approvedOn(db);
    const lease = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    await app(async () => {
      await runtime.runtimeClaimExecution(db, lease);
      await runtime.saveCheckout(db, { ...lease, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
      await expect(runtime.finishExecution(db, { ...lease, status: 'SUCCEEDED', externalRef: 'sq-other' })).rejects.toThrow(/RESULT/);
      expect((await runtime.finishExecution(db, { ...lease, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId })).status).toBe('SUCCEEDED');
    });
    expect((await db.query('select external_ref,square_order_id from public.action_executions where id=$1', [lease.executionId])).rows[0])
      .toEqual({ external_ref: 'sq-' + p.subjectId, square_order_id: 'sq-' + p.subjectId });
    const b = await approvedOn(db, 'booking_bundle');
    const blease = { businessId: b.businessId, executionId: b.executions[0]!.id, workerId: 'w', attempt: 1 };
    await app(async () => {
      await runtime.runtimeClaimExecution(db, blease);
      // A calendar step cannot succeed without its verified booking, so the booking cannot stay RECHECKING_SLOT.
      await expect(runtime.finishExecution(db, { ...blease, status: 'SUCCEEDED', externalRef: 'evt-invented' })).rejects.toThrow(/RESULT/);
      expect((await runtime.verifyBooking(db, { ...blease, googleEventId: 'evt-' + b.subjectId })).status).toBe('BOOKED_VERIFIED');
    });
  });

  it('refuses to requeue a message step whose dispatch is already recorded as sent', async () => {
    const p = await approvedOn(db);
    await insert(db, 'integrations', { business_id: p.businessId, provider: 'square', alias: 'main', config: { locationId: 'loc-' + p.businessId } });
    const checkout = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    const message = { businessId: p.businessId, executionId: p.executions[1]!.id, workerId: 'm', attempt: 1 };
    const providerId = 'msg-' + uniq();
    await app(async () => {
      await runtime.runtimeClaimExecution(db, checkout);
      await runtime.saveCheckout(db, { ...checkout, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
      await runtime.finishExecution(db, { ...checkout, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
      await runtime.runtimeClaimExecution(db, message);
      const d = await runtime.recordDispatch(db, { ...message, bodyHash: hash('body') });
      await runtime.updateDispatch(db, { ...message, dispatchId: d.id, status: 'SENT', providerMessageId: providerId });
    });
    // The worker crashes after the send was stored and before it finished the step.
    await db.query("update public.action_executions set lease_deadline=clock_timestamp()-interval '1 second' where id=$1", [message.executionId]);
    await app(async () => {
      expect((await runtime.recoverStaleExecutions(db, { businessId: p.businessId, staleAfterMs: 60_000 })).map(x => x.status)).toEqual(['NEEDS_REVIEW']);
      await expect(runtime.resolveExecution(db, { ...message, status: 'QUEUED', nothingWritten: true })).rejects.toThrow(/proved absent/);
      await expect(runtime.resolveExecution(db, { ...message, status: 'SUCCEEDED', externalRef: 'msg-other', nothingWritten: false })).rejects.toThrow(/IDENTITY/);
      expect((await runtime.resolveExecution(db, { ...message, status: 'SUCCEEDED', externalRef: providerId, nothingWritten: false })).status).toBe('SUCCEEDED');
    });
  });

  it('fails closed on a fact proposal whose signed fromVersion is not a whole number of the stored kind', async () => {
    // material() rejects these before check_subject is reached; the coalesce in check_subject is a second line.
    const owner = await createOwner(db);
    const fact = await insert(db, 'business_facts', { business_id: owner.businessId, kind: 'hours', key: 'sat', value: { text: 'x' }, source_type: 'owner_ui' });
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    for (const fromVersion of [null, '0', 0.5]) {
      const payload = { businessId: owner.businessId, subjectId: String(fact.id), kind: 'hours', key: 'sat', fromVersion, before: null, after: { text: 'x' },
        actionBundle: ['local.fact.update'], expiresAt };
      const canonical = JSON.stringify(payload);
      await app(() => expect(runtime.createApproval(db, { businessId: owner.businessId, bundleType: 'fact_edit', subjectId: String(fact.id), actorType: 'owner',
        actorId: owner.userId, payload, canonical, payloadHash: hash(canonical), actionBundle: ['local.fact.update'], expiresAt })).rejects.toThrow(/MATERIAL|SUBJECT/));
    }
  });
});
