import { describe, expect, it, vi } from 'vitest';
import { SquareError, type Square } from 'square';
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
  get.mockResolvedValueOnce({ object: variation() }).mockResolvedValue({ object: variation(1900n) });
  const adapter = createPriceAdapterForTest({ client: { catalog: { object: { get, upsert } } }, locationId: 'loc', environment: 'sandbox' });
  return { adapter, get, upsert };
}
describe('Square price updates', () => {
  it('preserves the full object, version, and long key and verifies by reading back', async () => {
    const { adapter, upsert, get } = setup();
    await expect(adapter.updateVariationPrice(input)).resolves.toMatchObject({ verified: true, version: 10 });
    expect(upsert.mock.calls[0]?.[0]).toEqual({ idempotencyKey: input.idempotencyKey, object: { ...variation(), itemVariationData: { ...variation().itemVariationData, priceMoney: { amount: 1900n, currency: 'USD' } } } });
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
  it('maps a provider concurrency conflict to stale_version', async () => {
    const { adapter, upsert } = setup();
    upsert.mockRejectedValue(new SquareError({ statusCode: 409, body: { errors: [{ code: 'CONFLICT' }] } }));
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'stale_version' });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it('maps an error response concurrency conflict to stale_version', async () => {
    const { adapter, upsert, get } = setup();
    upsert.mockResolvedValue({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'CONFLICT' }] });
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'stale_version' });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('preserves other locations and changes the effective location override', async () => {
    const { adapter, get, upsert } = setup();
    const object = variation(2000n);
    object.itemVariationData!.locationOverrides = [
      { locationId: 'loc', priceMoney: { amount: 2200n, currency: 'USD' }, trackInventory: true },
      { locationId: 'other', priceMoney: { amount: 2500n, currency: 'USD' } },
    ];
    const after = structuredClone(object);
    after.itemVariationData!.locationOverrides![0]!.priceMoney!.amount = 1900n;
    get.mockReset().mockResolvedValueOnce({ object }).mockResolvedValue({ object: after });
    await adapter.updateVariationPrice(input);
    expect(upsert.mock.calls[0]![0].object).toEqual(after);
    expect(object.itemVariationData!.locationOverrides![0]!.priceMoney!.amount).toBe(2200n);
  });
  it('keeps the same key on repeat calls and refuses replay after the price has changed', async () => {
    const { adapter, get, upsert } = setup();
    upsert.mockRejectedValueOnce(new SquareError({ statusCode: 429 }));
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'not_updated' });
    get.mockResolvedValueOnce({ object: variation() });
    await adapter.updateVariationPrice(input);
    expect(upsert.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([input.idempotencyKey, input.idempotencyKey]);
    expect(upsert.mock.calls.every(([, options]) => options?.maxRetries === 0)).toBe(true);
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'not_updated' });
    expect(upsert).toHaveBeenCalledTimes(2);
  });
  it('never sends a write when the initial read fails', async () => {
    const { adapter, get, upsert } = setup();
    get.mockReset().mockRejectedValue(new Error('private'));
    await expect(adapter.updateVariationPrice(input)).rejects.toMatchObject({ outcome: 'not_updated' });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('rejects production labels and unbranded clients', () => {
    const client: PriceSquareClient = { catalog: { object: { get: vi.fn(), upsert: vi.fn() } } };
    expect(() => createPriceAdapterForTest({ client, locationId: 'loc', environment: 'production' })).toThrow();
    expect(() => createPriceAdapter({ client: client as unknown as SandboxSquareClient, locationId: 'loc', environment: 'sandbox' })).toThrow();
  });
});
