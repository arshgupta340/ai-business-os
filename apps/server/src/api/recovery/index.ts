import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  ActionExecutionSchema, ActivityEventSchema, ApprovalRequestSchema, BusinessScopeQuerySchema,
  CancelOrderResponseSchema, ENDPOINTS, ERROR_CODE_INFO, ErrorCodeSchema,
  OrderSchema,
  ResolveExecutionBodySchema, ResolveExecutionResponseSchema, canTransition, makeApiError,
  type ActionExecution, type ActivityEvent, type ErrorCode, type ResolveExecutionBody,
} from '@abos/contracts';
import type { RecoveryDecision, RecoveryLookup, RecoveryPorts, RecoveryRecord, RecoveryScope } from './types';

export type { RecoveryDecision, RecoveryLookup, RecoveryPorts, RecoveryRecord, RecoveryScope, RecoveryTransaction } from './types';

class RecoveryError extends Error {
  constructor(readonly code: ErrorCode) { super('Recovery request was refused.'); }
}
const refuse = (code: ErrorCode): never => { throw new RecoveryError(code); };

async function scopeFor(ports: RecoveryPorts, request: FastifyRequest, id: string, businessId: string): Promise<RecoveryScope> {
  // Authentication is installed by the composition root. A missing guard fails closed.
  const ownerUserId = request.ownerUserId;
  if (!ownerUserId) refuse('UNAUTHENTICATED');
  if (!await ports.ownsBusiness({ ownerUserId, businessId })) refuse('FORBIDDEN_BUSINESS');
  return { id, businessId, ownerUserId };
}

function event(ports: RecoveryPorts, scope: RecoveryScope, correlationId: string,
  detail: Pick<ActivityEvent, 'type' | 'payload'>): ActivityEvent {
  return ActivityEventSchema.parse({ ...detail, id: ports.ids.next('evt_'), businessId: scope.businessId,
    correlationId, actorType: 'owner', occurredAt: ports.clock.now().toISOString() });
}

function checkRecord(record: RecoveryRecord, scope: RecoveryScope): void {
  const e = ActionExecutionSchema.parse(record.execution);
  const a = ApprovalRequestSchema.parse(record.approval);
  if (e.id !== scope.id || e.businessId !== scope.businessId || a.businessId !== scope.businessId || e.approvalId !== a.id) refuse('NOT_FOUND');
  if (a.actionBundle[e.stepIndex] !== e.actionType) refuse('INVALID_STATE');
  if ((a.bundleType === 'order_bundle' && !record.order) || (a.bundleType === 'booking_bundle' && !record.booking)) refuse('NOT_FOUND');
  if (record.order && (record.order.businessId !== scope.businessId || record.order.id !== a.subjectId || record.order.approvalId !== a.id)) refuse('NOT_FOUND');
  if (record.booking && (record.booking.businessId !== scope.businessId || record.booking.id !== a.subjectId || record.booking.approvalId !== a.id)) refuse('NOT_FOUND');
  const d = record.dispatch;
  if (d && (d.businessId !== scope.businessId || d.executionId !== e.id || d.subjectId !== a.subjectId || d.idempotencyKey !== e.idempotencyKey)) refuse('INVALID_STATE');
}

function checkResult(before: ActionExecution, after: ActionExecution, status?: ActionExecution['status']): ActionExecution {
  const parsed = ActionExecutionSchema.parse(after);
  if (parsed.id !== before.id || parsed.businessId !== before.businessId || parsed.approvalId !== before.approvalId ||
    parsed.actionType !== before.actionType || parsed.stepIndex !== before.stepIndex ||
    parsed.idempotencyKey !== before.idempotencyKey || parsed.attempts !== before.attempts ||
    (status !== undefined && parsed.status !== status)) refuse('INTERNAL');
  return parsed;
}

function checkDecision(before: ActionExecution, decision: RecoveryDecision, action: ResolveExecutionBody['action']): ActionExecution {
  if (decision.action !== action || decision.generation !== before.attempts) refuse('INVALID_STATE');
  const parsed = ActionExecutionSchema.parse(decision.execution);
  if (parsed.id !== before.id || parsed.businessId !== before.businessId || parsed.approvalId !== before.approvalId ||
    parsed.actionType !== before.actionType || parsed.stepIndex !== before.stepIndex || parsed.idempotencyKey !== before.idempotencyKey) refuse('INTERNAL');
  return parsed;
}

