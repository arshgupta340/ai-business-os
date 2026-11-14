// "Keep the current value" on a fact conflict stored in the database (web app wiring, 2026-11-14).
// POST /api/conflicts/:id/resolve with { resolution: 'keep_authoritative' } resolves the one conflict
// named, for the owner's own business, with no approval and no external write (API.md 3.12).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { parseEnv } from '../../src/env';
import { OTHER, OWNER, PHONE, createWorld, verifier, type World } from './world';

const PIZZA = 'biz_pizza_01';
const KEEP = { resolution: 'keep_authoritative' };

describe('resolving a database conflict by keeping the current value', () => {
  let w: World;
  const count = async (sql: string, params: unknown[] = []) => Number(((await w.t.db.query(sql, params)).rows[0] as { n: string }).n);
  beforeAll(async () => {
    w = await createWorld();
    await w.t.admin(async (q) => {
      await q.query(`insert into public.fact_conflicts (id, business_id, kind, key, candidates, required, state) values
        ('cfl_keep_policy', $1, 'policy', 'pickup_window', '[{"sourceType":"seed","value":{"minutes":20}},{"sourceType":"upload","value":{"minutes":25}}]'::jsonb, true, 'open'),
        ('cfl_keep_price', $1, 'menu_item', 'margherita_large', '[{"sourceType":"upload","value":{"priceMinor":2100}},{"sourceType":"square","value":{"priceMinor":2000}}]'::jsonb, true, 'open'),
        ('cfl_keep_other', $1, 'faq', 'parking', '[{"value":"a"},{"value":"b"}]'::jsonb, true, 'open')`, [PIZZA]);
    });
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('resolves a policy conflict with no new fact version, no approval and a fact.changed event', async () => {
    const facts = await count('select count(*) as n from business_facts where business_id = $1', [PIZZA]);
    const approvals = await count('select count(*) as n from approval_requests where business_id = $1', [PIZZA]);
    const verified = (await w.t.db.query("select id, version from business_facts where business_id = $1 and kind = 'policy' and key = 'pickup_window' and status = 'verified'", [PIZZA])).rows[0] as { id: string; version: number };
    const res = await w.app.inject({ method: 'POST', url: `/api/conflicts/cfl_keep_policy/resolve?businessId=${PIZZA}`, headers: OWNER, payload: KEEP });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().conflict).toMatchObject({ id: 'cfl_keep_policy', state: 'resolved', resolvedBy: 'usr_owner_01', resolvedFactId: verified.id });
    expect(await count('select count(*) as n from business_facts where business_id = $1', [PIZZA])).toBe(facts);
    expect(await count('select count(*) as n from approval_requests where business_id = $1', [PIZZA])).toBe(approvals);
    const events = (await w.t.db.query("select payload from activity_events where business_id = $1 and type = 'fact.changed' and payload->>'resolvedConflictId' = 'cfl_keep_policy'", [PIZZA])).rows as { payload: Record<string, unknown> }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ factId: verified.id, kind: 'policy', key: 'pickup_window', fromVersion: Number(verified.version), toVersion: Number(verified.version) });
  });

  it('refuses a second resolve of the same conflict', async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/conflicts/cfl_keep_policy/resolve?businessId=${PIZZA}`, headers: OWNER, payload: KEEP });
    expect(res.json()).toMatchObject({ code: 'INVALID_STATE' });
  });

  it('never resolves a conflict for an owner of another business', async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/conflicts/cfl_keep_other/resolve?businessId=${PIZZA}`, headers: OTHER, payload: KEEP });
    expect(res.statusCode).not.toBe(200);
    expect((await w.t.db.query("select state from fact_conflicts where id = 'cfl_keep_other'")).rows[0]).toEqual({ state: 'open' });
  });

  it('keeps the current Square price: the conflict is resolved and the catalog is not touched', async () => {
    const before = (await w.t.db.query('select square_variation_id, price_minor from catalog_items where business_id = $1 order by id', [PIZZA])).rows;
    const approvals = await count('select count(*) as n from approval_requests where business_id = $1', [PIZZA]);
    const res = await w.app.inject({ method: 'POST', url: `/api/conflicts/cfl_keep_price/resolve?businessId=${PIZZA}`, headers: OWNER, payload: KEEP });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().conflict).toMatchObject({ id: 'cfl_keep_price', state: 'resolved', resolvedBy: 'usr_owner_01' });
    expect((await w.t.db.query('select square_variation_id, price_minor from catalog_items where business_id = $1 order by id', [PIZZA])).rows).toEqual(before);
    expect(await count('select count(*) as n from approval_requests where business_id = $1', [PIZZA])).toBe(approvals);
  });
});

