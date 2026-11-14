import type { ApprovalDecision, Order, Booking, BusinessFact, MessageChannelSetting, ErrorCode } from '@abos/contracts';

export interface QueryInterface {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
export interface PolicyDb extends QueryInterface {
  transaction<T>(fn: (tx: QueryInterface) => Promise<T>): Promise<T>;
}
export interface PolicyDeps {
  now(): Date;
  newId(prefix: string): string;
}
export type OrderProposalInput = Pick<Order, 'businessId' | 'callId' | 'cart' | 'quote' | 'contact' | 'fulfillment'> & {
  agentVersionId: string;
  messageChannel: MessageChannelSetting;
};
export type BookingProposalInput = Pick<Booking, 'businessId' | 'callId' | 'serviceId' | 'serviceName' | 'startUtc' | 'endUtc' | 'timezone' | 'calendarId' | 'customer'> & {
  agentVersionId: string;
  messageChannel: MessageChannelSetting;
};
export type FactEditInput = Pick<BusinessFact, 'businessId' | 'kind' | 'key' | 'value'> & {
  ownerUserId: string;
  reason?: string;
  resolvesConflictId?: string;
};
export type DecisionInput = ApprovalDecision & { approvalId: string; businessId: string; ownerUserId: string };
export class PolicyError extends Error {
  constructor(readonly code: ErrorCode, message: string = code) {
    super(message);
    this.name = 'PolicyError';
  }
}
