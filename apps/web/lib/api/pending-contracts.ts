/**
 * TEMPORARY. This file is a hand transcription of docs/CONTRACTS.md as it is on
 * origin/main after the contract freeze (commit 22d9672, "Accept the
 * contract-freeze requests from the UI review"), plus the new shapes in
 * docs/API.md section 3.12.
 *
 * It exists only because packages/contracts (task S-02) has not merged yet.
 * Once S-02 merges, delete this file and replace every import of
 * "@/lib/api/pending-contracts" with an import from the contracts package.
 *
 * Naming rule, so the swap is a find and replace:
 * - Every TypeScript type has exactly the name used in docs/CONTRACTS.md.
 * - Every Zod schema is that name plus the suffix "Schema".
 *
 * Where docs/CONTRACTS.md and docs/API.md disagree on a field name, this file
 * follows CONTRACTS.md (SPEC 2.9 tie-breaker). Where a SPEC 2.9 ruling
 * overrides CONTRACTS.md directly, the field is marked "SPEC 2.9" below.
 */
import { z } from "zod";

// ---------------------------------------------------------------- 1. Errors

export const ErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN_BUSINESS",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "INVALID_STATE",
  "CONFLICT_UNRESOLVED",
  "APPROVAL_EXPIRED",
  "APPROVAL_ALREADY_DECIDED",
  "PAYLOAD_HASH_MISMATCH",
  "CAPABILITY_NOT_ALLOWED",
  "INTEGRATION_UNAVAILABLE",
  "ENVIRONMENT_MISMATCH",
  "SIGNATURE_INVALID",
  "RATE_LIMITED",
  "INTERNAL",
  "QUOTE_EXPIRED",
  "ITEM_UNAVAILABLE",
  "SLOT_CONFLICT",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  correlationId: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------- 2. Capability registry

export const CapabilityIdSchema = z.enum([
  "catalog.read",
  "business.facts.read",
  "order.quote",
  "order.propose",
  "order.status.read",
  "order.checkout.prepare",
  "message.checkout.send",
  "calendar.availability.read",
  "booking.propose",
  "calendar.event.create",
  "message.booking.confirm",
  "sheets.rows.append",
  "catalog.price.update",
]);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const CapabilityEffectSchema = z.enum(["read", "propose", "write", "external_message"]);
export type CapabilityEffect = z.infer<typeof CapabilityEffectSchema>;

/**
 * The display part of the server-owned registry (CONTRACTS.md section 2,
 * descriptions from SPEC 2.2). inputSchema, outputSchema and handlerId are
 * server concerns and are left out here.
 */
export const CAPABILITY_REGISTRY: Record<
  CapabilityId,
  {
    id: CapabilityId;
    description: string;
    effect: CapabilityEffect;
    approvalMode: "none" | "creates_approval" | "required";
    tier: "MUST" | "SHOULD";
  }
> = {
  "catalog.read": { id: "catalog.read", description: "Search the cached catalog for items, variations and modifiers", effect: "read", approvalMode: "none", tier: "MUST" },
  "business.facts.read": { id: "business.facts.read", description: "Read verified hours, policies and services", effect: "read", approvalMode: "none", tier: "MUST" },
  "order.quote": { id: "order.quote", description: "Authoritative totals and tax from Square CalculateOrder", effect: "read", approvalMode: "none", tier: "MUST" },
  "order.propose": { id: "order.propose", description: "Store an immutable order proposal and open an approval request", effect: "propose", approvalMode: "creates_approval", tier: "MUST" },
  "order.status.read": { id: "order.status.read", description: "Read the verified status of an order", effect: "read", approvalMode: "none", tier: "MUST" },
  "order.checkout.prepare": { id: "order.checkout.prepare", description: "Create the Square payment link (which creates the Square order)", effect: "write", approvalMode: "required", tier: "MUST" },
  "message.checkout.send": { id: "message.checkout.send", description: "Send the checkout link to the confirmed recipient", effect: "external_message", approvalMode: "required", tier: "MUST" },
  "calendar.availability.read": { id: "calendar.availability.read", description: "Free slots from Google Calendar free/busy", effect: "read", approvalMode: "none", tier: "MUST" },
  "booking.propose": { id: "booking.propose", description: "Store a booking proposal and open an approval request", effect: "propose", approvalMode: "creates_approval", tier: "MUST" },
  "calendar.event.create": { id: "calendar.event.create", description: "Create one Calendar event after a fresh availability check", effect: "write", approvalMode: "required", tier: "MUST" },
  "message.booking.confirm": { id: "message.booking.confirm", description: "Tell the customer the booking is confirmed", effect: "external_message", approvalMode: "required", tier: "MUST" },
  "sheets.rows.append": { id: "sheets.rows.append", description: "Append one reporting row, deduplicated", effect: "write", approvalMode: "required", tier: "MUST" },
  "catalog.price.update": { id: "catalog.price.update", description: "Change a price in Square", effect: "write", approvalMode: "required", tier: "SHOULD" },
};