describe('the paths that cannot resolve a database conflict answer clear, non-retryable errors', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
    await w.t.admin((q) => q.query(`insert into public.fact_conflicts (id, business_id, kind, key, candidates, required, state) values
      ('cfl_use_price', $1, 'menu_item', 'margherita_large', '[{"value":{"priceMinor":2100}},{"value":{"priceMinor":2000}}]'::jsonb, true, 'open'),
      ('cfl_use_policy', $1, 'policy', 'pickup_window', '[{"value":{"minutes":20}},{"value":{"minutes":25}}]'::jsonb, true, 'open')`, [PIZZA]));
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('"use the uploaded price" through facts/propose names the price change, then keep the current value', async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/facts/propose`, headers: OWNER, payload: { resolvesConflictId: 'cfl_use_price', value: { priceMinor: 2100 } } });
    expect(res.json()).toMatchObject({ code: 'CAPABILITY_NOT_ALLOWED', retryable: false,
      details: { use: ['POST /api/businesses/:id/catalog/prices/propose', 'POST /api/conflicts/:id/resolve with resolution keep_authoritative'] } });
    expect((await w.t.db.query("select state from fact_conflicts where id = 'cfl_use_price'")).rows[0]).toEqual({ state: 'open' });
  });

  it('keeping the current value through facts/propose names the resolve route', async () => {
    const current = (await w.t.db.query("select value from business_facts where business_id = $1 and kind = 'policy' and key = 'pickup_window' and status = 'verified'", [PIZZA])).rows[0] as { value: unknown };
    const res = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/facts/propose`, headers: OWNER, payload: { resolvesConflictId: 'cfl_use_policy', value: current.value } });
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false, details: { use: 'POST /api/conflicts/:id/resolve with resolution keep_authoritative' } });
  });

  it('a price proposal that carries resolvesConflictId is accepted as input; the item is looked up first (the link itself: routines.test.ts)', async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/catalog/prices/propose`, headers: OWNER, payload: { variationId: 'x', newPriceMinor: 2100, currency: 'USD', resolvesConflictId: 'cfl_use_price' } });
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect((await w.t.db.query("select state from fact_conflicts where id = 'cfl_use_price'")).rows[0]).toEqual({ state: 'open' });
  });

  it('any other resolve body gets the redirect answer, not marked retryable', async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/conflicts/cfl_use_policy/resolve?businessId=${PIZZA}`, headers: OWNER, payload: { value: 'x' } });
    expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', retryable: false });
  });
});

