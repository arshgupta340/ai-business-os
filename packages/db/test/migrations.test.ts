import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, checksums, readMigrations, type MigrationPool, type PooledSession } from '../src/migrate';
import { createApproval, createEmptyDb, createOrder, createOwner, insert, migrationDb } from './helpers';

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
    expect(files.length).toBe(7);
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

  it('a migration recorded from a CRLF checkout is the same migration in an LF checkout, and a real edit still stops the run', async () => {
    const lf = 'create table public.eol_probe (id int);\nselect 1;\n';
    expect(checksums(lf.replace(/\n/g, '\r\n'))).toEqual(checksums(lf));
    expect(checksums(lf).checksum).not.toBe(checksums(lf).alsoAccepted[0]);

    const files = readMigrations();
    const first = files[0]!;
    // Record the first file the way a Windows checkout did before this change: the CRLF checksum.
    await db.query('update public.schema_migrations set checksum = $1 where name = $2', [first.alsoAccepted![0], first.name]);
    try {
      const again = await applyMigrations(migrationDb(db), files);
      expect(again.applied).toEqual([]);
      expect(again.skipped).toContain(first.name);
      // A changed file is still refused, whichever form was recorded.
      const edited = files.map((f, i) => (i === 0 ? { ...f, ...checksums(`${f.sql}\n-- edited\n`) } : f));
      await expect(applyMigrations(migrationDb(db), edited)).rejects.toThrow(/content has changed/);
    } finally {
      await db.query('update public.schema_migrations set checksum = $1 where name = $2', [first.checksum, first.name]);
    }
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

describe('a run that stops after the table file leaves nothing exposed', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createEmptyDb();
    const throughTables = readMigrations().filter((f) => f.name < '0003');
    expect(throughTables.map((f) => f.name.slice(0, 4))).toEqual(['0001', '0002']);
    await applyMigrations(migrationDb(db), throughTables);
    const o = await createOwner(db);
    await createOrder(db, o);
    await createApproval(db, o);
    await insert(db, 'activity_events', { business_id: o.businessId, type: 'call.started', correlation_id: o.callId, actor_type: 'system' });
    await insert(db, 'webhook_events', { source: 'square', provider_event_id: 'p1', event_type: 'x' });
  });
  afterAll(async () => {
    await db.close();
  });

  async function publicTables(): Promise<{ name: string; col: string }[]> {
    const { rows } = await db.query<{ name: string; col: string }>(`
      select c.relname as name,
             (select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum = 1) as col
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`);
    return rows;
  }

  async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.exec('reset role');
    }
  }

  it('every public table has row level security already', async () => {
    const { rows } = await db.query(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  for (const role of ['anon', 'authenticated']) {
    it(`${role} can read no row and write nothing in any public table`, async () => {
      const tables = await publicTables();
      // The 21 SPEC tables plus schema_migrations.
      expect(tables.length).toBe(22);
      for (const t of tables) {
        const read = await as(role, () =>
          db.query(`select * from public.${t.name}`).then(
            (r) => String(r.rows.length),
            (e: Error) => e.message,
          ),
        );
        // Either no privilege at all, or the RLS policy returns nothing for a session with no owner.
        expect(read === '0' || /permission denied/.test(read), `${role} select ${t.name}: ${read}`).toBe(true);
        for (const sql of [
          `insert into public.${t.name} default values`,
          `update public.${t.name} set ${t.col} = ${t.col}`,
          `delete from public.${t.name}`,
          `truncate public.${t.name} cascade`,
        ]) {
          await expect(as(role, () => db.query(sql)), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
        }
      }
    });
  }
});

describe('function hardening', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createEmptyDb();
    await applyMigrations(migrationDb(db));
  });
  afterAll(async () => {
    await db.close();
  });

  it('every function the migrations create pins search_path to an empty string', async () => {
    const { rows } = await db.query<{ fn: string; config: string[] | null }>(`
      select n.nspname || '.' || p.proname as fn, p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prokind = 'f'`);
    expect(rows.length).toBe(51);
    for (const r of rows) expect(r.config, r.fn).toContain('search_path=""');
  });

  it('owns_business lives in private, is security definer, and only authenticated may run it', async () => {
    const { rows } = await db.query(`
      select p.prosecdef as definer,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             (select count(*)::int from pg_proc q join pg_namespace m on m.oid = q.pronamespace
              where m.nspname = 'public' and q.proname = 'owns_business') as in_public
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'owns_business'`);
    expect(rows[0]).toEqual({ definer: true, anon: false, authenticated: true, in_public: 0 });
  });

  it('anon cannot execute any function the migrations create', async () => {
    const { rows } = await db.query(`
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')`);
    expect(rows).toEqual([]);
  });

  it('the service role can still insert with gen_id defaults and fire the triggers', async () => {
    const o = await createOwner(db);
    await db.exec('set role service_role');
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.activity_events (business_id, type, correlation_id, actor_type)
         values ($1, 'call.started', 'call_x', 'system') returning id`,
        [o.businessId],
      );
      expect(rows[0]?.id).toMatch(/^evt_[0-9a-f]{32}$/);
      await db.query(`update public.businesses set name = 'Renamed' where id = $1`, [o.businessId]);
      await expect(db.query(`delete from public.activity_events`)).rejects.toThrow(/append only/);
    } finally {
      await db.exec('reset role');
    }
  });
});

function sessionOver(db: PGlite, onRelease: (err?: Error | boolean) => void): PooledSession {
  return {
    query: async (text, params) => {
      if (params) return db.query(text, params);
      const results = await db.exec(text);
      return results[results.length - 1] ?? { rows: [] };
    },
    release: onRelease,
  };
}

describe('applyMigrations with a pool pins one session', () => {
  it('checks out one client for the lock, every transaction and the unlock, then releases it', async () => {
    const sessions = [await createEmptyDb(), await createEmptyDb()];
    let connects = 0;
    let released = 0;
    let poolQueries = 0;
    // A pool that would hand each checkout, and each direct query, to a different session.
    const pool: MigrationPool & { query: () => Promise<never> } = {
      async connect() {
        const db = sessions[connects++ % sessions.length]!;
        return sessionOver(db, () => {
          released += 1;
        });
      },
      async query() {
        poolQueries += 1;
        throw new Error('pool.query must not be used: it can reach any session');
      },
    };
    try {
      const result = await applyMigrations(pool);
      expect(result.applied.length).toBe(readMigrations().length);
      expect({ connects, released, poolQueries }).toEqual({ connects: 1, released: 1, poolQueries: 0 });
      const first = await sessions[0]!.query(`select count(*)::int as n from public.schema_migrations`);
      expect(first.rows[0]).toEqual({ n: readMigrations().length });
      const second = await sessions[1]!.query(`select to_regclass('public.schema_migrations') as t`);
      expect(second.rows[0]).toEqual({ t: null });
    } finally {
      for (const s of sessions) await s.close();
    }
  }, 60_000);

  it('releases the client, flagged as broken, when a migration fails', async () => {
    const db = await createEmptyDb();
    let released: unknown = 'not released';
    const pool: MigrationPool = {
      async connect() {
        return sessionOver(db, (err) => {
          released = err;
        });
      },
    };
    try {
      const bad = { name: '0001_bad.sql', sql: 'select 1/0;', checksum: 'x' };
      await expect(applyMigrations(pool, [bad])).rejects.toThrow(/0001_bad.sql failed/);
      expect(released).toBeInstanceOf(Error);
    } finally {
      await db.close();
    }
  });
});

describe('guards and ACLs exist at the table migration boundary', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createEmptyDb();
    await applyMigrations(migrationDb(db), readMigrations().slice(0, 2));
  });
  afterAll(async () => { await db.close(); });
  it('all invariant triggers already exist and are ALWAYS enabled', async () => {
    const { rows } = await db.query<{ tgname: string; tgenabled: string }>(`
      select tgname, tgenabled from pg_trigger where not tgisinternal order by tgname`);
    for (const name of ['approval_requests_guard', 'action_executions_match_approval', 'message_dispatches_guard', 'activity_events_append_only', 'agent_versions_immutable']) {
      expect(rows.find(r => r.tgname === name)?.tgenabled, name).toBe('A');
    }
    expect(rows.every(r => r.tgenabled === 'A')).toBe(true);
  });
  it('authenticated can execute only the policy ownership function', async () => {
    const { rows } = await db.query(`
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute')`);
    expect(rows).toEqual([{ fn: 'private.owns_business' }]);
  });
  it('future public functions inherit no anon or authenticated execution', async () => {
    await db.exec(`create function public.future_helper() returns integer language sql set search_path = '' as 'select 1'`);
    try {
      const { rows } = await db.query(`select has_function_privilege('anon', 'public.future_helper()', 'execute') as anon,
        has_function_privilege('authenticated', 'public.future_helper()', 'execute') as authenticated`);
      expect(rows).toEqual([{ anon: false, authenticated: false }]);
    } finally { await db.exec('drop function public.future_helper()'); }
  });
  it('direct DML approval and deletion guards also run in replica mode', async () => {
    const o = await createOwner(db); const a = await createApproval(db, o);
    await db.exec(`set session_replication_role = replica`);
    try {
      await db.exec('set role service_role');
      try {
        await expect(db.query(`update public.approval_requests set state = 'APPROVED', decided_at = expires_at, decided_by = $2 where id = $1`, [a.id, o.userId])).rejects.toThrow(/owner and an unexpired/);
        await expect(db.query(`delete from public.approval_requests where id = $1`, [a.id])).rejects.toThrow(/cannot be deleted/);
      } finally { await db.exec('reset role'); }
    } finally { await db.exec('set session_replication_role = origin'); }
  });
});