export const BundleTypeSchema = z.enum(["order_bundle", "booking_bundle", "fact_edit", "price_edit"]);
export type BundleType = z.infer<typeof BundleTypeSchema>;

export const ActionTypeSchema = z.enum([
  "square.checkout.create",
  "message.checkout.send",
  "local.order.record",
  "sheets.order.append",
  "calendar.event.create",
  "message.booking.confirm",
  "local.booking.record",
  "sheets.booking.append",
  "local.fact.update",
  "square.catalog.price.update",
  "local.catalog.sync",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const BUNDLE_ACTIONS: Record<BundleType, ActionType[]> = {
  order_bundle: ["square.checkout.create", "message.checkout.send", "local.order.record", "sheets.order.append"],
  booking_bundle: ["calendar.event.create", "message.booking.confirm", "local.booking.record", "sheets.booking.append"],
  fact_edit: ["local.fact.update"],
  price_edit: ["square.catalog.price.update", "local.catalog.sync"],
};

export const ACTION_CAPABILITY: Record<ActionType, CapabilityId | undefined> = {
  "square.checkout.create": "order.checkout.prepare",
  "message.checkout.send": "message.checkout.send",
  "calendar.event.create": "calendar.event.create",
  "message.booking.confirm": "message.booking.confirm",
  "sheets.order.append": "sheets.rows.append",
  "sheets.booking.append": "sheets.rows.append",
  "square.catalog.price.update": "catalog.price.update",
  "local.order.record": undefined,
  "local.booking.record": undefined,
  "local.fact.update": undefined,
  "local.catalog.sync": undefined,
};

// ----------------------------------------------------------- 3. Core schemas

const isoUtc = z.string();
const usd = z.literal("USD");

export const AgentStatusSchema = z.enum(["draft", "live", "paused"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSpecSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  version: z.number().int(),
  template: z.enum(["restaurant_order_taker", "appointment_booker", "custom"]),
  name: z.string(),
  channel: z.literal("phone"),
  goal: z.string(),
  knowledgeScopes: z.array(z.enum(["business_profile", "catalog", "hours", "order_policies", "services", "faq"])),
  capabilities: z.array(CapabilityIdSchema),
  writePolicy: z.literal("owner_approval_each_action_bundle"),
  escalation: z.literal("explain_unsupported_or_offer_callback"),
  status: AgentStatusSchema,
  guardrailVersion: z.literal("v1"),
  greeting: z.string().optional(),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** menu_item: upload drafts only, never a price source. */
export const FactKindSchema = z.enum(["hours", "policy", "service", "contact", "faq", "menu_item"]);
export type FactKind = z.infer<typeof FactKindSchema>;

export const FactSourceTypeSchema = z.enum(["square", "google_calendar", "owner_chat", "owner_ui", "upload", "seed"]);

export const BusinessFactSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  kind: FactKindSchema,
  /** hours: "mon".."sun"; policy: "pickup_window"; service: the svc_ id. */
  key: z.string(),
  value: z.unknown(),
  sourceType: FactSourceTypeSchema,
  sourceRef: z.string().optional(),
  fileId: z.string().optional(),
  status: z.enum(["draft", "verified", "superseded"]),
  confidence: z.number().min(0).max(1),
  version: z.number().int(),
  supersedesId: z.string().optional(),
  verifiedAt: isoUtc.optional(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type BusinessFact = z.infer<typeof BusinessFactSchema>;

export const FactConflictSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  kind: FactKindSchema,
  key: z.string(),
  required: z.boolean(),
  candidates: z.array(
    z.object({
      factId: z.string().optional(),
      sourceType: FactSourceTypeSchema,
      sourceRef: z.string().optional(),
      value: z.unknown(),
    }),
  ),
  state: z.enum(["open", "resolved"]),
  resolvedFactId: z.string().optional(),
  resolvedBy: z.string().optional(),
  resolvedAt: isoUtc.optional(),
  createdAt: isoUtc,
});
export type FactConflict = z.infer<typeof FactConflictSchema>;

export const FileMimeSchema = z.enum([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const FileRecordSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  /** The original file name. */
  name: z.string(),
  mime: FileMimeSchema,
  sizeBytes: z.number().int(),
  sha256: z.string(),
  extractionState: z.enum(["PENDING", "EXTRACTING", "EXTRACTED", "FAILED"]),
  draftFactIds: z.array(z.string()).optional(),
  conflictIds: z.array(z.string()).optional(),
  createdAt: isoUtc,
});
export type FileRecord = z.infer<typeof FileRecordSchema>;

/** Grouped by squareItemId; catalog_items has one cat_ row per variation, which the API does not expose. */
export const CatalogItemSchema = z.object({
  squareItemId: z.string(),
  businessId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  available: z.boolean(),
  variations: z.array(z.object({ id: z.string(), name: z.string(), priceMinor: z.number().int(), currency: usd })),
  modifierLists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      selectionType: z.enum(["SINGLE", "MULTIPLE"]),
      modifiers: z.array(z.object({ id: z.string(), name: z.string(), priceMinor: z.number().int() })),
    }),
  ),
  syncedAt: isoUtc,
});
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const CartSchema = z.object({
  lines: z.array(
    z.object({
      catalogItemId: z.string(),
      variationId: z.string(),
      quantity: z.number().int().min(1).max(20),
      modifierIds: z.array(z.string()),
      note: z.string().max(140).optional(),
    }),
  ),
});
export type Cart = z.infer<typeof CartSchema>;

