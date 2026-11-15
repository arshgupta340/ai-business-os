// The demo fixtures (CONTRACTS 9, task S-03): one consistent world for both businesses.
// Import with `import { ... } from '@abos/contracts/fixtures'`. Browser-safe: no Node-only module.
export * from './world';
export * from './catalog';
export * from './demo-shop';
export * from './demo-stage';
export * from './facts';
export * from './agents';
export * from './calls';
export * from './orders';
export * from './bookings';
export * from './approvals';
export * from './executions';
export * from './timelines';
export * from './operations';
export * from './responses';
export * from './materialize';
export { materializeBusyBlocks } from './wall-clock';
export { storedHash, storedKey } from './hashes';
