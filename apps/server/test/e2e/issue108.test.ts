// Issue #108, through the composed app and the migrated database as abos_app, with fake providers.
// 1. A builder turn's stop conditions carry `conflictIds` on `open_conflict` and `path` on
//    `missing_required_fact`, and the contract schema keeps both. Before the fields were in the
//    contract, parsing the response dropped them.
// 2. A price edit carries the catalog names beside its payload, and a decision names the decider,
//    through the real approval engine and decision routine. The fake Square counts its writes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Square } from 'square';
import { ENDPOINTS, FactConflictIdSchema, MATERIAL_FIELDS, verifyPayloadHash } from '@abos/contracts';
import { createPriceAdapterForTest, type PriceSquareClient } from '../../src/adapters/square/price';
import { OWNER, createWorld, type World } from './world';

const PIZZA = 'biz_pizza_01';

describe('issue #108: stop conditions on a builder turn', () => {
  let w: World;
  let openRequired: string[];
  beforeAll(async () => {
    w = await createWorld();
    // One verified fact the pizza agent needs goes missing, as the owner role.
    await w.t.admin((q) => q.query("update public.business_facts set status = 'superseded' where business_id = $1 and kind = 'hours' and key = 'mon' and status = 'verified'", [PIZZA]));
    // Two open required conflicts and one that is not required (it must not be listed).
    await w.t.admin(async (q) => {
      for (const [id, key, required] of [['cfl_e2e_108a', 'parking', true], ['cfl_e2e_108b', 'refunds', true], ['cfl_e2e_108c', 'napkins', false]] as const) {
        await q.query(`insert into public.fact_conflicts (id, business_id, kind, key, candidates, required, state)
          values ($1, $2, 'policy', $3, '[{"sourceType":"upload","value":"a"},{"sourceType":"seed","value":"b"}]'::jsonb, $4, 'open')`, [id, PIZZA, key, required]);
      }
    });
    openRequired = ((await w.t.db.query("select id from public.fact_conflicts where business_id = $1 and state = 'open' and required order by id", [PIZZA])).rows as { id: string }[]).map((r) => r.id);
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('names each open required conflict and each missing fact', async () => {
    expect(openRequired).toEqual(expect.arrayContaining(['cfl_e2e_108a', 'cfl_e2e_108b']));
    expect(openRequired).not.toContain('cfl_e2e_108c');
    const session = await w.app.inject({ method: 'POST', url: `/api/builder/sessions?businessId=${PIZZA}`, headers: OWNER, payload: {} });
    expect(session.statusCode, session.body).toBe(201);
    const res = await w.app.inject({ method: 'POST', url: `/api/builder/sessions/${(session.json() as { id: string }).id}/messages?businessId=${PIZZA}`, headers: OWNER,
      payload: { text: 'I run a pizza shop and want an AI that takes pickup orders.', inputMode: 'text' } });
    expect(res.statusCode, res.body).toBe(200);

    // What the web client does: parse with the endpoint's response schema and use the result.
    const turn = ENDPOINTS.sendBuilderMessage.response.parse(res.json());
    const conflict = turn.stopConditions.filter((s) => s.code === 'open_conflict');
    expect(conflict).toEqual([{ code: 'open_conflict', conflictIds: openRequired }]);
    for (const id of conflict[0]!.conflictIds!) expect(FactConflictIdSchema.safeParse(id).success).toBe(true);

    const missing = turn.stopConditions.filter((s) => s.code === 'missing_required_fact');
    expect(missing).toContainEqual({ code: 'missing_required_fact', path: 'hours.mon' });
    for (const s of missing) expect(s.path, JSON.stringify(s)).toEqual(expect.any(String));
    expect(new Set(missing.map((s) => s.path)).size).toBe(missing.length);
    // The parsed turn equals what the server sent: nothing was dropped.
    expect(turn.stopConditions).toEqual((res.json() as { stopConditions: unknown }).stopConditions);
  });
});

describe('issue #108: display fields through the real engine', () => {
  let w: World;
  const square = { upserts: 0 };
  beforeAll(async () => {
    w = await createWorld();
    await w.t.admin((q) => q.query("update public.users set display_name = 'Demo Owner' where id = 'usr_owner_01'"));
    const row = (await w.t.db.query("select square_item_id, price_minor, square_variation_version from catalog_items where business_id = $1 and square_variation_id = 'SQ_VAR_PEP_LG'", [PIZZA])).rows[0] as
      { square_item_id: string; price_minor: number; square_variation_version: string | number };
    const client = { __priceAdapterTestFake: true as const, catalog: { object: {
      get: async () => ({ object: { type: 'ITEM_VARIATION', id: 'SQ_VAR_PEP_LG', version: BigInt(row.square_variation_version),
        itemVariationData: { itemId: row.square_item_id, name: 'Large', pricingType: 'FIXED_PRICING', priceMoney: { amount: BigInt(row.price_minor), currency: 'USD' } } } satisfies Square.CatalogObject.ItemVariation }),
      upsert: async () => { square.upserts++; throw new Error('this test never approves a price change'); },
    } } } satisfies PriceSquareClient & { __priceAdapterTestFake: true };
    w.app.composed.providers.prices = createPriceAdapterForTest({ client, locationId: 'LOC_E2E', environment: 'sandbox' });
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('a proposed price edit is named from the catalog row, and rejecting it names the decider', async () => {
    const proposed = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/catalog/prices/propose`, headers: OWNER, payload: { variationId: 'SQ_VAR_PEP_LG', newPriceMinor: 1900, currency: 'USD' } });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const { approval } = ENDPOINTS.proposePrice.response.parse(proposed.json());
    expect(approval).toMatchObject({ state: 'PENDING', itemName: 'Pepperoni', variationName: 'Large' });
    expect(approval).not.toHaveProperty('decidedByName');
    // The stored payload is the material fields only, and the stored hash is the hash of that payload.
    const stored = (await w.t.db.query('select payload, payload_hash from approval_requests where id = $1', [approval.id])).rows[0] as { payload: Record<string, unknown>; payload_hash: string };
    expect(Object.keys(stored.payload).sort()).toEqual([...MATERIAL_FIELDS.price_edit].sort());
    expect(await verifyPayloadHash('price_edit', stored.payload, stored.payload_hash)).toBe(true);
    expect(approval.payloadHash).toBe(stored.payload_hash);

    const pending = ENDPOINTS.getApproval.response.parse((await w.app.inject({ url: `/api/approvals/${approval.id}?businessId=${PIZZA}`, headers: OWNER })).json());
    expect(pending).toMatchObject({ id: approval.id, itemName: 'Pepperoni', variationName: 'Large' });

    const decision = await w.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'reject', payloadHash: approval.payloadHash } });
    expect(decision.statusCode, decision.body).toBe(200);
    expect(ENDPOINTS.decideApproval.response.parse(decision.json()).approval).toMatchObject({ id: approval.id, state: 'REJECTED', decidedBy: 'usr_owner_01', decidedByName: 'Demo Owner' });

    const rejected = ENDPOINTS.listApprovals.response.parse((await w.app.inject({ url: `/api/approvals?businessId=${PIZZA}&state=REJECTED&bundleType=price_edit`, headers: OWNER })).json());
    expect(rejected.items.find((a) => a.id === approval.id)).toMatchObject({ decidedBy: 'usr_owner_01', decidedByName: 'Demo Owner', itemName: 'Pepperoni', variationName: 'Large' });
    await w.settle();
    expect(square.upserts).toBe(0);
  });

  it('the names follow the catalog row as it is now: they are not a record of the proposal', async () => {
    const approvalId = ((await w.t.db.query("select id from approval_requests where business_id = $1 and bundle_type = 'price_edit' order by created_at desc limit 1", [PIZZA])).rows[0] as { id: string }).id;
    await w.t.admin((q) => q.query("update public.catalog_items set item_name = 'Pepperoni Classic' where business_id = $1 and square_variation_id = 'SQ_VAR_PEP_LG'", [PIZZA]));
    const after = ENDPOINTS.getApproval.response.parse((await w.app.inject({ url: `/api/approvals/${approvalId}?businessId=${PIZZA}`, headers: OWNER })).json());
    expect(after).toMatchObject({ itemName: 'Pepperoni Classic', variationName: 'Large' });
  });
});
