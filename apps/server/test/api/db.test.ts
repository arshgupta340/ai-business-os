import { rootCertificates } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createDb, createPool, supabaseRootCa, type DbPool } from '../../src/db/index';
import { parseEnv } from '../../src/env';

function poolFixture(fail?: string) {
  const statements: string[] = [];
  const release = vi.fn();
  const poolQuery = vi.fn(async () => ({ rows: [] }));
  const connect = vi.fn(async () => ({
    async query(text: string, params?: unknown[]) {
      statements.push(text);
      if (text === fail) throw new Error('database failure');
      return { rows: params ?? [] };
    },
    release,
  }));
  const pool: DbPool = { query: poolQuery, connect };
  return { db: createDb(pool), statements, release, poolQuery, connect };
}

describe('database session wrapper', () => {
  it('pins one client for BEGIN, callback queries and COMMIT, then releases it', async () => {
    const f = poolFixture();
    expect(await f.db.transaction(async (tx) => {
      const result = await tx.query('select $1', [42]);
      await tx.query('select 2');
      return result.rows[0];
    })).toBe(42);
    expect(f.statements).toEqual(['BEGIN', 'select $1', 'select 2', 'COMMIT']);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.poolQuery).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(false);
  });
  it('rolls back errors and releases the client without hiding the original error', async () => {
    const f = poolFixture();
    const original = new Error('callback failed');
    await expect(f.db.transaction(async (tx) => { await tx.query('select 1'); throw original; })).rejects.toBe(original);
    expect(f.statements).toEqual(['BEGIN', 'select 1', 'ROLLBACK']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('discards the client when rollback fails', async () => {
    const f = poolFixture('ROLLBACK');
    const original = new Error('callback failed');
    await expect(f.db.transaction(async () => { throw original; })).rejects.toBe(original);
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it('rolls back a failed commit and releases the client', async () => {
    const f = poolFixture('COMMIT');
    await expect(f.db.transaction(async () => 1)).rejects.toThrow('database failure');
    expect(f.statements).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('forwards ordinary queries without checking out a transaction client', async () => {
    const f = poolFixture();
    await f.db.query('select $1', ['value']);
    expect(f.poolQuery).toHaveBeenCalledWith('select $1', ['value']);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('requires a configured database and uses verified TLS even if the URL disables it', async () => {
    expect(() => createPool(parseEnv({}))).toThrow('not configured');
    const pool = createPool(parseEnv({ DATABASE_URL: 'postgresql://test:dummy@localhost/db?sslmode=disable' }));
    try {
      const ssl = pool.options.ssl as { rejectUnauthorized: boolean; ca: string[] };
      expect(ssl.rejectUnauthorized).toBe(true);
      // Default public roots plus the pinned Supabase root, never a replacement of the default store.
      expect(ssl.ca.length).toBe(rootCertificates.length + 1);
      expect(ssl.ca.at(-1)).toBe(supabaseRootCa());
      expect(ssl.ca.at(-1)).toContain('BEGIN CERTIFICATE');
      expect(pool.options.connectionString).not.toContain('sslmode');
    } finally { await pool.end(); }
  });
  // Review finding 1: pg reparses the connection string in each Client, and its ssl setting there
  // overrides the pool's. Check the EFFECTIVE client parameters, not the pool options.
  it.each(['ssl=0', 'ssl=1', 'ssl=true', 'ssl=false', 'sslmode=disable', 'sslmode=require', 'sslmode=no-verify', 'sslmode=verify-full',
    'sslrootcert=/tmp/x.crt', 'SSL=0', 'ssl=0&sslmode=disable&uselibpqcompat=true'])('the effective client TLS stays pinned with %s in the URL', async (query) => {
    const pool = createPool(parseEnv({ DATABASE_URL: `postgresql://test:dummy@localhost/db?${query}` }));
    try {
      const client = new pg.Client(pool.options) as unknown as { connectionParameters: { ssl: unknown } };
      const ssl = client.connectionParameters.ssl as { rejectUnauthorized?: boolean; ca?: string[] };
      expect(typeof ssl).toBe('object');
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca?.at(-1)).toBe(supabaseRootCa());
      expect(ssl.ca?.length).toBe(rootCertificates.length + 1);
    } finally { await pool.end(); }
  });
});
