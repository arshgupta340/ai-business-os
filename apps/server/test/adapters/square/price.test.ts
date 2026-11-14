import { describe, expect, it, vi } from 'vitest';
import { SquareClient, SquareEnvironment, SquareError, type Square } from 'square';
import { createPriceAdapter, createPriceAdapterForTest, type PriceSquareClient } from '../../../src/adapters/square/price';
import type { SandboxSquareClient } from '../../../src/adapters/square/types';

const variation = (amount = 2200n): Square.CatalogObject.ItemVariation => ({
  type: 'ITEM_VARIATION', id: 'var', version: 10n,
  itemVariationData: { itemId: 'item', name: 'Large', pricingType: 'FIXED_PRICING', priceMoney: { amount, currency: 'USD' } },
});
const input = { variationId: 'var', expectedOldPriceMinor: 2200, newPriceMinor: 1900, currency: 'USD' as const, idempotencyKey: 'a'.repeat(200), expectedVersion: 10 };
function setup() {
  const get = vi.fn<PriceSquareClient['catalog']['object']['get']>(async () => ({ object: variation() }));
  const upsert = vi.fn<PriceSquareClient['catalog']['object']['upsert']>(async () => ({ catalogObject: variation(1900n) }));
  const verified = variation(1900n);
  verified.version = 11n;
  get.mockResolvedValueOnce({ object: variation() }).mockResolvedValue({ object: verified });
  const adapter = createPriceAdapterForTest({ client: { __priceAdapterTestFake: true, catalog: { object: { get, upsert } } }, locationId: 'loc', environment: 'sandbox' });
  return { adapter, get, upsert };
}
describe('Square price updates', () => {
  it('uses the unchanged full object, version, configured-location override, and long key', async () => {
    const { adapter, upsert, get } = setup();
    await expect(adapter.updateVariationPrice(input)).resolves.toMatchObject({ verified: true, version: 11 });
    expect(upsert.mock.calls[0]?.[0]).toEqual({ idempotencyKey: input.idempotencyKey, object: {
      ...variation(), itemVariationData: { ...variation().itemVariationData, locationOverrides: [{ locationId: 'loc', priceMoney: { amount: 1900n, currency: 'USD' } }] },
    } });
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('refuses an old price that changed', async () => {
    const { adapter, upsert } = setup();
    await expect(adapter.updateVariationPrice({ ...input, expectedOldPriceMinor: 2100 })).rejects.toMatchObject({ outcome: 'not_updated' });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('refuses stale approved versions', async () => {
    const { adapter, upsert } = setup();
    await expect(adapter.updateVariationPrice({ ...input, expectedVersion: 9 })).rejects.toMatchObject({ outcome: 'stale_version' });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('reports uncertainty after send without retry or leaking errors', async () => {
    const { adapter, upsert } = setup();
    upsert.mockRejectedValue(new Error('secret token'));
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'unknown', message: 'The Square price write could not be confirmed.' });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it('reports a failed read-back separately', async () => {
    const { adapter, get } = setup();
    get.mockRejectedValue(new Error('private'));
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'updated_unverified' });
  });
  it('reports read-back mismatch', async () => {
    const { adapter, get } = setup();
    get.mockResolvedValue({ object: variation(1800n) });
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'mismatch' });
  });
  it.each(['EUR', 'USD'] as const)('refuses invalid provider money in %s', async (currency) => {
    const { adapter, get, upsert } = setup();
    const object = variation(currency === 'USD' ? 2147483648n : 2200n);
    object.itemVariationData!.priceMoney!.currency = currency;
    get.mockReset().mockResolvedValue({ object });
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'not_updated' });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('rejects a wrong input currency without reading', async () => {
    const { adapter, get, upsert } = setup();
    await expect(adapter.updateVariationPrice({ ...input, currency: 'EUR' as 'USD' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(get).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
  it('treats an unverified provider concurrency conflict as unknown', async () => {
    const { adapter, upsert } = setup();
    upsert.mockRejectedValue(new SquareError({ statusCode: 409, body: { errors: [{ code: 'CONFLICT' }] } }));
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it('treats an error response with a conflict as unknown', async () => {
    const { adapter, upsert, get } = setup();
    upsert.mockResolvedValue({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'CONFLICT' }] });
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('creates a configured-location override without changing the global or other location prices', async () => {
    const { adapter, get, upsert } = setup();
    const object = variation();
    object.itemVariationData!.locationOverrides = [{ locationId: 'other', priceMoney: { amount: 2500n, currency: 'USD' } }];
    const written = structuredClone(object);
    written.itemVariationData!.locationOverrides!.push({ locationId: 'loc', priceMoney: { amount: 1900n, currency: 'USD' } });
    const verified = structuredClone(written);
    verified.version = 11n;
    get.mockReset().mockResolvedValueOnce({ object }).mockResolvedValue({ object: verified });
    await adapter.updateVariationPrice(input);
    expect(upsert.mock.calls[0]![0].object).toEqual(written);
    expect((upsert.mock.calls[0]![0].object as Square.CatalogObject.ItemVariation).itemVariationData!.priceMoney!.amount).toBe(2200n);
    expect(object.itemVariationData!.locationOverrides![0]!.priceMoney!.amount).toBe(2500n);
  });
  it('adds a price to an inventory-only configured-location override without changing inherited locations', async () => {
    const { adapter, get, upsert } = setup();
    const object = variation();
    object.itemVariationData!.locationOverrides = [{ locationId: 'loc', trackInventory: true }, { locationId: 'other', trackInventory: false }];
    const writtenExpected = structuredClone(object);
    writtenExpected.itemVariationData!.locationOverrides![0]!.priceMoney = { amount: 1900n, currency: 'USD' };
    const verified = structuredClone(writtenExpected);
    verified.version = 11n;
    get.mockReset().mockResolvedValueOnce({ object }).mockResolvedValue({ object: verified });
    await adapter.updateVariationPrice(input);
    expect(upsert.mock.calls[0]![0].object).toEqual(writtenExpected);
    const written = upsert.mock.calls[0]![0].object as Square.CatalogObject.ItemVariation;
    expect(written.itemVariationData!.priceMoney!.amount).toBe(2200n);
    expect(written.itemVariationData!.locationOverrides![1]).toEqual({ locationId: 'other', trackInventory: false });
  });
  it('reuses the same key for a later eligible retry and refuses replay after a verified version increment', async () => {
    const { adapter, get, upsert } = setup();
    upsert.mockRejectedValueOnce(new SquareError({ statusCode: 429 }));
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'not_updated' });
    const current = variation();
    const verified = variation(1900n);
    verified.version = 11n;
    get.mockReset().mockResolvedValueOnce({ object: current }).mockResolvedValue({ object: verified });
    await adapter.updateVariationPrice(input);
    expect(upsert.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([input.idempotencyKey, input.idempotencyKey]);
    expect(upsert.mock.calls.every(([, options]) => options?.maxRetries === 0)).toBe(true);
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'stale_version' });
    expect(upsert).toHaveBeenCalledTimes(2);
  });
  it('never sends a write when the initial read fails', async () => {
    const { adapter, get, upsert } = setup();
    get.mockReset().mockRejectedValue(new Error('private'));
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'not_updated' });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('rejects a real production SDK client through every public constructor', () => {
    const client: PriceSquareClient = { catalog: { object: { get: vi.fn(), upsert: vi.fn() } } };
    const productionClient = new SquareClient({ token: 'not-a-secret', environment: SquareEnvironment.Production });
    expect(() => createPriceAdapterForTest({ client: productionClient as unknown as PriceSquareClient & { __priceAdapterTestFake: true }, locationId: 'loc', environment: 'sandbox' })).toThrow();
    expect(() => createPriceAdapterForTest({ client: { ...client, __priceAdapterTestFake: false } as unknown as PriceSquareClient & { __priceAdapterTestFake: true }, locationId: 'loc', environment: 'sandbox' })).toThrow();
    expect(() => createPriceAdapter({ client: client as unknown as SandboxSquareClient, locationId: 'loc', environment: 'sandbox' })).toThrow();
  });
});
