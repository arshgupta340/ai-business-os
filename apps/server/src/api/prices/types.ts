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
    /** Catalog cache names for display on the approval (issue #108). Never part of the payload. */
    itemName?: string;
    variationName?: string;
  } | null>;
}
export interface ApprovalPort {
  /** Calls the checked database routine that atomically creates or returns a PENDING price_edit approval. */
  createPendingPriceEditApproval(input: {
    ownerUserId: string;
    actorType: PriceEditApprovalRequest['actorType'];
    bundleType: PriceEditApprovalRequest['bundleType'];
    payload: PriceEditApprovalPayload;
    payloadHash: PriceEditApprovalRequest['payloadHash'];
    createdAt: string;
  }): Promise<{ kind: 'created' | 'existing'; approval: PriceEditApprovalRequest } | { kind: 'conflict' }>;
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
  /** The executor persists this result through its checked lease/result routine, never direct DML. */
  square: Pick<PriceAdapter, 'updateVariationPrice'>;
}
export interface PriceReconciliationPorts { square: Pick<PriceAdapter, 'readVariationPrice'> }
export type PriceStepResult =
  | { state: Extract<ExecutionStatus, 'SUCCEEDED'>; squareVersion: number }
  | { state: Extract<ExecutionStatus, 'QUEUED' | 'FAILED' | 'NEEDS_REVIEW'>; code: ErrorCode; outcome?: PriceOutcome };