export const QuoteSchema = z.object({
  quoteId: z.string(),
  cartHash: z.string(),
  subtotalMinor: z.number().int(),
  taxMinor: z.number().int(),
  totalMinor: z.number().int(),
  currency: usd,
  lines: z.array(
    z.object({
      variationId: z.string(),
      name: z.string(),
      quantity: z.number().int(),
      unitPriceMinor: z.number().int(),
      modifiers: z.array(z.object({ modifierId: z.string(), name: z.string(), priceMinor: z.number().int() })),
      lineTotalMinor: z.number().int(),
    }),
  ),
  quotedAt: isoUtc,
  expiresAt: isoUtc,
});
export type Quote = z.infer<typeof QuoteSchema>;

export const ContactSchema = z.object({
  name: z.string(),
  messageRecipient: z.string(),
  messageConsent: z.boolean(),
  consentAt: isoUtc,
});
export type Contact = z.infer<typeof ContactSchema>;

export const FulfillmentSchema = z.object({ type: z.literal("pickup"), pickupAt: isoUtc });
export type Fulfillment = z.infer<typeof FulfillmentSchema>;

export const OrderStatusSchema = z.enum([
  "AWAITING_OWNER_APPROVAL",
  "APPROVED",
  "CREATING_CHECKOUT",
  "PAYMENT_LINK_READY",
  "MESSAGE_SENT",
  "PAYMENT_PENDING",
  "PAID_VERIFIED",
  "FULFILLMENT_READY",
  "REJECTED",
  "APPROVAL_EXPIRED",
  "UNAVAILABLE",
  "PAYMENT_FAILED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  callId: z.string(),
  status: OrderStatusSchema,
  cart: CartSchema,
  cartHash: z.string(),
  quote: QuoteSchema,
  totalMinor: z.number().int(),
  currency: usd,
  contact: ContactSchema,
  fulfillment: FulfillmentSchema,
  approvalId: z.string().optional(),
  squareOrderId: z.string().optional(),
  squarePaymentLinkId: z.string().optional(),
  checkoutUrl: z.string().optional(),
  squarePaymentId: z.string().optional(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type Order = z.infer<typeof OrderSchema>;

export const BookingStatusSchema = z.enum([
  "AWAITING_OWNER_APPROVAL",
  "RECHECKING_SLOT",
  "BOOKED_VERIFIED",
  "SLOT_CONFLICT",
  "REJECTED",
  "EXPIRED",
  "RETRY_REQUIRED",
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const BookingCustomerSchema = z.object({
  name: z.string(),
  messageRecipient: z.string(),
  messageConsent: z.boolean(),
});
export type BookingCustomer = z.infer<typeof BookingCustomerSchema>;

export const BookingSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  callId: z.string().optional(),
  status: BookingStatusSchema,
  serviceId: z.string(),
  serviceName: z.string(),
  startUtc: isoUtc,
  endUtc: isoUtc,
  timezone: z.string(),
  calendarId: z.string(),
  customer: BookingCustomerSchema,
  approvalId: z.string().optional(),
  googleEventId: z.string().optional(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type Booking = z.infer<typeof BookingSchema>;

export const ServiceOfferingSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  name: z.string(),
  durationMinutes: z.number().int(),
  priceMinor: z.number().int(),
  currency: usd,
  bufferMinutes: z.number().int().optional(),
});
export type ServiceOffering = z.infer<typeof ServiceOfferingSchema>;

export const AvailabilitySlotSchema = z.object({
  serviceId: z.string(),
  startUtc: isoUtc,
  endUtc: isoUtc,
  timezone: z.string(),
});
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;

// ------------------------------------------------------ 4. Approval payloads

export const OrderApprovalPayloadSchema = z.object({
  businessId: z.string(),
  subjectId: z.string(),
  agentVersionId: z.string(),
  cartHash: z.string(),
  totalMinor: z.number().int(),
  currency: usd,
  pickupAt: isoUtc,
  messageRecipient: z.string(),
  messageChannel: z.string(),
  actionBundle: z.array(z.string()),
  expiresAt: isoUtc,
});
export type OrderApprovalPayload = z.infer<typeof OrderApprovalPayloadSchema>;

export const BookingApprovalPayloadSchema = z.object({
  businessId: z.string(),
  subjectId: z.string(),
  agentVersionId: z.string(),
  serviceId: z.string(),
  calendarId: z.string(),
  startUtc: isoUtc,
  endUtc: isoUtc,
  timezone: z.string(),
  messageRecipient: z.string(),
  messageChannel: z.string(),
  actionBundle: z.array(z.string()),
  expiresAt: isoUtc,
});
export type BookingApprovalPayload = z.infer<typeof BookingApprovalPayloadSchema>;

export const FactEditApprovalPayloadSchema = z.object({
  businessId: z.string(),
  subjectId: z.string(),
  kind: FactKindSchema,
  key: z.string(),
  fromVersion: z.number().int(),
  /** null when the fact is new. */
  before: z.unknown(),
  after: z.unknown(),
  actionBundle: z.array(z.string()),
  expiresAt: isoUtc,
});
export type FactEditApprovalPayload = z.infer<typeof FactEditApprovalPayloadSchema>;

export const PriceEditApprovalPayloadSchema = z.object({
  businessId: z.string(),
  subjectId: z.string(),
  squareItemId: z.string(),
  variationId: z.string(),
  fromPriceMinor: z.number().int(),
  newPriceMinor: z.number().int(),
  currency: usd,
  squareVersion: z.number().int(),
  actionBundle: z.array(z.string()),
  expiresAt: isoUtc,
});
export type PriceEditApprovalPayload = z.infer<typeof PriceEditApprovalPayloadSchema>;

export const ApprovalStateSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  actorType: z.enum(["deployed_agent", "owner"]),
  bundleType: BundleTypeSchema,
  actionBundle: z.array(z.string()),
  subjectId: z.string(),
  payload: z.union([
    OrderApprovalPayloadSchema,
    BookingApprovalPayloadSchema,
    PriceEditApprovalPayloadSchema,
    FactEditApprovalPayloadSchema,
  ]),
  payloadHash: z.string(),
  state: ApprovalStateSchema,
  expiresAt: isoUtc,
  decidedBy: z.string().optional(),
  decidedAt: isoUtc.optional(),
  createdAt: isoUtc,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  payloadHash: z.string(),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ActionExecutionSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  approvalId: z.string(),
  actionType: z.string(),
  stepIndex: z.number().int(),
  capabilityId: CapabilityIdSchema.optional(),
  idempotencyKey: z.string(),
  /** SKIPPED: message step under qr_only. */
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "SKIPPED", "FAILED", "NEEDS_REVIEW"]),
  attempts: z.number().int(),
  externalRef: z.string().optional(),
  errorCode: ErrorCodeSchema.optional(),
  lastError: z.string().optional(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type ActionExecution = z.infer<typeof ActionExecutionSchema>;

export const MessageDispatchStatusSchema = z.enum(["QUEUED", "SENT", "DELIVERED", "FAILED", "UNKNOWN"]);
export type MessageDispatchStatus = z.infer<typeof MessageDispatchStatusSchema>;

export const MessageDispatchSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  executionId: z.string(),
  subjectId: z.string(),
  channel: z.enum(["surge", "android_gateway", "whatsapp_sandbox"]),
  recipient: z.string(),
  template: z.enum(["checkout_link", "booking_confirmed"]),
  status: MessageDispatchStatusSchema,
  providerMessageId: z.string().optional(),
  idempotencyKey: z.string(),
  errorCode: ErrorCodeSchema.optional(),
  sentAt: isoUtc.optional(),
  deliveredAt: isoUtc.optional(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type MessageDispatch = z.infer<typeof MessageDispatchSchema>;

export const CallStageSchema = z.enum([
  "CALL_STARTED",
  "COLLECTING",
  "VALIDATING",
  "UNAVAILABLE",
  "CUSTOMER_CONFIRMED",
  "INQUIRY",
  "SLOT_SEARCH",
  "PROPOSAL",
]);
export type CallStage = z.infer<typeof CallStageSchema>;

export const CallSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  agentId: z.string(),
  agentVersionId: z.string(),
  channel: z.enum(["phone", "test_console"]),
  /** Stays CUSTOMER_CONFIRMED once the proposal row exists. */
  stage: CallStageSchema,
  providerCallId: z.string().optional(),
  callerLast4: z.string().optional(),
  status: z.enum(["IN_PROGRESS", "COMPLETED", "DROPPED", "FAILED"]),
  endReason: z.enum(["completed", "dropped", "failed"]).optional(),
  startedAt: isoUtc,
  endedAt: isoUtc.optional(),
});
export type Call = z.infer<typeof CallSchema>;

export const BuilderMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["owner", "assistant"]),
  inputMode: z.enum(["text", "voice"]),
  text: z.string(),
  specPatch: AgentSpecSchema.partial().optional(),
  evidenceRefs: z.array(z.string()).optional(),
  createdAt: isoUtc,
});
export type BuilderMessage = z.infer<typeof BuilderMessageSchema>;

