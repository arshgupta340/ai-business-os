// TEMPORARY. This file is a transcription of the shapes the builder needs from
// docs/CONTRACTS.md (and the error codes from docs/API.md section 2). It exists
// only because packages/contracts is still empty (task S-02 is not merged).
// When S-02 merges, delete this file and import every name below from
// `@abos/contracts` instead. No field name here is new: each one is copied
// from CONTRACTS.md. Where a shape is not needed by the builder it is left out.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Error codes (API.md section 2, CONTRACTS.md section 1)

export const ErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN_BUSINESS',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'INVALID_STATE',
  'CONFLICT_UNRESOLVED',
  'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_DECIDED',
  'PAYLOAD_HASH_MISMATCH',
  'CAPABILITY_NOT_ALLOWED',
  'INTEGRATION_UNAVAILABLE',
  'ENVIRONMENT_MISMATCH',
  'SIGNATURE_INVALID',
  'RATE_LIMITED',
  'INTERNAL',
  'QUOTE_EXPIRED',
  'ITEM_UNAVAILABLE',
  'SLOT_CONFLICT',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Shared value shapes (CONTRACTS.md section 3)

export const FactKindSchema = z.enum(['hours', 'policy', 'service', 'contact', 'faq', 'menu_item']);
export type FactKind = z.infer<typeof FactKindSchema>;

const E164 = /^\+[1-9]\d{6,14}$/;

export const CartSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        catalogItemId: z.string().min(1),
        variationId: z.string().min(1),
        quantity: z.number().int().min(1).max(20),
        modifierIds: z.array(z.string()),
        note: z.string().max(140).optional(),
      }),
    )
    .min(1),
});
export type Cart = z.infer<typeof CartSchema>;

