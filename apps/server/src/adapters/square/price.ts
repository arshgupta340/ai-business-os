import { SquareError, type Square } from 'square';
import { CurrencySchema, MinorAmountSchema } from '@abos/contracts';
import { assertSandboxEnvironment, CATALOG_PRICE_MAX } from './index';
import { isSandboxSquareClient } from './client';
import type { SandboxSquareClient } from './types';
import { SquarePriceError, type PriceAdapter, type PriceSquareClient, type UpdateVariationPriceInput, type VariationPrice } from './price-types';
export * from './price-types';

interface Dependencies { client: PriceSquareClient; locationId: string; environment: string }

/** Production accepts only the existing sandbox factory's runtime-branded client. */
export function createPriceAdapter(deps: Omit<Dependencies, 'client'> & { client: SandboxSquareClient }): PriceAdapter {
  assertSandboxEnvironment(deps.environment);
  if (!isSandboxSquareClient(deps.client)) throw new SquarePriceError('ENVIRONMENT_MISMATCH', 'A Square sandbox client is required.', 'not_updated');
  // The existing factory's narrow interface predates catalog.object; its SDK instance provides it.
  return buildPriceAdapter({ ...deps, client: deps.client as unknown as PriceSquareClient });
}

/** Test seam. Production composition must use createPriceAdapter. */
export function createPriceAdapterForTest(deps: Dependencies): PriceAdapter {
  return buildPriceAdapter(deps);
}