export const BuilderSessionSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  status: z.enum(["active", "completed", "abandoned"]),
  messages: z.array(BuilderMessageSchema),
  draftSpec: AgentSpecSchema.partial(),
  missingFields: z.array(z.string()),
  agentId: z.string().optional(),
  createdAt: isoUtc,
  updatedAt: isoUtc,
});
export type BuilderSession = z.infer<typeof BuilderSessionSchema>;


export const RealtimeClientSecretSchema = z.object({
  clientSecret: z.string(),
  expiresAt: isoUtc,
  model: z.literal("gpt-realtime-2.1"),
  builderSessionId: z.string(),
});
export type RealtimeClientSecret = z.infer<typeof RealtimeClientSecretSchema>;

export const IntegrationProviderSchema = z.enum([
  "square",
  "twilio",
  "openai",
  "google_calendar",
  "google_sheets",
  "message_channel",
]);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;

export const IntegrationHealthEntrySchema = z.object({
  state: z.enum(["connected", "degraded", "disconnected"]),
  lastCheckedAt: isoUtc,
  environment: z.literal("sandbox").optional(),
  channel: z.enum(["surge", "android_gateway", "whatsapp_sandbox", "qr_only"]).optional(),
  detail: z.string().optional(),
});
export type IntegrationHealthEntry = z.infer<typeof IntegrationHealthEntrySchema>;