/** API 3.12 recovery routes only. All persistence and provider access is injected. */
export function createRecoveryPlugin(ports: RecoveryPorts): FastifyPluginAsync {
  return async app => {
    // Scoped handler also sanitizes port exceptions. Never expose raw provider errors.
    app.setErrorHandler((error, request, reply) => {
      const candidate = error as { code?: unknown; statusCode?: unknown };
      const parsed = ErrorCodeSchema.safeParse(candidate.code);
      const code = parsed.success ? parsed.data :
        typeof candidate.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode < 500 ? 'VALIDATION_FAILED' : 'INTERNAL';
      return reply.header('X-Correlation-Id', request.id).code(ERROR_CODE_INFO[code].httpStatus)
        .send(makeApiError(code, 'Recovery request could not be completed.', request.id));
    });
    // Fastify's default 404 includes the request URL, which may contain a bearer token or phone
    // number. This encapsulated handler keeps malformed recovery-path requests redacted too.
    app.setNotFoundHandler((request, reply) => reply.header('X-Correlation-Id', request.id)
      .code(404).send(makeApiError('NOT_FOUND', 'Recovery route was not found.', request.id)));

    app.post(ENDPOINTS.cancelOrder.path, async (request, reply) => {
      reply.header('X-Correlation-Id', request.id);
      const params = ENDPOINTS.cancelOrder.params.safeParse(request.params);
      const query = BusinessScopeQuerySchema.safeParse(request.query);
      const body = ENDPOINTS.cancelOrder.body.safeParse(request.body ?? {});
      if (!params.success || !query.success || !body.success) return refuse('VALIDATION_FAILED');
      const scope = await scopeFor(ports, request, params.data.id, query.data.businessId);
      const candidate = await ports.withRecovery(scope, async tx => {
        const current = await tx.loadOrder();
        if (!current || current.id !== scope.id || current.businessId !== scope.businessId) return refuse('NOT_FOUND');
        if (current.status !== 'CANCELLED' && !canTransition('order', current.status, 'CANCELLED')) return refuse('INVALID_STATE');
        return current;
      });
      if (candidate.status === 'CANCELLED') return CancelOrderResponseSchema.parse({ order: candidate });
      // Reconciliation commits independently. Refusing cancellation must not roll back a verified payment.
      if (candidate.squareOrderId) {
        const reconciled = OrderSchema.parse(await ports.reconcilePayment(candidate));
        if (reconciled.id !== scope.id || reconciled.businessId !== scope.businessId) return refuse('NOT_FOUND');
        if (reconciled.status !== 'CANCELLED' && !canTransition('order', reconciled.status, 'CANCELLED')) return refuse('INVALID_STATE');
      } else if (candidate.status !== 'RECOVERY_REQUIRED') return refuse('INVALID_STATE');
      const order = await ports.withRecovery(scope, async tx => {
        const current = await tx.loadOrder();
        if (!current || current.id !== scope.id || current.businessId !== scope.businessId) return refuse('NOT_FOUND');
        if (current.status === 'CANCELLED') return current;
        if (!canTransition('order', current.status, 'CANCELLED')) return refuse('INVALID_STATE');
        // The checked routine must fence changes since the payment read, including active work.
        if (current.squareOrderId !== candidate.squareOrderId) return refuse('INVALID_STATE');
        const cancelled = OrderSchema.parse(await tx.cancelOrder(current));
        if (cancelled.id !== current.id || cancelled.businessId !== current.businessId || cancelled.status !== 'CANCELLED') return refuse('INTERNAL');
        await tx.activity.write(event(ports, scope, request.id, { type: 'order.status_changed', payload: {
          orderId: current.id, callId: current.callId, from: current.status, to: cancelled.status,
        } }));
        return cancelled;
      });
      return CancelOrderResponseSchema.parse({ order });
    });

    app.post(ENDPOINTS.resolveExecution.path, async (request, reply) => {
      reply.header('X-Correlation-Id', request.id);
      const params = ENDPOINTS.resolveExecution.params.safeParse(request.params);
      const query = BusinessScopeQuerySchema.safeParse(request.query);
      const body = ResolveExecutionBodySchema.safeParse(request.body);
      if (!params.success || !query.success || !body.success) return refuse('VALIDATION_FAILED');
      const scope = await scopeFor(ports, request, params.data.id, query.data.businessId);
      const execution = await ports.withRecovery(scope, async tx => {
        const record = await tx.loadExecution();
        if (!record) return refuse('NOT_FOUND');
        checkRecord(record, scope);
        const e = structuredClone(record.execution);
        const prior = await tx.recoveryDecision();
        if (prior && prior.generation === e.attempts) return checkDecision(e, prior, body.data.action);
        if (prior && prior.generation > e.attempts) return refuse('INTERNAL');
        if (e.status !== 'NEEDS_REVIEW') return refuse('INVALID_STATE');
        if (record.order && ['CANCELLED', 'REJECTED', 'APPROVAL_EXPIRED', 'UNAVAILABLE'].includes(record.order.status)) return refuse('INVALID_STATE');
        if (record.booking && ['REJECTED', 'EXPIRED', 'SLOT_CONFLICT'].includes(record.booking.status)) return refuse('INVALID_STATE');
        // Retry needs additive subject and dispatch transitions plus checked routines that are not
        // in this checkout. Do not report a queue that no restricted-role worker can consume.
        if (body.data.action === 'retry') return refuse('INVALID_STATE');
        const lookup: RecoveryLookup = await ports.lookup(record);
        if (lookup.outcome === 'unknown') return refuse('INVALID_STATE');
        if ((record.dispatch?.status === 'SENT' || record.dispatch?.status === 'DELIVERED') && lookup.outcome !== 'exists') return refuse('INVALID_STATE');
        // A found effect needs checkout or booking subject routines, not just an execution state.
        if (lookup.outcome !== 'absent') return refuse('INVALID_STATE');
        const audit = event(ports, scope, request.id, { type: 'execution.failed', payload: {
          executionId: e.id, actionType: e.actionType, errorCode: e.errorCode ?? 'INVALID_STATE', retryable: false, nextStatus: 'FAILED',
        } });
        const decision = await tx.resolveNeedsReview({ record, action: 'abandon', status: 'FAILED', lookup, event: audit });
        return checkResult(e, checkDecision(e, decision, 'abandon'), 'FAILED');
      });
      return ResolveExecutionResponseSchema.parse({ execution });
    });
  };
}
