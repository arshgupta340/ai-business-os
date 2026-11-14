import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Square, SquareClient as SdkClient } from 'square';
import { cartHash, PIZZA_BUSINESS_ID, QUOTE_EXPIRY_MS, QuoteSchema, type Cart } from '@abos/contracts';
import { demoTaxMinor, pizzaCatalog, SQ } from '@abos/contracts/fixtures';
import { catalogRows, createSquareAdapter, orderFromCart, verifyWebhookSignature } from '../../../src/adapters/square/index';
import type { Database, Queryable, SquareClient } from '../../../src/adapters/square/types';

// tsc verifies that a real SDK client fits this boundary without a cast.
const acceptsSdkClient = (client: SdkClient): SquareClient => client;
void acceptsSdkClient;
const NOW = new Date('2026-11-13T20:00:00Z');
const LOCATION = 'location_sandbox';
const money = (amount: number, currency: Square.Currency = 'USD'): Square.Money => ({ amount: BigInt(amount), currency });
async function* values<T>(items: T[]): AsyncIterable<T> { yield* items; }
const catalogObjects = (): Square.CatalogObject[] => [
  { type: 'TAX', id: 'tax', version: 3n, taxData: { name: 'Tax', percentage: '8.75', enabled: true } },
  ...pizzaCatalog[0]!.modifierLists.map((list): Square.CatalogObject => ({
    type: 'MODIFIER_LIST', id: list.id, version: 3n,
    modifierListData: { name: list.name, selectionType: list.selectionType,
      modifiers: list.modifiers.map((mod) => ({ type: 'MODIFIER' as const, id: mod.id, modifierData: { name: mod.name, priceMoney: money(mod.priceMinor) } })),
    },
  })),
  ...pizzaCatalog.map((item): Square.CatalogObject => ({
    type: 'ITEM', id: item.squareItemId, version: 3n,
    itemData: { name: item.name, description: item.description, taxIds: ['tax'],
      modifierListInfo: item.modifierLists.map((list) => ({ modifierListId: list.id, enabled: true })),
      variations: item.variations.map((variation) => ({ type: 'ITEM_VARIATION' as const, id: variation.id, version: 4n,
        itemVariationData: { itemId: item.squareItemId, name: variation.name, sellable: true, priceMoney: money(variation.priceMinor) },
      })),
    },
  })),
];
type CacheRow = { business_id: string; square_item_id: string; square_variation_id: string; is_available: boolean; modifier_lists: unknown };
class FakeDb implements Database {
  rows: CacheRow[] = pizzaCatalog.flatMap((item) => item.variations.map((variation) => ({
    business_id: item.businessId, square_item_id: item.squareItemId, square_variation_id: variation.id, is_available: true, modifier_lists: item.modifierLists,
  })));
  calls: { text: string; params: unknown[] }[] = [];
  transactions = 0;
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    this.transactions++;
    const before = structuredClone(this.rows);
    try { return await fn(this); } catch (error) { this.rows = before; throw error; }
  }
  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ text, params });
    if (/^\s*select/i.test(text)) return { rows: this.rows.filter((row) => row.business_id === params[0] && (params[1] as string[]).includes(row.square_variation_id)) };
    if (/^\s*insert/i.test(text)) {
      const row = { business_id: params[0] as string, square_item_id: params[1] as string, square_variation_id: params[2] as string,
        modifier_lists: JSON.parse(params[10] as string) as unknown, is_available: params[11] as boolean };
      this.rows = this.rows.filter((old) => old.business_id !== row.business_id || old.square_variation_id !== row.square_variation_id);
      this.rows.push(row);
    }
    if (/^\s*update/i.test(text)) for (const row of this.rows) if (row.business_id === params[0] && !(params[1] as string[]).includes(row.square_variation_id)) row.is_available = false;
    return { rows: [] };
  }
}
// Price arithmetic lives only in the fake Square provider.
function calculate(request: { order: Square.Order }): Square.CalculateOrderResponse {
  const lineItems = request.order.lineItems!.map((line): Square.OrderLineItem => {
    const item = pizzaCatalog.find((candidate) => candidate.variations.some((v) => v.id === line.catalogObjectId))!;
    const variation = item.variations.find((v) => v.id === line.catalogObjectId)!;
    const modifiers = (line.modifiers ?? []).map((mod) => {
      const found = item.modifierLists.flatMap((list) => list.modifiers).find((m) => m.id === mod.catalogObjectId)!;
      return { ...mod, name: found.name, basePriceMoney: money(found.priceMinor) };
    });
    const gross = (variation.priceMinor + modifiers.reduce((sum, mod) => sum + Number(mod.basePriceMoney.amount), 0)) * Number(line.quantity);
    return { ...line, name: `${item.name} ${variation.name}`, basePriceMoney: money(variation.priceMinor), modifiers,
      grossSalesMoney: money(gross), totalMoney: money(gross + demoTaxMinor(gross)) };
  });
  const subtotal = lineItems.reduce((sum, line) => sum + Number(line.grossSalesMoney!.amount), 0);
  return { order: { locationId: LOCATION, lineItems, totalTaxMoney: money(demoTaxMinor(subtotal)), totalMoney: money(subtotal + demoTaxMinor(subtotal)) } };
}
function setup() {
  const client = {
    catalog: { list: vi.fn(async (_request: { types: string }) => values(catalogObjects())) },
    orders: {
      calculate: vi.fn(async (request: { order: Square.Order }) => calculate(request)),
      get: vi.fn(async (_request: { orderId: string }): Promise<Square.GetOrderResponse> => ({ order: { id: 'sq_order', locationId: LOCATION, totalMoney: money(3263) } })),
    },
    checkout: { paymentLinks: { create: vi.fn(async (_request: { order: Square.Order; idempotencyKey: string }): Promise<Square.CreatePaymentLinkResponse> => ({ paymentLink: {
      id: 'link', version: 1, orderId: 'sq_order', url: 'https://square.example/checkout',
    } })) } },
    payments: {
      get: vi.fn(async (_request: { paymentId: string }): Promise<Square.GetPaymentResponse> => ({ payment: {
        id: 'pay', status: 'COMPLETED', orderId: 'sq_order', locationId: LOCATION, amountMoney: money(3263),
      } })),
      list: vi.fn(async (_request: { locationId: string; beginTime: string; sortOrder: 'DESC'; limit: number }) => values<Square.Payment>([])),
    },
  };
  const deps = { client, locationId: LOCATION, environment: 'sandbox', now: () => new Date(NOW) };
  return { client, deps, adapter: createSquareAdapter(deps), db: new FakeDb() };
}
const cartCases: Cart[] = Array.from({ length: 20 }, (_, index) => {
  const variants = pizzaCatalog.flatMap((item) => item.variations.map((v) => ({ item, v })));
  const { item, v } = variants[index % variants.length]!;
  const line = { catalogItemId: item.squareItemId, variationId: v.id, quantity: index % 4 + 1,
    modifierIds: item.modifierLists.flatMap((list) => list.modifiers).slice(0, index % 4).map((m) => m.id) };
  return { lines: index < 12 ? [line] : [line, { catalogItemId: SQ.itemPepperoni, variationId: SQ.varPepperoniLarge, quantity: 2, modifierIds: [SQ.modExtraCheese] }] };
});

