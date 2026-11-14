// The only way production code gets a Square client. The destination is fixed to the sandbox host
// here, so a label elsewhere cannot point the adapter at production (AGENTS.md rule 4, AC-19).
import { SquareClient as SdkSquareClient, SquareEnvironment } from 'square';
import { SquareAdapterError, type SandboxSquareClient } from './types';

/** Clients built by the factory below. Anything not in this set is refused by createSquareAdapter. */
const sandboxClients = new WeakSet<object>();

/** The sandbox host every request from a factory client goes to. */
export const SQUARE_SANDBOX_BASE_URL: string = SquareEnvironment.Sandbox;

export interface SandboxClientOptions {
  accessToken: string;
}

/**
 * Builds the real SDK client with `SquareEnvironment.Sandbox`. It takes no environment, base URL,
 * fetch or header option, so nothing can redirect it.
 */
export function createSandboxSquareClient(options: SandboxClientOptions): SandboxSquareClient {
  const accessToken = options.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new SquareAdapterError('VALIDATION_FAILED', 'A Square sandbox access token is required.');
  }
  const client = new SdkSquareClient({ token: accessToken, environment: SquareEnvironment.Sandbox });
  sandboxClients.add(client);
  // The brand is type-only; the WeakSet above is the runtime proof.
  return client as unknown as SandboxSquareClient;
}

/** True only for a client returned by createSandboxSquareClient. */
export function isSandboxSquareClient(client: unknown): client is SandboxSquareClient {
  return typeof client === 'object' && client !== null && sandboxClients.has(client);
}
