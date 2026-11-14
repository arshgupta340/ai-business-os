import { cartHash, QUOTE_EXPIRY_MS, type Cart } from '@abos/contracts';
import { createTestDb, type TestDb } from '../support/db';

export { createTestDb, type TestDb };

let sequence = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${++sequence}`;

/** One owner with two businesses, one live agent version and one call, written as the owner role. */
export async function seed(t: TestDb) {
  const n = ++sequence;
  const ownerUserId = newId('usr_');
  const businessId = newId('biz_');
  const otherBusinessId = newId('biz_');
  const agentId = newId('agt_');
  const agentVersionId = newId('agv_');
  const callId = newId('call_');
  const authId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await t.admin(async (q) => {
    await q.query('insert into auth.users (id, email) values ($1, $2)', [authId, `${ownerUserId}@example.test`]);
    await q.query('insert into public.users (id, auth_user_id, email) values ($1, $2, $3)', [ownerUserId, authId, `${ownerUserId}@example.test`]);
    for (const id of [businessId, otherBusinessId]) {
      await q.query("insert into public.businesses (id, owner_id, name, category, timezone) values ($1, $2, 'Demo', 'restaurant', 'America/Los_Angeles')", [id, ownerUserId]);
    }
    await q.query("insert into public.agents (id, business_id, name, template) values ($1, $2, 'Agent', 'restaurant_order_taker')", [agentId, businessId]);
    await q.query("insert into public.agent_versions (id, business_id, agent_id, version, spec, published_at) values ($1, $2, $3, 1, '{}', now())", [agentVersionId, businessId, agentId]);
    await q.query("update public.agents set state = 'live', active_version_id = $1 where id = $2", [agentVersionId, agentId]);
    await q.query("insert into public.calls (id, business_id, agent_id, agent_version_id, channel, stage) values ($1, $2, $3, $4, 'test_console', 'CUSTOMER_CONFIRMED')", [callId, businessId, agentId, agentVersionId]);
  });
  return { ownerUserId, businessId, otherBusinessId, agentId, agentVersionId, callId };
}
export type Seeded = Awaited<ReturnType<typeof seed>>;

export async function orderInput(ids: Seeded, now: Date) {
  const cart: Cart = { lines: [{ catalogItemId: 'pizza', variationId: 'large', quantity: 1, modifierIds: [] }] };
  return { businessId: ids.businessId, callId: ids.callId, agentVersionId: ids.agentVersionId, cart,
    quote: { quoteId: newId('qte_'), cartHash: await cartHash(cart), subtotalMinor: 1000, taxMinor: 100,
      totalMinor: 1100, currency: 'USD' as const, lines: [], quotedAt: now.toISOString(), expiresAt: new Date(now.getTime() + QUOTE_EXPIRY_MS).toISOString() },
    contact: { name: 'Test Customer', messageRecipient: '+15555550123', messageConsent: true as boolean, consentAt: now.toISOString() },
    fulfillment: { type: 'pickup' as const, pickupAt: new Date(now.getTime() + 3600000).toISOString() }, messageChannel: 'surge' as const };
}
