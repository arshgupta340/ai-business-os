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

export function createPool(env: Env): Pool {
  if (!env.DATABASE_URL) throw new AppError('INTEGRATION_UNAVAILABLE', 'Database is not configured.');
  // Do not let URL sslmode parameters replace the verified TLS configuration.
  const url = new URL(env.DATABASE_URL);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  return new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true } });
}

export const unavailableDb: Db = {
  async query() { throw new AppError('INTEGRATION_UNAVAILABLE', 'Database is not configured.'); },
  async transaction() { throw new AppError('INTEGRATION_UNAVAILABLE', 'Database is not configured.'); },
};
