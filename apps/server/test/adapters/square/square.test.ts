import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SquareClient as SdkClient, SquareEnvironment, SquareError, SquareTimeoutError, type Square } from 'square';
import { cartHash, PIZZA_BUSINESS_ID, QUOTE_EXPIRY_MS, QuoteSchema, type Cart } from '@abos/contracts';
import { demoTaxMinor, pizzaCatalog, SQ } from '@abos/contracts/fixtures';
import {
  CATALOG_PRICE_MAX, SquareAdapterError, SquareCheckoutError, catalogRows, createSandboxSquareClient, createSquareAdapter, orderFromCart, verifyWebhookSignature,
} from '../../../src/adapters/square/index';
import { createSquareAdapterForTest } from '../../../src/adapters/square/testing';
import type { Database, Queryable, SandboxSquareClient, SquareClient } from '../../../src/adapters/square/types';

// tsc verifies that a real SDK client fits this boundary without a cast.
const acceptsSdkClient = (client: SdkClient): SquareClient => client;
void acceptsSdkClient;
const NOW = new Date('2026-11-13T20:00:00Z');
const LOCATION = 'location_sandbox';
const money = (amount: number, currency: Square.Currency = 'USD'): Square.Money => ({ amount: BigInt(amount), currency });
async function* values<T>(items: T[]): AsyncIterable<T> { yield* items; }
/** A provider error whose message and body carry a fake secret, to prove it never crosses the adapter boundary. */
const SECRET = 'sq0atp-SECRET_MARKER_123';
function secretError(statusCode?: number): Error {
  return statusCode === undefined
    ? new SquareTimeoutError(`timed out ${SECRET}`)
    : new SquareError({ message: `failed ${SECRET}`, statusCode, body: { errors: [{ detail: SECRET }] } });
}
async function* latePageFailure<T>(first: T, error: unknown): AsyncIterable<T> { yield first; throw error; }
async function expectSanitized(promise: Promise<unknown>, code: string, message?: string): Promise<SquareAdapterError> {
  const error = await promise.then(() => { throw new Error('expected a rejection'); }, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SquareAdapterError);
  const typed = error as SquareAdapterError;
  expect(typed.code).toBe(code);
  if (message !== undefined) expect(typed.message).toBe(message);
  expect(typed.cause).toBeUndefined();
  expect(JSON.stringify({ ...typed, message: typed.message, stack: typed.stack })).not.toContain('SECRET_MARKER');
  return typed;
}const catalogObjects = (): Square.CatalogObject[] => [
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
    } })),
      get: vi.fn(async (_request: { id: string }): Promise<Square.GetPaymentLinkResponse> => ({ paymentLink: { id: 'link', version: 1, orderId: 'sq_order', url: 'https://square.example/checkout' } })),
      list: vi.fn(async (_request: { limit?: number }) => values<Square.PaymentLink>([{ id: 'link', version: 1, orderId: 'sq_order', url: 'https://square.example/checkout' }])),
    } },
    payments: {
      get: vi.fn(async (_request: { paymentId: string }): Promise<Square.GetPaymentResponse> => ({ payment: {
        id: 'pay', status: 'COMPLETED', orderId: 'sq_order', locationId: LOCATION, amountMoney: money(3263),
      } })),
      list: vi.fn(async (_request: { locationId: string; beginTime: string; sortOrder: 'DESC'; limit: number }) => values<Square.Payment>([])),
    },
  };
  const options = { locationId: LOCATION, environment: 'sandbox', now: () => new Date(NOW) };
  return { client, options, adapter: createSquareAdapterForTest(client, options), db: new FakeDb() };
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
    expect(() => createSquareAdapterForTest(setup().client, { locationId: LOCATION, environment, now: () => NOW }))
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
  it('maps a late catalog page failure to a sanitized typed error and leaves the cache alone', async () => {
    const { adapter, client, db } = setup();
    client.catalog.list.mockImplementationOnce(async () => latePageFailure(catalogObjects()[0]!, secretError(500)));
    await expectSanitized(adapter.syncCatalog(db, PIZZA_BUSINESS_ID), 'INTEGRATION_UNAVAILABLE', 'The Square catalog list request failed.');
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
    { signatureKey: '' }, { notificationUrl: '' }, { signatureHeader: signatureHeader.slice(0, -1) }, { signatureHeader: `${signatureHeader}A` },
  ])('rejects altered or missing inputs %j', (patch) => {
    expect(verifyWebhookSignature({ ...input, signatureHeader, ...patch })).toBe(false);
  });
});

