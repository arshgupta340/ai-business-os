import { describe, expect, it, vi } from 'vitest';
import type { BookingApprovalPayload } from '@abos/contracts';
import { createExecutor, DEFAULT_STALE_AFTER_MS } from '../../src/executor/index.js';
import { runSyncJob } from '../../src/executor/jobs.js';
import type { CheckoutResult, SyncDeps } from '../../src/executor/types.js';
import { harness } from './fakes.js';

const link: CheckoutResult = { squareOrderId: 'sq_order', paymentLinkId: 'sq_link', url: 'https://example.test/pay' };
/** Shaped like the Square adapter's typed error: no `kind`, only `code`, `outcome` and known IDs. */
const squareError = (fields: Record<string, unknown>) => Object.assign(new Error('Fixed sanitized text'), { name: 'SquareCheckoutError', ...fields });

async function ticks(executor: ReturnType<typeof createExecutor>, count: number) {
  for (let n = 0; n < count; n++) await executor.tick();
}

describe('checkout outcomes', () => {
  it('persists the IDs through onLinkCreated before the total is verified, and records the Square order ID', async () => {
    const h = harness(); let savedBeforeResolve = false;
    vi.mocked(h.deps.checkout.createCheckout).mockImplementation(async ({ onLinkCreated }) => {
      await onLinkCreated?.(link);
      savedBeforeResolve = vi.mocked(h.deps.subjects.saveCheckoutLink).mock.calls.length === 1 && h.order.checkoutUrl === undefined;
      return link;
    });
    await createExecutor(h.deps).tick();
    expect(savedBeforeResolve).toBe(true);
    expect(h.deps.subjects.saveCheckoutLink).toHaveBeenCalledWith(h.order.businessId, h.order.id, h.rows[0]!.id, link);
    expect(h.rows[0]?.externalRef).toBe('sq_order');
    expect(h.order.status).toBe('PAYMENT_LINK_READY');
  });

  it('a total mismatch reported by orderState stops the bundle with RECOVERY_REQUIRED and no message', async () => {
    const h = harness();
    vi.mocked(h.deps.checkout.createCheckout).mockImplementation(async ({ onLinkCreated }) => {
      await onLinkCreated?.(link);
      throw squareError({ code: 'INVALID_STATE', orderState: 'RECOVERY_REQUIRED', squareOrderId: 'sq_order', paymentLinkId: 'sq_link' });
    });
    await ticks(createExecutor(h.deps), 10);
    expect(h.rows[0]?.status).toBe('FAILED'); expect(h.order.status).toBe('RECOVERY_REQUIRED');
    expect(h.order.checkoutUrl).toBeUndefined();
    expect(h.deps.messages.sendOnce).not.toHaveBeenCalled(); expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('not_created requeues with the same key within the attempt limit, then fails to RECOVERY_REQUIRED', async () => {
    const h = harness();
    vi.mocked(h.deps.checkout.createCheckout).mockRejectedValue(squareError({ code: 'INTEGRATION_UNAVAILABLE', outcome: 'not_created' }));
    const e = createExecutor(h.deps);
    await e.tick(); expect(h.rows[0]?.status).toBe('QUEUED');
    for (let n = 0; n < 10; n++) { h.advance(60_000); await e.tick(); }
    expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(3);
    for (const [input] of vi.mocked(h.deps.checkout.createCheckout).mock.calls) expect(input.idempotencyKey).toBe(h.rows[0]?.idempotencyKey);
    expect(h.rows[0]?.status).toBe('FAILED'); expect(h.order.status).toBe('RECOVERY_REQUIRED');
    expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'created_unverified'] as const)('%s goes to review once, withholds the link and sends nothing', async (outcome) => {
    const h = harness();
    vi.mocked(h.deps.checkout.createCheckout).mockImplementation(async ({ onLinkCreated }) => {
      if (outcome === 'created_unverified') await onLinkCreated?.(link);
      throw squareError({ code: 'INTEGRATION_UNAVAILABLE', outcome, retryable: true, ...(outcome === 'created_unverified' ? { squareOrderId: 'sq_order' } : {}) });
    });
    const e = createExecutor(h.deps);
    for (let n = 0; n < 10; n++) { await e.tick(); h.advance(60_000); }
    expect(h.rows[0]?.status).toBe('NEEDS_REVIEW'); expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
    expect(h.order.checkoutUrl).toBeUndefined(); expect(h.order.status).toBe('RECOVERY_REQUIRED');
    expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
    if (outcome === 'created_unverified') { expect(h.order.squareOrderId).toBe('sq_order'); expect(h.rows[0]?.externalRef).toBe('sq_order'); }
  });

  it('never retries after onLinkCreated, even if the error claims not_created', async () => {
    const h = harness();
    vi.mocked(h.deps.checkout.createCheckout).mockImplementation(async ({ onLinkCreated }) => {
      await onLinkCreated?.(link); throw squareError({ code: 'INTEGRATION_UNAVAILABLE', outcome: 'not_created' });
    });
    const e = createExecutor(h.deps);
    for (let n = 0; n < 10; n++) { await e.tick(); h.advance(60_000); }
    expect(h.rows[0]?.status).toBe('NEEDS_REVIEW'); expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('resumes by reading when the order already holds a Square order ID, and never creates again', async () => {
    const h = harness(); h.order.status = 'CREATING_CHECKOUT'; h.order.squareOrderId = 'sq_order'; h.order.squarePaymentLinkId = 'sq_link';
    await ticks(createExecutor(h.deps), 5);
    expect(h.deps.checkout.createCheckout).not.toHaveBeenCalled();
    expect(h.deps.checkout.resumeCheckout).toHaveBeenCalledWith(expect.objectContaining({ squareOrderId: 'sq_order', paymentLinkId: 'sq_link', idempotencyKey: h.rows[0]?.idempotencyKey }));
    expect(h.order.status).toBe('PAYMENT_PENDING');
  });

  it('a failed resume goes to review instead of creating a link', async () => {
    const h = harness(); h.order.status = 'CREATING_CHECKOUT'; h.order.squareOrderId = 'sq_order';
    vi.mocked(h.deps.checkout.resumeCheckout).mockRejectedValue(squareError({ code: 'INTEGRATION_UNAVAILABLE', outcome: 'not_created' }));
    await ticks(createExecutor(h.deps), 5);
    expect(h.rows[0]?.status).toBe('NEEDS_REVIEW'); expect(h.deps.checkout.createCheckout).not.toHaveBeenCalled();
  });
});

describe('message results', () => {
  it('passes the execution and lease to sendOnce and records the provider message ID', async () => {
    const h = harness(); await ticks(createExecutor(h.deps), 3);
    expect(h.deps.messages.sendOnce).toHaveBeenCalledWith(expect.objectContaining({ executionId: h.rows[1]!.id, workerId: 'worker-a' }));
    expect(h.rows[1]?.status).toBe('SUCCEEDED'); expect(h.rows[1]?.externalRef).toBe('msg_provider_1');
  });

  it('SENT without a provider message ID is not marked sent', async () => {
    const h = harness(); vi.mocked(h.deps.messages.sendOnce).mockResolvedValue({ status: 'SENT' });
    await ticks(createExecutor(h.deps), 5);
    expect(h.rows[1]?.status).toBe('NEEDS_REVIEW'); expect(h.order.status).toBe('PAYMENT_PENDING');
    expect(vi.mocked(h.deps.subjects.moveOrder).mock.calls.some(([, , s]) => s === 'MESSAGE_SENT')).toBe(false);
  });

  it('a replayed dispatch that is still QUEUED goes to review, and a channel SKIPPED is never recorded as SKIPPED', async () => {
    for (const status of ['QUEUED', 'SKIPPED'] as const) {
      const h = harness(); vi.mocked(h.deps.messages.sendOnce).mockResolvedValue({ status });
      await ticks(createExecutor(h.deps), 5);
      expect(h.rows[1]?.status).toBe(status === 'QUEUED' ? 'NEEDS_REVIEW' : 'FAILED');
      expect(h.order.status).toBe('PAYMENT_PENDING'); expect(h.deps.messages.sendOnce).toHaveBeenCalledTimes(1);
    }
  });
});

describe('calendar results', () => {
  it('passes the stored key and handles a SLOT_CONFLICT result without a confirmation', async () => {
    const h = harness('booking_bundle'); const p = h.material as BookingApprovalPayload;
    const alternatives = [{ serviceId: p.serviceId, startUtc: p.startUtc, endUtc: p.endUtc, timezone: p.timezone }];
    vi.mocked(h.deps.calendar.createEvent).mockResolvedValue({ ok: false, reason: 'SLOT_CONFLICT', retryable: false, alternatives });
    await ticks(createExecutor(h.deps), 10);
    expect(h.deps.calendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: h.rows[0]?.idempotencyKey }));
    expect(h.booking.status).toBe('SLOT_CONFLICT'); expect(h.rows[0]?.status).toBe('FAILED');
    expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
  });

  it('a retryable calendar failure requeues with the same key and then books once', async () => {
    const h = harness('booking_bundle');
    vi.mocked(h.deps.calendar.createEvent).mockResolvedValueOnce({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
    const e = createExecutor(h.deps);
    await e.tick(); expect(h.rows[0]?.status).toBe('QUEUED');
    h.advance(60_000); await ticks(e, 5);
    expect(h.deps.calendar.createEvent).toHaveBeenCalledTimes(2);
    const keys = vi.mocked(h.deps.calendar.createEvent).mock.calls.map(([input]) => input.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([h.rows[0]?.idempotencyKey]));
    expect(h.booking.status).toBe('BOOKED_VERIFIED');
  });
});

describe('crash recovery and the loop', () => {
  it('a step left RUNNING past the stale age goes to review and is never rerun', async () => {
    const h = harness(); vi.mocked(h.deps.checkout.createCheckout).mockImplementation(() => new Promise(() => {}));
    void createExecutor(h.deps).tick(); // worker-a "crashes" mid-call
    await vi.waitFor(() => expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1));
    const b = createExecutor({ ...h.deps, workerId: 'worker-b' });
    h.advance(DEFAULT_STALE_AFTER_MS - 1); await b.tick();
    expect(h.rows[0]?.status).toBe('RUNNING');
    h.advance(2); await ticks(b, 5);
    expect(h.rows[0]?.status).toBe('NEEDS_REVIEW');
    expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
    expect(h.events.some((e) => e.type === 'execution.failed' && e.payload.nextStatus === 'NEEDS_REVIEW')).toBe(true);
  });

  it('stop settles even when the running tick fails', async () => {
    const h = harness(); vi.mocked(h.deps.queue.claimNext).mockRejectedValue(new Error('database down'));
    const onError = vi.fn(); const e = createExecutor({ ...h.deps, onError });
    const running = e.tick(); await expect(e.stop()).resolves.toBeUndefined();
    await expect(running).rejects.toThrow();
  });
});

describe('Sheets result shape', () => {
  function sync(result: Awaited<ReturnType<SyncDeps['reporting']['appendOnce']>>) {
    const outcomes: unknown[] = [];
    const h = harness();
    const deps: SyncDeps = { workerId: 'w', activity: h.deps.activity, clock: h.deps.clock, ids: h.deps.ids,
      queue: { claimNext: vi.fn(async () => ({ id: 'syn_1', businessId: h.order.businessId, approvalId: h.order.approvalId!, recordId: 'r', recordType: 'order' as const, attempts: 1, row: ['r'] })),
        finish: vi.fn(async (_i, _w, o) => { outcomes.push(o); }) },
      policy: { authorizeSync: vi.fn(async () => ({ ok: true as const })) },
      reporting: { appendOnce: vi.fn(async () => result) } };
    return { deps, outcomes };
  }
  it('a retryable adapter failure retries and a definite one fails at once', async () => {
    const a = sync({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true }); await runSyncJob(a.deps);
    expect(a.outcomes[0]).toMatchObject({ status: 'RETRYING' });
    const b = sync({ ok: false, reason: 'VALIDATION_FAILED', retryable: false }); await runSyncJob(b.deps);
    expect(b.outcomes[0]).toMatchObject({ status: 'FAILED', errorCode: 'VALIDATION_FAILED' });
    const c = sync({ ok: true, status: 'skipped' }); await runSyncJob(c.deps);
    expect(c.outcomes[0]).toEqual({ status: 'DONE' });
  });
});
