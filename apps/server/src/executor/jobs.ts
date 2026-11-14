import { APPROVAL_SWEEP_INTERVAL_MS, ErrorCodeSchema, SYNC_JOB_MAX_ATTEMPTS, type ActivityEvent, type ErrorCode } from '@abos/contracts';
import type { SyncDeps, SyncOutcome } from './types.js';

/** Sheets is an eventual projection. This port deliberately has no subject mutation methods. */
export async function runSyncJob(deps: SyncDeps): Promise<boolean> {
  const job = await deps.queue.claimNext(deps.workerId);
  if (!job) return false;
  let outcome: SyncOutcome;
  try {
    const authorization = await deps.policy.authorizeSync(job);
    if (!authorization.ok) outcome = { status: 'FAILED', errorCode: authorization.code };
    else {
      // appendOnce checks the record ID column on every attempt, including after a timeout.
      const result = await deps.reporting.appendOnce({ recordId: job.recordId, row: job.row });
      if (typeof result !== 'object' || result === null) throw new Error('Invalid append result');
      if (result.ok === true) {
        if (result.status !== 'appended' && result.status !== 'skipped') throw new Error('Invalid append result');
        outcome = { status: 'DONE' };
      } else if (result.retryable === false) {
        // A definite refusal (for example an invalid row) cannot succeed on a retry.
        outcome = { status: 'FAILED', errorCode: ErrorCodeSchema.safeParse(result.reason).success ? result.reason : 'INTEGRATION_UNAVAILABLE' };
      } else throw new Error('Retryable append failure');
    }
  } catch {
    outcome = job.attempts < SYNC_JOB_MAX_ATTEMPTS
      ? { status: 'RETRYING', delayMs: 1000 * 2 ** Math.max(0, job.attempts - 1), errorCode: 'INTEGRATION_UNAVAILABLE' }
      : { status: 'FAILED', errorCode: 'INTEGRATION_UNAVAILABLE' };
  }
  await deps.queue.finish(job.id, deps.workerId, outcome);
  const common = { id: deps.ids.next('evt_'), businessId: job.businessId, correlationId: job.approvalId,
    actorType: 'system' as const, occurredAt: deps.clock.now().toISOString() };
  const payload = { target: 'google_sheets' as const, syncJobId: job.id, recordType: job.recordType, recordId: job.recordId };
  const event: ActivityEvent = outcome.status === 'DONE'
    ? { ...common, type: 'sync.succeeded', payload }
    : { ...common, type: 'sync.failed', payload: { ...payload, attempts: job.attempts, final: outcome.status === 'FAILED' } };
  await deps.activity.write(event);
  return true;
}

export interface ExpiryDeps { expireDue(): Promise<unknown> }

/** The expiry service owns its conditional updates and activity. This runner writes nothing. */
export async function runExpirySweep(deps: ExpiryDeps): Promise<void> {
  await deps.expireDue();
}

export interface JobRegistrationDeps {
  sync: SyncDeps;
  expiry: ExpiryDeps;
  syncIntervalMs?: number;
  onError?(code: ErrorCode): void;
}

/** Starts on registration. start is idempotent; stop clears timers and drains both tasks. */
export function registerJobs(deps: JobRegistrationDeps) {
  const intervalMs = deps.syncIntervalMs ?? 1000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('syncIntervalMs must be positive');
  let timers: ReturnType<typeof setInterval>[] = [];
  let syncFlight: Promise<void> | undefined;
  let expiryFlight: Promise<void> | undefined;
  function start() {
    if (timers.length) return;
    timers = [
      setInterval(() => {
        if (syncFlight) return;
        syncFlight = runSyncJob(deps.sync).then(() => {}).catch(() => deps.onError?.('INTERNAL'))
          .finally(() => { syncFlight = undefined; });
      }, intervalMs),
      setInterval(() => {
        if (expiryFlight) return;
        expiryFlight = runExpirySweep(deps.expiry).catch(() => deps.onError?.('INTERNAL'))
          .finally(() => { expiryFlight = undefined; });
      }, APPROVAL_SWEEP_INTERVAL_MS),
    ];
    for (const timer of timers) timer.unref?.();
  }
  async function stop() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
    await Promise.all([syncFlight, expiryFlight]);
  }
  start();
  return { start, stop };
}
