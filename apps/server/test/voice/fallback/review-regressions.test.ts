import { describe, expect, it, vi } from 'vitest';
import type { BusinessFact } from '@abos/contracts';
import { createFallbackRouter, type FallbackPorts, type FallbackReservation } from '../../../src/voice/fallback';

const businessId = 'biz_pizza_01';
const callId = 'call_fallback';
const providerCallId = 'CA_deadline';
const fact: BusinessFact = {
  id: 'fact_fallback', businessId, kind: 'contact', key: 'fallback_phone_number', value: '+18055550101',
  sourceType: 'owner_ui', status: 'verified', confidence: 1, version: 1,
  verifiedAt: '2026-11-14T00:00:00Z', createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z',
};
const reservation: FallbackReservation = {
  businessId, callId, providerCallId, businessName: 'Pizza', callStatus: 'IN_PROGRESS', channel: 'phone',
  humanFallbackEnabled: true, fallbackFact: fact, idempotencyKey: 'fallback-CA_deadline',
};
const request = { businessId, callId, providerCallId, businessName: 'Ignored', mode: 'stream' as const, signals: { callerRequestedPerson: true } };

function ports(): FallbackPorts {
  return {
    callerId: { readOwnedNumber: vi.fn(async () => ({ number: '+18055550100', accountOwned: true })) },
    fallback: {
      reserve: vi.fn(async () => reservation),
      beginDispatch: vi.fn(async () => true),
    },
    calls: { update: vi.fn(async () => undefined) },
    outcomes: { record: vi.fn(async () => undefined) },
  };
}

describe('B-28 review deadline regressions', () => {
  it('returns safely and aborts a nonsettling reservation before any dispatch', async () => {
    const p = ports();
    let aborted = false;
    vi.mocked(p.fallback.reserve).mockImplementation(async (_input, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve(null); });
    }));
    const result = await createFallbackRouter(p, { routingDeadlineMs: 250 }).route({ ...request, mode: 'webhook' });
    expect(result.kind).toBe('webhook');
    expect(aborted).toBe(true);
    expect(p.fallback.beginDispatch).not.toHaveBeenCalled();
    expect(p.calls.update).not.toHaveBeenCalled();
  });

  it('returns safely and aborts a nonsettling dispatch fence before any call update', async () => {
    const p = ports();
    let aborted = false;
    vi.mocked(p.fallback.beginDispatch).mockImplementation(async (_input, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve(false); });
    }));
    const result = await createFallbackRouter(p, { routingDeadlineMs: 250 }).route({ ...request, mode: 'webhook' });
    expect(result.kind).toBe('webhook');
    expect(aborted).toBe(true);
    expect(p.calls.update).not.toHaveBeenCalled();
  });

  it('returns redirect_unknown and aborts a nonsettling provider update without sending another update', async () => {
    const p = ports();
    let aborted = false;
    let sends = 0;
    vi.mocked(p.fallback.beginDispatch).mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.mocked(p.calls.update).mockImplementation(async (_instruction, signal) => new Promise((resolve) => {
      if (!signal.aborted) sends += 1;
      signal.addEventListener('abort', () => { aborted = true; resolve(); });
    }));
    const router = createFallbackRouter(p, { routingDeadlineMs: 250 });
    expect(await router.route(request)).toEqual({ kind: 'redirect_unknown', reason: 'caller_requested_person' });
    expect(aborted).toBe(true);
    expect(sends).toBe(1);
    expect(await router.route(request)).toEqual({ kind: 'blocked' });
    expect(sends).toBe(1);
  });
});
