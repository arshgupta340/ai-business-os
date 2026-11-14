// "Keep the current value" on a fact conflict stored in the database (web app wiring, 2026-11-14).
// POST /api/conflicts/:id/resolve with { resolution: 'keep_authoritative' } resolves the one conflict
// named, for the owner's own business, with no approval and no external write (API.md 3.12).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, OWNER, createWorld, type World } from './world';

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

  it('a price proposal that carries resolvesConflictId is refused with a message saying what to do', async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/catalog/prices/propose`, headers: OWNER, payload: { variationId: 'x', newPriceMinor: 2100, currency: 'USD', resolvesConflictId: 'cfl_use_price' } });
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
    expect(res.json().message).toMatch(/keep the current value/i);
  });

  it('any other resolve body gets the redirect answer, not marked retryable', async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/conflicts/cfl_use_policy/resolve?businessId=${PIZZA}`, headers: OWNER, payload: { value: 'x' } });
    expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', retryable: false });
  });
});
