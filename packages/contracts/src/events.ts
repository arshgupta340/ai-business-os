import { z } from 'zod';
import {
  ActionTypeSchema,
  ActorTypeSchema,
  BookingMachineStateSchema,
  BundleTypeSchema,
  CallChannelSchema,
  CallStatusSchema,
  ExecutionStatusSchema,
  FactKindSchema,
  FactSourceTypeSchema,
  FileMimeSchema,
  GuardrailRuleSchema,
  MessageChannelSchema,
  MessageTemplateSchema,
  OrderMachineStateSchema,
  SyncRecordTypeSchema,
  WebhookProviderSchema,
  WebhookRejectReasonSchema,
} from './enums';
import { ErrorCodeSchema } from './errors';
import {
  AgentIdSchema,
  AgentVersionIdSchema,
  ApprovalIdSchema,
  BookingIdSchema,
  BusinessIdSchema,
  CallIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  FactIdSchema,
  FileIdSchema,
  JobIdSchema,
  MessageDispatchIdSchema,
  OrderIdSchema,
  SyncJobIdSchema,
  UserIdSchema,
} from './ids';
import { CurrencySchema, IsoDateTimeSchema, Last4Schema, MinorAmountSchema, TimezoneSchema } from './primitives';

// CONTRACTS 7. Payloads are redacted: last four digits only, first names only, no card data, no checkout URLs.
export const ACTIVITY_EVENT_TYPES = [
  'call.started',
  'call.ended',
  'proposal.created',
  'approval.requested',
  'approval.decided',
  'approval.expired',
  'execution.started',
  'execution.succeeded',
  'execution.failed',
  'checkout.created',
  'message.sent',
  'message.failed',
  'payment.verified',
  'payment.failed',
  'booking.verified',
  'booking.slot_conflict',
  'order.status_changed',
  'booking.status_changed',
  'sync.queued',
  'sync.succeeded',
  'sync.failed',
  'fact.changed',
  'extraction.completed',
  'agent.published',
  'agent.paused',
  'live_agent.changed',
  'guardrail.refused',
  'webhook.rejected',
] as const;
export const ActivityEventTypeSchema = z.enum(ACTIVITY_EVENT_TYPES);
export type ActivityEventType = z.infer<typeof ActivityEventTypeSchema>;

// Sheets sync events carry syncJobId, recordType and recordId; catalog sync events carry jobId (CONTRACTS 7).
const sheetsSyncFields = {
  target: z.literal('google_sheets'),
  syncJobId: SyncJobIdSchema,
  recordType: SyncRecordTypeSchema,
  recordId: z.string().min(1),
};
const catalogSyncFields = { target: z.literal('catalog'), jobId: JobIdSchema };
const syncFailedFields = { attempts: z.int().min(0), final: z.boolean() };

