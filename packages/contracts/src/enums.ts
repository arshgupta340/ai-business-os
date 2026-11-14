import { z } from 'zod';

// ---- Capability registry (SPEC 2.2, CONTRACTS 2) ----
export const EffectSchema = z.enum(['read', 'propose', 'write', 'external_message']);
export type Effect = z.infer<typeof EffectSchema>;

export const ApprovalModeSchema = z.enum(['none', 'creates_approval', 'required']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const TierSchema = z.enum(['MUST', 'SHOULD']);
export type Tier = z.infer<typeof TierSchema>;

export const CapabilityIdSchema = z.enum([
  'catalog.read',
  'business.facts.read',
  'order.quote',
  'order.propose',
  'order.status.read',
  'order.checkout.prepare',
  'message.checkout.send',
  'calendar.availability.read',
  'booking.propose',
  'calendar.event.create',
  'message.booking.confirm',
  'sheets.rows.append',
  'catalog.price.update',
]);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

// ---- Bundles and action types (SPEC 2.3) ----
export const BundleTypeSchema = z.enum(['order_bundle', 'booking_bundle', 'fact_edit', 'price_edit']);
export type BundleType = z.infer<typeof BundleTypeSchema>;

export const ActionTypeSchema = z.enum([
  'square.checkout.create',
  'message.checkout.send',
  'local.order.record',
  'sheets.order.append',
  'calendar.event.create',
  'message.booking.confirm',
  'local.booking.record',
  'sheets.booking.append',
  'local.fact.update',
  'square.catalog.price.update',
  'local.catalog.sync',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/** SPEC 2.9: the Sheets steps never get an `action_executions` row, so an execution's `actionType` is one of these. */
export const ExecutionActionTypeSchema = ActionTypeSchema.exclude(['sheets.order.append', 'sheets.booking.append']);
export type ExecutionActionType = z.infer<typeof ExecutionActionTypeSchema>;

// ---- Actors (SPEC 2.5) ----
export const ActorTypeSchema = z.enum(['owner', 'deployed_agent', 'system', 'provider']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

/** Who opened an approval: the deployed agent, or the owner for fact_edit and price_edit (P-09). */
export const ApprovalActorTypeSchema = z.enum(['deployed_agent', 'owner']);
export type ApprovalActorType = z.infer<typeof ApprovalActorTypeSchema>;

// ---- State lists (SPEC 2.4) ----
export const OrderStatusSchema = z.enum([
  'AWAITING_OWNER_APPROVAL',
  'APPROVED',
  'CREATING_CHECKOUT',
  'PAYMENT_LINK_READY',
  'MESSAGE_SENT',
  'PAYMENT_PENDING',
  'PAID_VERIFIED',
  'FULFILLMENT_READY',
  'REJECTED',
  'APPROVAL_EXPIRED',
  'UNAVAILABLE',
  'PAYMENT_FAILED',
  'CANCELLED',
  'RECOVERY_REQUIRED',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** SPEC 2.4 rulings: the conversation states of an order call, kept in `Call.stage`. */
export const OrderStageSchema = z.enum(['CALL_STARTED', 'COLLECTING', 'VALIDATING', 'UNAVAILABLE', 'CUSTOMER_CONFIRMED']);
export type OrderStage = z.infer<typeof OrderStageSchema>;

export const BookingStatusSchema = z.enum([
  'AWAITING_OWNER_APPROVAL',
  'RECHECKING_SLOT',
  'BOOKED_VERIFIED',
  'SLOT_CONFLICT',
  'REJECTED',
  'EXPIRED',
  'RETRY_REQUIRED',
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

/** The conversation states of a booking call, kept in `Call.stage`. */
export const BookingStageSchema = z.enum(['INQUIRY', 'SLOT_SEARCH', 'PROPOSAL', 'CUSTOMER_CONFIRMED']);
export type BookingStage = z.infer<typeof BookingStageSchema>;

/** CONTRACTS 3 `CallStage`: both stage lists, as stored in `calls.stage`. */
export const CallStageSchema = z.enum([
  'CALL_STARTED',
  'COLLECTING',
  'VALIDATING',
  'UNAVAILABLE',
  'CUSTOMER_CONFIRMED',
  'INQUIRY',
  'SLOT_SEARCH',
  'PROPOSAL',
]);
export type CallStage = z.infer<typeof CallStageSchema>;

/** Any order state, stage or status. Used by `order.status_changed` `from` and `to`. */
export const OrderMachineStateSchema = z.enum([
  'CALL_STARTED',
  'COLLECTING',
  'VALIDATING',
  'CUSTOMER_CONFIRMED',
  ...OrderStatusSchema.options,
]);
export type OrderMachineState = z.infer<typeof OrderMachineStateSchema>;

/** Any booking state, stage or status. Used by `booking.status_changed` `from` and `to`. */
export const BookingMachineStateSchema = z.enum([...BookingStageSchema.options, ...BookingStatusSchema.options]);
export type BookingMachineState = z.infer<typeof BookingMachineStateSchema>;

export const ApprovalStateSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ExecutionStatusSchema = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'NEEDS_REVIEW']);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const SyncJobStateSchema = z.enum(['PENDING', 'RUNNING', 'DONE', 'RETRYING', 'FAILED']);
export type SyncJobState = z.infer<typeof SyncJobStateSchema>;

export const AgentStatusSchema = z.enum(['draft', 'live', 'paused']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const CallStatusSchema = z.enum(['IN_PROGRESS', 'COMPLETED', 'DROPPED', 'FAILED']);
export type CallStatus = z.infer<typeof CallStatusSchema>;

export const CallEndReasonSchema = z.enum(['completed', 'dropped', 'failed']);
export type CallEndReason = z.infer<typeof CallEndReasonSchema>;

export const MessageDispatchStatusSchema = z.enum(['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNKNOWN']);
export type MessageDispatchStatus = z.infer<typeof MessageDispatchStatusSchema>;

export const FactStatusSchema = z.enum(['draft', 'verified', 'superseded']);
export type FactStatus = z.infer<typeof FactStatusSchema>;

export const FactConflictStateSchema = z.enum(['open', 'resolved']);
export type FactConflictState = z.infer<typeof FactConflictStateSchema>;

// ---- Channels ----
/** SPEC 2.9: `calls.channel`. */
export const CallChannelSchema = z.enum(['phone', 'test_console']);
export type CallChannel = z.infer<typeof CallChannelSchema>;

/** SPEC 2.9: `message_dispatches.channel`. `qr_only` never appears here. */
export const MessageChannelSchema = z.enum(['surge', 'android_gateway', 'whatsapp_sandbox']);
export type MessageChannel = z.infer<typeof MessageChannelSchema>;

/** SPEC 3.3: the server's `MESSAGE_CHANNEL` setting. The order and booking approval payloads carry this value. */
export const MessageChannelSettingSchema = z.enum(['surge', 'android_gateway', 'whatsapp_sandbox', 'qr_only']);
export type MessageChannelSetting = z.infer<typeof MessageChannelSettingSchema>;

export const MessageTemplateSchema = z.enum(['checkout_link', 'booking_confirmed']);
export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;

// ---- Facts (SPEC 2.9) ----
export const FactKindSchema = z.enum(['hours', 'policy', 'service', 'contact', 'faq', 'menu_item']);
export type FactKind = z.infer<typeof FactKindSchema>;

/** Kinds the agent may read. `menu_item` facts are upload drafts and never returned (CONTRACTS 2). */
export const ReadableFactKindSchema = FactKindSchema.exclude(['menu_item']);
export type ReadableFactKind = z.infer<typeof ReadableFactKindSchema>;

export const FactSourceTypeSchema = z.enum(['square', 'google_calendar', 'owner_chat', 'owner_ui', 'upload', 'seed']);
export type FactSourceType = z.infer<typeof FactSourceTypeSchema>;

/** SPEC 2.9: one `hours` fact per weekday. */
export const HoursKeySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type HoursKey = z.infer<typeof HoursKeySchema>;

// ---- Integrations (SPEC 2.9) ----
export const IntegrationProviderSchema = z.enum(['square', 'twilio', 'openai', 'google_calendar', 'google_sheets', 'message_channel']);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;

export const IntegrationStateSchema = z.enum(['connected', 'degraded', 'disconnected']);
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

// ---- Agents and builder ----
export const AgentTemplateSchema = z.enum(['restaurant_order_taker', 'appointment_booker', 'custom']);
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

export const KnowledgeScopeSchema = z.enum(['business_profile', 'catalog', 'hours', 'order_policies', 'services', 'faq']);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

export const BuilderSessionStatusSchema = z.enum(['active', 'completed', 'abandoned']);
export type BuilderSessionStatus = z.infer<typeof BuilderSessionStatusSchema>;

export const BuilderRoleSchema = z.enum(['owner', 'assistant']);
export type BuilderRole = z.infer<typeof BuilderRoleSchema>;

export const InputModeSchema = z.enum(['text', 'voice']);
export type InputMode = z.infer<typeof InputModeSchema>;

export const GuardrailRuleSchema = z.enum([
  'no_fact_changes',
  'no_secret_reveal',
  'no_approval_bypass',
  'no_cross_business',
  'unsupported_request',
]);
export type GuardrailRule = z.infer<typeof GuardrailRuleSchema>;

// ---- Files (P-12) ----
export const FileMimeSchema = z.enum([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
export type FileMime = z.infer<typeof FileMimeSchema>;

export const ExtractionStateSchema = z.enum(['PENDING', 'EXTRACTING', 'EXTRACTED', 'FAILED']);
export type ExtractionState = z.infer<typeof ExtractionStateSchema>;

// ---- Sync and webhooks ----
/** SPEC 2.9: Sheets is `google_sheets`; catalog sync events use `catalog` and are not `sync_jobs` rows. */
export const SyncTargetSchema = z.enum(['google_sheets', 'catalog']);
export type SyncTarget = z.infer<typeof SyncTargetSchema>;

export const SyncRecordTypeSchema = z.enum(['order', 'booking']);
export type SyncRecordType = z.infer<typeof SyncRecordTypeSchema>;

export const WebhookProviderSchema = z.enum(['square', 'twilio']);
export type WebhookProvider = z.infer<typeof WebhookProviderSchema>;

export const WebhookRejectReasonSchema = z.enum(['signature_invalid', 'malformed']);
export type WebhookRejectReason = z.infer<typeof WebhookRejectReasonSchema>;

// ---- Agent tools (SPEC 2.6) ----
export const ToolNameSchema = z.enum([
  'read_catalog',
  'read_business_facts',
  'quote_order',
  'propose_order',
  'get_order_status',
  'read_calendar_availability',
  'propose_booking',
]);
export type ToolName = z.infer<typeof ToolNameSchema>;