// ---------- review fixes (B-12 review findings 1 to 7) ----------

const KEY = 'b'.repeat(64);
const baseCheckout = () => ({
  order: { locationId: LOCATION, lineItems: [{ catalogObjectId: SQ.varMargheritaSmall, quantity: '1' }] },
  idempotencyKey: KEY, approvedTotalMinor: 3263, currency: 'USD' as const,
});
const paid = { squareOrderId: 'sq_order', amountMinor: 3263, currency: 'USD' as const, locationId: LOCATION };
const completedPayment = (patch: Partial<Square.Payment> = {}): Square.GetPaymentResponse => ({ payment: {
  id: 'pay', status: 'COMPLETED', orderId: 'sq_order', locationId: LOCATION, amountMoney: money(3263), ...patch,
} });

describe('payment verification: refunds, tips and split tenders', () => {
  it.each([
    ['full refund', 3263, ['refunded']],
    ['partial refund', 100, ['refunded']],
    ['zero refund', 0, []],
  ] as const)('a COMPLETED, otherwise matching payment with a %s', async (_label, refunded, failed) => {
    const { adapter, client } = setup();
    client.payments.get.mockResolvedValueOnce(completedPayment({ refundedMoney: money(refunded) }));
    expect(await adapter.verifyPayment({ paymentId: 'pay', expected: paid }))
      .toEqual(failed.length === 0 ? { verified: true, failedFields: [] } : { verified: false, failedFields: [...failed] });
  });
  it('fails closed on refund IDs even before refunded money is reported', async () => {
    const { adapter, client } = setup();
    client.payments.get.mockResolvedValueOnce(completedPayment({ refundIds: ['refund_1'] }));
    expect(await adapter.verifyPayment({ paymentId: 'pay', expected: paid })).toEqual({ verified: false, failedFields: ['refunded'] });
  });
  it('compares amount_money, so a tip does not change the comparison', async () => {
    const { adapter, client } = setup();
    client.payments.get.mockResolvedValueOnce(completedPayment({ tipMoney: money(500), totalMoney: money(3763) }));
    expect(await adapter.verifyPayment({ paymentId: 'pay', expected: paid })).toEqual({ verified: true, failedFields: [] });
  });
  it('returns both IDs for two partial tenders but verifies neither: one payment must cover the order', async () => {
    const { adapter, client } = setup();
    client.orders.get.mockResolvedValueOnce({ order: { id: 'sq_order', locationId: LOCATION, tenders: [
      { type: 'CARD', paymentId: 'pay_a', amountMoney: money(1500) }, { type: 'CARD', paymentId: 'pay_b', amountMoney: money(1763) },
    ] } });
    expect(await adapter.findPaymentForOrder('sq_order')).toEqual(['pay_a', 'pay_b']);
    for (const [paymentId, amount] of [['pay_a', 1500], ['pay_b', 1763]] as const) {
      client.payments.get.mockResolvedValueOnce(completedPayment({ id: paymentId, amountMoney: money(amount) }));
      expect(await adapter.verifyPayment({ paymentId, expected: paid })).toEqual({ verified: false, failedFields: ['amountMinor'] });
    }
  });
});

