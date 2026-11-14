import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  ActionExecutionSchema, ActivityEventSchema, ApprovalRequestSchema, BusinessScopeQuerySchema,
  CancelOrderResponseSchema, ENDPOINTS, ERROR_CODE_INFO, EXECUTION_MAX_ATTEMPTS, ErrorCodeSchema,
  OrderSchema, verifyPayloadHash,
  ResolveExecutionBodySchema, ResolveExecutionResponseSchema, canTransition, makeApiError,
  type ActionExecution, type ActivityEvent, type ErrorCode, type ResolveExecutionBody,
} from '@abos/contracts';
import type { RecoveryDecision, RecoveryLookup, RecoveryPorts, RecoveryRecord, RecoveryScope } from './types';

export type { RecoveryDecision, RecoveryLookup, RecoveryPorts, RecoveryRecord, RecoveryScope, RecoveryTransaction } from './types';

class RecoveryError extends Error {
  /** `detail` is a fixed sentence written here, shown to the owner. It never carries request or provider text. */
  constructor(readonly code: ErrorCode, readonly detail?: string) { super('Recovery request was refused.'); }
}
const refuse = (code: ErrorCode, detail?: string): never => { throw new RecoveryError(code, detail); };

/** The fixed sentences the resolve route answers with (issue #54). */
export const RECOVERY_MESSAGES = {
  messageNotResent: 'A message whose delivery is unknown is never sent again. Abandon it to mark it failed; the order or booking goes on without it.',
  messageWasSent: 'This message was sent. Retry records it as sent; it cannot be abandoned.',
  outcomeUnknown: 'The provider could not confirm whether this step happened, so it cannot be retried or abandoned yet. For an order, cancel it instead.',
  attemptsUsed: 'This step has used all of its attempts, so it cannot be retried. Abandon it instead.',
  approvalNotApproved: 'This step does not belong to an approved request, so it cannot be retried.',
  checkoutNotProvable: 'Square cannot show that this payment link was never created, so the checkout cannot be retried or abandoned. Cancel the order instead.',
} as const;

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
        .send(makeApiError(code, error instanceof RecoveryError && error.detail ? error.detail : 'Recovery request could not be completed.', request.id));
    });
    // Fastify's default 404 includes the request URL, which may contain a bearer token or phone
    // number. This encapsulated handler keeps malformed recovery-path requests redacted too.
    // Fastify allows one not-found handler per prefix. Registered at the server root (prefix '/'), the
    // root's handler applies instead; it prints the path only, never the query string.
    try {
      app.setNotFoundHandler((request, reply) => reply.header('X-Correlation-Id', request.id)
        .code(404).send(makeApiError('NOT_FOUND', 'Recovery route was not found.', request.id)));
    } catch { /* root handler in use */ }

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
        const lookup: RecoveryLookup = await ports.lookup(record);
        const message = e.actionType === 'message.checkout.send' || e.actionType === 'message.booking.confirm';
        const sent = record.dispatch?.status === 'SENT' || record.dispatch?.status === 'DELIVERED';
        const finish = async (action: ResolveExecutionBody['action'], status: 'SUCCEEDED' | 'QUEUED' | 'FAILED', audit: ActivityEvent) => {
          const decision = await tx.resolveNeedsReview({ record, action, status, lookup, event: audit });
          return checkResult(e, checkDecision(e, decision, action), status);
        };
        const succeeded = (externalRef: string) => event(ports, scope, request.id, { type: 'execution.succeeded', payload: { executionId: e.id, actionType: e.actionType, externalRef } });
        const failed = (nextStatus: 'QUEUED' | 'FAILED') => event(ports, scope, request.id, { type: 'execution.failed', payload: {
          executionId: e.id, actionType: e.actionType, errorCode: e.errorCode ?? 'INVALID_STATE', retryable: nextStatus === 'QUEUED', nextStatus } });
        if (message) {
          // CONTRACTS "Message dispatch": no resend from UNKNOWN, and SPEC 4 says an unknown AgentPhone send
          // must not be resent. So "retry" only records a send the stored dispatch proves; there is no
          // move back to QUEUED. "Abandon" is the owner marking the message failed (UNKNOWN -> FAILED),
          // which writes nothing external and needs no provider proof.
          if (body.data.action === 'retry') {
            if (lookup.outcome !== 'exists') return refuse('INVALID_STATE', RECOVERY_MESSAGES.messageNotResent);
            return finish('retry', 'SUCCEEDED', succeeded(lookup.externalRef));
          }
          if (sent || lookup.outcome === 'exists') return refuse('INVALID_STATE', RECOVERY_MESSAGES.messageWasSent);
          return finish('abandon', 'FAILED', failed('FAILED'));
        }
        if (lookup.outcome === 'unknown') return refuse('INVALID_STATE', RECOVERY_MESSAGES.outcomeUnknown);
        // No Square read can prove a payment link absent (0008 refuses it too), so a checkout without
        // evidence of its link is neither requeued nor abandoned.
        if (lookup.outcome === 'absent' && e.actionType === 'square.checkout.create') return refuse('INVALID_STATE', RECOVERY_MESSAGES.checkoutNotProvable);
        if (body.data.action === 'retry') {
          // A provider effect proven to match the approved material completes the step from that evidence
          // (checkout references and PAYMENT_LINK_READY, the verified booking and its Sheets job). Proven
          // absence (today only a calendar read) requeues the same step row, so the same idempotency key
          // (owner_resolve_execution, 0008), and moves the booking back to RECHECKING_SLOT.
          if (lookup.outcome === 'exists') return finish('retry', 'SUCCEEDED', succeeded(lookup.externalRef));
          if (record.approval.state !== 'APPROVED') return refuse('INVALID_STATE', RECOVERY_MESSAGES.approvalNotApproved);
          if (!await verifyPayloadHash(record.approval.bundleType, record.approval.payload as unknown as Record<string, unknown>, record.approval.payloadHash)) return refuse('PAYLOAD_HASH_MISMATCH');
          if (e.attempts >= EXECUTION_MAX_ATTEMPTS) return refuse('INVALID_STATE', RECOVERY_MESSAGES.attemptsUsed);
          return finish('retry', 'QUEUED', failed('QUEUED'));
        }
        // Abandon of a provider step: only after a lookup proves nothing was written.
        if (lookup.outcome !== 'absent') return refuse('INVALID_STATE');
        return finish('abandon', 'FAILED', failed('FAILED'));
      });
      return ResolveExecutionResponseSchema.parse({ execution });
    });
  };
}
