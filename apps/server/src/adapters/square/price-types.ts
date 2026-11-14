import type { Square } from 'square';
import type { Currency, PriceEditApprovalPayload } from '@abos/contracts';
import { SquareAdapterError } from './types';

export interface PriceSquareClient {
  catalog: { object: {
    get(request: Square.catalog.GetObjectRequest, options?: { maxRetries?: number }): Promise<Square.GetCatalogObjectResponse>;
    upsert(request: Square.catalog.UpsertCatalogObjectRequest, options?: { maxRetries?: number }): Promise<Square.UpsertCatalogObjectResponse>;
  } };
}
/** A plain in-memory client used only by unit tests. It cannot be an SDK client. */
export interface PriceAdapterTestFakeClient extends PriceSquareClient {
  readonly __priceAdapterTestFake: true;
}
export interface UpdateVariationPriceInput {
  variationId: string;
  expectedOldPriceMinor: PriceEditApprovalPayload['fromPriceMinor'];
  newPriceMinor: PriceEditApprovalPayload['newPriceMinor'];
  currency: Currency;
  idempotencyKey: string;
  /** Required by the approved executor path; compares the proposal's version before writing. */
  expectedVersion?: PriceEditApprovalPayload['squareVersion'];
}
export interface VariationPrice {
  variationId: string;
  squareItemId: string;
  priceMinor: number;
  currency: Currency;
  version: number;
}
export interface PriceAdapter {
  readVariationPrice(variationId: string): Promise<VariationPrice>;
  updateVariationPrice(input: UpdateVariationPriceInput): Promise<VariationPrice & { verified: true }>;
}
export type PriceOutcome = 'not_updated' | 'unknown' | 'updated_unverified' | 'mismatch' | 'stale_version';
export class SquarePriceError extends SquareAdapterError {
  constructor(code: SquareAdapterError['code'], message: string, readonly outcome: PriceOutcome, readonly idempotencyKey?: string) {
    super(code, message);
    this.name = 'SquarePriceError';
  }
}