export const ACTIVITY_EVENT_PAYLOADS = {
  'call.started': z.object({
    callId: CallIdSchema,
    agentId: AgentIdSchema,
    agentVersionId: AgentVersionIdSchema,
    channel: CallChannelSchema,
    callerLast4: Last4Schema.optional(),
  }),
  'call.ended': z.object({
    callId: CallIdSchema,
    status: CallStatusSchema,
    reason: z.enum(['completed', 'dropped', 'failed']),
    durationSec: z.number().min(0),
  }),
  'proposal.created': z.object({
    subjectId: z.string().min(1),
    subjectType: z.enum(['order', 'booking']),
    callId: CallIdSchema,
    totalMinor: MinorAmountSchema.optional(),
    currency: CurrencySchema.optional(),
    serviceName: z.string().optional(),
    startUtc: IsoDateTimeSchema.optional(),
  }),
  'approval.requested': z.object({
    approvalId: ApprovalIdSchema,
    bundleType: BundleTypeSchema,
    subjectId: z.string().min(1),
    actionBundle: z.array(ActionTypeSchema),
    expiresAt: IsoDateTimeSchema,
    totalMinor: MinorAmountSchema.optional(),
    recipientLast4: Last4Schema.optional(),
  }),
  'approval.decided': z.object({
    approvalId: ApprovalIdSchema,
    subjectId: z.string().min(1),
    decision: z.enum(['APPROVED', 'REJECTED']),
    decidedBy: UserIdSchema,
  }),
  'approval.expired': z.object({ approvalId: ApprovalIdSchema, subjectId: z.string().min(1) }),
  'execution.started': z.object({
    executionId: ExecutionIdSchema,
    approvalId: ApprovalIdSchema,
    actionType: ActionTypeSchema,
    stepIndex: z.int().min(0),
    attempt: z.int().min(1),
  }),
  'execution.succeeded': z.object({
    executionId: ExecutionIdSchema,
    actionType: ActionTypeSchema,
    externalRef: z.string().optional(),
  }),
  'execution.failed': z.object({
    executionId: ExecutionIdSchema,
    actionType: ActionTypeSchema,
    errorCode: ErrorCodeSchema,
    retryable: z.boolean(),
    nextStatus: ExecutionStatusSchema,
  }),
  'checkout.created': z.object({
    orderId: OrderIdSchema,
    squareOrderId: z.string().min(1),
    squarePaymentLinkId: z.string().min(1),
    totalMinor: MinorAmountSchema,
    currency: CurrencySchema,
    sandbox: z.literal(true),
  }),
  'message.sent': z.object({
    dispatchId: MessageDispatchIdSchema,
    subjectId: z.string().min(1),
    channel: MessageChannelSchema,
    template: MessageTemplateSchema,
    recipientLast4: Last4Schema,
  }),
  'message.failed': z.object({
    dispatchId: MessageDispatchIdSchema,
    subjectId: z.string().min(1),
    channel: MessageChannelSchema,
    status: z.enum(['FAILED', 'UNKNOWN']),
    errorCode: ErrorCodeSchema.optional(),
  }),
  'payment.verified': z.object({
    orderId: OrderIdSchema,
    squarePaymentId: z.string().min(1),
    amountMinor: MinorAmountSchema,
    currency: CurrencySchema,
    sandbox: z.literal(true),
  }),
  'payment.failed': z.object({
    orderId: OrderIdSchema,
    squarePaymentId: z.string().optional(),
    reason: z.string(),
    sandbox: z.literal(true),
  }),
  'booking.verified': z.object({
    bookingId: BookingIdSchema,
    googleEventId: z.string().min(1),
    serviceName: z.string(),
    startUtc: IsoDateTimeSchema,
    timezone: TimezoneSchema,
  }),
  'booking.slot_conflict': z.object({
    bookingId: BookingIdSchema,
    approvalId: ApprovalIdSchema,
    startUtc: IsoDateTimeSchema,
    alternatives: z.array(z.object({ startUtc: IsoDateTimeSchema, endUtc: IsoDateTimeSchema })).max(3),
  }),
  'order.status_changed': z.object({
    orderId: OrderIdSchema.optional(), // absent for stage changes before the proposal
    callId: CallIdSchema,
    from: OrderMachineStateSchema.optional(),
    to: OrderMachineStateSchema,
  }),
  'booking.status_changed': z.object({
    bookingId: BookingIdSchema.optional(),
    callId: CallIdSchema.optional(),
    from: BookingMachineStateSchema.optional(),
    to: BookingMachineStateSchema,
  }),
  'sync.queued': z.discriminatedUnion('target', [z.object(sheetsSyncFields), z.object(catalogSyncFields)]),
  'sync.succeeded': z.discriminatedUnion('target', [z.object(sheetsSyncFields), z.object(catalogSyncFields)]),
  'sync.failed': z.discriminatedUnion('target', [
    z.object({ ...sheetsSyncFields, ...syncFailedFields }),
    z.object({ ...catalogSyncFields, ...syncFailedFields }),
  ]),
  'fact.changed': z.object({
    factId: FactIdSchema,
    kind: FactKindSchema,
    key: z.string().min(1),
    fromVersion: z.int().min(0),
    toVersion: z.int().min(1),
    sourceType: FactSourceTypeSchema,
  }),
  'extraction.completed': z.object({
    fileId: FileIdSchema,
    mime: FileMimeSchema,
    extractionState: z.enum(['EXTRACTED', 'FAILED']),
    draftFactCount: z.int().min(0),
    conflictCount: z.int().min(0),
  }),
  'agent.published': z.object({
    agentId: AgentIdSchema,
    agentVersionId: AgentVersionIdSchema,
    version: z.int().min(1),
    phoneNumberLast4: Last4Schema.optional(),
    rolledBackFrom: AgentVersionIdSchema.optional(), // rollback only
  }),
  'agent.paused': z.object({ agentId: AgentIdSchema }),
  'live_agent.changed': z.object({
    phoneNumberLast4: Last4Schema,
    agentId: AgentIdSchema,
    agentVersionId: AgentVersionIdSchema,
    previousAgentId: AgentIdSchema.optional(),
  }),
  'guardrail.refused': z.object({
    callId: CallIdSchema,
    rule: GuardrailRuleSchema, // SPEC 2.9: the rule that fired
    toolName: z.string().optional(),
  }),
  // SPEC 2.9: nothing from the unverified request body is trusted, stored or copied.
  'webhook.rejected': z.object({ provider: WebhookProviderSchema, reason: WebhookRejectReasonSchema }),
} as const satisfies Record<ActivityEventType, z.ZodType>;

export type ActivityEventPayloads = { [T in ActivityEventType]: z.infer<(typeof ACTIVITY_EVENT_PAYLOADS)[T]> };

const envelope = {
  id: EventIdSchema,
  businessId: BusinessIdSchema,
  correlationId: z.string().min(1), // call_, bld_, file_ or apv_ id
  actorType: ActorTypeSchema,
  occurredAt: IsoDateTimeSchema,
};

