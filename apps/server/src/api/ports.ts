import { randomUUID } from 'node:crypto';
import type { ApprovalRequest, ActionExecution, FactEditApprovalRequest, FactKind, JsonValue } from '@abos/contracts';
import { AppError } from '../errors';

export interface DecideInput {
  approvalId: string;
  businessId: string;
  ownerUserId: string;
  decision: 'approve' | 'reject';
  payloadHash: string;
  reason?: string;
}
export interface ProposeFactEditInput {
  businessId: string;
  ownerUserId: string;
  kind: FactKind;
  key: string;
  value: JsonValue;
  reason?: string;
  resolvesConflictId?: string;
}
export interface EnginePorts {
  decide(input: DecideInput): Promise<{ approval: ApprovalRequest; executions: ActionExecution[] }>;
  proposeFactEdit(input: ProposeFactEditInput): Promise<{ approval: FactEditApprovalRequest }>;
}
export interface CatalogPort {
  sync(input: { businessId: string; ownerUserId: string }): Promise<{ jobId: string }>;
}
export const unavailableEngine: EnginePorts = {
  async decide() { throw new AppError('INTEGRATION_UNAVAILABLE', 'Approval engine is not configured.'); },
  async proposeFactEdit() { throw new AppError('INTEGRATION_UNAVAILABLE', 'Approval engine is not configured.'); },
};
export const unavailableCatalog: CatalogPort = {
  async sync() { throw new AppError('INTEGRATION_UNAVAILABLE', 'Square catalog sync is not configured.'); },
};

/** Test fake only. It has no provider clients and never performs an external write. */
export function createInMemoryEngine(initial: ApprovalRequest[] = []): EnginePorts & { approvals: Map<string, ApprovalRequest> } {
  const approvals = new Map(initial.map((a) => [a.id, structuredClone(a)]));
  return {
    approvals,
    async decide(input) {
      const approval = approvals.get(input.approvalId);
      if (!approval || approval.businessId !== input.businessId) throw new AppError('NOT_FOUND', 'Approval was not found.');
      if (approval.payloadHash !== input.payloadHash) throw new AppError('PAYLOAD_HASH_MISMATCH', 'Approval payload changed.');
      const state = input.decision === 'approve' ? 'APPROVED' : 'REJECTED';
      if (approval.state === state) return { approval: structuredClone(approval), executions: [] };
      if (approval.state !== 'PENDING') throw new AppError('APPROVAL_ALREADY_DECIDED', 'Approval was already decided.');
      if (Date.parse(approval.expiresAt) <= Date.now()) throw new AppError('APPROVAL_EXPIRED', 'Approval expired.');
      const decided: ApprovalRequest = { ...approval, state, decidedBy: input.ownerUserId, decidedAt: new Date().toISOString() };
      approvals.set(decided.id, decided);
      return { approval: structuredClone(decided), executions: [] };
    },
    async proposeFactEdit(input) {
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.parse(now) + 600_000).toISOString();
      const subjectId = `fact_${randomUUID().replaceAll('-', '')}`;
      const approval: FactEditApprovalRequest = {
        id: `apv_${randomUUID().replaceAll('-', '')}`, businessId: input.businessId, actorType: 'owner', bundleType: 'fact_edit',
        actionBundle: ['local.fact.update'], subjectId,
        payload: { businessId: input.businessId, subjectId, kind: input.kind, key: input.key,
          fromVersion: 1, before: null, after: input.value, actionBundle: ['local.fact.update'], expiresAt },
        payloadHash: `sha256:${'a'.repeat(64)}`, state: 'PENDING', expiresAt, createdAt: now,
      };
      approvals.set(approval.id, approval);
      return { approval };
    },
  };
}
