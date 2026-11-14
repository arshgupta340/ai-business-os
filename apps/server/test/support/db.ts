// One in-process Postgres for server tests, migrated as the Supabase-like owner and then used as
// the restricted runtime role `abos_app` (SPEC D-10). Every query the code under test sends runs
// with the same privileges the real server has. Fixtures that only an operator may write
// (capabilities, users, published agent versions) go through `admin`, which switches back to the
// owner for the duration of one function.
//
// PGlite is one session, so the role is session state. Tests in one file run in order, so the
// switch in `admin` cannot interleave with a query from the code under test.
import { CAPABILITY_LIST, canonicalJson, hashCanonical } from '@abos/contracts';
import type { PGlite } from '@electric-sql/pglite';
import type { Db, QueryDb } from '../../src/db/index';
import { createMigratedDb } from '../../../../packages/db/test/helpers';

export type TestDb = {
  pg: PGlite;
  /** The application connection: every statement runs as abos_app. */
  db: Db;
  /** Runs fn as the migration owner (test superuser), then returns to abos_app. */
  admin<T>(fn: (q: QueryDb) => Promise<T>): Promise<T>;
  /** Inserts one row as the owner. Plain objects become JSON; arrays stay Postgres arrays. */
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
};

export async function createTestDb(): Promise<TestDb> {
  const pg = await createMigratedDb();
  const raw: QueryDb = { query: (text, params) => pg.query(text, params) };
  for (const c of CAPABILITY_LIST) {
    await pg.query(`insert into public.capabilities (id, description, effect, approval_mode, handler_id, input_schema, output_schema, tier)
      values ($1,$2,$3,$4,$5,'{}','{}',$6) on conflict (id) do nothing`, [c.id, c.description, c.effect, c.approvalMode, c.handlerId, c.tier]);
  }
  await pg.exec('set role abos_app');
  const db: Db = {
    query: (text, params) => pg.query(text, params),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
  };
  async function admin<T>(fn: (q: QueryDb) => Promise<T>): Promise<T> {
    await pg.exec('reset role');
    try { return await fn(raw); } finally { await pg.exec('set role abos_app'); }
  }
  async function insert(table: string, row: Record<string, unknown>): Promise<void> {
    // Identifiers are test constants. Every value is a parameter.
    const columns = Object.keys(row);
    const values = Object.values(row).map((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v);
    await admin((q) => q.query(`insert into public.${table} (${columns.join(',')}) values (${columns.map((_, i) => `$${i + 1}`).join(',')})`, values));
  }
  return { pg, db, admin, insert, close: () => pg.close() };
}

/**
 * Test-only time travel: moves one PENDING approval `ms` into the past, as if that much time had
 * passed since it was created. The database clock cannot be faked, so this rewrites created_at,
 * expires_at and the signed expiresAt together (with a fresh canonical text and hash) as the owner,
 * with the guard trigger off for one statement. The decision path that follows is the real routine.
 * A client must reload the approval to see the new hash, exactly as after any change.
 */
export async function ageApproval(t: TestDb, approvalId: string, ms: number): Promise<void> {
  await t.admin(async (q) => {
    const row = (await q.query('select payload, created_at, expires_at from public.approval_requests where id=$1', [approvalId])).rows[0] as
      { payload: Record<string, unknown>; created_at: Date; expires_at: Date } | undefined;
    if (!row) throw new Error(`ageApproval: no approval ${approvalId}`);
    const expiresAt = new Date(row.expires_at.getTime() - ms);
    const payload = { ...row.payload, expiresAt: expiresAt.toISOString() };
    await q.query('alter table public.approval_requests disable trigger approval_requests_guard');
    try {
      await q.query(`update public.approval_requests set created_at=$2, expires_at=$3, payload=$4::jsonb, payload_canonical=$5, payload_hash=$6 where id=$1`,
        [approvalId, new Date(row.created_at.getTime() - ms), expiresAt, JSON.stringify(payload), canonicalJson(payload), await hashCanonical(payload)]);
    } finally {
      await q.query('alter table public.approval_requests enable always trigger approval_requests_guard');
    }
  });
}

/** Proves the connection really is the restricted role, so a test cannot pass by accident as the owner. */
export async function currentRole(db: QueryDb): Promise<string> {
  const row = (await db.query('select current_user as role')).rows[0] as { role: string };
  return row.role;
}
