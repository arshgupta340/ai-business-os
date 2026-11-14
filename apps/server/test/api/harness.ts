import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { applyMigrations } from '@abos/db';
import { ApprovalRequestSchema, type ApprovalRequest } from '@abos/contracts';
import type { Db } from '../../src/db/index';
import type { TokenVerifier } from '../../src/auth/verify';
import { mapRow } from '../../src/api/rows';

export const HASH = `sha256:${'a'.repeat(64)}`;
export const NOW = '2026-11-13T12:00:00.000Z';
export const verifier: TokenVerifier = {
  async verify(token) {
    if (token !== 'a' && token !== 'b') throw new Error('Invalid token');
    return { authUserId: token === 'a' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002' };
  },
};
export const headers = { authorization: 'Bearer a' };

export async function createHarness() {
  const pg = await PGlite.create({ extensions: { btree_gist } });
  await pg.exec(readFileSync(new URL('../../../../packages/db/test/supabase-prelude.sql', import.meta.url), 'utf8'));
  await applyMigrations({ exec: (sql) => pg.exec(sql), query: (text, params) => pg.query(text, params) });
  const db: Db = {
    query: (text, params) => pg.query(text, params),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
  };
  async function insert(table: string, row: Record<string, unknown>) {
    // Identifiers are test fixture constants. Every value is a SQL parameter.
    const columns = Object.keys(row);
    const values = Object.values(row).map((value) => value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value);
    await pg.query(`insert into public.${table} (${columns.join(',')}) values (${columns.map((_, i) => `$${i + 1}`).join(',')})`, values);
  }
  const approvals: ApprovalRequest[] = [];
  for (const owner of ['a', 'b']) {
    const authId = owner === 'a' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002';
    await pg.query('insert into auth.users (id, email) values ($1, $2)', [authId, `${owner}@example.test`]);
    await insert('users', { id: `usr_${owner}`, auth_user_id: authId, email: `${owner}@example.test` });
    await insert('businesses', { id: `biz_${owner}`, owner_id: `usr_${owner}`, name: `Business ${owner}`, category: 'restaurant', timezone: 'America/Los_Angeles' });
    await insert('agents', { id: `agt_${owner}`, business_id: `biz_${owner}`, name: 'Agent', template: 'restaurant_order_taker' });
    await insert('agent_versions', { id: `agv_${owner}`, business_id: `biz_${owner}`, agent_id: `agt_${owner}`, version: 1, spec: {}, published_at: NOW });
    await pg.query("update public.agents set state = 'live', active_version_id = $1 where id = $2", [`agv_${owner}`, `agt_${owner}`]);
    for (let i = 1; i <= 3; i++) {
      const suffix = `${owner}${i}`;
      await insert('calls', { id: `call_${suffix}`, business_id: `biz_${owner}`, agent_id: `agt_${owner}`, agent_version_id: `agv_${owner}`, channel: 'test_console', stage: 'CALL_STARTED', started_at: NOW });
      await insert('orders', {
        id: `ord_${suffix}`, business_id: `biz_${owner}`, call_id: `call_${suffix}`, cart_hash: HASH,
        cart: { lines: [{ catalogItemId: 'item', variationId: 'var', quantity: 1, modifierIds: [] }] },
        quote: { quoteId: `qte_${suffix}`, cartHash: HASH, subtotalMinor: 1000, taxMinor: 0, totalMinor: 1000, currency: 'USD', lines: [], quotedAt: NOW, expiresAt: '2026-11-13T12:05:00.000Z' },
        total_minor: 1000, currency: 'USD',
        contact: { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: NOW },
        fulfillment: { type: 'pickup', pickupAt: '2026-11-13T13:00:00.000Z' }, created_at: NOW,
      });
      await insert('bookings', { id: `bkg_${suffix}`, business_id: `biz_${owner}`, service_id: 'svc_cut', service_name: 'Haircut', calendar_id: 'calendar',
        start_utc: '2026-11-20T12:00:00Z', end_utc: '2026-11-20T12:30:00Z', timezone: 'America/Los_Angeles',
        customer: { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true }, created_at: NOW });
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + 600_000).toISOString();
      await insert('approval_requests', { id: `apv_${suffix}`, business_id: `biz_${owner}`, actor_type: 'owner', actor_id: `usr_${owner}`,
        bundle_type: 'fact_edit', action_bundle: ['local.fact.update'], subject_id: `fact_${suffix}`, payload_hash: HASH,
        created_at: createdAt, expires_at: expiresAt,
        payload: { businessId: `biz_${owner}`, subjectId: `fact_${suffix}`, kind: 'policy', key: `policy${i}`, fromVersion: 0,
          before: null, after: { minutes: 20 }, actionBundle: ['local.fact.update'], expiresAt } });
      await insert('business_facts', { id: `fact_${suffix}`, business_id: `biz_${owner}`, kind: 'policy', key: `policy${i}`, value: { field_with_underscore: null }, source_type: 'seed' });
      await insert('activity_events', { id: `evt_${suffix}`, business_id: `biz_${owner}`, type: 'call.started', correlation_id: `call_${suffix}`, actor_type: 'system', occurred_at: NOW,
        payload: { callId: `call_${suffix}`, agentId: `agt_${owner}`, agentVersionId: `agv_${owner}`, channel: 'test_console' } });
      await insert('catalog_items', { id: `cat_${suffix}`, business_id: `biz_${owner}`, square_item_id: `ITEM_${owner}`, square_variation_id: `VAR_${suffix}`,
        square_item_version: 1, square_variation_version: 1, item_name: `Pizza ${owner}`, variation_name: String(i), price_minor: i * 100, synced_at: NOW });
    }
    const result = await pg.query('select * from public.approval_requests where business_id = $1', [`biz_${owner}`]);
    approvals.push(...result.rows.map((row) => ApprovalRequestSchema.parse(mapRow(row))));
  }
  return { pg, db, approvals, insert };
}
