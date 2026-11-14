// Phase 3 wiring: owner decisions reach the live call, and GET /health?refresh=1 checks the database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { createCallDecisions } from '../../src/compose/decisions';
import type { QueryDb } from '../../src/db/index';
import { parseEnv } from '../../src/env';
import type { CallDecision } from '../../src/voice/types';
import { createHarness, verifier } from '../api/harness';

const rowDb = (row: Record<string, unknown> | undefined): QueryDb => ({ query: async () => ({ rows: row ? [row] : [] }) as never });

describe('call decisions bus', () => {
  it('delivers an approval to the subscribers of its call only, never claiming a sent message', async () => {
    const bus = createCallDecisions();
    const got: CallDecision[] = [];
    const other: CallDecision[] = [];
    const off = bus.subscribe('call_a', (d) => got.push(d));
    bus.subscribe('call_b', (d) => other.push(d));
    await bus.publish(rowDb({ subject_id: 'ord_1', call_id: 'call_a' }), { businessId: 'biz_a', approvalId: 'apv_1', state: 'APPROVED' });
    expect(got).toEqual([{ kind: 'approved', messageSent: false, proposalId: 'ord_1', approvalId: 'apv_1' }]);
    expect(other).toEqual([]);
    await bus.publish(rowDb({ subject_id: 'ord_1', call_id: 'call_a' }), { businessId: 'biz_a', approvalId: 'apv_1', state: 'EXPIRED' });
    expect(got.at(-1)).toEqual({ kind: 'expired', proposalId: 'ord_1', approvalId: 'apv_1' });
    off();
    await bus.publish(rowDb({ subject_id: 'ord_1', call_id: 'call_a' }), { businessId: 'biz_a', approvalId: 'apv_1', state: 'REJECTED' });
    expect(got).toHaveLength(2);
  });
  it('publishes nothing for a pending approval, a fact edit or a subject without a call', async () => {
    const bus = createCallDecisions();
    const got: CallDecision[] = [];
    bus.subscribe('call_a', (d) => got.push(d));
    await bus.publish(rowDb({ subject_id: 'ord_1', call_id: 'call_a' }), { businessId: 'biz_a', approvalId: 'apv_1', state: 'PENDING' });
    await bus.publish(rowDb({ subject_id: 'fact_1', call_id: null }), { businessId: 'biz_a', approvalId: 'apv_2', state: 'APPROVED' });
    await bus.publish(rowDb(undefined), { businessId: 'biz_a', approvalId: 'apv_3', state: 'APPROVED' });
    expect(got).toEqual([]);
  });
});

describe('GET /health database check', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeAll(async () => { h = await createHarness(); }, 60_000);
  afterAll(async () => { await h?.close(); });
  it('runs select 1 only on refresh=1', async () => {
    const app = await buildApp(parseEnv({}), { db: h.db, verifier });
    try {
      expect((await app.inject({ url: '/health' })).json()).not.toHaveProperty('database');
      expect((await app.inject({ url: '/health?refresh=1' })).json()).toMatchObject({ ok: true, database: 'ok' });
    } finally { await app.close(); }
  });
  it('reports not_configured without a database', async () => {
    const app = await buildApp(parseEnv({}), { verifier });
    try { expect((await app.inject({ url: '/health?refresh=1' })).json()).toMatchObject({ database: 'not_configured' }); }
    finally { await app.close(); }
  });
});
