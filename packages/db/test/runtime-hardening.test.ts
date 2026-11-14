// Independent review of 0004 (round four). Each block proves one defect or one boundary claim.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  ORDER_BUNDLE, createMigratedDb, createOwner, createOrder, createSupabaseLikeDb, insert, migrateAsSupabaseOwner, uniq,
} from './helpers';
import * as runtime from '../src/runtime';

let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); });
afterAll(async () => { await db.close(); });
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const hash = (s: string) => 'sha256:' + digest(s);
async function app<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('set role abos_app');
  try { return await fn(); } finally { await db.exec('reset role'); }
}

async function orderProposal(material: Record<string, unknown>, lifetime = 600_000) {
  const owner = await createOwner(db);
  const order = await createOrder(db, owner);
  const expiresAt = new Date(Date.now() + lifetime).toISOString();
  const payload = { businessId: owner.businessId, subjectId: String(order.id), agentVersionId: owner.agentVersionId,
    cartHash: order.cart_hash, totalMinor: 1200, currency: 'USD', pickupAt: null, ...material, actionBundle: ORDER_BUNDLE, expiresAt };
  const canonical = JSON.stringify(payload);
  return { owner, order, args: { businessId: owner.businessId, bundleType: 'order_bundle' as const, subjectId: String(order.id),
    actorType: 'deployed_agent' as const, actorId: owner.agentVersionId, payload, canonical, payloadHash: hash(canonical),
    actionBundle: ORDER_BUNDLE, expiresAt } };
}
async function approve(p: Awaited<ReturnType<typeof orderProposal>>) {
  const a = await app(() => runtime.createApproval(db, p.args));
  return app(() => runtime.runtimeDecideAndEnqueue(db, { businessId: p.owner.businessId, approvalId: a.id,
    ownerUserId: p.owner.userId, payloadHash: a.payload_hash, decision: 'APPROVED' }));
}

describe('Supabase-like deployment (non-superuser migration owner)', () => {
  it('applies every migration without superuser and owns tables and routines as that role', async () => {
    const q = await db.query<{ owners: string[] }>(`select array(select distinct pg_get_userbyid(proowner) from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
      union select distinct pg_get_userbyid(relowner) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r') owners`);
    expect(q.rows[0]!.owners).toEqual(['supabase_postgres']);
  });

  it('is a no-op when the runner runs a second time as that owner', async () => {
    await db.exec('set role supabase_postgres');
    try {
      const { applyMigrations } = await import('../src/migrate');
      const { migrationDb } = await import('./helpers');
      const again = await applyMigrations(migrationDb(db));
      expect(again.applied).toEqual([]);
      expect(again.skipped).toHaveLength(7);
    } finally { await db.exec('reset role'); }
  });

  it('refuses, and rolls back, when a pre-existing abos_app has unsafe attributes', async () => {
    const fresh = await createSupabaseLikeDb();
    try {
      await fresh.exec('create role abos_app nologin bypassrls');
      await expect(migrateAsSupabaseOwner(fresh)).rejects.toThrow(/0004.*ROLE: existing abos_app/);
      expect((await fresh.query("select count(*)::int n from pg_proc where proname='create_approval'")).rows[0]).toEqual({ n: 0 });
    } finally { await fresh.close(); }
  });

  it('revokes API execution of an existing public.rls_auto_enable()', async () => {
    const fresh = await createSupabaseLikeDb();
    try {
      await fresh.exec(`set role supabase_postgres;
        create function public.rls_auto_enable() returns void language sql security definer set search_path='' as 'select';
        grant execute on function public.rls_auto_enable() to public, anon, authenticated; reset role;`);
      await migrateAsSupabaseOwner(fresh);
      const q = await fresh.query(`select has_function_privilege('anon','public.rls_auto_enable()','execute') anon,
        has_function_privilege('authenticated','public.rls_auto_enable()','execute') auth,
        has_function_privilege('abos_app','public.rls_auto_enable()','execute') app`);
      expect(q.rows[0]).toEqual({ anon: false, auth: false, app: false });
    } finally { await fresh.close(); }
  });
});

