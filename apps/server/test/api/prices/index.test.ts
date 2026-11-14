import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_EXPIRY_MS, MATERIAL_FIELDS, payloadHash, type PriceEditApprovalRequest } from '@abos/contracts';
import { pricesPlugin, executePriceEditStep } from '../../../src/api/prices';
import { SquarePriceError } from '../../../src/adapters/square/price';
import type { PricesDependencies } from '../../../src/api/prices/types';

const now = new Date('2026-11-14T00:00:00Z');
async function setup() {
  const createPriceEdit = vi.fn<PricesDependencies['approvals']['createPriceEdit']>(async ({ payload, createdAt }) => ({
    id: 'apv_price_01', businessId: payload.businessId, actorType: 'owner', bundleType: 'price_edit',
    actionBundle: payload.actionBundle, subjectId: payload.subjectId, payload, payloadHash: await payloadHash(payload),
    state: 'PENDING', expiresAt: payload.expiresAt, createdAt,
  }));
  const deps: PricesDependencies = {
    auth: { requireOwner: vi.fn(async () => ({ ownerUserId: 'usr_owner_01' })) },
    catalog: { findVariation: vi.fn(async () => ({ businessId: 'biz_pizza_01', subjectId: 'cat_pepperoni', squareItemId: 'item', variationId: 'var' })) },
    square: { readVariationPrice: vi.fn(async () => ({ variationId: 'var', squareItemId: 'item', priceMinor: 2200, currency: 'USD' as const, version: 10 })) },
    approvals: { createPriceEdit }, now: () => now,
  };
  const app = Fastify();
  await app.register(pricesPlugin, deps);
  return { app, deps, createPriceEdit };
}
const url = '/api/businesses/biz_pizza_01/catalog/prices/propose';
const body = { variationId: 'var', newPriceMinor: 1900, currency: 'USD' };
describe('price proposals', () => {
  it('creates only an approval with exactly the material fields and fresh Square version', async () => {
    const { app, deps, createPriceEdit } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(201);
      const payload = createPriceEdit.mock.calls[0]![0].payload;
      expect(Object.keys(payload).sort()).toEqual([...MATERIAL_FIELDS.price_edit].sort());
      expect(payload).toMatchObject({ fromPriceMinor: 2200, newPriceMinor: 1900, squareVersion: 10 });
      expect(Date.parse(payload.expiresAt) - now.getTime()).toBe(APPROVAL_EXPIRY_MS);
      expect(Object.keys(deps.square)).toEqual(['readVariationPrice']);
      expect(response.json().approval.payloadHash).toBe(await payloadHash(payload));
    } finally { await app.close(); }
  });
  it('refuses an item of another business before reading Square', async () => {
    const { app, deps, createPriceEdit } = await setup();
    vi.mocked(deps.catalog.findVariation).mockResolvedValue({ businessId: 'biz_barber_01', subjectId: 'cat_other', squareItemId: 'item', variationId: 'var' });
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(404);
      expect(deps.square.readVariationPrice).not.toHaveBeenCalled();
      expect(createPriceEdit).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each([{ ...body, currency: 'EUR' }, { ...body, newPriceMinor: -1 }, { ...body, resolvesConflictId: 'cfl_other' }])('validates contract input %j', async (payload) => {
    const { app, deps } = await setup();
    try {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
      expect(deps.square.readVariationPrice).not.toHaveBeenCalled();
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
    const { app, deps, createPriceEdit } = await setup();
    vi.mocked(deps.square.readVariationPrice).mockRejectedValue(new Error('private provider token'));
    try {
      const response = await app.inject({ method: 'POST', url, payload: body });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('private');
      expect(response.json()).toMatchObject({ code: 'INTERNAL', retryable: true, correlationId: expect.any(String) });
      expect(createPriceEdit).not.toHaveBeenCalled();
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
  it('passes the approved version and unchanged key, then refreshes only after verification', async () => {
    const approval = await approved();
    const order: string[] = [];
    const updateVariationPrice = vi.fn(async () => { order.push('verified'); return { variationId: 'var', squareItemId: 'item', priceMinor: 1900, currency: 'USD' as const, version: 11, verified: true as const }; });
    const sync = vi.fn(async () => { order.push('sync'); });
    const result = await executePriceEditStep({ approval, idempotencyKey: 'a'.repeat(200) }, { square: { updateVariationPrice }, catalogSync: { sync } });
    expect(result.state).toBe('SUCCEEDED');
    expect(updateVariationPrice).toHaveBeenCalledWith({ variationId: 'var', expectedOldPriceMinor: 2200, newPriceMinor: 1900, currency: 'USD', expectedVersion: 10, idempotencyKey: 'a'.repeat(200) });
    expect(order).toEqual(['verified', 'sync']);
  });
  it.each(['unknown', 'updated_unverified', 'mismatch'] as const)('requires review for %s and never syncs', async (outcome) => {
    const sync = vi.fn();
    const result = await executePriceEditStep({ approval: await approved(), idempotencyKey: 'key' }, {
      square: { updateVariationPrice: vi.fn().mockRejectedValue(new SquarePriceError('INTEGRATION_UNAVAILABLE', 'Sanitized.', outcome)) }, catalogSync: { sync },
    });
    expect(result.state).toBe('NEEDS_REVIEW');
    expect(sync).not.toHaveBeenCalled();
  });
  it('refuses pending approvals and tampered payloads', async () => {
    const approval = await approved();
    const updateVariationPrice = vi.fn();
    const ports = { square: { updateVariationPrice }, catalogSync: { sync: vi.fn() } };
    expect((await executePriceEditStep({ approval: { ...approval, state: 'PENDING', decidedAt: undefined, decidedBy: undefined }, idempotencyKey: 'key' }, ports)).state).toBe('FAILED');
    expect((await executePriceEditStep({ approval: { ...approval, payload: { ...approval.payload, newPriceMinor: 1 } }, idempotencyKey: 'key' }, ports)).state).toBe('FAILED');
    expect(updateVariationPrice).not.toHaveBeenCalled();
  });
  it.each(['not_updated', 'stale_version'] as const)('fails a definite %s without refreshing', async (outcome) => {
    const sync = vi.fn();
    const result = await executePriceEditStep({ approval: await approved(), idempotencyKey: 'key' }, {
      square: { updateVariationPrice: vi.fn().mockRejectedValue(new SquarePriceError('INVALID_STATE', 'Create a new proposal.', outcome)) }, catalogSync: { sync },
    });
    expect(result).toEqual({ state: 'FAILED', code: 'INVALID_STATE', outcome });
    expect(sync).not.toHaveBeenCalled();
  });
  it('requires review when cache refresh fails after verification', async () => {
    const updateVariationPrice = vi.fn(async () => ({ variationId: 'var', squareItemId: 'item', priceMinor: 1900, currency: 'USD' as const, version: 11, verified: true as const }));
    const result = await executePriceEditStep({ approval: await approved(), idempotencyKey: 'key' }, {
      square: { updateVariationPrice }, catalogSync: { sync: vi.fn().mockRejectedValue(new Error('private database details')) },
    });
    expect(result).toEqual({ state: 'NEEDS_REVIEW', code: 'INTEGRATION_UNAVAILABLE' });
    expect(updateVariationPrice).toHaveBeenCalledTimes(1);
  });
});
