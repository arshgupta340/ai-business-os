// Square adapter (task B-12): the production entry point. Sandbox only, enforced twice: the
// environment label must be exactly "sandbox", and the client must come from createSandboxSquareClient,
// which fixes the SDK destination to the sandbox host. Tests use ./testing instead.
import { isSandboxSquareClient } from './client';
import { buildSquareAdapter } from './core';
import { SquareAdapterError, type SquareAdapter, type SquareAdapterDeps } from './types';

export * from './types';
export { createSandboxSquareClient, SQUARE_SANDBOX_BASE_URL, type SandboxClientOptions } from './client';
export {
  CATALOG_PRICE_MAX,
  CATALOG_SYNC_TYPES,
  PAYMENT_LINK_KEY_MAX,
  catalogRows,
  checkPayment,
  orderFromCart,
  verifyWebhookSignature,
  type CatalogRowInput,
} from './core';

/** Refuses anything but the exact "sandbox" label (AC-19). Checked before any client is touched. */
export function assertSandboxEnvironment(environment: string): void {
  if (environment !== 'sandbox') {
    throw new SquareAdapterError('ENVIRONMENT_MISMATCH', 'The Square adapter runs only when SQUARE_ENVIRONMENT is exactly "sandbox".');
  }
}

export function createSquareAdapter(deps: SquareAdapterDeps): SquareAdapter {
  assertSandboxEnvironment(deps.environment);
  if (!isSandboxSquareClient(deps.client)) {
    throw new SquareAdapterError('ENVIRONMENT_MISMATCH', 'The Square client must be built by createSandboxSquareClient.');
  }
  return buildSquareAdapter(deps.client, { locationId: deps.locationId, now: deps.now });
}