function buildPriceAdapter({ client, locationId, environment }: Dependencies): PriceAdapter {
  assertSandboxEnvironment(environment);
  if (!locationId) throw new SquarePriceError('VALIDATION_FAILED', 'A Square location ID is required.', 'not_updated');
  const failure = (message: string) => new SquarePriceError('ITEM_UNAVAILABLE', message, 'not_updated');
  function inspect(object: Square.CatalogObject | undefined, id: string): { object: Square.CatalogObject.ItemVariation; value: VariationPrice } {
    if (!object || object.id !== id || object.type !== 'ITEM_VARIATION' || object.isDeleted) throw new SquarePriceError('NOT_FOUND', 'The Square variation was not found.', 'not_updated');
    if ((object.presentAtAllLocations === false && !object.presentAtLocationIds?.includes(locationId)) || object.absentAtLocationIds?.includes(locationId)) throw failure('The variation is unavailable at this location.');
    const data = object.itemVariationData;
    const override = data?.locationOverrides?.find((o) => o.locationId === locationId);
    const money = override?.priceMoney ?? data?.priceMoney;
    if (!data?.itemId || data.sellable === false || override?.soldOut || (override?.pricingType ?? data.pricingType) === 'VARIABLE_PRICING') throw failure('The variation has no editable fixed price.');
    if (!CurrencySchema.safeParse(money?.currency).success || typeof money?.amount !== 'bigint' || money.amount < 0n || money.amount > CATALOG_PRICE_MAX) throw failure('The variation requires a supported USD price.');
    if (typeof object.version !== 'bigint' || object.version < 0n || object.version > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('The variation has no supported object version.');
    return { object, value: { variationId: id, squareItemId: data.itemId, priceMinor: Number(money.amount), currency: 'USD', version: Number(object.version) } };
  }
  async function read(id: string) {
    let response: Square.GetCatalogObjectResponse;
    try { response = await client.catalog.object.get({ objectId: id }, { maxRetries: 0 }); }
    catch (error) {
      throw new SquarePriceError(error instanceof SquareError && error.statusCode === 404 ? 'NOT_FOUND' : 'INTEGRATION_UNAVAILABLE', 'The Square variation read failed.', 'not_updated');
    }
    if (response.errors?.length) throw new SquarePriceError('INTEGRATION_UNAVAILABLE', 'The Square variation read failed.', 'not_updated');
    return inspect(response.object, id);
  }
  return {
    async readVariationPrice(id) { return (await read(id)).value; },
    async updateVariationPrice(input: UpdateVariationPriceInput) {
      const fail = (code: SquarePriceError['code'], message: string, outcome: SquarePriceError['outcome']): never => { throw new SquarePriceError(code, message, outcome, input.idempotencyKey); };
      if (!input.variationId || !input.idempotencyKey || !CurrencySchema.safeParse(input.currency).success ||
          !MinorAmountSchema.safeParse(input.expectedOldPriceMinor).success || !MinorAmountSchema.safeParse(input.newPriceMinor).success ||
          input.newPriceMinor > Number(CATALOG_PRICE_MAX) || (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0))) {
        return fail('VALIDATION_FAILED', 'The price update input is invalid.', 'not_updated');
      }
      let current: Awaited<ReturnType<typeof read>>;
      try { current = await read(input.variationId); }
      catch (error) {
        if (error instanceof SquarePriceError) return fail(error.code, error.message, error.outcome);
        return fail('INTEGRATION_UNAVAILABLE', 'The Square variation read failed.', 'not_updated');
      }
      if (input.expectedVersion !== undefined && current.value.version !== input.expectedVersion) return fail('INVALID_STATE', 'The Square variation version changed. Create a new proposal.', 'stale_version');
      if (current.value.priceMinor !== input.expectedOldPriceMinor) return fail('INVALID_STATE', 'The Square price changed. Create a new proposal.', 'not_updated');
      const data = current.object.itemVariationData!;
      const money: Square.Money = { amount: BigInt(input.newPriceMinor), currency: input.currency };
      // Preserve all fields because Square upsert replaces the complete variation object.
      const override = data.locationOverrides?.find((o) => o.locationId === locationId);
      const object: Square.CatalogObject.ItemVariation = { ...current.object, itemVariationData: {
        ...data,
        ...(override?.priceMoney ? { locationOverrides: data.locationOverrides?.map((o) => o.locationId === locationId ? { ...o, priceMoney: money } : o) } : { priceMoney: money }),
      } };
      let response: Square.UpsertCatalogObjectResponse;
      try { response = await client.catalog.object.upsert({ object, idempotencyKey: input.idempotencyKey }, { maxRetries: 0 }); }
      catch (error) {
        const body: unknown = error instanceof SquareError ? error.body : undefined;
        const errors = typeof body === 'object' && body !== null && 'errors' in body ? body.errors : undefined;
        if ((error instanceof SquareError && error.statusCode === 409) || (Array.isArray(errors) && errors.some((e: unknown) => typeof e === 'object' && e !== null && 'code' in e && (e.code === 'VERSION_MISMATCH' || e.code === 'CONFLICT')))) return fail('INVALID_STATE', 'The Square variation version changed. Create a new proposal.', 'stale_version');
        const status = error instanceof SquareError ? error.statusCode : undefined;
        return fail('INTEGRATION_UNAVAILABLE', 'The Square price write could not be confirmed.', status !== undefined && status >= 400 && status < 500 && status !== 408 ? 'not_updated' : 'unknown');
      }
      if (response.errors?.length) {
        if (response.errors.some((e) => String(e.code) === 'VERSION_MISMATCH' || e.code === 'CONFLICT')) return fail('INVALID_STATE', 'The Square variation version changed. Create a new proposal.', 'stale_version');
        return fail('INTEGRATION_UNAVAILABLE', 'Square refused the price update.', 'not_updated');
      }
      let verified: VariationPrice;
      try { verified = (await read(input.variationId)).value; }
      catch { return fail('INTEGRATION_UNAVAILABLE', 'The Square price write returned but verification failed.', 'updated_unverified'); }
      if (verified.priceMinor !== input.newPriceMinor || verified.squareItemId !== current.value.squareItemId) return fail('INVALID_STATE', 'The Square price read-back did not match.', 'mismatch');
      return { ...verified, verified: true };
    },
  };
}
