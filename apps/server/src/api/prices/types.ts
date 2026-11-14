import type { FastifyRequest } from 'fastify';
import type { ErrorCode, ExecutionStatus, PriceEditApprovalPayload, PriceEditApprovalRequest } from '@abos/contracts';
import type { PriceAdapter, PriceOutcome } from '../../adapters/square/price-types';

export interface OwnerAuthPort {
  /** Verifies the owner session and ownership of businessId, or throws a typed API error. */
  requireOwner(request: FastifyRequest, businessId: string): Promise<{ ownerUserId: string } | null>;
}
export interface CatalogLookupPort {
  findVariation(businessId: string, variationId: string): Promise<{
    businessId: string;
    subjectId: PriceEditApprovalPayload['subjectId'];
    squareItemId: string;
    variationId: string;
  } | null>;
}
export interface ApprovalPort {
  /** Persists a PENDING owner price_edit approval and approval.requested atomically. No provider writes. */
  createPriceEdit(input: {
    ownerUserId: string;
    actorType: PriceEditApprovalRequest['actorType'];
    bundleType: PriceEditApprovalRequest['bundleType'];
    payload: PriceEditApprovalPayload;
    payloadHash: PriceEditApprovalRequest['payloadHash'];
    createdAt: string;
  }): Promise<PriceEditApprovalRequest>;
}
export interface CatalogSyncPort {
  sync(businessId: string): Promise<void>;
}
export interface PricesDependencies {
  auth: OwnerAuthPort;
  catalog: CatalogLookupPort;
  square: Pick<PriceAdapter, 'readVariationPrice'>;
  approvals: ApprovalPort;
  now(): Date;
}
export interface PriceExecutionPorts {
  square: Pick<PriceAdapter, 'updateVariationPrice'>;
  catalogSync: CatalogSyncPort;
}
export type PriceStepResult =
  | { state: Extract<ExecutionStatus, 'SUCCEEDED'>; squareVersion: number }
  | { state: Extract<ExecutionStatus, 'FAILED' | 'NEEDS_REVIEW'>; code: ErrorCode; outcome?: PriceOutcome };
