import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { applyMigrations } from '@abos/db';
import { CAPABILITY_LIST, cartHash, QUOTE_EXPIRY_MS, type Cart } from '@abos/contracts';
import type { PolicyDb } from '../../src/policy/types';

export async function harness() {
  const pg = await PGlite.create({ extensions: { btree_gist } });
  await pg.exec(readFileSync(new URL('../../../../packages/db/test/supabase-prelude.sql', import.meta.url), 'utf8'));
  await applyMigrations({ exec: (sql) => pg.exec(sql), query: (sql, params) => pg.query(sql, params) });
  for (const c of CAPABILITY_LIST) {
    await pg.query(`insert into capabilities (id, description, effect, approval_mode, handler_id, input_schema, output_schema, tier)
      values ($1,$2,$3,$4,$5,'{}','{}',$6)`, [c.id, c.description, c.effect, c.approvalMode, c.handlerId, c.tier]);
  }
  const db: PolicyDb = {
    query: (sql, params) => pg.query(sql, params),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  };
  return { pg, db };
}
let sequence = 0;
export const newId = (prefix: string) => `${prefix}${++sequence}`;
export async function seed(db: PolicyDb) {
  const ownerUserId = newId('usr_');
  const businessId = newId('biz_');
  const otherBusinessId = newId('biz_');
  const agentId = newId('agt_');
  const agentVersionId = newId('agv_');
  const callId = newId('call_');
  await db.query('insert into auth.users (id) values ($1)', [`00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`]);
  await db.query('insert into users (id,auth_user_id,email) select $1,id,$2 from auth.users where id=$3', [ownerUserId, `${ownerUserId}@example.test`, `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`]);
  for (const id of [businessId, otherBusinessId]) await db.query("insert into businesses (id,owner_id,name,category,timezone) values ($1,$2,'Demo','restaurant','America/Los_Angeles')", [id, ownerUserId]);
  await db.query("insert into agents (id,business_id,name,template) values ($1,$2,'Agent','restaurant_order_taker')", [agentId, businessId]);
  await db.query("insert into agent_versions (id,business_id,agent_id,version,spec) values ($1,$2,$3,1,'{}')", [agentVersionId, businessId, agentId]);
  await db.query("insert into calls (id,business_id,agent_id,agent_version_id,channel,stage) values ($1,$2,$3,$4,'test_console','CUSTOMER_CONFIRMED')", [callId, businessId, agentId, agentVersionId]);
  return { ownerUserId, businessId, otherBusinessId, agentVersionId, callId };
}
export async function orderInput(ids: Awaited<ReturnType<typeof seed>>, now: Date) {
  const cart: Cart = { lines: [{ catalogItemId: 'pizza', variationId: 'large', quantity: 1, modifierIds: [] }] };
  return { businessId: ids.businessId, callId: ids.callId, agentVersionId: ids.agentVersionId, cart,
    quote: { quoteId: newId('qte_'), cartHash: await cartHash(cart), subtotalMinor: 1000, taxMinor: 100,
      totalMinor: 1100, currency: 'USD' as const, lines: [], quotedAt: now.toISOString(), expiresAt: new Date(now.getTime() + QUOTE_EXPIRY_MS).toISOString() },
    contact: { name: 'Test Customer', messageRecipient: '+15555550123', messageConsent: true as const, consentAt: now.toISOString() },
    fulfillment: { type: 'pickup' as const, pickupAt: new Date(now.getTime() + 3600000).toISOString() }, messageChannel: 'surge' as const };
}