function eventSchema<T extends ActivityEventType>(type: T) {
  return z.object({ ...envelope, type: z.literal(type), payload: ACTIVITY_EVENT_PAYLOADS[type] });
}

export const CallStartedEventSchema = eventSchema('call.started');
export const CallEndedEventSchema = eventSchema('call.ended');
export const ProposalCreatedEventSchema = eventSchema('proposal.created');
export const ApprovalRequestedEventSchema = eventSchema('approval.requested');
export const ApprovalDecidedEventSchema = eventSchema('approval.decided');
export const ApprovalExpiredEventSchema = eventSchema('approval.expired');
export const ExecutionStartedEventSchema = eventSchema('execution.started');
export const ExecutionSucceededEventSchema = eventSchema('execution.succeeded');
export const ExecutionFailedEventSchema = eventSchema('execution.failed');
export const CheckoutCreatedEventSchema = eventSchema('checkout.created');
export const MessageSentEventSchema = eventSchema('message.sent');
export const MessageFailedEventSchema = eventSchema('message.failed');
export const PaymentVerifiedEventSchema = eventSchema('payment.verified');
export const PaymentFailedEventSchema = eventSchema('payment.failed');
export const BookingVerifiedEventSchema = eventSchema('booking.verified');
export const BookingSlotConflictEventSchema = eventSchema('booking.slot_conflict');
export const OrderStatusChangedEventSchema = eventSchema('order.status_changed');
export const BookingStatusChangedEventSchema = eventSchema('booking.status_changed');
export const SyncQueuedEventSchema = eventSchema('sync.queued');
export const SyncSucceededEventSchema = eventSchema('sync.succeeded');
export const SyncFailedEventSchema = eventSchema('sync.failed');
export const FactChangedEventSchema = eventSchema('fact.changed');
export const ExtractionCompletedEventSchema = eventSchema('extraction.completed');
export const AgentPublishedEventSchema = eventSchema('agent.published');
export const AgentPausedEventSchema = eventSchema('agent.paused');
export const LiveAgentChangedEventSchema = eventSchema('live_agent.changed');
export const GuardrailRefusedEventSchema = eventSchema('guardrail.refused');
export const WebhookRejectedEventSchema = eventSchema('webhook.rejected');

/** Discriminated on `type`. */
export const ActivityEventSchema = z.discriminatedUnion('type', [
  CallStartedEventSchema,
  CallEndedEventSchema,
  ProposalCreatedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalDecidedEventSchema,
  ApprovalExpiredEventSchema,
  ExecutionStartedEventSchema,
  ExecutionSucceededEventSchema,
  ExecutionFailedEventSchema,
  CheckoutCreatedEventSchema,
  MessageSentEventSchema,
  MessageFailedEventSchema,
  PaymentVerifiedEventSchema,
  PaymentFailedEventSchema,
  BookingVerifiedEventSchema,
  BookingSlotConflictEventSchema,
  OrderStatusChangedEventSchema,
  BookingStatusChangedEventSchema,
  SyncQueuedEventSchema,
  SyncSucceededEventSchema,
  SyncFailedEventSchema,
  FactChangedEventSchema,
  ExtractionCompletedEventSchema,
  AgentPublishedEventSchema,
  AgentPausedEventSchema,
  LiveAgentChangedEventSchema,
  GuardrailRefusedEventSchema,
  WebhookRejectedEventSchema,
]);
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type ActivityEventOf<T extends ActivityEventType> = Extract<ActivityEvent, { type: T }>;

/** The raw `activity_events` row that Supabase Realtime delivers (snake_case columns). */
export const ActivityEventRowSchema = z.object({
  id: z.string(),
  business_id: z.string(),
  type: z.string(),
  agent_id: z.string().nullable().optional(),
  correlation_id: z.string(),
  actor_type: z.string(),
  occurred_at: z.string(),
  payload: z.unknown(),
});
export type ActivityEventRow = z.infer<typeof ActivityEventRowSchema>;

/**
 * Maps a Realtime row to a validated `ActivityEvent`. Postgres timestamps (`2026-11-14 19:00:00+00`)
 * are normalized to ISO UTC with `Z`. Throws a ZodError if the row does not match the contract.
 */
export function activityEventFromRow(row: unknown): ActivityEvent {
  const r = ActivityEventRowSchema.parse(row);
  const occurred = new Date(r.occurred_at.replace(' ', 'T').replace(/\+00$/, '+00:00'));
  return ActivityEventSchema.parse({
    id: r.id,
    businessId: r.business_id,
    type: r.type,
    correlationId: r.correlation_id,
    actorType: r.actor_type,
    occurredAt: Number.isNaN(occurred.getTime()) ? r.occurred_at : occurred.toISOString(),
    payload: r.payload,
  });
}
