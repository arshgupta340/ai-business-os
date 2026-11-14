import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityEventSchema, APPROVAL_SWEEP_INTERVAL_MS, SYNC_JOB_MAX_ATTEMPTS } from '@abos/contracts';
import { orderPaid } from '@abos/contracts/fixtures';
import { registerJobs, runExpirySweep, runSyncJob } from '../../src/executor/jobs.js';
import type { ReportingResult, SyncDeps, SyncJob, SyncOutcome } from '../../src/executor/types.js';
import { harness } from './fakes.js';
import { createExecutor } from '../../src/executor/index.js';

function syncHarness() {
  const h = harness();
  const job: SyncJob = { id: 'syn_test_1', businessId: orderPaid.businessId, approvalId: orderPaid.approvalId!,
    recordId: 'record-key', recordType: 'order', attempts: 0, row: ['record-key', 'sandbox', 100] };
  const outcomes: SyncOutcome[] = [];
  let ready = true;
  let delay = 0;
  const deps: SyncDeps = {
    workerId: 'sync-worker', activity: h.deps.activity, clock: h.deps.clock, ids: h.deps.ids,
    queue: {
      claimNext: vi.fn(async () => {
        if (!ready) return undefined;
        ready = false; job.attempts++; return { ...job };
      }),
      finish: vi.fn(async (_id, _worker, outcome) => { outcomes.push(outcome); delay = outcome.delayMs ?? 0; }),
    },
    policy: { authorizeSync: vi.fn(async () => ({ ok: true as const })) },
    reporting: { appendOnce: vi.fn(async (): Promise<ReportingResult> => ({ ok: true, status: 'appended' })) },
  };
  return { deps, job, outcomes, events: h.events, retry() { if (outcomes.at(-1)?.status === 'RETRYING') { ready = true; h.advance(delay); } } };
}

afterEach(() => vi.useRealTimers());
describe('Sheets jobs', () => {
  it.each(['appended', 'skipped'] as const)('finishes %s once and does nothing without a due job', async (result) => {
    const h = syncHarness(); vi.mocked(h.deps.reporting.appendOnce).mockResolvedValue({ ok: true, status: result });
    expect(await runSyncJob(h.deps)).toBe(true); expect(await runSyncJob(h.deps)).toBe(false);
    expect(h.outcomes).toEqual([{ status: 'DONE' }]);
    expect(h.deps.reporting.appendOnce).toHaveBeenCalledWith({ recordId: h.job.recordId, row: h.job.row });
    for (const event of h.events) expect(ActivityEventSchema.safeParse(event).success).toBe(true);
  });
  it('retries failures five times with backoff and leaves the paid order untouched (AC-13)', async () => {
    const paid = structuredClone(orderPaid); const before = structuredClone(paid); const h = syncHarness();
    vi.mocked(h.deps.reporting.appendOnce).mockRejectedValue(new Error('provider failed'));
    for (let attempt = 0; attempt < SYNC_JOB_MAX_ATTEMPTS; attempt++) { await runSyncJob(h.deps); h.retry(); }
    await runSyncJob(h.deps);
    expect(h.outcomes.map((o) => o.status)).toEqual(['RETRYING', 'RETRYING', 'RETRYING', 'RETRYING', 'FAILED']);
    expect(h.outcomes[1]?.delayMs).toBeGreaterThan(h.outcomes[0]?.delayMs ?? 0);
    expect(h.deps.reporting.appendOnce).toHaveBeenCalledTimes(5);
    expect(h.deps.policy.authorizeSync).toHaveBeenCalledTimes(5);
    expect(paid).toEqual(before);
    expect(h.events.at(-1)).toMatchObject({ type: 'sync.failed', payload: { final: true, attempts: 5 } });
  });
  it('does not append a row when its approval is refused', async () => {
    const h = syncHarness(); vi.mocked(h.deps.policy.authorizeSync).mockResolvedValue({ ok: false, code: 'PAYLOAD_HASH_MISMATCH' });
    await runSyncJob(h.deps);
    expect(h.deps.reporting.appendOnce).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual([{ status: 'FAILED', errorCode: 'PAYLOAD_HASH_MISMATCH' }]);
  });
  it('recovers an uncertain append by the same record ID without a second row', async () => {
    const h = syncHarness(); const records = new Set<string>();
    vi.mocked(h.deps.reporting.appendOnce).mockImplementation(async ({ recordId }) => {
      if (records.has(recordId)) return { ok: true, status: 'skipped' };
      records.add(recordId); throw new Error('timeout after append');
    });
    await runSyncJob(h.deps); h.retry(); await runSyncJob(h.deps);
    expect(records.size).toBe(1); expect(h.outcomes.at(-1)?.status).toBe('DONE');
  });
});

describe('background timers', () => {
  it('expiry calls only expireDue', async () => {
    const expireDue = vi.fn(async () => {});
    await runExpirySweep({ expireDue }); expect(expireDue).toHaveBeenCalledTimes(1);
  });
  it('sweeps every 30 seconds, registers once, and stops every timer', async () => {
    vi.useFakeTimers(); const h = syncHarness(); const expireDue = vi.fn(async () => {});
    const jobs = registerJobs({ sync: h.deps, expiry: { expireDue }, syncIntervalMs: 1000 });
    jobs.start();
    await vi.advanceTimersByTimeAsync(APPROVAL_SWEEP_INTERVAL_MS - 1); expect(expireDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(expireDue).toHaveBeenCalledTimes(1);
    await jobs.stop(); await vi.advanceTimersByTimeAsync(60000); expect(expireDue).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not overlap slow expiry jobs and drains them on stop', async () => {
    vi.useFakeTimers(); const h = syncHarness(); let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const expireDue = vi.fn(() => pending);
    const jobs = registerJobs({ sync: h.deps, expiry: { expireDue } });
    await vi.advanceTimersByTimeAsync(90000); expect(expireDue).toHaveBeenCalledTimes(1);
    const stopping = jobs.stop(); release(); await stopping; expect(vi.getTimerCount()).toBe(0);
  });
  it('reports timer errors and keeps scheduling', async () => {
    vi.useFakeTimers(); const h = syncHarness(); const onError = vi.fn();
    const expireDue = vi.fn(async () => { throw new Error('private error'); });
    const jobs = registerJobs({ sync: h.deps, expiry: { expireDue }, onError });
    await vi.advanceTimersByTimeAsync(60000); await jobs.stop();
    expect(expireDue).toHaveBeenCalledTimes(2); expect(onError).toHaveBeenCalledWith('INTERNAL');
  });
  it('executor start and concurrent tick calls never overlap, and stop drains the claim', async () => {
    vi.useFakeTimers(); const h = harness(); let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => {};
    const checkoutStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(h.deps.checkout.createCheckout).mockImplementation(async () => { started(); await pending;
      return { squareOrderId: 'order', paymentLinkId: 'link', url: 'https://example.test/pay' }; });
    const e = createExecutor(h.deps); e.start({ intervalMs: 10 }); e.start({ intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(50); await checkoutStarted;
    expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
    const a = e.tick(); const b = e.tick(); expect(a).toBe(b);
    const stop = e.stop(); release(); await stop; await a;
    await vi.advanceTimersByTimeAsync(100); expect(h.deps.queue.claimNext).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
