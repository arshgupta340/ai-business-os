// Live run 2026-11-14: the server clock ran about 7 seconds behind the database clock. Rows the server
// inserted carried the server's time and rows the routines inserted carried the database's, so the feed
// (ordered by occurred_at) showed APPROVED after PAYMENT_PENDING. Every row now takes the database clock.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { notWiredExecutor } from '../../src/compose/seams';
import { emitActivity } from '../../src/policy/activity';
import { createWorld, type World } from './world';

let w: World;
beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor }); }, 120_000);
afterAll(async () => { await w?.close(); });

it('stores occurred_at from the database clock, whatever the server clock says', async () => {
  const skewed = new Date(Date.now() - 3_600_000).toISOString();
  await emitActivity(w.t.db, { id: 'evt_clock_1', businessId: 'biz_pizza_01', type: 'sync.queued', correlationId: 'job_clock_1', actorType: 'system',
    occurredAt: skewed, payload: { target: 'catalog', jobId: 'job_clock_1' } });
  const row = (await w.t.db.query("select extract(epoch from (clock_timestamp() - occurred_at))::float as age from activity_events where id = 'evt_clock_1'", [])).rows[0] as { age: number };
  expect(row.age).toBeGreaterThanOrEqual(0);
  expect(row.age).toBeLessThan(60);
});
