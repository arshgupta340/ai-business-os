import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import {
  APPROVAL_EXPIRY_MS, BUNDLE_ACTIONS, ENDPOINTS, ERROR_CODE_INFO, EXECUTION_MAX_ATTEMPTS, ErrorCodeSchema, PriceEditApprovalPayloadSchema,
  PriceEditApprovalRequestSchema, ProposePriceResponseSchema, approvalPayloadHash, verifyPayloadHash,
  makeApiError, type ErrorCode, type PriceEditApprovalRequest,
} from '@abos/contracts';
import { AppError } from '../../errors';
import { SquareAdapterError } from '../../adapters/square/types';
import { SquarePriceError } from '../../adapters/square/price-types';
import { CATALOG_PRICE_MAX } from '../../adapters/square';
import type { CatalogSyncPort, PricesDependencies, PriceExecutionPorts, PriceReconciliationPorts, PriceStepResult } from './types';
export * from './types';

function apiFailure(code: ErrorCode, message: string): AppError {
  const info = ERROR_CODE_INFO[code];
  return new AppError(code, message, info.httpStatus, info.retryable);
}

/** Register once at the server root. Auth and persistence are supplied by composition. */
export const pricesPlugin: FastifyPluginAsync<PricesDependencies> = async (app, deps) => {
  const endpoint = ENDPOINTS.proposePrice;
  app.post(endpoint.path, async (request, reply) => {
    const correlationId = request.correlationId || randomUUID();
    reply.header('X-Correlation-Id', correlationId);
    try {
      const params = endpoint.params.safeParse(request.params);
      if (!params.success) throw apiFailure('VALIDATION_FAILED', 'The business path is invalid.');
      const owner = await deps.auth.requireOwner(request, params.data.id);
      if (!owner) throw apiFailure('UNAUTHENTICATED', 'An owner session is required.');
      // The price proposal contract has no resolvesConflictId yet (NOTES.md), so say what works instead.
      if (request.body && typeof request.body === 'object' && 'resolvesConflictId' in request.body) {
        return reply.code(ERROR_CODE_INFO.VALIDATION_FAILED.httpStatus).send(makeApiError('VALIDATION_FAILED',
          'A price change cannot resolve a conflict yet. Change the price, sync, then keep the current value on the conflict.', correlationId));
      }
      const parsed = endpoint.body.safeParse(request.body);
      if (!parsed.success) throw apiFailure('VALIDATION_FAILED', 'The price proposal is invalid.');
      const input = parsed.data;
      if (input.newPriceMinor > Number(CATALOG_PRICE_MAX)) throw apiFailure('VALIDATION_FAILED', 'The price proposal is invalid.');
      const item = await deps.catalog.findVariation(params.data.id, input.variationId);
      if (!item || item.businessId !== params.data.id || item.variationId !== input.variationId) throw apiFailure('NOT_FOUND', 'The variation was not found in this business.');
      const current = await deps.square.readVariationPrice(input.variationId);
      if (current.variationId !== input.variationId || current.squareItemId !== item.squareItemId) throw apiFailure('NOT_FOUND', 'The variation was not found in this business.');
      const createdAt = deps.now().toISOString();
      const payload = PriceEditApprovalPayloadSchema.parse({
        businessId: item.businessId, subjectId: item.subjectId, squareItemId: item.squareItemId,
        variationId: input.variationId, fromPriceMinor: current.priceMinor, newPriceMinor: input.newPriceMinor,
        currency: current.currency, squareVersion: current.version, actionBundle: [...BUNDLE_ACTIONS.price_edit],
        expiresAt: new Date(Date.parse(createdAt) + APPROVAL_EXPIRY_MS).toISOString(),
      });
      const hash = await approvalPayloadHash('price_edit', payload);
      const created = await deps.approvals.createPendingPriceEditApproval({
        ownerUserId: owner.ownerUserId, actorType: 'owner', bundleType: 'price_edit', payload,
        payloadHash: hash, createdAt,
      });
      if (created.kind === 'conflict') throw apiFailure('INVALID_STATE', 'A different price proposal is already pending for this item.');
      const approval = created.approval;
      const response = ProposePriceResponseSchema.parse({ approval });
      if (response.approval.state !== 'PENDING' || response.approval.payloadHash !== hash ||
          !(await verifyPayloadHash('price_edit', response.approval.payload, hash))) throw apiFailure('INTERNAL', 'The price approval could not be confirmed.');
      return reply.code(endpoint.successStatus).send(response);
    } catch (error) {
      const code: ErrorCode = error instanceof SquareAdapterError ? error.code :
        error instanceof AppError && ErrorCodeSchema.safeParse(error.code).success ? error.code as ErrorCode : 'INTERNAL';
      // Fixed messages keep arbitrary port failures and provider bodies out of responses and logs.
      const messages: Partial<Record<ErrorCode, string>> = {
        UNAUTHENTICATED: 'An owner session is required.', FORBIDDEN_BUSINESS: 'The owner cannot access this business.',
        NOT_FOUND: 'The variation was not found in this business.', VALIDATION_FAILED: 'The price proposal is invalid.',
        ENVIRONMENT_MISMATCH: 'Square must use the sandbox environment.', INTEGRATION_UNAVAILABLE: 'The price integration is unavailable.',
      };
      return reply.code(ERROR_CODE_INFO[code].httpStatus).send(makeApiError(code, messages[code] ?? 'The price proposal could not be completed.', correlationId));
    }
  });
};

