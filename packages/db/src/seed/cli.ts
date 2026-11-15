// Command-line entry points behind scripts/seed.ts and scripts/reset.ts.
// Operator actions (D-10): they connect with DATABASE_ADMIN_URL, the owner connection, and never
// with DATABASE_URL. The connection is made the same way as the migration runner (src/migrate.ts):
// the connection string as given, so TLS follows its sslmode.

import { findEnvFile } from '../migrate';
import type { SeedDb } from './db';
import { MissingEnvError, envValue, requireEnv, type SeedEnv } from './env';
import { squareSandboxCatalogClient, supabaseAuthAdmin } from './providers';
import { ResetRefusedError, formatResetSummary, runReset } from './reset';
import { formatSeedSummary, formatTally, seedDatabase } from './seed';
import { requireSquareSandboxEnv, seedSquareCatalog } from './square';
import { seedDemoShop } from './demo-shop';

const ADMIN_HINT = 'Put it in .env.local. Seed and reset use the owner connection, never DATABASE_URL.';

function loadEnv(): string | undefined {
  const file = findEnvFile();
  // loadEnvFile does not overwrite variables already set in the shell.
  if (file) process.loadEnvFile(file);
  return file;
}

async function withAdminDb<T>(env: SeedEnv, fn: (db: SeedDb) => Promise<T>): Promise<T> {
  const { DATABASE_ADMIN_URL } = requireEnv(env, ['DATABASE_ADMIN_URL'], ADMIN_HINT);
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: DATABASE_ADMIN_URL });
  await client.connect();
  try {
    const db: SeedDb = {
      async query<R>(text: string, params?: unknown[]) {
        const r = await client.query(text, params);
        return { rows: r.rows as R[] };
      },
    };
    return await fn(db);
  } finally {
    await client.end();
  }
}

export async function seedMain(argv: string[]): Promise<void> {
  const envFile = loadEnv();
  const env: SeedEnv = process.env;
  if (argv.includes('square')) {
    const { accessToken } = requireSquareSandboxEnv(env);
    requireEnv(env, ['DATABASE_ADMIN_URL'], ADMIN_HINT);
    const summary = await withAdminDb(env, (db) => seedSquareCatalog(db, { env, client: squareSandboxCatalogClient(accessToken) }));
    console.log(summary.upserted
      ? `Square SANDBOX catalog upserted: ${summary.created.length} created, ${summary.updated.length} updated in place.`
      : 'Square SANDBOX catalog already matches the menu; no upsert sent.');
    for (const line of formatTally(summary.tables)) console.log(line);
    return;
  }

  const v = requireEnv(env, ['DATABASE_ADMIN_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], ADMIN_HINT);
  const auth = supabaseAuthAdmin(v.SUPABASE_URL!, v.SUPABASE_SERVICE_ROLE_KEY!);
  const summary = await withAdminDb(env, (db) =>
    seedDatabase(db, { env, auth, envFilePath: envFile, withDemoConflict: argv.includes('--with-demo-conflict') }));
  for (const line of formatSeedSummary(summary)) console.log(line);
}

/** npm run seed:demo-shop: the demo shop's menu (Square SANDBOX and catalog_items) and its verified facts. */
export async function demoShopMain(): Promise<void> {
  loadEnv();
  const env: SeedEnv = process.env;
  const { accessToken } = requireSquareSandboxEnv(env);
  requireEnv(env, ['DATABASE_ADMIN_URL'], ADMIN_HINT);
  const summary = await withAdminDb(env, (db) => seedDemoShop(db, { env, client: squareSandboxCatalogClient(accessToken) }));
  console.log(summary.catalog.upserted
    ? `Square SANDBOX catalog upserted: ${summary.catalog.created.length} created, ${summary.catalog.updated.length} updated in place.`
    : 'Square SANDBOX catalog already matches the demo shop menu; no upsert sent.');
  for (const line of formatTally(summary.catalog.tables)) console.log(line);
  for (const line of formatTally(summary.facts)) console.log(line);
  console.log(`Facts retired: ${summary.retired}.`);
}

export async function resetMain(argv: string[]): Promise<void> {
  loadEnv();
  const env: SeedEnv = process.env;
  const opts = { env, confirmed: argv.includes('--yes'), withDemoConflict: argv.includes('--with-demo-conflict') };
  // Refuse before connecting, so a missing --yes never opens a database session.
  if (!opts.confirmed || envValue(env, 'SQUARE_ENVIRONMENT') !== 'sandbox') {
    await runReset({ query: () => Promise.reject(new Error('unreachable')) }, opts);
  }
  const summary = await withAdminDb(env, (db) => runReset(db, opts));
  for (const line of formatResetSummary(summary)) console.log(line);
}

/** Prints only the message: a pg error object can echo connection details. */
export function runCli(main: (argv: string[]) => Promise<void>): void {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const known = err instanceof MissingEnvError || err instanceof ResetRefusedError;
    console.error(`${known ? '' : 'error: '}${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
