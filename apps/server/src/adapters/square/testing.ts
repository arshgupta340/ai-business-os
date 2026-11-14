// Test-only entry point for the Square adapter. It accepts a fake client that implements the narrow
// SquareClient interface. Production code must never import this file; it refuses to run when
// NODE_ENV is "production".
import { buildSquareAdapter } from './core';
import { assertSandboxEnvironment } from './index';
import { SquareAdapterError, type SquareAdapter, type SquareAdapterDeps, type SquareClient } from './types';

export interface TestAdapterOptions extends Omit<SquareAdapterDeps, 'client'> {}

export function createSquareAdapterForTest(fakeClient: SquareClient, options: TestAdapterOptions): SquareAdapter {
  if (process.env.NODE_ENV === 'production') {
    throw new SquareAdapterError('ENVIRONMENT_MISMATCH', 'The Square test adapter cannot run in production.');
  }
  assertSandboxEnvironment(options.environment);
  return buildSquareAdapter(fakeClient, { locationId: options.locationId, now: options.now });
}
