// Phase 4 of the integration: the flows that run on the migration 0005 routines end to end, on the
// in-process Postgres as abos_app, through the REST API, the executor and the webhook routes, with
// fake providers. Each test counts the external writes it caused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Square } from 'square';
import { ENDPOINTS, type Cart, type Quote, type ToolResult } from '@abos/contracts';
import { createPriceAdapterForTest, type PriceSquareClient } from '../../src/adapters/square/price';
import { createDbExecutor } from '../../src/compose/executor';
import { notWiredExecutor, type SeamDeps } from '../../src/compose/seams';
import { OWNER, createWorld, nextLocalDate, zonedIso, type World } from './world';

const PIZZA = 'biz_pizza_01';
const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 2, modifierIds: [] }] };
const silentLog: SeamDeps['log'] = { info() {}, warn() {}, error() {} };

async function sim(w: World, body: Record<string, unknown>) {
  const res = await w.app.inject({ method: 'POST', url: `/api/agents/agt_pizza_01/sim-call?businessId=${PIZZA}`, headers: OWNER, payload: body });
  return res.json() as { callId: string; reply: string };
}

/** Quote through the real toolset on a sim call, then propose with consent through the engine on that live call. */
async function pizzaOrder(w: World) {
  let quote: Quote | undefined;
  w.model.push(async ({ executeTool }) => {
    const r = await executeTool('quote_order', { cart: CART }) as ToolResult<'quote_order'>;
    if (r.ok) quote = r.quote;
    return 'quoted';
  }, async () => 'bye');
  const first = await sim(w, { message: 'Two large pepperoni' });
  const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [first.callId])).rows[0] as { agent_version_id: string };
  const { order, approval } = await w.app.composed.engine.createOrderProposal({ businessId: PIZZA, callId: first.callId, agentVersionId: call.agent_version_id,
    cart: CART, quote: quote!, contact: { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: new Date().toISOString() },
    fulfillment: { type: 'pickup', pickupAt: zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles') },
    messageChannel: w.app.composed.providers.messageChannel });
  await sim(w, { callId: first.callId, message: 'thanks', end: true });
  return { orderId: order.id, approvalId: approval.id, callId: first.callId };
}

