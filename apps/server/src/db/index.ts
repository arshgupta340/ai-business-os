import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { Pool } from 'pg';
import type { Env } from '../env';
import { AppError } from '../errors';

export interface QueryDb {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
export interface Db extends QueryDb {
  transaction<T>(fn: (tx: QueryDb) => Promise<T>): Promise<T>;
}
export interface DbPool extends QueryDb {
  connect(): Promise<QueryDb & { release(error?: Error | boolean): void }>;
}

export function createDb(pool: DbPool): Db {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction<T>(fn: (tx: QueryDb) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const value = await fn({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return value;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
        throw error;
      } finally {
        client.release(broken);
      }
    },
  };
}

// TLS to the Supabase session pooler. Its certificate chains to Supabase's own private root
// ("Supabase Root 2021 CA"), not to a public CA, so Node's default trust store alone refuses it
// (SELF_SIGNED_CERT_IN_CHAIN, checked 2026-11-13). The server trusts the default store plus that
// one public root certificate, and keeps full verification, including the host name.
//   File:   apps/server/certs/supabase-root-2021-ca.crt (public certificate, not a secret)
//   Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
//           the file the dashboard's Database Settings > SSL Configuration "Download certificate"
//           button serves (docs: https://supabase.com/docs/guides/platform/ssl-enforcement)
//   SHA-256 of the file: 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7
//   Valid 2021-04-28 to 2031-04-26.
export const SUPABASE_ROOT_CA_SHA256 = '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';
const SUPABASE_ROOT_CA_FILE = new URL('../../certs/supabase-root-2021-ca.crt', import.meta.url);

/** The pinned root, refused if the file on disk is not the one recorded above. */
export function supabaseRootCa(): string {
  const pem = readFileSync(SUPABASE_ROOT_CA_FILE);
  if (createHash('sha256').update(pem).digest('hex') !== SUPABASE_ROOT_CA_SHA256) {
    throw new Error('The Supabase root certificate file does not match its recorded SHA-256.');
  }
  return pem.toString('utf8');
}

/** Verified TLS options: the default public roots plus the Supabase root. Never rejectUnauthorized: false. */
export function databaseTls(): { rejectUnauthorized: true; ca: string[] } {
  return { rejectUnauthorized: true, ca: [...rootCertificates, supabaseRootCa()] };
}

export function createPool(env: Env): Pool {
  if (!env.DATABASE_URL) throw new AppError('INTEGRATION_UNAVAILABLE', 'Database is not configured.');
  // Do not let URL sslmode parameters replace the verified TLS configuration.
  const url = new URL(env.DATABASE_URL);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const pool = new Pool({ connectionString: url.toString(), ssl: databaseTls(), max: 5, connectionTimeoutMillis: 10_000 });
  // An idle client error (for example the pooler closing a connection) must not crash the process.
  pool.on('error', () => undefined);
  return pool;
}

export const unavailableDb: Db = {
  async query() { throw new AppError('INTEGRATION_UNAVAILABLE', 'Database is not configured.'); },
  async transaction() { throw new AppError('INTEGRATION_UNAVAILABLE', 'Database is not configured.'); },
};