export const ContactSchema = z.strictObject({
  name: z.string().min(1),
  messageRecipient: z.string().regex(E164),
  messageConsent: z.boolean(),
  consentAt: z.string(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const FulfillmentSchema = z.strictObject({
  type: z.literal('pickup'),
  pickupAt: z.string(),
});
export type Fulfillment = z.infer<typeof FulfillmentSchema>;

export const BookingCustomerSchema = z.strictObject({
  name: z.string().min(1),
  messageRecipient: z.string().regex(E164),
  messageConsent: z.boolean(),
});
export type BookingCustomer = z.infer<typeof BookingCustomerSchema>;

export interface QuoteLine {
  variationId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  modifiers: { modifierId: string; name: string; priceMinor: number }[];
  lineTotalMinor: number;
}
export interface Quote {
  quoteId: string;
  cartHash: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: 'USD';
  lines: QuoteLine[];
  quotedAt: string;
  expiresAt: string;
}

export interface CatalogItem {
  squareItemId: string;
  businessId: string;
  name: string;
  description?: string;
  available: boolean;
  variations: { id: string; name: string; priceMinor: number; currency: 'USD' }[];
  modifierLists: {
    id: string;
    name: string;
    selectionType: 'SINGLE' | 'MULTIPLE';
    modifiers: { id: string; name: string; priceMinor: number }[];
  }[];
  syncedAt: string;
}

export interface ServiceOffering {
  id: string;
  businessId: string;
  name: string;
  durationMinutes: number;
  priceMinor: number;
  currency: 'USD';
  bufferMinutes?: number;
}

export interface AvailabilitySlot {
  serviceId: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
}

export type OrderStatus =
  | 'AWAITING_OWNER_APPROVAL'
  | 'APPROVED'
  | 'CREATING_CHECKOUT'
  | 'PAYMENT_LINK_READY'
  | 'MESSAGE_SENT'
  | 'PAYMENT_PENDING'
  | 'PAID_VERIFIED'
  | 'FULFILLMENT_READY'
  | 'REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'UNAVAILABLE'
  | 'PAYMENT_FAILED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export interface BusinessFact {
  id: string;
  businessId: string;
  kind: FactKind;
  key: string;
  value: unknown;
  sourceType: 'square' | 'google_calendar' | 'owner_chat' | 'owner_ui' | 'upload' | 'seed';
  sourceRef?: string;
  fileId?: string;
  status: 'draft' | 'verified' | 'superseded';
  confidence: number;
  version: number;
  supersedesId?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Capability registry (CONTRACTS.md section 2)

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

export type CapabilityEffect = 'read' | 'propose' | 'write' | 'external_message';

export interface Capability {
  id: CapabilityId;
  description: string;
  effect: CapabilityEffect;
  approvalMode: 'none' | 'creates_approval' | 'required';
  requiredScopes: string[];
  handlerId: string;
  timeoutMs: number;
  tier: 'MUST' | 'SHOULD';
  inputSchema: z.ZodType;
  // The builder never reads output schemas. S-02 supplies the real ones.
  outputSchema: z.ZodType;
}

// ---------------------------------------------------------------------------
// Agent tools (CONTRACTS.md section 8)

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

export const ToolInputSchemas = {
  read_catalog: z.strictObject({ query: z.string().max(200).optional() }),
  read_business_facts: z.strictObject({
    kinds: z.array(z.enum(['hours', 'policy', 'service', 'contact', 'faq'])).optional(),
  }),
  quote_order: z.strictObject({ cart: CartSchema }),
  propose_order: z.strictObject({
    cart: CartSchema,
    contact: ContactSchema,
    fulfillment: FulfillmentSchema,
    quoteId: z.string().min(1),
  }),
  get_order_status: z.strictObject({ orderId: z.string().min(1) }),
  read_calendar_availability: z.strictObject({
    serviceId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    maxSlots: z.number().int().min(1).max(5).optional(),
  }),
  propose_booking: z.strictObject({
    serviceId: z.string().min(1),
    startUtc: z.string().min(1),
    customer: BookingCustomerSchema,
  }),
} satisfies Record<ToolName, z.ZodType>;

export type ToolInput = { [N in ToolName]: z.infer<(typeof ToolInputSchemas)[N]> };

export interface ToolOutput {
  read_catalog: {
    items: {
      catalogItemId: string;
      name: string;
      available: boolean;
      variations: { id: string; name: string; priceMinor: number }[];
      modifierLists: {
        id: string;
        name: string;
        selectionType: 'SINGLE' | 'MULTIPLE';
        modifiers: { id: string; name: string; priceMinor: number }[];
      }[];
    }[];
  };
  read_business_facts: { facts: { kind: FactKind; key: string; value: unknown }[]; timezone: string };
  quote_order: { quote: Quote };
  propose_order: { proposalId?: string; quote?: Quote; missingFields: string[]; approvalId?: string };
  get_order_status: { orderId: string; status: OrderStatus; paid: boolean; checkoutLinkSent: boolean };
  read_calendar_availability: { slots: AvailabilitySlot[]; timezone: string };
  propose_booking: { proposalId?: string; approvalId?: string; missingFields: string[]; slot?: AvailabilitySlot };
}

export type ToolFailureReason = Extract<
  ErrorCode,
  | 'QUOTE_EXPIRED'
  | 'ITEM_UNAVAILABLE'
  | 'SLOT_CONFLICT'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CAPABILITY_NOT_ALLOWED'
  | 'INTEGRATION_UNAVAILABLE'
>;

export type ToolResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: ToolFailureReason; message?: string; quote?: Quote; alternatives?: AvailabilitySlot[] };

export interface ToolContext {
  businessId: string;
  agentVersionId: string;
  callId?: string;
  testSessionId?: string;
  correlationId: string;
}

export interface ToolHandler {
  readonly toolset: 'real' | 'mock';
  call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<ToolOutput[N]>>;
}

// The description strings the model sees (CONTRACTS.md section 8 JSON).
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  read_catalog: "Search this shop's menu. Use exact item, size and topping IDs from the result.",
  read_business_facts: 'Read verified opening hours, policies and services. Answer only from this result.',
  quote_order: 'Get the exact total and tax for a cart. Read the total back to the caller from this result only.',
  propose_order:
    'Send the confirmed order to the owner for approval. Call only after the caller confirmed the read-back of this quote and agreed to receive a payment link.',
  get_order_status: 'Read the verified status of an order placed on this call.',
  read_calendar_availability: 'List free appointment slots for one service on one date.',
  propose_booking:
    'Send the confirmed appointment to the owner for approval. Call only after the caller confirmed service, time and contact.',
};

// ---------------------------------------------------------------------------
// AgentSpec, builder session and messages (CONTRACTS.md section 3)

export const AgentTemplateSchema = z.enum(['restaurant_order_taker', 'appointment_booker', 'custom']);
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

export const KnowledgeScopeSchema = z.enum(['business_profile', 'catalog', 'hours', 'order_policies', 'services', 'faq']);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

export const AgentStatusSchema = z.enum(['draft', 'live', 'paused']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSpecSchema = z.strictObject({
  id: z.string().startsWith('agt_'),
  businessId: z.string().startsWith('biz_'),
  version: z.number().int().min(1),
  template: AgentTemplateSchema,
  name: z.string().min(1).max(80),
  channel: z.literal('phone'),
  goal: z.string().min(1).max(300),
  knowledgeScopes: z.array(KnowledgeScopeSchema),
  capabilities: z.array(CapabilityIdSchema).min(1),
  writePolicy: z.literal('owner_approval_each_action_bundle'),
  escalation: z.literal('explain_unsupported_or_offer_callback'),
  status: AgentStatusSchema,
  guardrailVersion: z.literal('v1'),
  greeting: z.string().min(1).max(300).optional(),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export interface BuilderMessage {
  id: string;
  sessionId: string;
  role: 'owner' | 'assistant';
  inputMode: 'text' | 'voice';
  text: string;
  specPatch?: Partial<AgentSpec>;
  evidenceRefs?: string[];
  createdAt: string;
}

export interface BuilderSession {
  id: string;
  businessId: string;
  status: 'active' | 'completed' | 'abandoned';
  messages: BuilderMessage[];
  draftSpec: Partial<AgentSpec>;
  missingFields: string[];
  agentId?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Agent run modes (CONTRACTS.md section 3, "Agent run modes")

export const GuardrailRuleSchema = z.enum([
  'no_fact_changes',
  'no_secret_reveal',
  'no_approval_bypass',
  'no_cross_business',
  'unsupported_request',
]);
export type GuardrailRule = z.infer<typeof GuardrailRuleSchema>;

export const AgentRunRequestSchema = z.strictObject({
  testSessionId: z.string().optional(),
  callId: z.string().optional(),
  message: z.string().min(1).max(2000),
  end: z.boolean().optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export interface ToolTraceEntry {
  tool: ToolName;
  capabilityId: CapabilityId;
  effect: 'read' | 'propose';
  input: unknown;
  output: unknown;
  mocked: boolean;
  durationMs: number;
}

export interface AgentRunResponse {
  testSessionId?: string;
  callId?: string;
  reply: string;
  toolTrace: ToolTraceEntry[];
  guardrail?: { refused: true; rule: GuardrailRule };
}