async function approve(w: World, businessId: string, approvalId: string) {
  const list = ENDPOINTS.listApprovals.response.parse((await w.app.inject({ url: `/api/approvals?businessId=${businessId}`, headers: OWNER })).json());
  const a = list.items.find((x) => x.id === approvalId)!;
  const res = await w.app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decision?businessId=${businessId}`, headers: OWNER, payload: { decision: 'approve', payloadHash: a.payloadHash } });
  expect(res.statusCode).toBe(200);
  return res;
}
const steps = async (w: World, approvalId: string) => (await w.t.db.query('select id, action_type, status, external_ref, attempts from action_executions where approval_id = $1 order by step_index', [approvalId])).rows as
  { id: string; action_type: string; status: string; external_ref: string | null; attempts: number }[];
const order = async (w: World, id: string) => (await w.t.db.query('select status, square_order_id, checkout_url, square_payment_id, link_ready_at from orders where id = $1', [id])).rows[0] as
  { status: string; square_order_id: string | null; checkout_url: string | null; square_payment_id: string | null; link_ready_at: Date | null };
const n = async (w: World, sql: string, params: unknown[]) => ((await w.t.db.query(sql, params)).rows[0] as { n: number }).n;

function paymentEvent(eventId: string, paymentId: string, squareOrderId: string) {
  return JSON.stringify({ merchant_id: 'M_E2E', type: 'payment.updated', event_id: eventId, created_at: new Date().toISOString(),
    data: { type: 'payment', id: paymentId, object: { payment: { id: paymentId, order_id: squareOrderId, status: 'COMPLETED', amount_money: { amount: 1, currency: 'USD' } } } } });
}

describe('a payment that arrives before the order waits for it', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('changes nothing while the link is being sent, then the reconcile poll verifies it once the order is PAYMENT_PENDING', async () => {
    const { orderId, approvalId } = await pizzaOrder(w);
    await approve(w, PIZZA, approvalId);
    const c = w.app.composed;
    const executor = createDbExecutor({ env: c.env, db: c.db, engine: c.engine, providers: c.providers, now: c.now, newId: c.newId, log: silentLog }, { workerId: 'worker-early' });
    expect(await executor.tick()).toBe(true); // the checkout step only
    const linked = await order(w, orderId);
    expect(linked.status).toBe('PAYMENT_LINK_READY');
    expect(linked.link_ready_at).not.toBeNull();
    // The customer pays from the link before the message step ran; Square's webhook arrives.
    const total = ((await w.t.db.query('select total_minor from orders where id = $1', [orderId])).rows[0] as { total_minor: number }).total_minor;
    w.square.addPayment({ id: 'PAY_EARLY', orderId: linked.square_order_id!, amountMinor: total, status: 'COMPLETED' });
    const body = paymentEvent('evt_sq_early', 'PAY_EARLY', linked.square_order_id!);
    const res = await w.app.inject({ method: 'POST', url: '/webhooks/square', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': w.squareSignature(body) }, payload: body });
    expect(res.statusCode).toBe(200);
    await w.settle();
    // mark_order_paid would refuse the jump; nothing changed and no receipt was stored.
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_LINK_READY', square_payment_id: null });
    expect(await n(w, 'select count(*)::int as n from payment_receipts where order_id = $1', [orderId])).toBe(0);
    // The job finished (it changed nothing), so mark_webhook_processed (0006) recorded the row as processed;
    // the payment is picked up by the reconcile poll below, which reads Square again.
    expect(await n(w, "select count(*)::int as n from webhook_events where provider_event_id = 'evt_sq_early' and processed_at is not null", [])).toBe(1);
    await executor.drain();
    expect((await order(w, orderId)).status).toBe('PAYMENT_PENDING');
    await c.webhooks!.reconcileNow();
    expect(await order(w, orderId)).toMatchObject({ status: 'FULFILLMENT_READY', square_payment_id: 'PAY_EARLY' });
    expect(await n(w, "select count(*)::int as n from payment_receipts where order_id = $1 and status = 'COMPLETED'", [orderId])).toBe(1);
    await executor.stop();
  });
});

describe('recovery of a NEEDS_REVIEW checkout', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });
  const resolve = (businessId: string, id: string, action: 'retry' | 'abandon') =>
    w.app.inject({ method: 'POST', url: `/api/executions/${id}/resolve?businessId=${businessId}`, headers: OWNER, payload: { action } });

  it('link exists: Square answered without a URL, the owner retries, the saved link is read back and the bundle continues', async () => {
    const create = w.square.client.checkout.paymentLinks.create;
    w.square.client.checkout.paymentLinks.create = async (input) => {
      const r = await create(input);
      return { paymentLink: { ...r.paymentLink, url: undefined } as Square.PaymentLink };
    };
    const { orderId, approvalId } = await pizzaOrder(w);
    await approve(w, PIZZA, approvalId);
    await w.settle();
    w.square.client.checkout.paymentLinks.create = create;
    const [checkout] = await steps(w, approvalId);
    expect(checkout).toMatchObject({ status: 'NEEDS_REVIEW', external_ref: expect.stringMatching(/^SQ_ORDER_/) });
    expect((await order(w, orderId)).status).toBe('RECOVERY_REQUIRED');
    const writes = w.squareWrites.length;
    const res = await resolve(PIZZA, checkout!.id, 'retry');
    expect(res.statusCode).toBe(200);
    expect(res.json().execution.status).toBe('SUCCEEDED');
    const o = await order(w, orderId);
    expect(o).toMatchObject({ status: 'PAYMENT_LINK_READY', square_order_id: checkout!.external_ref });
    expect(o.checkout_url).toMatch(/^https:\/\/sandbox\.square\.link\//);
    w.app.composed.executor.kick(PIZZA);
    await w.settle();
    expect((await steps(w, approvalId)).map((s) => s.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    expect((await order(w, orderId)).status).toBe('PAYMENT_PENDING');
    // No second payment link was created.
    expect(w.squareWrites.length).toBe(writes);
    // A repeat is refused: the step is no longer in review.
    expect((await resolve(PIZZA, checkout!.id, 'retry')).statusCode).toBe(409);
  });

  it('link may not exist: Square timed out, nothing proves either way, retry and abandon are refused, the owner cancels', async () => {
    w.square.mode.create = 'timeout';
    const { orderId, approvalId } = await pizzaOrder(w);
    await approve(w, PIZZA, approvalId);
    await w.settle();
    w.square.mode.create = 'ok';
    const [checkout] = await steps(w, approvalId);
    expect(checkout!.status).toBe('NEEDS_REVIEW');
    expect((await order(w, orderId)).status).toBe('RECOVERY_REQUIRED');
    const writes = w.squareWrites.length;
    expect((await resolve(PIZZA, checkout!.id, 'retry')).json()).toMatchObject({ code: 'INVALID_STATE' });
    expect((await resolve(PIZZA, checkout!.id, 'abandon')).json()).toMatchObject({ code: 'INVALID_STATE' });
    expect((await steps(w, approvalId))[0]!.status).toBe('NEEDS_REVIEW');
    const cancelled = await w.app.inject({ method: 'POST', url: `/api/orders/${orderId}/cancel?businessId=${PIZZA}`, headers: OWNER, payload: {} });
    expect(cancelled.statusCode).toBe(200);
    expect((await order(w, orderId)).status).toBe('CANCELLED');
    expect(w.squareWrites.length).toBe(writes);
  });

  it('refuses another owner', async () => {
    const id = ((await w.t.db.query("select id from action_executions where status = 'NEEDS_REVIEW' limit 1")).rows[0] as { id: string } | undefined)?.id ?? 'exe_missing';
    const res = await w.app.inject({ method: 'POST', url: `/api/executions/${id}/resolve?businessId=${PIZZA}`, headers: { authorization: 'Bearer other' }, payload: { action: 'retry' } });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('price change', () => {
  let w: World;
  const state = { priceMinor: 0, version: 0, upserts: 0, itemId: '' };
  beforeAll(async () => {
    w = await createWorld();
    const row = (await w.t.db.query("select square_item_id, price_minor, square_variation_version from catalog_items where business_id = $1 and square_variation_id = 'SQ_VAR_PEP_LG'", [PIZZA])).rows[0] as
      { square_item_id: string; price_minor: number; square_variation_version: string | number };
    Object.assign(state, { priceMinor: row.price_minor, version: Number(row.square_variation_version), itemId: row.square_item_id });
    const object = (): Square.CatalogObject.ItemVariation => ({ type: 'ITEM_VARIATION', id: 'SQ_VAR_PEP_LG', version: BigInt(state.version),
      itemVariationData: { itemId: state.itemId, name: 'Large', pricingType: 'FIXED_PRICING', priceMoney: { amount: BigInt(state.priceMinor), currency: 'USD' } } });
    const client = { __priceAdapterTestFake: true as const, catalog: { object: {
      get: async () => ({ object: object() }),
      upsert: async (request: Square.catalog.UpsertCatalogObjectRequest) => {
        state.upserts++;
        const next = request.object as Square.CatalogObject.ItemVariation;
        const money = next.itemVariationData?.locationOverrides?.[0]?.priceMoney ?? next.itemVariationData?.priceMoney;
        state.priceMinor = Number(money?.amount ?? 0n); state.version += 1;
        return { catalogObject: object() };
      },
    } } } satisfies PriceSquareClient & { __priceAdapterTestFake: true };
    w.app.composed.providers.prices = createPriceAdapterForTest({ client, locationId: 'LOC_E2E', environment: 'sandbox' });
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('is proposed, approved and executed once with the stored key; the catalog cache step runs after it', async () => {
    const from = state.priceMinor;
    const res = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/catalog/prices/propose`, headers: OWNER, payload: { variationId: 'SQ_VAR_PEP_LG', newPriceMinor: from + 100, currency: 'USD' } });
    expect(res.statusCode).toBe(201);
    const approval = res.json().approval as { id: string; state: string; payload: { fromPriceMinor: number; newPriceMinor: number } };
    expect(approval).toMatchObject({ state: 'PENDING', payload: { fromPriceMinor: from, newPriceMinor: from + 100, currency: 'USD' } });
    expect(state.upserts).toBe(0);
    // The same proposal again creates no second approval (the route answers with an error, because its
    // clock-derived expiry gives the repeat a different hash; B-26 route behavior, noted in the report).
    await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/catalog/prices/propose`, headers: OWNER, payload: { variationId: 'SQ_VAR_PEP_LG', newPriceMinor: from + 100, currency: 'USD' } });
    expect(await n(w, "select count(*)::int as n from approval_requests where business_id = $1 and bundle_type = 'price_edit' and state = 'PENDING'", [PIZZA])).toBe(1);
    await approve(w, PIZZA, approval.id);
    await w.settle();
    const s = await steps(w, approval.id);
    expect(s.map((x) => [x.action_type, x.status])).toEqual([['square.catalog.price.update', 'SUCCEEDED'], ['local.catalog.sync', 'SUCCEEDED']]);
    expect(s[0]!.external_ref).toBe(`SQ_VAR_PEP_LG@${state.version}`);
    expect(state).toMatchObject({ upserts: 1, priceMinor: from + 100 });
    // Approving again (same hash) runs nothing more.
    const hash = ((await w.t.db.query('select payload_hash from approval_requests where id = $1', [approval.id])).rows[0] as { payload_hash: string }).payload_hash;
    const repeat = await w.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash: hash } });
    expect(repeat.statusCode).toBe(200);
    await w.settle();
    expect(state.upserts).toBe(1);
  });
});

describe('human fallback', () => {
  let w: World;
  const updates: { callSid: string; twiml: string }[] = [];
  let enabled = true;
  beforeAll(async () => {
    w = await createWorld({ versionEnablesFallback: async () => enabled });
    w.app.composed.providers.twilioCalls = { async update({ callSid, twiml }) { updates.push({ callSid, twiml }); } };
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  async function phoneCall(sid: string) {
    const live = (await w.t.db.query('select agent_id, agent_version_id from live_agent where business_id = $1', [PIZZA])).rows[0] as { agent_id: string; agent_version_id: string };
    const { callId } = await w.app.composed.calls.startCall({ businessId: PIZZA, agentId: live.agent_id, agentVersionId: live.agent_version_id, providerCallId: sid });
    return callId;
  }
  const handOff = (callId: string, sid: string) => w.app.composed.fallback.relay({ businessId: PIZZA, callId, providerCallId: sid, signals: { modelSessionFailed: true, modelSessionReady: false } });

  it('is refused without a verified fallback number', async () => {
    const callId = await phoneCall('CA_fallback_none');
    expect(await handOff(callId, 'CA_fallback_none')).toBe(false);
    expect(updates).toEqual([]);
  });

  it('is allowed with a verified number, an enabling version and an active phone call: one call update', async () => {
    await w.t.admin((q) => q.query(`insert into public.business_facts (id, business_id, kind, key, value, source_type, status, version, verified_at)
      values ('fact_fallback_e2e', $1, 'contact', 'fallback_phone_number', '"+15555550142"', 'owner_ui', 'verified', 1, now())`, [PIZZA]));
    const callId = await phoneCall('CA_fallback_ok');
    expect(await handOff(callId, 'CA_fallback_ok')).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.callSid).toBe('CA_fallback_ok');
    expect(updates[0]!.twiml).toContain('+15555550142');
    // A second attempt for the same provider call does not dispatch again.
    expect(await handOff(callId, 'CA_fallback_ok')).toBe(false);
    expect(updates).toHaveLength(1);
  });

  it('is refused when the version does not enable it, for an ended call, and for a call bound to another provider SID', async () => {
    enabled = false;
    const a = await phoneCall('CA_fallback_off');
    expect(await handOff(a, 'CA_fallback_off')).toBe(false);
    enabled = true;
    const b = await phoneCall('CA_fallback_ended');
    await w.app.composed.calls.endCall(b, 'completed');
    expect(await handOff(b, 'CA_fallback_ended')).toBe(false);
    const c = await phoneCall('CA_fallback_bound');
    expect(await handOff(c, 'CA_fallback_other')).toBe(false);
    expect(updates).toHaveLength(1);
  });
});

describe('a new-key fact', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });
  const verified = async (key: string) => (await w.t.db.query("select status, version, value from business_facts where business_id = $1 and kind = 'policy' and key = $2 and status = 'verified'", [PIZZA, key])).rows;

  it('proposed through facts/propose is a draft subject until confirmed, then verified version 1', async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/facts/propose`, headers: OWNER, payload: { kind: 'policy', key: 'parking_e2e', value: 'Street parking only' } });
    expect(res.statusCode).toBe(201);
    const approval = res.json().approval as { id: string; payload: { fromVersion: number; before: unknown } };
    expect(approval.payload).toMatchObject({ fromVersion: 0, before: null });
    expect(await verified('parking_e2e')).toEqual([]);
    await approve(w, PIZZA, approval.id);
    expect(await verified('parking_e2e')).toEqual([{ status: 'verified', version: 1, value: 'Street parking only' }]);
  });

  it('an owner chat answer for a new key becomes a pending fact_edit, and confirming it verifies the fact', async () => {
    const propose = w.app.composed.builder.proposeFactFromChat!;
    const draftId = 'fact_wifi_e2e_draft';
    await w.t.db.query(`insert into public.business_facts (id, business_id, kind, key, value, source_type, status, version) values ($1,$2,'policy','wifi_e2e','"Free wifi"'::jsonb,'owner_ui','draft',1)`, [draftId, PIZZA]);
    const r = await propose({ businessId: PIZZA, ownerUserId: 'usr_owner_01', kind: 'policy', key: 'wifi_e2e', value: 'Free wifi', subjectId: draftId, fromVersion: 0, before: null });
    // The same answer again returns the same pending approval; a stale view is refused.
    expect((await propose({ businessId: PIZZA, ownerUserId: 'usr_owner_01', kind: 'policy', key: 'wifi_e2e', value: 'Free wifi', subjectId: draftId, fromVersion: 0, before: null })).approvalId).toBe(r.approvalId);
    await expect(propose({ businessId: PIZZA, ownerUserId: 'usr_owner_01', kind: 'policy', key: 'wifi_e2e', value: 'Free wifi', subjectId: draftId, fromVersion: 3, before: null })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(propose({ businessId: PIZZA, ownerUserId: 'usr_owner_01', kind: 'policy', key: 'wifi_e2e', value: 'Paid wifi', subjectId: draftId, fromVersion: 0, before: null })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(r.bundleType).toBe('fact_edit');
    const list = ENDPOINTS.listApprovals.response.parse((await w.app.inject({ url: `/api/approvals?businessId=${PIZZA}`, headers: OWNER })).json());
    expect(list.items.find((a) => a.id === r.approvalId)).toMatchObject({ state: 'PENDING', bundleType: 'fact_edit' });
    await approve(w, PIZZA, r.approvalId);
    expect(await verified('wifi_e2e')).toEqual([{ status: 'verified', version: 1, value: 'Free wifi' }]);
  });

  it('maps errors: unknown conflict NOT_FOUND, malformed body VALIDATION_FAILED', async () => {
    const missing = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/facts/propose`, headers: OWNER, payload: { resolvesConflictId: 'cfl_missing', value: 'x' } });
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
    const malformed = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/facts/propose`, headers: OWNER, payload: { kind: 'policy' } });
    expect(malformed.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('review finding 2: a created checkout survives a failed local completion', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('keeps the Square order ID, moves the order to RECOVERY_REQUIRED, never creates again, and recovery resolves it from Square', async () => {
    const { orderId, approvalId } = await pizzaOrder(w);
    await approve(w, PIZZA, approvalId);
    const c = w.app.composed;
    // One transaction failure at save_checkout, after Square created and the adapter verified the link.
    const db = c.db as { transaction: typeof c.db.transaction };
    const original = db.transaction.bind(c.db);
    let failures = 1;
    db.transaction = (fn) => original((tx) => fn({ query: (text, params) => {
      if (failures > 0 && text.includes('save_checkout')) { failures--; return Promise.reject(new Error('connection reset')); }
      return tx.query(text, params);
    } }));
    const executor = createDbExecutor({ env: c.env, db: c.db, engine: c.engine, providers: c.providers, now: c.now, newId: c.newId, log: silentLog }, { workerId: 'worker-f2' });
    try {
      expect(await executor.tick()).toBe(true);
      await executor.drain();
    } finally { db.transaction = original; await executor.stop(); }
    expect(w.squareWrites).toHaveLength(1);
    const checkout = (await steps(w, approvalId)).find((s) => s.action_type === 'square.checkout.create')!;
    const linked = w.square.orders.size > 0 ? [...w.square.orders.keys()][0] : undefined;
    expect(checkout).toMatchObject({ status: 'NEEDS_REVIEW', external_ref: linked });
    expect((await order(w, orderId)).status).toBe('RECOVERY_REQUIRED');
    // Owner recovery reads the link back from Square by the kept order ID and completes the step.
    const res = await w.app.inject({ method: 'POST', url: `/api/executions/${checkout.id}/resolve?businessId=${PIZZA}`, headers: OWNER, payload: { action: 'retry' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_LINK_READY', square_order_id: linked });
    expect(w.squareWrites).toHaveLength(1);
  });
});

describe('review finding 3: a failed payment check never cancels a linked order', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('a paid order whose Square read fails stays as it is; a linked order is not cancelled even when the read succeeds', async () => {
    const { orderId, approvalId } = await pizzaOrder(w);
    await approve(w, PIZZA, approvalId);
    await w.settle();
    const linked = await order(w, orderId);
    expect(linked.status).toBe('PAYMENT_PENDING');
    const total = ((await w.t.db.query('select total_minor from orders where id = $1', [orderId])).rows[0] as { total_minor: number }).total_minor;
    w.square.addPayment({ id: 'PAY_F3', orderId: linked.square_order_id!, amountMinor: total, status: 'COMPLETED' });
    const square = w.app.composed.providers.square!;
    const real = square.findPaymentForOrder;
    square.findPaymentForOrder = async () => { throw new Error('timeout'); };
    const cancel = () => w.app.inject({ method: 'POST', url: `/api/orders/${orderId}/cancel?businessId=${PIZZA}`, headers: OWNER, payload: {} });
    try {
      const refused = await cancel();
      expect(refused.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
      expect((await order(w, orderId)).status).toBe('PAYMENT_PENDING');
    } finally { square.findPaymentForOrder = real; }
    // With a working read, the payment found is reconciled and the cancel is still refused.
    const again = await cancel();
    expect(again.json()).toMatchObject({ code: 'INVALID_STATE' });
    expect((await order(w, orderId)).status).toBe('FULFILLMENT_READY');
  });
});