describe('sandbox by construction', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  it('sends every request from a factory client to the sandbox host, with no request leaving the process', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const path = new URL(url).pathname;
      if (path.startsWith('/v2/payments/')) return json({ payment: { id: 'pay', status: 'COMPLETED', order_id: 'sq_order', location_id: LOCATION, amount_money: { amount: 3263, currency: 'USD' } } });
      if (path.startsWith('/v2/catalog/list')) return json({ objects: [] });
      if (path.startsWith('/v2/online-checkout/payment-links')) return json({ payment_link: { id: 'link', version: 1, order_id: 'sq_order', url: 'https://sandbox.square.link/u/test' } });
      if (path.startsWith('/v2/orders/')) return json({ order: { id: 'sq_order', location_id: LOCATION, total_money: { amount: 3263, currency: 'USD' }, tenders: [{ type: 'CARD', payment_id: 'pay' }] } });
      return json({});
    }));
    const adapter = createSquareAdapter({ client: createSandboxSquareClient({ accessToken: 'test-token-not-real' }), locationId: LOCATION, environment: 'sandbox', now: () => NOW });
    expect(await adapter.verifyPayment({ paymentId: 'pay', expected: paid })).toEqual({ verified: true, failedFields: [] });
    expect(await adapter.syncCatalog(new FakeDb(), PIZZA_BUSINESS_ID)).toBe(0);
    expect(await adapter.createCheckout(baseCheckout())).toEqual({ squareOrderId: 'sq_order', paymentLinkId: 'link', url: 'https://sandbox.square.link/u/test' });
    expect(await adapter.findPaymentForOrder('sq_order')).toEqual(['pay']);
    expect(urls.length).toBeGreaterThanOrEqual(5);
    for (const url of urls) expect(url.startsWith('https://connect.squareupsandbox.com/')).toBe(true);
  });
  it.each([
    ['production', () => new SdkClient({ token: 'x', environment: SquareEnvironment.Production })],
    ['default (production)', () => new SdkClient({ token: 'x' })],
    ['custom base URL', () => new SdkClient({ token: 'x', baseUrl: 'https://proxy.example' })],
    ['hand-built sandbox', () => new SdkClient({ token: 'x', environment: SquareEnvironment.Sandbox })],
  ])('refuses a %s client not built by the factory, before any request', (_label, build) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(() => createSquareAdapter({ client: build() as unknown as SandboxSquareClient, locationId: LOCATION, environment: 'sandbox', now: () => NOW }))
      .toThrowError(expect.objectContaining({ code: 'ENVIRONMENT_MISMATCH' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('refuses a fake client on the production entry point and an empty token in the factory', () => {
    expect(() => createSquareAdapter({ client: setup().client as unknown as SandboxSquareClient, locationId: LOCATION, environment: 'sandbox', now: () => NOW }))
      .toThrowError(expect.objectContaining({ code: 'ENVIRONMENT_MISMATCH' }));
    expect(() => createSandboxSquareClient({ accessToken: '' })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('checkout outcomes and resume', () => {
  const keysSent = (client: ReturnType<typeof setup>['client']) => client.checkout.paymentLinks.create.mock.calls.map(([request]) => request.idempotencyKey);
  it.each([
    ['a timeout', undefined, 'unknown', 'INTEGRATION_UNAVAILABLE'],
    ['a 500', 500, 'unknown', 'INTEGRATION_UNAVAILABLE'],
    ['a 408', 408, 'unknown', 'INTEGRATION_UNAVAILABLE'],
    ['a 429', 429, 'not_created', 'RATE_LIMITED'],
    ['a 400', 400, 'not_created', 'INTEGRATION_UNAVAILABLE'],
  ] as const)('classifies %s during CreatePaymentLink', async (_label, status, outcome, code) => {
    const { adapter, client } = setup();
    const onLinkCreated = vi.fn();
    client.checkout.paymentLinks.create.mockRejectedValueOnce(secretError(status));
    const error = await expectSanitized(adapter.createCheckout({ ...baseCheckout(), onLinkCreated }), code);
    expect(error).toBeInstanceOf(SquareCheckoutError);
    expect(error).toMatchObject({ outcome, idempotencyKey: KEY, squareOrderId: undefined, paymentLinkId: undefined });
    expect(onLinkCreated).not.toHaveBeenCalled();
    expect(client.orders.get).not.toHaveBeenCalled();
  });
  it('gives created_unverified with both IDs after the callback when the read-back times out, then resumes by read', async () => {
    const { adapter, client } = setup();
    const onLinkCreated = vi.fn(async () => {});
    client.orders.get.mockRejectedValueOnce(secretError());
    const error = await expectSanitized(adapter.createCheckout({ ...baseCheckout(), onLinkCreated }), 'INTEGRATION_UNAVAILABLE');
    expect(error).toMatchObject({ outcome: 'created_unverified', idempotencyKey: KEY, squareOrderId: 'sq_order', paymentLinkId: 'link' });
    expect(error).not.toHaveProperty('url');
    expect(onLinkCreated).toHaveBeenCalledWith({ squareOrderId: 'sq_order', paymentLinkId: 'link', url: 'https://square.example/checkout' });
    expect(onLinkCreated.mock.invocationCallOrder[0]!).toBeLessThan(client.orders.get.mock.invocationCallOrder[0]!);

    const resumed = await adapter.resumeCheckout({ squareOrderId: 'sq_order', paymentLinkId: 'link', approvedTotalMinor: 3263, currency: 'USD', idempotencyKey: KEY });
    expect(resumed).toEqual({ squareOrderId: 'sq_order', paymentLinkId: 'link', url: 'https://square.example/checkout' });
    expect(client.checkout.paymentLinks.get).toHaveBeenCalledWith({ id: 'link' });
    // Resume made no write, and the only create carried the caller's key.
    expect(keysSent(client)).toEqual([KEY]);
  });
  it('resumes after a restart with only the order ID by listing links, and still checks the total', async () => {
    const { adapter, client } = setup();
    expect(await adapter.resumeCheckout({ squareOrderId: 'sq_order', approvedTotalMinor: 3263, currency: 'USD' })).toMatchObject({ paymentLinkId: 'link' });
    expect(client.checkout.paymentLinks.list).toHaveBeenCalled();
    client.orders.get.mockResolvedValueOnce({ order: { id: 'sq_order', locationId: LOCATION, totalMoney: money(1) } });
    await expect(adapter.resumeCheckout({ squareOrderId: 'sq_order', paymentLinkId: 'link', approvedTotalMinor: 3263, currency: 'USD', idempotencyKey: KEY }))
      .rejects.toMatchObject({ outcome: 'total_mismatch', orderState: 'RECOVERY_REQUIRED', idempotencyKey: KEY, squareOrderId: 'sq_order', paymentLinkId: 'link' });
    expect(client.checkout.paymentLinks.create).not.toHaveBeenCalled();
  });
  it('maps resume read failures: a late link page failure stays created_unverified, a missing link is unknown', async () => {
    const { adapter, client } = setup();
    client.checkout.paymentLinks.list.mockImplementationOnce(async () => latePageFailure({ id: 'other', version: 1, orderId: 'other' }, secretError(503)));
    expect(await expectSanitized(adapter.resumeCheckout({ squareOrderId: 'sq_order', approvedTotalMinor: 3263, currency: 'USD' }), 'INTEGRATION_UNAVAILABLE'))
      .toMatchObject({ outcome: 'created_unverified' });
    client.checkout.paymentLinks.get.mockRejectedValueOnce(secretError(404));
    expect(await expectSanitized(adapter.resumeCheckout({ squareOrderId: 'sq_order', paymentLinkId: 'link', approvedTotalMinor: 3263, currency: 'USD', idempotencyKey: KEY }), 'NOT_FOUND'))
      .toMatchObject({ outcome: 'unknown', idempotencyKey: KEY });
  });
  it('withholds the link when the caller cannot record it', async () => {
    const { adapter, client } = setup();
    const error = await expectSanitized(adapter.createCheckout({ ...baseCheckout(), onLinkCreated: async () => { throw new Error(SECRET); } }), 'INTERNAL');
    expect(error).toMatchObject({ outcome: 'created_unverified', squareOrderId: 'sq_order', paymentLinkId: 'link', idempotencyKey: KEY });
    expect(client.orders.get).not.toHaveBeenCalled();
  });
  it('reports a total mismatch with the key and both IDs', async () => {
    const { adapter, client } = setup();
    client.orders.get.mockResolvedValueOnce({ order: { id: 'sq_order', locationId: LOCATION, totalMoney: money(3264) } });
    await expect(adapter.createCheckout(baseCheckout())).rejects.toMatchObject({
      code: 'INVALID_STATE', outcome: 'total_mismatch', orderState: 'RECOVERY_REQUIRED', idempotencyKey: KEY, squareOrderId: 'sq_order', paymentLinkId: 'link',
    });
  });
});

describe('provider errors are typed and sanitized', () => {
  it('maps a rate-limited catalog list', async () => {
    const { adapter, client, db } = setup();
    client.catalog.list.mockRejectedValueOnce(secretError(429));
    await expectSanitized(adapter.syncCatalog(db, PIZZA_BUSINESS_ID), 'RATE_LIMITED', 'Square rate limited the catalog list request.');
  });
  it('maps a late payment list page failure', async () => {
    const { adapter, client } = setup();
    client.payments.list.mockImplementationOnce(async () => latePageFailure<Square.Payment>({ id: 'x', orderId: 'other' }, secretError(500)));
    await expectSanitized(adapter.findPaymentForOrder('sq_order'), 'INTEGRATION_UNAVAILABLE', 'The Square payment list request failed.');
  });
  it('maps an order read failure in the payment lookup', async () => {
    const { adapter, client } = setup();
    client.orders.get.mockRejectedValueOnce(secretError(429));
    await expectSanitized(adapter.findPaymentForOrder('sq_order'), 'RATE_LIMITED', 'Square rate limited the order read request.');
  });
  it('maps a payment read failure', async () => {
    const { adapter, client } = setup();
    client.payments.get.mockRejectedValueOnce(secretError());
    await expectSanitized(adapter.verifyPayment({ paymentId: 'pay', expected: paid }), 'INTEGRATION_UNAVAILABLE', 'The Square payment read request failed.');
  });
  it('keeps a pricing failure inside the tool result with a fixed message', async () => {
    const { adapter, client, db } = setup();
    client.orders.calculate.mockRejectedValueOnce(secretError(500));
    const result = await adapter.quote(db, PIZZA_BUSINESS_ID, cartCases[0]!);
    expect(result).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', code: 'INTEGRATION_UNAVAILABLE', message: 'Square could not price the order.' });
  });
});

const findItem = (objects: Square.CatalogObject[], id: string) => objects.find((o): o is Square.CatalogObject.Item => o.type === 'ITEM' && o.id === id)!;
const findVariation = (objects: Square.CatalogObject[], itemId: string, id: string) =>
  (findItem(objects, itemId).itemData!.variations as Square.CatalogObject.ItemVariation[]).find((v) => v.id === id)!;
const toppings = (objects: Square.CatalogObject[]) => objects.find((o): o is Square.CatalogObject.ModifierList => o.type === 'MODIFIER_LIST')!;
const topping = (objects: Square.CatalogObject[], id: string) =>
  (toppings(objects).modifierListData!.modifiers as Square.CatalogObject.Modifier[]).find((m) => m.id === id)!;
const firstRowModifiers = (objects: Square.CatalogObject[]) =>
  catalogRows(objects, LOCATION).find((row) => row.squareVariationId === SQ.varMargheritaSmall)!.modifierLists.flatMap((list) => list.modifiers);

describe('catalog money and modifier location rules', () => {
  const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  it.each([
    ['integer maximum', CATALOG_PRICE_MAX, true],
    ['integer maximum plus one', CATALOG_PRICE_MAX + 1n, false],
    ['safe-integer maximum', SAFE, false],
    ['safe-integer maximum plus one', SAFE + 1n, false],
  ] as const)('caches a variation priced at the %s only when it fits the integer column', async (_label, amount, cached) => {
    const { adapter, client, db } = setup();
    const objects = catalogObjects();
    findVariation(objects, SQ.itemMargherita, SQ.varMargheritaSmall).itemVariationData!.priceMoney = { amount, currency: 'USD' };
    client.catalog.list.mockResolvedValueOnce(values(objects));
    expect(await adapter.syncCatalog(db, PIZZA_BUSINESS_ID)).toBe(cached ? 6 : 5);
    const insert = db.calls.find((call) => /insert/i.test(call.text) && call.params[2] === SQ.varMargheritaSmall);
    if (cached) expect(insert!.params[8]).toBe(2147483647);
    else expect(insert).toBeUndefined();
    // The earlier cached row for that variation is disabled by the missing-row update.
    expect(db.rows.find((row) => row.square_variation_id === SQ.varMargheritaSmall)!.is_available).toBe(cached);
  });
  it('does not cache a variation priced in another currency', () => {
    const objects = catalogObjects();
    findVariation(objects, SQ.itemMargherita, SQ.varMargheritaSmall).itemVariationData!.priceMoney = money(1200, 'CAD');
    expect(catalogRows(objects, LOCATION).map((row) => row.squareVariationId)).not.toContain(SQ.varMargheritaSmall);
  });
  it('applies a location price override and a zero-price override to modifiers', () => {
    const objects = catalogObjects();
    topping(objects, SQ.modExtraCheese).modifierData!.locationOverrides = [{ locationId: LOCATION, priceMoney: money(250) }, { locationId: 'elsewhere', priceMoney: money(999) }];
    topping(objects, SQ.modOlives).modifierData!.locationOverrides = [{ locationId: LOCATION, priceMoney: money(0) }];
    expect(firstRowModifiers(objects)).toEqual([
      { id: SQ.modMushrooms, name: 'Mushrooms', priceMinor: 150 }, { id: SQ.modOlives, name: 'Olives', priceMinor: 0 }, { id: SQ.modExtraCheese, name: 'Extra cheese', priceMinor: 250 },
    ]);
  });
  it.each([
    ['sold out here', (objects: Square.CatalogObject[]) => { topping(objects, SQ.modExtraCheese).modifierData!.locationOverrides = [{ locationId: LOCATION, soldOut: true }]; }],
    ['absent here', (objects: Square.CatalogObject[]) => { topping(objects, SQ.modExtraCheese).absentAtLocationIds = [LOCATION]; }],
    ['priced in another currency', (objects: Square.CatalogObject[]) => { topping(objects, SQ.modExtraCheese).modifierData!.priceMoney = money(200, 'CAD'); }],
    ['missing its price', (objects: Square.CatalogObject[]) => { delete topping(objects, SQ.modExtraCheese).modifierData!.priceMoney; }],
  ])('drops a modifier that is %s from the cached allowlist', (_label, mutate) => {
    const objects = catalogObjects();
    mutate(objects);
    expect(firstRowModifiers(objects).map((m) => m.id)).toEqual([SQ.modMushrooms, SQ.modOlives]);
  });
  it('drops a modifier list that is absent at this location', () => {
    const objects = catalogObjects();
    Object.assign(toppings(objects), { presentAtAllLocations: false, presentAtLocationIds: ['elsewhere'] });
    expect(firstRowModifiers(objects)).toEqual([]);
  });
  it('rejects a sold-out modifier in quote after a sync, before calling Square', async () => {
    const { adapter, client, db } = setup();
    const objects = catalogObjects();
    topping(objects, SQ.modExtraCheese).modifierData!.locationOverrides = [{ locationId: LOCATION, soldOut: true }];
    client.catalog.list.mockResolvedValueOnce(values(objects));
    await adapter.syncCatalog(db, PIZZA_BUSINESS_ID);
    const cart: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaSmall, quantity: 1, modifierIds: [SQ.modExtraCheese] }] };
    expect(await adapter.quote(db, PIZZA_BUSINESS_ID, cart)).toMatchObject({ ok: false, code: 'ITEM_UNAVAILABLE' });
    expect(client.orders.calculate).not.toHaveBeenCalled();
  });
});

describe('SDK-shaped CalculateOrder fixtures', () => {
  const margSmall: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaSmall, quantity: 1, modifierIds: [] }] };
  it('maps an inclusive-tax response as Square returns it', async () => {
    const { adapter, client, db } = setup();
    client.orders.calculate.mockResolvedValueOnce({ order: { locationId: LOCATION,
      lineItems: [{ uid: 'l1', catalogObjectId: SQ.varMargheritaSmall, quantity: '1', name: 'Margherita Small', basePriceMoney: money(1200),
        grossSalesMoney: money(1104), totalTaxMoney: money(96), totalMoney: money(1200), modifiers: [] }],
      taxes: [{ uid: 't1', name: 'Inclusive tax', percentage: '8.7', type: 'INCLUSIVE', scope: 'ORDER' }],
      totalTaxMoney: money(96), totalMoney: money(1200) } });
    expect(await adapter.quote(db, PIZZA_BUSINESS_ID, margSmall)).toMatchObject({ ok: true, quote: { subtotalMinor: 1104, taxMinor: 96, totalMinor: 1200, lines: [{ lineTotalMinor: 1200 }] } });
  });
  it('passes a discount and service charge where total is not subtotal plus tax (SPEC 2.9)', async () => {
    const { adapter, client, db } = setup();
    client.orders.calculate.mockResolvedValueOnce({ order: { locationId: LOCATION,
      lineItems: [{ uid: 'l1', catalogObjectId: SQ.varMargheritaSmall, quantity: '1', name: 'Margherita Small', basePriceMoney: money(1200),
        grossSalesMoney: money(1200), totalDiscountMoney: money(200), totalTaxMoney: money(88), totalMoney: money(1088) }],
      totalDiscountMoney: money(200), totalServiceChargeMoney: money(300), totalTaxMoney: money(114), totalMoney: money(1414) } });
    const result = await adapter.quote(db, PIZZA_BUSINESS_ID, margSmall);
    expect(result).toMatchObject({ ok: true, quote: { subtotalMinor: 1200, taxMinor: 114, totalMinor: 1414 } });
  });
  it('maps quantity three with two modifiers from Square line money', async () => {
    const { adapter, client, db } = setup();
    const cart: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaMedium, quantity: 3, modifierIds: [SQ.modMushrooms, SQ.modExtraCheese] }] };
    client.orders.calculate.mockResolvedValueOnce({ order: { locationId: LOCATION,
      lineItems: [{ uid: 'l1', catalogObjectId: SQ.varMargheritaMedium, quantity: '3', name: 'Margherita Medium', basePriceMoney: money(1600),
        modifiers: [
          { uid: 'm1', catalogObjectId: SQ.modMushrooms, name: 'Mushrooms', quantity: '1', basePriceMoney: money(150), totalPriceMoney: money(450) },
          { uid: 'm2', catalogObjectId: SQ.modExtraCheese, name: 'Extra cheese', quantity: '1', basePriceMoney: money(200), totalPriceMoney: money(600) },
        ],
        grossSalesMoney: money(5850), totalTaxMoney: money(512), totalMoney: money(6362) }],
      totalTaxMoney: money(512), totalMoney: money(6362) } });
    expect(await adapter.quote(db, PIZZA_BUSINESS_ID, cart)).toMatchObject({ ok: true, quote: { subtotalMinor: 5850, taxMinor: 512, totalMinor: 6362, lines: [{
      quantity: 3, unitPriceMinor: 1600, lineTotalMinor: 6362,
      modifiers: [{ modifierId: SQ.modMushrooms, priceMinor: 150 }, { modifierId: SQ.modExtraCheese, priceMinor: 200 }],
    }] } });
  });
  it('fails the quote when Square money is beyond the safe-integer range', async () => {
    const { adapter, client, db } = setup();
    const response = calculate({ order: orderFromCart(margSmall, LOCATION) });
    response.order!.totalMoney = { amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n, currency: 'USD' };
    client.orders.calculate.mockResolvedValueOnce(response);
    expect(await adapter.quote(db, PIZZA_BUSINESS_ID, margSmall)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
  });
});