/** Called only by the approval executor, after its per-step hash and policy checks. Never retries. */
export async function executePriceEditStep(input: { approval: PriceEditApprovalRequest; idempotencyKey: string; attempt: number }, ports: PriceExecutionPorts): Promise<PriceStepResult> {
  const parsed = PriceEditApprovalRequestSchema.safeParse(input.approval);
  if (!parsed.success || parsed.data.state !== 'APPROVED' || !input.idempotencyKey || !Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > EXECUTION_MAX_ATTEMPTS) return { state: 'FAILED', code: 'INVALID_STATE' };
  const approval = parsed.data;
  if (!(await verifyPayloadHash('price_edit', approval.payload, approval.payloadHash))) return { state: 'FAILED', code: 'PAYLOAD_HASH_MISMATCH' };
  const payload = approval.payload;
  try {
    const result = await ports.square.updateVariationPrice({
      variationId: payload.variationId, expectedOldPriceMinor: payload.fromPriceMinor,
      newPriceMinor: payload.newPriceMinor, currency: payload.currency, expectedVersion: payload.squareVersion,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.verified || result.priceMinor !== payload.newPriceMinor || result.currency !== payload.currency ||
        result.variationId !== payload.variationId || result.squareItemId !== payload.squareItemId) return { state: 'NEEDS_REVIEW', code: 'INVALID_STATE', outcome: 'mismatch' };
    return { state: 'SUCCEEDED', squareVersion: result.version };
  } catch (error) {
    if (error instanceof SquarePriceError) {
      if (error.outcome === 'not_updated' && error.code === 'INTEGRATION_UNAVAILABLE' && input.attempt < EXECUTION_MAX_ATTEMPTS) {
        return { state: 'QUEUED', code: error.code, outcome: error.outcome };
      }
      return { state: ['unknown', 'updated_unverified', 'mismatch'].includes(error.outcome) ? 'NEEDS_REVIEW' : 'FAILED', code: error.code, outcome: error.outcome };
    }
    return { state: 'NEEDS_REVIEW', code: 'INTEGRATION_UNAVAILABLE' };
  }
}

/** Read-only recovery for a NEEDS_REVIEW write. It never calls Square upsert. */
export async function reconcilePriceEditStep(input: { approval: PriceEditApprovalRequest }, ports: PriceReconciliationPorts): Promise<PriceStepResult> {
  const parsed = PriceEditApprovalRequestSchema.safeParse(input.approval);
  if (!parsed.success || parsed.data.state !== 'APPROVED') return { state: 'FAILED', code: 'INVALID_STATE' };
  const approval = parsed.data;
  if (!(await verifyPayloadHash('price_edit', approval.payload, approval.payloadHash))) return { state: 'FAILED', code: 'PAYLOAD_HASH_MISMATCH' };
  try {
    const current = await ports.square.readVariationPrice(approval.payload.variationId);
    if (current.squareItemId === approval.payload.squareItemId && current.priceMinor === approval.payload.newPriceMinor && current.currency === approval.payload.currency) return { state: 'SUCCEEDED', squareVersion: current.version };
    if (current.squareItemId === approval.payload.squareItemId && current.priceMinor === approval.payload.fromPriceMinor && current.version === approval.payload.squareVersion) return { state: 'QUEUED', code: 'INTEGRATION_UNAVAILABLE' };
    return { state: 'NEEDS_REVIEW', code: 'INVALID_STATE', outcome: 'mismatch' };
  } catch { return { state: 'NEEDS_REVIEW', code: 'INTEGRATION_UNAVAILABLE' }; }
}

/** Runs only the second, local.catalog.sync execution after its predecessor was persisted SUCCEEDED. */
export async function executeCatalogSyncStep(input: { businessId: string; attempt: number }, port: CatalogSyncPort): Promise<PriceStepResult> {
  if (!input.businessId || !Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > EXECUTION_MAX_ATTEMPTS) return { state: 'FAILED', code: 'INVALID_STATE' };
  try {
    await port.sync(input.businessId);
    return { state: 'SUCCEEDED', squareVersion: 0 };
  } catch {
    return input.attempt < EXECUTION_MAX_ATTEMPTS ? { state: 'QUEUED', code: 'INTEGRATION_UNAVAILABLE' } : { state: 'FAILED', code: 'INTEGRATION_UNAVAILABLE' };
  }
}