describe('Square adapter', () => {
  it.each(['production', 'Sandbox', '', ' sandbox'])('refuses environment %j before accessing the client', (environment) => {
    expect(() => createSquareAdapter({ client: undefined as never, locationId: LOCATION, environment, now: () => NOW }))
      .toThrowError(expect.objectContaining({ code: 'ENVIRONMENT_MISMATCH' }));
  });
  it('maps the migration columns, upserts each variation and marks disappeared rows unavailable in this business only', async () => {
    const { adapter, client, db } = setup();
    db.rows.push({ ...db.rows[0]!, square_variation_id: 'gone' }, { ...db.rows[0]!, business_id: 'biz_other', square_variation_id: 'other' });
    expect(await adapter.syncCatalog(db, PIZZA_BUSINESS_ID)).toBe(6);
    expect(db.transactions).toBe(1);
    expect(client.catalog.list).toHaveBeenCalledWith({ types: 'ITEM,ITEM_VARIATION,MODIFIER_LIST,TAX' });
    const insert = db.calls.find((call) => /insert into catalog_items/i.test(call.text))!;
    for (const column of ['square_item_version', 'square_variation_version', 'price_minor', 'modifier_lists', 'synced_at']) expect(insert.text).toContain(column);
    expect(insert.text).toMatch(/on conflict\s*\(business_id, square_variation_id\)\s*do update/i);
    expect(insert.params).toEqual([PIZZA_BUSINESS_ID, SQ.itemMargherita, SQ.varMargheritaSmall, '3', '4', 'Margherita', pizzaCatalog[0]!.description, 'Small', 1200, 'USD', JSON.stringify(pizzaCatalog[0]!.modifierLists), true, NOW.toISOString()]);
    expect(db.rows.find((row) => row.square_variation_id === 'gone')!.is_available).toBe(false);
    expect(db.rows.find((row) => row.square_variation_id === 'other')!.is_available).toBe(true);
    const update = db.calls.find((call) => /^\s*update/i.test(call.text))!;
    expect(update.text).toMatch(/business_id\s*=\s*\$1/);
    expect(update.text).toMatch(/not.*square_variation_id\s*=\s*any/is);
    expect(db.calls.some((call) => /delete from/i.test(call.text))).toBe(false);
  });
  it('does not invalidate the cache if a later catalog page fails', async () => {
    const { adapter, client, db } = setup();
    client.catalog.list.mockImplementationOnce(async () => (async function* () { yield catalogObjects()[0]!; throw new Error('page failed'); })());
    await expect(adapter.syncCatalog(db, PIZZA_BUSINESS_ID)).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });
  it('marks all prior variations unavailable after an empty successful sync', async () => {
    const { adapter, client, db } = setup();
    client.catalog.list.mockResolvedValueOnce(values([]));
    expect(await adapter.syncCatalog(db, PIZZA_BUSINESS_ID)).toBe(0);
    expect(db.rows.every((row) => !row.is_available)).toBe(true);
  });
  it.each(cartCases.map((cart, index) => ({ cart, index })))('AC-05 fixture cart $index uses exact Square prices', async ({ cart }) => {
    const { adapter, client, db } = setup();
    const result = await adapter.quote(db, PIZZA_BUSINESS_ID, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected quote');
    const quote = QuoteSchema.parse(result.quote);
    const expected = calculate({ order: { locationId: LOCATION, lineItems: cart.lines.map((line) => ({
      catalogObjectId: line.variationId, quantity: String(line.quantity), modifiers: line.modifierIds.map((id) => ({ catalogObjectId: id, quantity: '1' })),
    })) } }).order!;
    expect(quote.totalMinor).toBe(Number(expected.totalMoney!.amount));
    expect(quote.taxMinor).toBe(Number(expected.totalTaxMoney!.amount));
    expect(quote.subtotalMinor).toBe(expected.lineItems!.reduce((sum, line) => sum + Number(line.grossSalesMoney!.amount), 0));
    expect(quote.lines).toEqual(expected.lineItems!.map((line) => ({
      variationId: line.catalogObjectId, name: line.name, quantity: Number(line.quantity), unitPriceMinor: Number(line.basePriceMoney!.amount),
      modifiers: line.modifiers!.map((mod) => ({ modifierId: mod.catalogObjectId, name: mod.name, priceMinor: Number(mod.basePriceMoney!.amount) })),
      lineTotalMinor: Number(line.totalMoney!.amount),
    })));
    expect(quote.cartHash).toBe(await cartHash(cart));
    expect(quote.quoteId).toMatch(/^qte_/);
    expect(quote.quotedAt).toBe(NOW.toISOString());
    expect(Date.parse(quote.expiresAt) - Date.parse(quote.quotedAt)).toBe(QUOTE_EXPIRY_MS);
    const request = client.orders.calculate.mock.calls[0]![0];
    expect(request.order).not.toHaveProperty('taxes');
    expect(request.order.pricingOptions).toEqual({ autoApplyTaxes: true });
    expect(request.order.lineItems!.every((line) => line.basePriceMoney === undefined)).toBe(true);
  });
  it.each(['unknown variation', 'unavailable variation', 'unknown modifier', 'wrong item', 'wrong business'])('refuses %s before Square pricing', async (scenario) => {
    const { adapter, client, db } = setup();
    const cart = structuredClone(cartCases[0]!);
    if (scenario === 'unknown variation') cart.lines[0]!.variationId = 'unknown';
    if (scenario === 'unavailable variation') db.rows[0]!.is_available = false;
    if (scenario === 'unknown modifier') cart.lines[0]!.modifierIds = ['unknown'];
    if (scenario === 'wrong item') cart.lines[0]!.catalogItemId = SQ.itemPepperoni;
    expect(await adapter.quote(db, scenario === 'wrong business' ? 'biz_other' : PIZZA_BUSINESS_ID, cart)).toMatchObject({ ok: false, code: 'ITEM_UNAVAILABLE', reason: 'ITEM_UNAVAILABLE' });
    expect(client.orders.calculate).not.toHaveBeenCalled();
  });
  it('returns INTEGRATION_UNAVAILABLE when Square pricing fails, and never invents a total', async () => {
    const { adapter, client, db } = setup();
    client.orders.calculate.mockRejectedValueOnce(new Error('network'));
    expect(await adapter.quote(db, PIZZA_BUSINESS_ID, cartCases[0]!)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
    client.orders.calculate.mockResolvedValueOnce({ order: { locationId: LOCATION, lineItems: [] } });
    expect(await adapter.quote(db, PIZZA_BUSINESS_ID, cartCases[0]!)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
  });
  it('marks sold-out, archived and unsellable variations unavailable and skips variable prices', () => {
    const objects = catalogObjects();
    const marg = objects.find((o): o is Square.CatalogObject.Item => o.type === 'ITEM' && o.id === SQ.itemMargherita)!;
    const [small, medium, large] = marg.itemData!.variations! as Square.CatalogObject.ItemVariation[];
    small!.itemVariationData!.locationOverrides = [{ locationId: LOCATION, soldOut: true }];
    medium!.itemVariationData!.sellable = false;
    large!.itemVariationData!.pricingType = 'VARIABLE_PRICING';
    const pep = objects.find((o): o is Square.CatalogObject.Item => o.type === 'ITEM' && o.id === SQ.itemPepperoni)!;
    pep.itemData!.isArchived = true;
    const rows = catalogRows(objects, LOCATION);
    expect(rows.map((row) => [row.squareVariationId, row.available])).toEqual([
      [SQ.varMargheritaSmall, false], [SQ.varMargheritaMedium, false],
      [SQ.varPepperoniSmall, false], [SQ.varPepperoniMedium, false], [SQ.varPepperoniLarge, false],
    ]);
  });
  it('builds the quote order from catalog IDs only, with automatic taxes', () => {
    const order = orderFromCart(cartCases[13]!, LOCATION);
    expect(order).toEqual({ locationId: LOCATION, pricingOptions: { autoApplyTaxes: true }, lineItems: cartCases[13]!.lines.map((line) => ({
      catalogObjectId: line.variationId, quantity: String(line.quantity), modifiers: line.modifierIds.map((id) => ({ catalogObjectId: id, quantity: '1' })),
    })) });
  });
  const checkoutInput = () => ({ order: { locationId: LOCATION, lineItems: [{ catalogObjectId: SQ.varMargheritaSmall, quantity: '1' }] }, idempotencyKey: 'a'.repeat(64), approvedTotalMinor: 3263, currency: 'USD' as const });
  it('passes the stable key unchanged on repeated CreatePaymentLink calls and reads the order', async () => {
    const { adapter, client } = setup();
    const input = checkoutInput();
    expect(await adapter.createCheckout(input)).toEqual({ squareOrderId: 'sq_order', paymentLinkId: 'link', url: 'https://square.example/checkout' });
    await adapter.createCheckout(input);
    const request = { idempotencyKey: input.idempotencyKey, order: { ...input.order, pricingOptions: { autoApplyTaxes: true } } };
    expect(client.checkout.paymentLinks.create.mock.calls).toEqual([[request], [request]]);
    expect(client.orders.get).toHaveBeenCalledWith({ orderId: 'sq_order' });
    expect(input.order).not.toHaveProperty('pricingOptions');
  });
  it('strips explicit order taxes and forces automatic taxes on checkout', async () => {
    const { adapter, client } = setup();
    await adapter.createCheckout({ ...checkoutInput(), order: { ...checkoutInput().order, taxes: [{ name: 'Tax', percentage: '8.75' }], pricingOptions: { autoApplyTaxes: false } } });
    expect(client.checkout.paymentLinks.create.mock.calls[0]![0].order).not.toHaveProperty('taxes');
    expect(client.checkout.paymentLinks.create.mock.calls[0]![0].order.pricingOptions?.autoApplyTaxes).toBe(true);
  });
  it('passes a 192-character key unchanged and refuses longer keys or another location before calling Square', async () => {
    const { adapter, client } = setup();
    const longKey = 'k'.repeat(192);
    await adapter.createCheckout({ ...checkoutInput(), idempotencyKey: longKey });
    expect(client.checkout.paymentLinks.create.mock.calls[0]![0].idempotencyKey).toBe(longKey);
    await expect(adapter.createCheckout({ ...checkoutInput(), idempotencyKey: 'k'.repeat(193) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(adapter.createCheckout({ ...checkoutInput(), order: { ...checkoutInput().order, locationId: 'elsewhere' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(client.checkout.paymentLinks.create).toHaveBeenCalledTimes(1);
  });
  it.each([['amount', money(3264)], ['currency', money(3263, 'CAD')], ['missing', undefined]] as const)('withholds the link on a %s total mismatch', async (_label, totalMoney) => {
    const { adapter, client } = setup();
    client.orders.get.mockResolvedValueOnce({ order: { id: 'sq_order', locationId: LOCATION, totalMoney } });
    await expect(adapter.createCheckout(checkoutInput())).rejects.toMatchObject({ code: 'INVALID_STATE', orderState: 'RECOVERY_REQUIRED', squareOrderId: 'sq_order', paymentLinkId: 'link' });
  });
  it('uses Square money even when it differs from cached fixture prices', async () => {
    const { adapter, client, db } = setup();
    const response = calculate({ order: { locationId: LOCATION, lineItems: [{ catalogObjectId: SQ.varMargheritaSmall, quantity: '1' }] } });
    response.order!.totalMoney = money(9999);
    response.order!.totalTaxMoney = money(77);
    response.order!.lineItems![0]!.basePriceMoney = money(1111);
    client.orders.calculate.mockResolvedValueOnce(response);
    expect(await adapter.quote(db, PIZZA_BUSINESS_ID, cartCases[0]!)).toMatchObject({ ok: true, quote: { totalMinor: 9999, taxMinor: 77, lines: [{ unitPriceMinor: 1111 }] } });
  });
  const expectedPayment = { squareOrderId: 'sq_order', amountMinor: 3263, currency: 'USD' as const, locationId: LOCATION };
  it('verifies a completed payment only after a matching fresh read', async () => {
    const { adapter, client } = setup();
    expect(await adapter.verifyPayment({ paymentId: 'pay', expected: expectedPayment })).toEqual({ verified: true, failedFields: [] });
    expect(client.payments.get).toHaveBeenCalledWith({ paymentId: 'pay' });
  });
  it.each([
    ['status', { status: 'APPROVED' }], ['squareOrderId', { orderId: 'wrong' }], ['locationId', { locationId: 'wrong' }],
    ['amountMinor', { amountMoney: money(1) }], ['currency', { amountMoney: money(3263, 'CAD') }], ['paymentId', { id: 'wrong' }],
  ] satisfies [string, Partial<Square.Payment>][])('names failed payment field %s', async (field, patch) => {
    const { adapter, client } = setup();
    const original = await client.payments.get({ paymentId: 'pay' });
    client.payments.get.mockResolvedValueOnce({ payment: { ...original.payment, ...patch } });
    expect(await adapter.verifyPayment({ paymentId: 'pay', expected: expectedPayment })).toEqual({ verified: false, failedFields: [field] });
  });
  it('rejects a missing payment', async () => {
    const { adapter, client } = setup();
    client.payments.get.mockResolvedValueOnce({});
    expect(await adapter.verifyPayment({ paymentId: 'pay', expected: expectedPayment })).toMatchObject({ verified: false });
  });
  it('reads and deduplicates tenders before ListPayments', async () => {
    const { adapter, client } = setup();
    client.orders.get.mockResolvedValueOnce({ order: { locationId: LOCATION, tenders: [{ type: 'CARD', paymentId: 'pay' }, { type: 'CARD', paymentId: 'pay' }, { type: 'CARD', id: 'pay_legacy' }] } });
    expect(await adapter.findPaymentForOrder('sq_order')).toEqual(['pay', 'pay_legacy']);
    expect(client.payments.list).not.toHaveBeenCalled();
  });
  it('filters fallback payment pages by order since ListPayments has no order filter', async () => {
    const { adapter, client } = setup();
    client.payments.list.mockResolvedValueOnce(values([{ id: 'wrong', orderId: 'other' }, { id: 'pay', orderId: 'sq_order' }, { id: 'pay', orderId: 'sq_order' }]));
    expect(await adapter.findPaymentForOrder('sq_order')).toEqual(['pay']);
    expect(client.orders.get.mock.invocationCallOrder[0]!).toBeLessThan(client.payments.list.mock.invocationCallOrder[0]!);
    expect(client.payments.list.mock.calls[0]![0]).toMatchObject({ locationId: LOCATION, sortOrder: 'DESC' });
    expect(client.payments.list.mock.calls[0]![0]).not.toHaveProperty('orderId');
  });
});
describe('Square webhook signatures', () => {
  const input = { rawBody: '{"event_id":"evt_1","name":"café"}\n', notificationUrl: 'https://server.example/webhooks/square', signatureKey: 'test-only-key' };
  const signatureHeader = createHmac('sha256', input.signatureKey).update(input.notificationUrl).update(input.rawBody).digest('base64');
  it('accepts an exact signature over raw UTF-8 bytes', () => {
    expect(verifyWebhookSignature({ ...input, signatureHeader })).toBe(true);
    expect(verifyWebhookSignature({ ...input, rawBody: Buffer.from(input.rawBody), signatureHeader })).toBe(true);
  });
  it.each([{ rawBody: input.rawBody.trim() }, { notificationUrl: `${input.notificationUrl}/` }, { signatureKey: 'wrong-key' },
    { signatureHeader: undefined }, { signatureHeader: '' }, { signatureHeader: 'not-base64' }, { signatureHeader: 'a'.repeat(44) },
  ])('rejects altered or missing inputs %j', (patch) => {
    expect(verifyWebhookSignature({ ...input, signatureHeader, ...patch })).toBe(false);
  });
});
