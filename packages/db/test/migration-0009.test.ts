// Migration 0009 (SPEC D-13, demo mode only): the demo_orders and demo_messages tables. Additive only.
// Local PGlite only, migrated by the non-superuser owner.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asOwner, createMigratedDb, createOrder, createOwner, createSupabaseLikeDb, migrationDb } from './helpers';
import { applyMigrations, readMigrations } from '../src/migrate';

const NAME = '0009_demo_orders.sql';
let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); }, 60_000);
afterAll(async () => { await db.close(); });

async function as<T>(target: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await target.exec(`set role ${role}`);
  try { return await fn(); } finally { await target.exec('reset role'); }
}
const one = async (sql: string, args: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, args)).rows[0]!;
const MSG_ID = `dmsg_${'a'.repeat(40)}`;

describe('0009 demo tables', () => {
  it('is the last migration and follows 0008', () => {
    const names = readMigrations().map((f) => f.name);
    expect(names.at(-1)).toBe(NAME);
    expect(names.at(-2)).toBe('0008_owner_recovery.sql');
  });

  it('abos_app may select, insert and update the demo tables, and nothing else', async () => {
    for (const t of ['demo_orders', 'demo_messages']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE']) expect((await one(`select has_table_privilege('abos_app','public.${t}',$1) ok`, [p])).ok, `${t} ${p}`).toBe(true);
      for (const p of ['DELETE', 'TRUNCATE']) expect((await one(`select has_table_privilege('abos_app','public.${t}',$1) ok`, [p])).ok, `${t} ${p}`).toBe(false);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await one(`select has_table_privilege($1,'public.${t}','SELECT, INSERT, UPDATE, DELETE, TRUNCATE') ok`, [role])).ok, `${t} ${role}`).toBe(false);
      }
      expect((await one(`select relrowsecurity r from pg_class where oid='public.${t}'::regclass`)).r).toBe(true);
    }
  });

  it('a demo row needs a real order of the same business and a valid number; abos_app cannot delete', async () => {
    const owner = await createOwner(db);
    const order = await createOrder(db, owner);
    await as(db, 'abos_app', async () => {
      await db.query('insert into public.demo_orders (order_id, business_id, recipient) values ($1,$2,$3)', [order.id, owner.businessId, '+15555550123']);
      await db.query('update public.demo_orders set demo_paid_at = now() where order_id = $1', [order.id]);
      await db.query("insert into public.demo_messages (id, business_id, call_id, kind, recipient) values ($1,$2,$3,'pay_link',$4)", [MSG_ID, owner.businessId, owner.callId, '+15555550123']);
      await expect(db.query('delete from public.demo_orders where order_id = $1', [order.id])).rejects.toMatchObject({ code: '42501' });
      await expect(db.query('delete from public.demo_messages where id = $1', [MSG_ID])).rejects.toMatchObject({ code: '42501' });
      await expect(db.query("insert into public.demo_messages (id, business_id, kind, recipient) values ($1,$2,'other',$3)", [`dmsg_${'b'.repeat(40)}`, owner.businessId, '+15555550123'])).rejects.toThrow();
      await expect(db.query("insert into public.demo_messages (id, business_id, kind, recipient) values ($1,$2,'menu','5550123')", [`dmsg_${'c'.repeat(40)}`, owner.businessId])).rejects.toThrow();
      // The order must belong to the business named.
      await expect(db.query('insert into public.demo_orders (order_id, business_id, recipient) values ($1,$2,$3)', ['ord_missing_1', owner.businessId, '+15555550123'])).rejects.toThrow();
    });
    // A signed-in owner sees nothing in the demo tables.
    await expect(asOwner(db, owner.authUserId, () => db.query('select * from public.demo_orders'))).rejects.toMatchObject({ code: '42501' });
  });

  it('adds only its two tables on a database that has 0001 to 0008, and writes no row', async () => {
    const fresh = await createSupabaseLikeDb();
    try {
      const files = readMigrations();
      await as(fresh, 'supabase_postgres', () => applyMigrations(migrationDb(fresh), files.filter((f) => f.name < NAME)));
      const tables = async () => (await fresh.query<{ t: string }>("select c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1")).rows.map((r) => r.t);
      const routines = async () => (await fresh.query<{ n: number }>("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')")).rows[0]!.n;
      const beforeTables = await tables();
      const beforeRoutines = await routines();
      expect((await as(fresh, 'supabase_postgres', () => applyMigrations(migrationDb(fresh)))).applied).toEqual([NAME]);
      expect((await tables()).filter((t) => !beforeTables.includes(t))).toEqual(['demo_messages', 'demo_orders']);
      expect(await routines()).toBe(beforeRoutines);
      expect((await fresh.query('select (select count(*)::int from public.demo_orders) o, (select count(*)::int from public.demo_messages) m')).rows[0]).toEqual({ o: 0, m: 0 });
      // The restricted runtime role is still restricted.
      const check = await as(fresh, 'abos_app', async () => (await fresh.query<{ restricted: boolean }>('select * from private.runtime_role_check()')).rows[0]);
      expect(check).toBeDefined();
    } finally { await fresh.close(); }
  }, 120_000);
});