describe('abos_app cannot reach the four protected tables or escalate', () => {
  it('denies MERGE, upsert, COPY FROM, data-modifying CTEs and row locks on every protected table', async () => {
    for (const t of ['approval_requests', 'action_executions', 'message_dispatches', 'sync_jobs']) {
      for (const sql of [
        `merge into public.${t} x using (select 1) s on false when not matched then insert default values`,
        `merge into public.${t} x using (select 1) s on true when matched then update set id = x.id`,
        `insert into public.${t} (id) values ('x') on conflict (id) do update set id = excluded.id`,
        `copy public.${t} (id) from stdin`,
        `with c as (update public.${t} set id = id returning 1) select * from c`,
        `with c as (delete from public.${t} returning 1) select * from c`,
        `select 1 from public.${t} for update`,
        `select 1 from public.${t} for key share`,
      ]) await app(() => expect(db.query(sql), sql).rejects.toMatchObject({ code: '42501' }));
      await db.exec('begin; set local role abos_app');
      try { await expect(db.query(`lock table public.${t} in exclusive mode`)).rejects.toMatchObject({ code: '42501' }); }
      finally { await db.exec('rollback'); }
    }
  });

  it('cannot create objects, switch roles, disable triggers or call internal helpers', async () => {
    for (const sql of [
      'create table public.shadow (id int)', 'create view public.v as select 1', 'create function public.f() returns int language sql as $$select 1$$',
      'create table private.shadow (id int)', 'create schema evil',
      'set session_replication_role = replica',
      'alter table public.action_executions disable trigger all',
      "select private.material('fact_edit', '{}'::jsonb)", 'select private.retain_identity()',
      "select public.execution_claim_allowed('a','b',0,'c')", "select private.sync_approval('b','order','s')",
      "select private.owns_business('b')", "select extensions.digest('x','sha256')",
      'grant abos_app to anon',
    ]) await app(() => expect(db.query(sql), sql).rejects.toBeTruthy());
    await app(async () => {
      expect((await db.query("select has_schema_privilege('extensions','usage') u")).rows[0]).toEqual({ u: false });
    });
    // SET ROLE is checked against the session user, which in PGlite is the test superuser, so
    // prove the catalog fact instead: abos_app can SET or inherit no other role.
    const q = await db.query(`select count(*)::int n from pg_roles r where r.rolname <> 'abos_app'
      and (pg_has_role('abos_app', r.oid, 'SET') or pg_has_role('abos_app', r.oid, 'USAGE'))`);
    expect(q.rows[0]).toEqual({ n: 0 });
  });

  it('can still do its ordinary writes, including a booking under the exclusion constraint', async () => {
    const owner = await createOwner(db);
    await app(async () => {
      const b = await insert(db, 'bookings', { business_id: owner.businessId, call_id: owner.callId, service_id: 'svc', service_name: 'Cut',
        calendar_id: 'cal_' + uniq(), start_utc: '2026-12-01T18:00:00Z', end_utc: '2026-12-01T18:30:00Z', timezone: 'UTC', customer: {} });
      await db.query("update public.bookings set status='RECHECKING_SLOT' where id=$1", [b.id]);
      await insert(db, 'orders', { business_id: owner.businessId, call_id: owner.callId, cart: { lines: [] }, cart_hash: hash(uniq()),
        quote: {}, total_minor: 1, contact: {}, fulfillment: {} });
    });
  });
});

