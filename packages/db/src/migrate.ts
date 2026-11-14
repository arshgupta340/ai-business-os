// Applies packages/db/migrations/*.sql in name order to the database at DATABASE_URL.
// Each file runs in its own transaction and is recorded in public.schema_migrations with
// its SHA-256 checksum. A file already recorded is skipped, so running twice changes nothing.
// A recorded file whose content has changed stops the run: write a new migration instead.
//
// Usage: npm run migrate -w @abos/db

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * One database session: every call must reach the same connection. A pg Client or a PGlite
 * instance fits through a thin adapter. Do not wrap a pg Pool in this; pass the pool itself.
 */
export interface MigrationDb {
  /** Runs one or more SQL statements with no parameters. */
  exec(sql: string): Promise<unknown>;
  /** Runs one statement with positional parameters. */
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** A connection pool, such as a pg Pool. The runner checks out one client for the whole run. */
export interface MigrationPool {
  connect(): Promise<PooledSession>;
}

/** A checked-out pool client, such as a pg PoolClient. */
export interface PooledSession {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
// Any fixed number works; it only has to be the same for every run of this runner.
const ADVISORY_LOCK_KEY = 4206001;

export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => MIGRATION_NAME.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      return { name, sql, checksum };
    });
}

/**
 * Applies every file not yet recorded. Given a pool, it checks out one client and runs the lock,
 * every transaction and the unlock on that client, then releases it. Given a MigrationDb, it uses
 * that single session as it is.
 */
export async function applyMigrations(
  target: MigrationDb | MigrationPool,
  files: MigrationFile[] = readMigrations(),
  log: (line: string) => void = () => {},
): Promise<MigrateResult> {
  if ('exec' in target) return runOnSession(target, files, log);
  const session = await target.connect();
  if (!session || typeof session.query !== 'function' || typeof session.release !== 'function') {
    throw new Error('applyMigrations needs a pool whose connect() returns a client, or a MigrationDb adapter.');
  }
  let failed: Error | undefined;
  try {
    const pinned: MigrationDb = {
      exec: (sql) => session.query(sql),
      query: (text, params) => session.query(text, params),
    };
    return await runOnSession(pinned, files, log);
  } catch (err) {
    failed = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    // Passing the error tells a pg Pool to discard the client instead of reusing it.
    session.release(failed ?? false);
  }
}

async function runOnSession(
  db: MigrationDb,
  files: MigrationFile[],
  log: (line: string) => void,
): Promise<MigrateResult> {
  // Two runners started at once wait for each other instead of applying the same file twice.
  await db.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await db.exec(`
      create table if not exists public.schema_migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      );
      alter table public.schema_migrations enable row level security;
      do $$
      begin
        -- On Supabase, close the bookkeeping table to the API roles. Plain Postgres has no such roles.
        if exists (select 1 from pg_roles where rolname = 'anon') then
          revoke all on public.schema_migrations from anon;
        end if;
        if exists (select 1 from pg_roles where rolname = 'authenticated') then
          revoke all on public.schema_migrations from authenticated;
        end if;
      end $$;
    `);
    const { rows } = await db.query('select name, checksum from public.schema_migrations');
    const done = new Map((rows as { name: string; checksum: string }[]).map((r) => [r.name, r.checksum]));
    const result: MigrateResult = { applied: [], skipped: [] };

    for (const file of files) {
      const recorded = done.get(file.name);
      if (recorded !== undefined) {
        if (recorded !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was already applied but its content has changed. ` +
              'Do not edit an applied migration; add a new file instead.',
          );
        }
        result.skipped.push(file.name);
        continue;
      }
      await db.exec('begin');
      try {
        await db.exec(file.sql);
        await db.query('insert into public.schema_migrations (name, checksum) values ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await db.exec('commit');
      } catch (err) {
        await db.exec('rollback');
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${file.name} failed and was rolled back: ${message}`);
      }
      result.applied.push(file.name);
      log(`applied ${file.name}`);
    }
    return result;
  } finally {
    await db.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}

/** Walks up from start until it finds .env.local. Returns its path, or undefined. */
export function findEnvFile(start: string = process.cwd(), name = '.env.local'): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function main(): Promise<void> {
  const envFile = findEnvFile();
  // loadEnvFile does not overwrite variables already set in the shell.
  if (envFile) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Put it in .env.local or the shell environment.');
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const db: MigrationDb = {
      exec: (sql) => client.query(sql),
      query: (text, params) => client.query(text, params),
    };
    const files = readMigrations();
    const result = await applyMigrations(db, files, (line) => console.log(line));
    console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} already applied`);
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    // Print only the message: a pg error object can echo connection details.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