// "Use the uploaded value" on a database conflict: facts/propose with resolvesConflictId creates a
// fact_edit approval, and approving it applies the fact and resolves that one conflict. The conflict ID
// is stored with the proposal in the database, so a restart between the proposal and the approval
// loses nothing, and nothing the decision request carries can name a conflict.
describe('an approved facts/propose that carries resolvesConflictId resolves its conflict', () => {
  let w: World;
  const conflict = async (id: string) => (await w.t.db.query('select state, resolved_by, resolved_fact_id from fact_conflicts where id = $1', [id])).rows[0] as { state: string; resolved_by: string | null; resolved_fact_id: string | null };
  const verifiedFact = async (kind: string, key: string) => (await w.t.db.query("select id, value, version from business_facts where business_id = $1 and kind = $2 and key = $3 and status = 'verified'", [PIZZA, kind, key])).rows[0] as { id: string; value: unknown; version: number };
  const propose = (payload: unknown) => w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/facts/propose`, headers: OWNER, payload: payload as Record<string, unknown> });
  beforeAll(async () => {
    w = await createWorld();
    await w.t.admin(async (q) => {
      await q.query(`insert into public.business_facts (id, business_id, kind, key, value, source_type, status, version, verified_at) values
        ('fact_use_faq_a', $1, 'faq', 'parking_a', '"Street parking"'::jsonb, 'seed', 'verified', 1, now()),
        ('fact_use_faq_b', $1, 'faq', 'parking_b', '"Street parking"'::jsonb, 'seed', 'verified', 1, now()),
        ('fact_use_faq_c', $1, 'faq', 'parking_c', '"Street parking"'::jsonb, 'seed', 'verified', 1, now())`, [PIZZA]);
      await q.query(`insert into public.fact_conflicts (id, business_id, kind, key, candidates, required, state) values
        ('cfl_use_a', $1, 'faq', 'parking_a', '[{"sourceType":"upload","value":"Lot behind the shop"},{"sourceType":"seed","value":"Street parking"}]'::jsonb, true, 'open'),
        ('cfl_use_b', $1, 'faq', 'parking_b', '[{"sourceType":"upload","value":"Lot behind the shop"},{"sourceType":"seed","value":"Street parking"}]'::jsonb, true, 'open'),
        ('cfl_use_c', $1, 'faq', 'parking_c', '[{"sourceType":"upload","value":"Lot behind the shop"},{"sourceType":"seed","value":"Street parking"}]'::jsonb, true, 'open')`, [PIZZA]);
    });
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('the approval the owner sees holds exactly the hashed material, and approving it resolves the conflict', async () => {
    const proposed = await propose({ resolvesConflictId: 'cfl_use_a', value: 'Lot behind the shop' });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const approval = proposed.json().approval as { id: string; payloadHash: string; payload: Record<string, unknown> };
    expect(approval.payload).toMatchObject({ kind: 'faq', key: 'parking_a', before: 'Street parking', after: 'Lot behind the shop' });
    expect(approval.payload).not.toHaveProperty('resolvesConflictId');
    // The single read and the list still answer with the contract shape for this approval.
    const single = await w.app.inject({ url: `/api/approvals/${approval.id}?businessId=${PIZZA}`, headers: OWNER });
    expect(single.statusCode, single.body).toBe(200);
    expect(single.json().payload).toEqual(approval.payload);
    const list = await w.app.inject({ url: `/api/approvals?businessId=${PIZZA}&bundleType=fact_edit`, headers: OWNER });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json().items as { id: string; payload: unknown }[]).find((a) => a.id === approval.id)?.payload).toEqual(approval.payload);
    expect((await conflict('cfl_use_a')).state).toBe('open');

    const decided = await w.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash: approval.payloadHash } });
    expect(decided.statusCode, decided.body).toBe(200);
    await w.settle();
    const fact = await verifiedFact('faq', 'parking_a');
    expect(fact).toMatchObject({ value: 'Lot behind the shop', version: 2 });
    expect(await conflict('cfl_use_a')).toEqual({ state: 'resolved', resolved_by: 'usr_owner_01', resolved_fact_id: fact.id });
    // The facts list no longer shows it, and the other conflicts are untouched.
    const facts = await w.app.inject({ url: `/api/businesses/${PIZZA}/facts?kind=faq`, headers: OWNER });
    expect((facts.json().conflicts as { id: string }[]).map((c) => c.id).sort()).toEqual(['cfl_use_b', 'cfl_use_c']);
    const activity = await w.app.inject({ url: `/api/activity?businessId=${PIZZA}&types=fact.changed&correlationId=${approval.id}`, headers: OWNER });
    expect(activity.statusCode, activity.body).toBe(200);
    const resolved = (activity.json().items as { payload: Record<string, unknown> }[]).filter((e) => e.payload.resolvedConflictId === 'cfl_use_a');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload).toMatchObject({ factId: fact.id, kind: 'faq', key: 'parking_a', toVersion: 2 });
  });

  it('a server restarted between the proposal and the approval still resolves the conflict', async () => {
    const proposed = await propose({ resolvesConflictId: 'cfl_use_b', value: 'Lot behind the shop' });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const approval = proposed.json().approval as { id: string; payloadHash: string };
    // A second server process on the same database: nothing of the first one's memory is shared.
    const restarted = await createApp(w);
    try {
      const decided = await restarted.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash: approval.payloadHash } });
      expect(decided.statusCode, decided.body).toBe(200);
      await restarted.composed.executor.idle?.();
    } finally { await restarted.close(); }
    const fact = await verifiedFact('faq', 'parking_b');
    expect(await conflict('cfl_use_b')).toEqual({ state: 'resolved', resolved_by: 'usr_owner_01', resolved_fact_id: fact.id });
  });

  it('the decision request cannot name a conflict: a conflict ID sent with the decision is ignored', async () => {
    const proposed = await propose({ kind: 'faq', key: 'parking_c', value: 'Lot behind the shop' });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const approval = proposed.json().approval as { id: string; payloadHash: string };
    // The same edit asked again with the conflict cannot attach it to the stored approval.
    const late = await propose({ resolvesConflictId: 'cfl_use_c', value: 'Lot behind the shop' });
    expect(late.json()).toMatchObject({ code: 'INVALID_STATE', retryable: false });
    const decided = await w.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${PIZZA}&resolvesConflictId=cfl_use_c`, headers: OWNER,
      payload: { decision: 'approve', payloadHash: approval.payloadHash, resolvesConflictId: 'cfl_use_c' } });
    await w.settle();
    // Whether the extra field is refused or dropped, it never reaches the step.
    expect([200, 400]).toContain(decided.statusCode);
    if (decided.statusCode === 400) {
      const again = await w.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash: approval.payloadHash } });
      expect(again.statusCode, again.body).toBe(200);
      await w.settle();
    }
    expect((await verifiedFact('faq', 'parking_c')).value).toBe('Lot behind the shop');
    expect(await conflict('cfl_use_c')).toEqual({ state: 'open', resolved_by: null, resolved_fact_id: null });
    // The value is now the current one, so "keep the current value" closes the conflict (API.md 3.12).
    const keep = await w.app.inject({ method: 'POST', url: `/api/conflicts/cfl_use_c/resolve?businessId=${PIZZA}`, headers: OWNER, payload: KEEP });
    expect(keep.statusCode, keep.body).toBe(200);
  });
});

/** A second server on the world's database with the world's verifier: a restart, as far as memory goes. */
async function createApp(w: World) {
  return buildApp(parseEnv({ TWILIO_PHONE_NUMBER: PHONE, MESSAGE_CHANNEL: 'qr_only' }), { db: w.t.db, verifier });
}