describe('legitimate flows that 0004 blocked', () => {
  for (const recipient of ['absent', 'null'] as const) it(`accepts qr_only with messageRecipient ${recipient} and never dispatches`, async () => {
    const p = await orderProposal(recipient === 'absent' ? { messageChannel: 'qr_only' } : { messageChannel: 'qr_only', messageRecipient: null });
    const r = await approve(p);
    expect(r.executions.map((e) => e.status)).toEqual(['QUEUED', 'SKIPPED', 'QUEUED']);
    const biz = p.owner.businessId;
    await app(async () => {
      await expect(runtime.recordDispatch(db, { businessId: biz, executionId: r.executions[1]!.id, workerId: 'w', attempt: 0, bodyHash: hash('b') })).rejects.toThrow(/LEASE/);
      await runtime.runtimeClaimExecution(db, { businessId: biz, executionId: r.executions[0]!.id, workerId: 'w' });
      // 0006: a checkout step succeeds only with its saved references.
      await runtime.saveCheckout(db, { businessId: biz, executionId: r.executions[0]!.id, workerId: 'w', attempt: 1, squareOrderId: 'sq-' + r.executions[0]!.id, paymentLinkId: 'link-' + r.executions[0]!.id, url: 'https://example.test/c' });
      await runtime.finishExecution(db, { businessId: biz, executionId: r.executions[0]!.id, workerId: 'w', attempt: 1, status: 'SUCCEEDED', externalRef: 'sq-' + r.executions[0]!.id });
      expect((await runtime.runtimeClaimNextExecution(db, { businessId: biz, workerId: 'w' }))?.action_type).toBe('local.order.record');
    });
  });

  it('still requires a valid recipient for every sending channel', async () => {
    for (const material of [{ messageChannel: 'surge' }, { messageChannel: 'surge', messageRecipient: null },
      { messageChannel: 'qr_only', messageRecipient: '555' }]) {
      const p = await orderProposal(material);
      await app(() => expect(runtime.createApproval(db, p.args)).rejects.toThrow(/MATERIAL/));
    }
  });

  it('lets local.catalog.sync run after the Square price write changed the catalog row', async () => {
    const owner = await createOwner(db);
    const item = await insert(db, 'catalog_items', { business_id: owner.businessId, square_item_id: 'i', square_variation_id: 'v' + uniq(),
      square_item_version: 1, square_variation_version: 1, item_name: 'P', variation_name: 'R', price_minor: 1200, synced_at: new Date() });
    const expiresAt = new Date(Date.now() + 600_000).toISOString(); const actionBundle = ['square.catalog.price.update', 'local.catalog.sync'];
    const payload = { businessId: owner.businessId, subjectId: String(item.id), squareItemId: 'i', variationId: item.square_variation_id,
      fromPriceMinor: 1200, newPriceMinor: 1500, currency: 'USD', squareVersion: 1, actionBundle, expiresAt };
    const canonical = JSON.stringify(payload); const biz = owner.businessId;
    await app(async () => {
      const a = await runtime.createApproval(db, { businessId: biz, bundleType: 'price_edit', subjectId: String(item.id), actorType: 'owner',
        actorId: owner.userId, payload, canonical, payloadHash: hash(canonical), actionBundle, expiresAt });
      const r = await runtime.runtimeDecideAndEnqueue(db, { businessId: biz, approvalId: a.id, ownerUserId: owner.userId, payloadHash: a.payload_hash, decision: 'APPROVED' });
      await runtime.runtimeClaimExecution(db, { businessId: biz, executionId: r.executions[0]!.id, workerId: 'w' });
      await runtime.finishExecution(db, { businessId: biz, executionId: r.executions[0]!.id, workerId: 'w', attempt: 1, status: 'SUCCEEDED', externalRef: 'sq' });
      // The Square catalog sync records the new price and version before the local step is claimed.
      await db.query('update public.catalog_items set price_minor=1500, square_variation_version=2 where id=$1', [item.id]);
      expect((await runtime.runtimeClaimNextExecution(db, { businessId: biz, workerId: 'w' }))?.action_type).toBe('local.catalog.sync');
    });
  });

  it('does not let one execution whose subject changed block the next claim for the business', async () => {
    const p1 = await orderProposal({ messageChannel: 'surge', messageRecipient: '+15555550123' });
    const r1 = await approve(p1);
    // A second approved bundle in the same business.
    const order2 = await createOrder(db, p1.owner);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const payload = { ...p1.args.payload, subjectId: String(order2.id), cartHash: order2.cart_hash, expiresAt };
    const canonical = JSON.stringify(payload);
    const r2 = await approve({ ...p1, order: order2, args: { ...p1.args, subjectId: String(order2.id), payload, canonical, payloadHash: hash(canonical), expiresAt } });
    await db.query('update public.orders set total_minor=9999 where id=$1', [p1.order.id]);
    await app(async () => {
      await expect(runtime.runtimeClaimExecution(db, { businessId: p1.owner.businessId, executionId: r1.executions[0]!.id, workerId: 'w' })).rejects.toThrow(/SUBJECT/);
      expect((await runtime.runtimeClaimNextExecution(db, { businessId: p1.owner.businessId, workerId: 'w' }))?.id).toBe(r2.executions[0]!.id);
    });
  });
});

