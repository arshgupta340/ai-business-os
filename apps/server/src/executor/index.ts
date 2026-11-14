import {
  ActionExecutionSchema, ApprovalPayloadSchema, ErrorCodeSchema, EXECUTION_MAX_ATTEMPTS,
  canonicalJson, type ActionExecution, type ActivityEvent, type ApprovalPayload,
} from '@abos/contracts';
import { handlers } from './handlers.js';
import type { ExecutorDeps, StepOutcome } from './types.js';

export type { ExecutorDeps, QueuePort, SubjectsPort, PolicyPort, StepOutcome, SyncDeps } from './types.js';

/** No SDK exception text crosses this boundary. Timeouts always require review. */
export function classifyFailure(error: unknown, attempt: number, externalAttempted: boolean): StepOutcome {
  const object = typeof error === 'object' && error !== null ? error : {};
  const parsed = ErrorCodeSchema.safeParse('code' in object ? object.code : undefined);
  const code = parsed.success ? parsed.data : 'INTERNAL';
  const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'
    || /timeout|timed out/i.test(error.message));
  const ambiguous = ('ambiguous' in object && object.ambiguous === true) || timeout;
  if (ambiguous) return { status: 'NEEDS_REVIEW', errorCode: code, reason: 'Provider outcome is unknown' };
  const beforeSend = 'requestSent' in object && object.requestSent === false;
  const retryable = 'retryable' in object && object.retryable === true;
  const permanent = 'retryable' in object && object.retryable === false;
  const providerUnavailable = code === 'INTEGRATION_UNAVAILABLE' || code === 'RATE_LIMITED' || code === 'INTERNAL';
  if (retryable || (beforeSend && providerUnavailable && !permanent)) {
    return attempt < EXECUTION_MAX_ATTEMPTS
      ? { status: 'QUEUED', errorCode: code, delayMs: 1000 * 2 ** Math.max(0, attempt - 1), reason: 'Retryable provider failure' }
      : { status: 'FAILED', errorCode: code, reason: 'Execution attempt limit reached' };
  }
  const definite = beforeSend || ('ambiguous' in object && object.ambiguous === false);
  // An error code alone says nothing about whether the provider performed the request.
  if (externalAttempted && !definite) return { status: 'NEEDS_REVIEW', errorCode: code, reason: 'Provider outcome is unknown' };
  return { status: 'FAILED', errorCode: code, reason: 'Execution failed' };
}

function isMessage(step: ActionExecution) {
  return step.actionType === 'message.checkout.send' || step.actionType === 'message.booking.confirm';
}

export function createExecutor(deps: ExecutorDeps) {
  let inFlight: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function authorize(step: ActionExecution, expectedMaterial?: ApprovalPayload) {
    const result = await deps.policy.authorizeStep({ executionId: step.id, businessId: step.businessId });
    if (!result.ok) return result;
    const execution = ActionExecutionSchema.parse(result.execution);
    const material = ApprovalPayloadSchema.parse(result.material);
    if (execution.id !== step.id || execution.businessId !== step.businessId || execution.approvalId !== step.approvalId
      || execution.actionType !== step.actionType || execution.stepIndex !== step.stepIndex
      || execution.idempotencyKey !== step.idempotencyKey || execution.status !== 'RUNNING'
      || material.businessId !== step.businessId || material.actionBundle[step.stepIndex] !== step.actionType
      || (expectedMaterial !== undefined && canonicalJson(material) !== canonicalJson(expectedMaterial))) {
      return { ok: false as const, code: 'PAYLOAD_HASH_MISMATCH' as const };
    }
    return { ok: true as const, execution, material };
  }

  async function runTick(): Promise<boolean> {
    const step = await deps.queue.claimNext(deps.workerId);
    if (!step) return false;
    let externalAttempted = false;
    let refusal = false;
    let material: ApprovalPayload | undefined;
    const envelope = () => ({ id: deps.ids.next('evt_'), businessId: step.businessId,
      correlationId: step.approvalId, actorType: 'system' as const, occurredAt: deps.clock.now().toISOString() });
    let outcome: StepOutcome;
    try {
      await deps.activity.write({ ...envelope(), type: 'execution.started', payload: {
        executionId: step.id, approvalId: step.approvalId, actionType: step.actionType,
        stepIndex: step.stepIndex, attempt: step.attempts,
      } });
      const authorization = await authorize(step);
      if (!authorization.ok) {
        refusal = true;
        outcome = { status: 'FAILED', errorCode: authorization.code, reason: 'Authorization refused' };
      } else {
        material = authorization.material;
        outcome = await handlers[step.actionType]({ execution: authorization.execution, material, deps,
          external: async (fn) => {
            const fresh = await authorize(step, material);
            if (!fresh.ok) { refusal = true; throw { code: fresh.code }; }
            externalAttempted = true;
            return fn();
          },
        });
      }
    } catch (error) {
      outcome = classifyFailure(error, step.attempts, externalAttempted);
      if (refusal) outcome = { status: 'FAILED', errorCode: outcome.errorCode, reason: 'Authorization refused' };
    }
    if (!refusal && isMessage(step) && (outcome.status === 'FAILED' || outcome.status === 'NEEDS_REVIEW') && externalAttempted) {
      outcome.continueBundle = true;
    }
    if (!refusal && material && !outcome.apply && (outcome.status === 'FAILED' || outcome.status === 'NEEDS_REVIEW')) {
      const subject = material;
      if (step.actionType === 'square.checkout.create') {
        outcome.apply = (subjects) => subjects.moveOrder(step.businessId, subject.subjectId,
          outcome.errorCode === 'ITEM_UNAVAILABLE' ? 'UNAVAILABLE' : 'RECOVERY_REQUIRED');
      } else if (step.actionType === 'calendar.event.create') {
        outcome.apply = (subjects) => subjects.moveBooking(step.businessId, subject.subjectId, 'RETRY_REQUIRED');
      }
    }
    try {
      await deps.queue.finish(step.id, deps.workerId, outcome);
    } catch {
      // A rolled-back local commit after a provider request must never trigger a new request.
      outcome = { status: externalAttempted ? 'NEEDS_REVIEW' : 'FAILED', errorCode: 'INTERNAL', reason: 'Execution persistence failed',
        continueBundle: externalAttempted && isMessage(step) };
      await deps.queue.finish(step.id, deps.workerId, outcome);
    }
    const event: ActivityEvent = outcome.status === 'SUCCEEDED' || outcome.status === 'SKIPPED'
      ? { ...envelope(), type: 'execution.succeeded', payload: { executionId: step.id, actionType: step.actionType,
        ...(outcome.externalRef ? { externalRef: outcome.externalRef } : {}) } }
      : { ...envelope(), type: 'execution.failed', payload: { executionId: step.id, actionType: step.actionType,
        errorCode: outcome.errorCode ?? 'INTERNAL', retryable: outcome.status === 'QUEUED', nextStatus: outcome.status } };
    for (const domainEvent of outcome.events ?? []) await deps.activity.write(domainEvent);
    await deps.activity.write(event);
    return true;
  }

  function tick(): Promise<boolean> {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  function start({ intervalMs }: { intervalMs: number }) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be positive');
    if (timer) return;
    timer = setInterval(() => { void tick().catch(() => deps.onError?.('INTERNAL')); }, intervalMs);
    timer.unref?.();
  }
  async function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    await inFlight;
  }
  return { tick, start, stop };
}
