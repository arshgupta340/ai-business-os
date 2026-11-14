import { AppError } from '../../errors';
import { apiError } from '../util';

// The catalog cache sync that publish runs first (API.md 3.4, P-10). The real
// one is the backend lead's Square adapter and is passed in. It is the only
// provider call publish makes, and it only reads from Square into the cache.
//
// It resolves with the time the cache was synced, or with no time if it did
// not sync. It throws on failure. An AppError with code
// INTEGRATION_UNAVAILABLE or ENVIRONMENT_MISMATCH keeps its code. Anything
// else becomes INTEGRATION_UNAVAILABLE. The provider's message is never passed
// on (API.md section 1, error body).

export interface CatalogSyncInput {
  businessId: string;
  agentId: string;
  correlationId: string;
}

export type CatalogSync = (input: CatalogSyncInput) => Promise<{ syncedAt?: string }>;

// The default: syncs nothing, reports no time, and records each call so a test
// can see that publish asked for a sync.
export class RecordingCatalogSync {
  readonly calls: CatalogSyncInput[] = [];
  readonly sync: CatalogSync = async (input) => {
    this.calls.push({ ...input });
    return {};
  };
}

export async function runCatalogSync(sync: CatalogSync, input: CatalogSyncInput): Promise<{ syncedAt?: string }> {
  try {
    return await sync(input);
  } catch (error) {
    if (error instanceof AppError && error.code === 'ENVIRONMENT_MISMATCH') {
      throw apiError('ENVIRONMENT_MISMATCH', 'Square is not configured as sandbox, so publish cannot sync the catalog.', { provider: 'square' });
    }
    throw apiError('INTEGRATION_UNAVAILABLE', 'The catalog sync with Square failed. Try publishing again.', { provider: 'square' });
  }
}