describe('guards 0004 was missing', () => {
  it('refuses an approval that lives longer than the 10 minute window', async () => {
    const p = await orderProposal({ messageChannel: 'surge', messageRecipient: '+15555550123' }, 3_600_000);
    await app(() => expect(runtime.createApproval(db, p.args)).rejects.toThrow(/EXPIRED: proposal window/));
  });

  it('refuses SUCCEEDED for a message step unless its dispatch was sent with that provider ID', async () => {
    const p = await orderProposal({ messageChannel: 'surge', messageRecipient: '+15555550123' });
    const r = await approve(p); const biz = p.owner.businessId; const [sq, msg] = r.executions;
    await app(async () => {
      await runtime.runtimeClaimExecution(db, { businessId: biz, executionId: sq!.id, workerId: 'w' });
      // 0006: a checkout step succeeds only with its saved references.
      await runtime.saveCheckout(db, { businessId: biz, executionId: sq!.id, workerId: 'w', attempt: 1, squareOrderId: 'sq-' + sq!.id, paymentLinkId: 'link-' + sq!.id, url: 'https://example.test/c' });
      await runtime.finishExecution(db, { businessId: biz, executionId: sq!.id, workerId: 'w', attempt: 1, status: 'SUCCEEDED', externalRef: 'sq-' + sq!.id });
      await runtime.runtimeClaimExecution(db, { businessId: biz, executionId: msg!.id, workerId: 'w' });
      const ok = (status: 'SUCCEEDED', externalRef: string) => runtime.finishExecution(db, { businessId: biz, executionId: msg!.id, workerId: 'w', attempt: 1, status, externalRef });
      await expect(ok('SUCCEEDED', 'invented')).rejects.toThrow(/RESULT/);
      const d = await runtime.recordDispatch(db, { businessId: biz, executionId: msg!.id, workerId: 'w', attempt: 1, bodyHash: hash('body') });
      await expect(ok('SUCCEEDED', 'invented')).rejects.toThrow(/RESULT/);
      const sent = await runtime.updateDispatch(db, { businessId: biz, dispatchId: d.id, workerId: 'w', attempt: 1, status: 'SENT', providerMessageId: 'pm-' + uniq() });
      await expect(ok('SUCCEEDED', 'other')).rejects.toThrow(/RESULT/);
      expect((await ok('SUCCEEDED', String(sent.provider_message_id))).status).toBe('SUCCEEDED');
    });
  });
});

describe('enableRuntimeLogin', () => {
  it('sends only a SCRAM verifier, never the password, and the verifier matches the server algorithm', async () => {
    const password = "correct horse 'battery' \\ staple; --";
    const seen: string[] = [];
    const spy = { query: async (sql: string) => { seen.push(sql); return db.query(sql); } };
    await runtime.enableRuntimeLogin(spy, password);
    expect(seen.join('\n')).not.toContain('horse');
    const stored = (await db.query<{ p: string; l: boolean }>("select rolpassword p, rolcanlogin l from pg_authid where rolname='abos_app'")).rows[0]!;
    expect(stored.l).toBe(true);
    expect(stored.p).toMatch(/^SCRAM-SHA-256\$4096:/);
    // Let the server hash the same password, then recompute with its salt: both must agree.
    await db.exec("set password_encryption = 'scram-sha-256'; create role scram_probe nologin");
    await db.query(`alter role scram_probe password '${password.replace(/'/g, "''")}'`);
    const server = (await db.query<{ p: string }>("select rolpassword p from pg_authid where rolname='scram_probe'")).rows[0]!.p;
    const [, iterSalt] = server.split('$'); const [iter, salt] = iterSalt!.split(':');
    expect(runtime.scramSha256Verifier(password, Buffer.from(salt!, 'base64'), Number(iter))).toBe(server);
    await db.exec('drop role scram_probe; alter role abos_app nologin password null');
  });

  it('refuses passwords it cannot hash exactly as the server would', async () => {
    const spy = { query: async () => { throw new Error('must not be called'); } };
    for (const bad of ['', 'short', 'café non-ascii password', 'tab\tinside password']) {
      await expect(runtime.enableRuntimeLogin(spy, bad)).rejects.toThrow(/Password/);
    }
  });
});
