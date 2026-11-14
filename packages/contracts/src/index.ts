// The shared interface between the web app and the server (docs/CONTRACTS.md, docs/API.md).
// After the contract freeze, changes here are additive only (see AGENTS.md).
// Browser-safe: nothing here imports a Node-only module.

export const CONTRACTS_VERSION = '1.0.0';

export * from './ids';
export * from './primitives';
export * from './enums';
export * from './errors';
export * from './constants';
export * from './bundles';
export * from './schemas/catalog';
export * from './schemas/facts';
export * from './schemas/orders';
export * from './schemas/approvals';
export * from './schemas/executions';
export * from './schemas/agents';
export * from './schemas/builder';
export * from './schemas/business';
export * from './capabilities';
export * from './events';
export * from './tools';
export * from './state-machines';
export * from './hash';
export * from './api';
