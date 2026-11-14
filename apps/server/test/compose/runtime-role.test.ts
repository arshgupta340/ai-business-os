// 0006 startup check: the server refuses to start unless it connects as the restricted abos_app role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeServer } from '../../src/compose/index';
import { parseEnv } from '../../src/env';
import type { Db } from '../../src/db/index';
import { createTestDb, type TestDb } from '../support/db';

const env = parseEnv({ SQUARE_ENVIRONMENT: 'sandbox' });

describe('startup runtime role check', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.close(); });

  it('passes as abos_app on the migrated test database', async () => {
    await expect(composeServer(env, { db: t.db }).assertRuntimeRole()).resolves.toBeUndefined();
  });

  it('refuses the migration owner (a role that can write protected tables)', async () => {
    const owner: Db = {
      query: (text, params) => t.admin((q) => q.query(text, params)),
      transaction: (fn) => t.admin((q) => fn(q)),
    };
    await expect(composeServer(env, { db: owner }).assertRuntimeRole()).rejects.toThrow(/not the restricted abos_app role/);
  });

  it('refuses when the check itself cannot run', async () => {
    const broken: Db = { query: async () => { throw new Error('permission denied'); }, transaction: async () => { throw new Error('permission denied'); } };
    await expect(composeServer(env, { db: broken }).assertRuntimeRole()).rejects.toThrow(/not the restricted abos_app role/);
  });

  it('has nothing to check without a database', async () => {
    await expect(composeServer(env).assertRuntimeRole()).resolves.toBeUndefined();
  });
});
