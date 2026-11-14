// AC-17: with an owner's session, a business-scoped table returns only that owner's rows.
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, createApproval, createMigratedDb, createOrder, createOwner, insert, type Owner } from './helpers';

let db: PGlite;
let a: Owner;
let b: Owner;

beforeAll(async () => {
  db = await createMigratedDb();
  a = await createOwner(db);
  b = await createOwner(db);
  for (const o of [a, b]) {
    await createOrder(db, o);
    await createApproval(db, o);
    await insert(db, 'activity_events', { business_id: o.businessId, type: 'call.started', correlation_id: o.callId, actor_type: 'system' });
  }
});
afterAll(async () => {
  await db.close();
});

const SCOPED = ['orders', 'approval_requests', 'activity_events', 'agents', 'agent_versions', 'calls'];

describe('row level security', () => {
  it('owner A sees only business A, and owner B only business B', async () => {
    const seenByA = await asOwner(db, a.authUserId, () => db.query<{ id: string }>('select id from public.businesses'));
    expect(seenByA.rows.map((r) => r.id)).toEqual([a.businessId]);
    const seenByB = await asOwner(db, b.authUserId, () => db.query<{ id: string }>('select id from public.businesses'));
    expect(seenByB.rows.map((r) => r.id)).toEqual([b.businessId]);
  });

  for (const table of SCOPED) {
    it(`${table}: owner A gets rows of business A and none of business B`, async () => {
      const all = await db.query<{ business_id: string }>(`select business_id from public.${table}`);
      expect(all.rows.some((r) => r.business_id === b.businessId)).toBe(true);
      const { rows } = await asOwner(db, a.authUserId, () =>
        db.query<{ business_id: string }>(`select business_id from public.${table}`),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.business_id === a.businessId)).toBe(true);
    });
  }

  it('users: an owner sees only their own profile', async () => {
    const { rows } = await asOwner(db, a.authUserId, () => db.query<{ id: string }>('select id from public.users'));
    expect(rows.map((r) => r.id)).toEqual([a.userId]);
  });

  it('a session with no user sees no business rows', async () => {
    const { rows } = await asOwner(db, '00000000-0000-0000-0000-000000000000', () => db.query('select id from public.orders'));
    expect(rows).toEqual([]);
  });

  it('authenticated cannot insert, update or delete anything', async () => {
    await asOwner(db, a.authUserId, async () => {
      await expect(
        db.query(`insert into public.activity_events (business_id, type, correlation_id, actor_type)
                  values ($1, 'call.started', 'x', 'owner')`, [a.businessId]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query(`update public.orders set total_minor = 0`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`delete from public.businesses`)).rejects.toThrow(/permission denied/);
    });
  });

  it('anon can read nothing', async () => {
    await db.exec('set role anon');
    try {
      await expect(db.query('select id from public.businesses')).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('reset role');
    }
  });

  it('webhook_events is closed to authenticated (no policy)', async () => {
    await insert(db, 'webhook_events', { source: 'square', provider_event_id: 'rls_1', event_type: 'x', business_id: a.businessId });
    const { rows } = await asOwner(db, a.authUserId, () => db.query('select id from public.webhook_events'));
    expect(rows).toEqual([]);
  });
});
