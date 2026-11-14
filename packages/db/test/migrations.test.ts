import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, readMigrations } from '../src/migrate';
import { createEmptyDb, migrationDb } from './helpers';

// SPEC 2.7: the PRD's seventeen tables plus the four added ones.
const SPEC_TABLES = [
  'users', 'businesses', 'business_facts', 'files', 'integrations', 'capabilities', 'agents', 'agent_versions',
  'builder_sessions', 'calls', 'orders', 'bookings', 'approval_requests', 'action_executions', 'webhook_events',
  'activity_events', 'sync_jobs',
  'catalog_items', 'message_dispatches', 'live_agent', 'fact_conflicts',
];

async function schemaSnapshot(db: PGlite): Promise<unknown> {
  const objects = await db.query(`
    select c.relkind::text as kind, c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' order by 1, 2`);
  const constraints = await db.query(`
    select conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public' order by 1`);
  const triggers = await db.query(`select tgname from pg_trigger where not tgisinternal order by 1`);
  const policies = await db.query(`select tablename, policyname from pg_policies order by 1, 2`);
  const recorded = await db.query(`select name, checksum from public.schema_migrations order by name`);
  return { objects: objects.rows, constraints: constraints.rows, triggers: triggers.rows, policies: policies.rows, recorded: recorded.rows };
}

describe('migrations', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createEmptyDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('apply cleanly to an empty database, in name order', async () => {
    const files = readMigrations();
    expect(files.length).toBeGreaterThanOrEqual(6);
    const result = await applyMigrations(migrationDb(db), files);
    expect(result.applied).toEqual(files.map((f) => f.name));
    expect(result.skipped).toEqual([]);
  });

  it('change nothing when the runner runs a second time', async () => {
    const before = await schemaSnapshot(db);
    const result = await applyMigrations(migrationDb(db));
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBe(readMigrations().length);
    expect(await schemaSnapshot(db)).toEqual(before);
  });

  it('refuse to continue when an applied file has been edited', async () => {
    const files = readMigrations();
    const edited = files.map((f, i) => (i === 0 ? { ...f, checksum: 'different' } : f));
    await expect(applyMigrations(migrationDb(db), edited)).rejects.toThrow(/content has changed/);
  });

  it('roll back a failing file and record nothing for it', async () => {
    const bad = { name: '9999_bad.sql', sql: 'create table public.half_done (id int); select 1/0;', checksum: 'x' };
    await expect(applyMigrations(migrationDb(db), [...readMigrations(), bad])).rejects.toThrow(/9999_bad.sql failed/);
    const { rows } = await db.query(`select to_regclass('public.half_done') as t,
      (select count(*)::int from public.schema_migrations where name = '9999_bad.sql') as n`);
    expect(rows[0]).toEqual({ t: null, n: 0 });
  });

  it('create every table named in SPEC 2.7', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of SPEC_TABLES) expect(names, t).toContain(t);
    expect(SPEC_TABLES.length).toBe(21);
  });

  it('enable row level security on every SPEC 2.7 table', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    for (const t of SPEC_TABLES) expect(rows.find((r) => r.relname === t)?.relrowsecurity, t).toBe(true);
  });

  it('add activity_events to the supabase_realtime publication', async () => {
    const { rows } = await db.query(
      `select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime'`,
    );
    expect(rows).toEqual([{ schemaname: 'public', tablename: 'activity_events' }]);
  });

  it('attach the updated_at trigger to every table with an updated_at column', async () => {
    const { rows } = await db.query<{ table_name: string; has_trigger: boolean }>(`
      select c.table_name,
             exists (select 1 from pg_trigger t where t.tgrelid = ('public.' || c.table_name)::regclass
                     and t.tgname = c.table_name || '_set_updated_at') as has_trigger
      from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'updated_at'`);
    expect(rows.length).toBe(10);
    for (const r of rows) expect(r.has_trigger, r.table_name).toBe(true);
  });
});
