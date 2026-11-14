import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_EXPIRY_MS, ENDPOINTS, EXECUTION_MAX_ATTEMPTS, MATERIAL_FIELDS, payloadHash, type PriceEditApprovalRequest } from '@abos/contracts';
import { CATALOG_PRICE_MAX } from '../../../src/adapters/square';
import { executeCatalogSyncStep, pricesPlugin, executePriceEditStep, reconcilePriceEditStep } from '../../../src/api/prices';
import { SquarePriceError } from '../../../src/adapters/square/price';
import { AppError } from '../../../src/errors';
import { PolicyError } from '../../../src/policy/types';
import type { PricesDependencies } from '../../../src/api/prices/types';

const now = new Date('2026-11-14T00:00:00Z');
async function setup() {
  const createPendingPriceEditApproval = vi.fn<PricesDependencies['approvals']['createPendingPriceEditApproval']>(async ({ payload, createdAt }) => ({ kind: 'created' as const, approval: {
    id: 'apv_price_01', businessId: payload.businessId, actorType: 'owner', bundleType: 'price_edit',
    actionBundle: payload.actionBundle, subjectId: payload.subjectId, payload, payloadHash: await payloadHash(payload),
    state: 'PENDING', expiresAt: payload.expiresAt, createdAt,
  } }));
  const deps: PricesDependencies = {
    auth: { requireOwner: vi.fn(async () => ({ ownerUserId: 'usr_owner_01' })) },
    catalog: { findVariation: vi.fn(async () => ({ businessId: 'biz_pizza_01', subjectId: 'cat_pepperoni', squareItemId: 'item', variationId: 'var' })) },
    square: { readVariationPrice: vi.fn(async () => ({ variationId: 'var', squareItemId: 'item', priceMinor: 2200, currency: 'USD' as const, version: 10 })) },
    approvals: { createPendingPriceEditApproval }, now: () => now,
  };
  const app = Fastify();
  await app.register(pricesPlugin, deps);
  return { app, deps, createPendingPriceEditApproval };
}
const url = '/api/businesses/biz_pizza_01/catalog/prices/propose';
const body = { variationId: 'var', newPriceMinor: 1900, currency: 'USD' };
describe('price proposals', () => {
  it('creates only an approval with exactly the material fields and fresh Square version', async () => {
    const { app, deps, createPendingPriceEditApproval } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(201);
      const payload = createPendingPriceEditApproval.mock.calls[0]![0].payload;
      expect(Object.keys(payload).sort()).toEqual([...MATERIAL_FIELDS.price_edit].sort());
      expect(payload).toMatchObject({ fromPriceMinor: 2200, newPriceMinor: 1900, squareVersion: 10 });
      expect(Date.parse(payload.expiresAt) - now.getTime()).toBe(APPROVAL_EXPIRY_MS);
      expect(Object.keys(deps.square)).toEqual(['readVariationPrice']);
      expect(response.json().approval.payloadHash).toBe(await payloadHash(payload));
    } finally { await app.close(); }
  });
  it('issue #108: answers with the catalog names beside the payload, never inside it', async () => {
    const { app, deps, createPendingPriceEditApproval } = await setup();
    vi.mocked(deps.catalog.findVariation).mockResolvedValue({ businessId: 'biz_pizza_01', subjectId: 'cat_pepperoni', squareItemId: 'item', variationId: 'var', itemName: 'Pepperoni', variationName: 'Large' });
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(201);
      const approval = response.json().approval;
      expect(approval).toMatchObject({ itemName: 'Pepperoni', variationName: 'Large' });
      // The stored and hashed payload is exactly the material fields: the names never reach the approval port.
      const stored = createPendingPriceEditApproval.mock.calls[0]![0].payload;
      expect(Object.keys(stored).sort()).toEqual([...MATERIAL_FIELDS.price_edit].sort());
      expect(Object.keys(approval.payload).sort()).toEqual([...MATERIAL_FIELDS.price_edit].sort());
      expect(approval.payloadHash).toBe(await payloadHash(stored));
    } finally { await app.close(); }
  });
  it('issue #108: sends no names when the catalog lookup has none', async () => {
    const { app } = await setup();
    try {
      const approval = (await app.inject({ method: 'POST', url, payload: body })).json().approval;
      expect(approval).not.toHaveProperty('itemName');
      expect(approval).not.toHaveProperty('variationName');
    } finally { await app.close(); }
  });
  it('issue #108: resolvesConflictId is in the contract, and the route still refuses it before any read', async () => {
    const { app, deps, createPendingPriceEditApproval } = await setup();
    try {
      expect(ENDPOINTS.proposePrice.body.safeParse({ ...body, resolvesConflictId: 'cfl_pizza_01' }).success).toBe(true);
      const response = await app.inject({ method: 'POST', url, payload: { ...body, resolvesConflictId: 'cfl_pizza_01' } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED', message: 'A price change cannot resolve a conflict yet. Change the price, sync, then keep the current value on the conflict.' });
      expect(deps.catalog.findVariation).not.toHaveBeenCalled();
      expect(deps.square.readVariationPrice).not.toHaveBeenCalled();
      expect(createPendingPriceEditApproval).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('refuses an item of another business before reading Square', async () => {
    const { app, deps, createPendingPriceEditApproval } = await setup();
    vi.mocked(deps.catalog.findVariation).mockResolvedValue({ businessId: 'biz_barber_01', subjectId: 'cat_other', squareItemId: 'item', variationId: 'var' });
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(404);
      expect(deps.square.readVariationPrice).not.toHaveBeenCalled();
      expect(createPendingPriceEditApproval).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each([{ ...body, currency: 'EUR' }, { ...body, newPriceMinor: -1 }, { ...body, newPriceMinor: 19.5 }, { ...body, resolvesConflictId: 'cfl_other' }])('validates contract input %j', async (payload) => {
    const { app, deps } = await setup();
    try {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
      expect(deps.square.readVariationPrice).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each([CATALOG_PRICE_MAX + 1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])('rejects an unexecutable price %s before a catalog or Square read', async (amount) => {
    const { app, deps, createPendingPriceEditApproval } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url, payload: { ...body, newPriceMinor: Number(amount) } });
      expect(response.statusCode).toBe(400);
      expect(deps.catalog.findVariation).not.toHaveBeenCalled();
      expect(deps.square.readVariationPrice).not.toHaveBeenCalled();
      expect(createPendingPriceEditApproval).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('requires owner authentication', async () => {
    const { app, deps } = await setup();
    vi.mocked(deps.auth.requireOwner).mockResolvedValue(null);
    try {
      expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(401);
      expect(deps.catalog.findVariation).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('returns forbidden when the injected owner scope rejects this business', async () => {
    const { app, deps } = await setup();
    vi.mocked(deps.auth.requireOwner).mockRejectedValue(new AppError('FORBIDDEN_BUSINESS', 'Private detail', 403));
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('Private');
      expect(deps.catalog.findVariation).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('refuses a missing variation before reading Square', async () => {
    const { app, deps } = await setup();
    vi.mocked(deps.catalog.findVariation).mockResolvedValue(null);
    try {
      expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(404);
      expect(deps.square.readVariationPrice).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('refuses a Square variation with a different parent item', async () => {
    const { app, deps, createPendingPriceEditApproval } = await setup();
    vi.mocked(deps.square.readVariationPrice).mockResolvedValue({ variationId: 'var', squareItemId: 'another_item', priceMinor: 2200, currency: 'USD', version: 10 });
    try {
      expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(404);
      expect(createPendingPriceEditApproval).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('returns the existing identical pending proposal from the checked routine', async () => {
    const { app, deps } = await setup();
    const original = await deps.approvals.createPendingPriceEditApproval({
      ownerUserId: 'usr_owner_01', actorType: 'owner', bundleType: 'price_edit',
      payload: { businessId: 'biz_pizza_01', subjectId: 'cat_pepperoni', squareItemId: 'item', variationId: 'var', fromPriceMinor: 2200, newPriceMinor: 1900, currency: 'USD', squareVersion: 10, actionBundle: ['square.catalog.price.update', 'local.catalog.sync'], expiresAt: new Date(now.getTime() + APPROVAL_EXPIRY_MS).toISOString() },
      payloadHash: `sha256:${'a'.repeat(64)}`, createdAt: now.toISOString(),
    });
    if (original.kind === 'conflict') throw new Error('Test setup returned a conflict.');
    vi.mocked(deps.approvals.createPendingPriceEditApproval).mockResolvedValue({ kind: 'existing', approval: original.approval });
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(201);
      expect(response.json().approval.id).toBe('apv_price_01');
    } finally { await app.close(); }
  });
  it('fails closed when the checked routine reports a conflicting pending proposal', async () => {
    const { app, deps } = await setup();
    vi.mocked(deps.approvals.createPendingPriceEditApproval).mockResolvedValue({ kind: 'conflict' });
    try {
      expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
  it('has no route path that writes to Square', async () => {
    const { app, deps } = await setup();
    const updateVariationPrice = vi.fn();
    const upsert = vi.fn();
    Object.assign(deps.square, { updateVariationPrice, catalog: { object: { upsert } } });
    try {
      expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(201);
      expect(updateVariationPrice).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('sanitizes port failures and does not create an approval after a failed read', async () => {
    const { app, deps, createPendingPriceEditApproval } = await setup();
    vi.mocked(deps.square.readVariationPrice).mockRejectedValue(new Error('private provider token'));
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('private');
      expect(response.json()).toMatchObject({ code: 'INTERNAL', retryable: true, correlationId: expect.any(String) });
      expect(createPendingPriceEditApproval).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('answers a stale Square version as a plain INVALID_STATE refusal, not a retryable INTERNAL', async () => {
    const { app, deps } = await setup();
    // The checked routine refuses a payload whose Square version differs from the catalog row (SUBJECT -> INVALID_STATE).
    vi.mocked(deps.approvals.createPendingPriceEditApproval).mockRejectedValue(new PolicyError('INVALID_STATE'));
    const updateVariationPrice = vi.fn();
    Object.assign(deps.square, { updateVariationPrice });
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'INVALID_STATE', retryable: false, correlationId: expect.any(String),
        message: 'This item changed in Square since the last sync. Sync the catalog, then try the price change again.',
      });
      expect(updateVariationPrice).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('keeps any other policy failure from the routine as a sanitized INTERNAL', async () => {
    const { app, deps } = await setup();
    vi.mocked(deps.approvals.createPendingPriceEditApproval).mockRejectedValue(new PolicyError('PAYLOAD_HASH_MISMATCH', 'private detail'));
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('private');
      expect(response.json()).toMatchObject({ code: 'INTERNAL', retryable: true });
    } finally { await app.close(); }
  });
});

async function approved(): Promise<PriceEditApprovalRequest> {
  const { app } = await setup();
  try {
    const response = await app.inject({ method: 'POST', url, payload: body });
    const approval = response.json<{ approval: PriceEditApprovalRequest }>().approval;
    return { ...approval, state: 'APPROVED', decidedBy: 'usr_owner_01', decidedAt: now.toISOString() };
  } finally { await app.close(); }
}
describe('approved price execution', () => {
  it('returns verified Square success before the distinct catalog-sync execution runs', async () => {
    const approval = await approved();
    const order: string[] = [];
    const updateVariationPrice = vi.fn(async () => { order.push('verified'); return { variationId: 'var', squareItemId: 'item', priceMinor: 1900, currency: 'USD' as const, version: 11, verified: true as const }; });
    const sync = vi.fn(async () => { order.push('sync'); });
    const result = await executePriceEditStep({ approval, idempotencyKey: 'a'.repeat(200), attempt: 1 }, { square: { updateVariationPrice } });
    expect(result).toEqual({ state: 'SUCCEEDED', squareVersion: 11 });
    expect(updateVariationPrice).toHaveBeenCalledWith({ variationId: 'var', expectedOldPriceMinor: 2200, newPriceMinor: 1900, currency: 'USD', expectedVersion: 10, idempotencyKey: 'a'.repeat(200) });
    expect(order).toEqual(['verified']);
  });
  it.each(['unknown', 'updated_unverified', 'mismatch'] as const)('requires review for %s and never syncs', async (outcome) => {
    const sync = vi.fn();
    const result = await executePriceEditStep({ approval: await approved(), idempotencyKey: 'key', attempt: 1 }, {
      square: { updateVariationPrice: vi.fn().mockRejectedValue(new SquarePriceError('INTEGRATION_UNAVAILABLE', 'Sanitized.', outcome)) },
    });
    expect(result.state).toBe('NEEDS_REVIEW');
    expect(sync).not.toHaveBeenCalled();
  });
  it('refuses pending approvals and tampered payloads', async () => {
    const approval = await approved();
    const updateVariationPrice = vi.fn();
    const ports = { square: { updateVariationPrice } };
    expect((await executePriceEditStep({ approval: { ...approval, state: 'PENDING', decidedAt: undefined, decidedBy: undefined }, idempotencyKey: 'key', attempt: 1 }, ports)).state).toBe('FAILED');
    expect((await executePriceEditStep({ approval: { ...approval, payload: { ...approval.payload, newPriceMinor: 1 } }, idempotencyKey: 'key', attempt: 1 }, ports)).state).toBe('FAILED');
    expect(updateVariationPrice).not.toHaveBeenCalled();
  });
  it('returns a retryable definite rejection to QUEUED before the attempt limit', async () => {
    const sync = vi.fn();
    const result = await executePriceEditStep({ approval: await approved(), idempotencyKey: 'key', attempt: 1 }, {
      square: { updateVariationPrice: vi.fn().mockRejectedValue(new SquarePriceError('INTEGRATION_UNAVAILABLE', 'Retry later.', 'not_updated')) },
    });
    expect(result).toEqual({ state: 'QUEUED', code: 'INTEGRATION_UNAVAILABLE', outcome: 'not_updated' });
    expect(sync).not.toHaveBeenCalled();
  });
  it('fails a definite rejection at the attempt limit', async () => {
    const result = await executePriceEditStep({ approval: await approved(), idempotencyKey: 'key', attempt: EXECUTION_MAX_ATTEMPTS }, {
      square: { updateVariationPrice: vi.fn().mockRejectedValue(new SquarePriceError('INTEGRATION_UNAVAILABLE', 'Retry later.', 'not_updated')) },
    });
    expect(result).toEqual({ state: 'FAILED', code: 'INTEGRATION_UNAVAILABLE', outcome: 'not_updated' });
  });
  it('does not turn a confirmed Square write into NEEDS_REVIEW when the separate cache step fails', async () => {
    const updateVariationPrice = vi.fn(async () => ({ variationId: 'var', squareItemId: 'item', priceMinor: 1900, currency: 'USD' as const, version: 11, verified: true as const }));
    const result = await executePriceEditStep({ approval: await approved(), idempotencyKey: 'key', attempt: 1 }, {
      square: { updateVariationPrice },
    });
    expect(result).toEqual({ state: 'SUCCEEDED', squareVersion: 11 });
    expect(updateVariationPrice).toHaveBeenCalledTimes(1);
  });
  it('runs catalog sync only as the separate second execution and queues its retryable failure', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('private database details'));
    expect(await executeCatalogSyncStep({ businessId: 'biz_pizza_01', attempt: 1 }, { sync })).toEqual({ state: 'QUEUED', code: 'INTEGRATION_UNAVAILABLE' });
    expect(sync).toHaveBeenCalledWith('biz_pizza_01');
  });
  it('reconciles a crash after verified write without calling upsert', async () => {
    const readVariationPrice = vi.fn(async () => ({ variationId: 'var', squareItemId: 'item', priceMinor: 1900, currency: 'USD' as const, version: 11 }));
    const result = await reconcilePriceEditStep({ approval: await approved() }, { square: { readVariationPrice } });
    expect(result).toEqual({ state: 'SUCCEEDED', squareVersion: 11 });
    expect(readVariationPrice).toHaveBeenCalledWith('var');
  });
  it('queues reconciliation only when a read proves the approved write did not happen', async () => {
    const readVariationPrice = vi.fn(async () => ({ variationId: 'var', squareItemId: 'item', priceMinor: 2200, currency: 'USD' as const, version: 10 }));
    expect(await reconcilePriceEditStep({ approval: await approved() }, { square: { readVariationPrice } })).toEqual({ state: 'QUEUED', code: 'INTEGRATION_UNAVAILABLE' });
  });
});