export const IntegrationHealthSchema = z.object({
  square: IntegrationHealthEntrySchema,
  twilio: IntegrationHealthEntrySchema,
  openai: IntegrationHealthEntrySchema,
  google_calendar: IntegrationHealthEntrySchema,
  google_sheets: IntegrationHealthEntrySchema,
  message_channel: IntegrationHealthEntrySchema,
});
export type IntegrationHealth = z.infer<typeof IntegrationHealthSchema>;

/**
 * SPEC 2.9 ("Live agent, empty case") and API.md 3.12: agentId and
 * agentVersionId are absent when no agent answers the number. CONTRACTS.md
 * section 3 still shows them as required.
 */
export const LiveAgentSchema = z.object({
  phoneNumber: z.string(),
  businessId: z.string(),
  agentId: z.string().optional(),
  agentVersionId: z.string().optional(),
  updatedAt: isoUtc,
});
export type LiveAgent = z.infer<typeof LiveAgentSchema>;

// ------------------------------------------------- Agent run modes (P-18)

export const ToolNameSchema = z.enum([
  "read_catalog",
  "read_business_facts",
  "quote_order",
  "propose_order",
  "get_order_status",
  "read_calendar_availability",
  "propose_booking",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const GuardrailRuleSchema = z.enum([
  "no_fact_changes",
  "no_secret_reveal",
  "no_approval_bypass",
  "no_cross_business",
  "unsupported_request",
]);
export type GuardrailRule = z.infer<typeof GuardrailRuleSchema>;

export const AgentRunRequestSchema = z.object({
  testSessionId: z.string().optional(),
  callId: z.string().optional(),
  message: z.string(),
  end: z.boolean().optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const ToolTraceEntrySchema = z.object({
  tool: ToolNameSchema,
  capabilityId: CapabilityIdSchema,
  effect: z.enum(["read", "propose"]),
  input: z.unknown(),
  output: z.unknown(),
  mocked: z.boolean(),
  durationMs: z.number(),
});

export const AgentRunResponseSchema = z.object({
  testSessionId: z.string().optional(),
  callId: z.string().optional(),
  reply: z.string(),
  toolTrace: z.array(ToolTraceEntrySchema),
  guardrail: z.object({ refused: z.literal(true), rule: GuardrailRuleSchema }).optional(),
});
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;

// --------------------------------------------------------- 7. Activity events

export const ActivityEventTypeSchema = z.enum([
  "call.started",
  "call.ended",
  "proposal.created",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "execution.started",
  "execution.succeeded",
  "execution.failed",
  "checkout.created",
  "message.sent",
  "message.failed",
  "payment.verified",
  "payment.failed",
  "booking.verified",
  "booking.slot_conflict",
  "order.status_changed",
  "booking.status_changed",
  "sync.queued",
  "sync.succeeded",
  "sync.failed",
  "fact.changed",
  "extraction.completed",
  "agent.published",
  "agent.paused",
  "live_agent.changed",
  "guardrail.refused",
  "webhook.rejected",
]);
export type ActivityEventType = z.infer<typeof ActivityEventTypeSchema>;

export const ActorTypeSchema = z.enum(["owner", "deployed_agent", "system", "provider"]);

export const ActivityEventSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  type: ActivityEventTypeSchema,
  correlationId: z.string(),
  actorType: ActorTypeSchema,
  occurredAt: isoUtc,
  payload: z.record(z.string(), z.unknown()),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

interface SyncEventFields {
  target: "google_sheets" | "catalog";
  syncJobId?: string;
  recordType?: "order" | "booking";
  recordId?: string;
  jobId?: string;
}

/**
 * Payload fields per event type, from CONTRACTS.md section 7. These are
 * TypeScript helpers only. The wire schema above keeps payload as a record
 * so a new optional field never breaks parsing.
 */
export interface ActivityPayloads {
  "call.started": { callId: string; agentId: string; agentVersionId: string; channel: "phone" | "test_console"; callerLast4?: string };
  "call.ended": { callId: string; status: Call["status"]; reason: "completed" | "dropped" | "failed"; durationSec: number };
  "proposal.created": { subjectId: string; subjectType: "order" | "booking"; callId: string; totalMinor?: number; currency?: "USD"; serviceName?: string; startUtc?: string };
  "approval.requested": { approvalId: string; bundleType: BundleType; subjectId: string; actionBundle: string[]; expiresAt: string; totalMinor?: number; recipientLast4?: string };
  "approval.decided": { approvalId: string; subjectId: string; decision: "APPROVED" | "REJECTED"; decidedBy: string };
  "approval.expired": { approvalId: string; subjectId: string };
  "execution.started": { executionId: string; approvalId: string; actionType: string; stepIndex: number; attempt: number };
  "execution.succeeded": { executionId: string; actionType: string; externalRef?: string };
  "execution.failed": { executionId: string; actionType: string; errorCode: ErrorCode; retryable: boolean; nextStatus: string };
  "checkout.created": { orderId: string; squareOrderId: string; squarePaymentLinkId: string; totalMinor: number; currency: "USD"; sandbox: true };
  "message.sent": { dispatchId: string; subjectId: string; channel: string; template: string; recipientLast4: string };
  "message.failed": { dispatchId: string; subjectId: string; channel: string; status: "FAILED" | "UNKNOWN"; errorCode?: ErrorCode };
  "payment.verified": { orderId: string; squarePaymentId: string; amountMinor: number; currency: "USD"; sandbox: true };
  "payment.failed": { orderId: string; squarePaymentId?: string; reason: string; sandbox: true };
  "booking.verified": { bookingId: string; googleEventId: string; serviceName: string; startUtc: string; timezone: string };
  "booking.slot_conflict": { bookingId: string; approvalId: string; startUtc: string; alternatives: { startUtc: string; endUtc: string }[] };
  "order.status_changed": { orderId?: string; callId: string; from?: string; to: string };
  "booking.status_changed": { bookingId?: string; callId?: string; from?: string; to: string };
  /** Sheets events carry syncJobId, recordType and recordId; catalog sync events carry jobId. */
  "sync.queued": SyncEventFields;
  "sync.succeeded": SyncEventFields;
  "sync.failed": SyncEventFields & { attempts: number; final: boolean };
  "fact.changed": { factId: string; kind: FactKind; key: string; fromVersion: number; toVersion: number; sourceType: string };
  "extraction.completed": { fileId: string; mime: string; extractionState: "EXTRACTED" | "FAILED"; draftFactCount: number; conflictCount: number };
  "agent.published": { agentId: string; agentVersionId: string; version: number; phoneNumberLast4?: string; rolledBackFrom?: string };
  "agent.paused": { agentId: string };
  "live_agent.changed": { phoneNumberLast4: string; agentId: string; agentVersionId: string; previousAgentId?: string };
  "guardrail.refused": { callId: string; rule: GuardrailRule; toolName?: string };
  "webhook.rejected": { provider: "square" | "twilio"; reason: "signature_invalid" | "malformed" };
}

/** Read an event's payload with the field types from CONTRACTS.md section 7. */
export function payloadOf<T extends ActivityEventType>(event: ActivityEvent & { type: T }): ActivityPayloads[T] {
  return event.payload as unknown as ActivityPayloads[T];
}
