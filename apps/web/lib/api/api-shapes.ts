/**
 * TEMPORARY, like pending-contracts.ts. Request and response shapes that
 * docs/API.md defines. API.md 3.12 says these have named schemas in
 * packages/contracts (Business, Agent, AgentVersion, PreviewResponse,
 * PublishResponse, BuilderTurnResponse, FactsListResponse, OrderCheckout and
 * the Page envelope). The type names here match those names; swap the
 * imports once S-02 merges. Field names are exactly the ones in API.md.
 */
import { z } from "zod";
import {
  ActionExecutionSchema,
  ActivityEventSchema,
  AgentRunResponseSchema,
  AgentSpecSchema,
  AgentStatusSchema,
  ApprovalRequestSchema,
  ApprovalStateSchema,
  BookingSchema,
  BuilderMessageSchema,
  BuilderSessionSchema,
  BundleTypeSchema,
  BusinessFactSchema,
  CallSchema,
  CapabilityIdSchema,
  CatalogItemSchema,
  FactConflictSchema,
  FactKindSchema,
  FileRecordSchema,
  MessageDispatchSchema,
  OrderSchema,
} from "./pending-contracts";

/** Every list endpoint returns this (API.md section 1, Pagination). */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().optional() });
}
export type Page<T> = { items: T[]; nextCursor?: string };

export interface ListParams {
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------- 3.1

/** GET /api/businesses/:id. contact.address is the business location (SPEC 2.9). */
export const BusinessSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  timezone: z.string(),
  contact: z.object({ phone: z.string().optional(), email: z.string().optional(), address: z.string().optional() }),
  settings: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Business = z.infer<typeof BusinessSchema>;

/** GET /api/businesses items. API.md shows only id, name, category and timezone, so the rest is optional here. */
export const BusinessListItemSchema = BusinessSchema.partial().extend({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  timezone: z.string(),
});
export type BusinessListItem = z.infer<typeof BusinessListItemSchema>;

export interface BusinessPatch {
  name?: string;
  contact?: Business["contact"];
  settings?: Record<string, unknown>;
}

export const FactsListResponseSchema = z.object({
  items: z.array(BusinessFactSchema),
  conflicts: z.array(FactConflictSchema),
});
export type FactsListResponse = z.infer<typeof FactsListResponseSchema>;

export interface FactsQuery {
  kind?: z.infer<typeof FactKindSchema>;
  status?: "draft" | "verified" | "superseded";
}

/** Body of POST /api/businesses/:id/facts/propose. Either kind and key, or resolvesConflictId. */
export type FactProposeRequest =
  | { kind: z.infer<typeof FactKindSchema>; key: string; value: unknown; reason?: string }
  | { resolvesConflictId: string; value: unknown; reason?: string };

export const ApprovalEnvelopeSchema = z.object({ approval: ApprovalRequestSchema });
export type ApprovalEnvelope = z.infer<typeof ApprovalEnvelopeSchema>;

export const CatalogSyncResponseSchema = z.object({ jobId: z.string() });
export type CatalogSyncResponse = z.infer<typeof CatalogSyncResponseSchema>;

/** GET /api/businesses/:id/catalog (API.md 3.12). */
export const CatalogResponseSchema = z.object({ items: z.array(CatalogItemSchema), syncedAt: z.string() });
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

export interface PriceProposeRequest {
  variationId: string;
  newPriceMinor: number;
  currency: "USD";
}

/** POST /api/conflicts/:id/resolve (API.md 3.12). */
export interface ConflictResolveRequest {
  resolution: "keep_authoritative";
}
export const ConflictEnvelopeSchema = z.object({ conflict: FactConflictSchema });
export type ConflictEnvelope = z.infer<typeof ConflictEnvelopeSchema>;

// ---------------------------------------------------------------- 3.2

export const FileEnvelopeSchema = z.object({ file: FileRecordSchema });

// ---------------------------------------------------------------- 3.3

export const BuilderProgressSchema = z.object({ answered: z.number().int(), required: z.number().int() });
export const StopConditionSchema = z.object({ code: z.string() });

/** BuilderSession as the session endpoints return it. API.md 3.3 also shows progress. */
export const BuilderSessionResponseSchema = BuilderSessionSchema.extend({ progress: BuilderProgressSchema.optional() });
export type BuilderSessionResponse = z.infer<typeof BuilderSessionResponseSchema>;

export interface BuilderMessageRequest {
  text: string;
  inputMode: "text" | "voice";
}

/** Response of POST /api/builder/sessions/:id/messages (API.md 3.3 and 3.12). */
export const BuilderTurnResponseSchema = z.object({
  reply: BuilderMessageSchema,
  draftSpec: AgentSpecSchema.partial(),
  missingFields: z.array(z.string()),
  suggestions: z.array(z.string()),
  stopConditions: z.array(StopConditionSchema),
  progress: BuilderProgressSchema,
  unsupportedRequests: z.array(z.string()),
  proposedChange: z.object({ approvalId: z.string(), bundleType: BundleTypeSchema }).optional(),
});
export type BuilderTurnResponse = z.infer<typeof BuilderTurnResponseSchema>;

// ---------------------------------------------------------------- 3.4

export const AgentVersionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  version: z.number().int(),
  spec: AgentSpecSchema.partial(),
  knowledgeSnapshotRef: z.object({
    facts: z.array(z.object({ id: z.string(), version: z.number().int() })),
    catalogSyncedAt: z.string().optional(),
  }),
  createdBy: z.string(),
  publishedAt: z.string(),
});
export type AgentVersion = z.infer<typeof AgentVersionSchema>;

/** The "Agent summary" of API.md 3.4. */
export const AgentSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  name: z.string(),
  template: z.enum(["restaurant_order_taker", "appointment_booker", "custom"]),
  state: AgentStatusSchema,
  activeVersionId: z.string().optional(),
  activeVersion: AgentVersionSchema.optional(),
  draftSpec: AgentSpecSchema.partial(),
  isLiveAgent: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

export type CreateAgentRequest = { builderSessionId: string } | { spec: z.infer<typeof AgentSpecSchema> };

export interface AgentsQuery extends ListParams {
  state?: z.infer<typeof AgentStatusSchema>;
}

export const PreviewResponseSchema = z.object({
  agentId: z.string(),
  specRevision: z.number().int(),
  permissions: z.object({
    readOnly: z.array(CapabilityIdSchema),
    proposes: z.array(CapabilityIdSchema),
    approvalRequired: z.array(CapabilityIdSchema),
  }),
  examples: z.array(
    z.object({
      scenario: z.string(),
      transcript: z.array(z.object({ role: z.enum(["caller", "agent"]), text: z.string() })),
      toolTrace: AgentRunResponseSchema.shape.toolTrace,
    }),
  ),
});
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

export interface PublishRequest {
  confirm: boolean;
  makeLive?: boolean;
}

export const PublishResponseSchema = z.object({
  agent: AgentSchema.partial().extend({ id: z.string() }),
  version: AgentVersionSchema,
  phoneNumber: z.string(),
});
export type PublishResponse = z.infer<typeof PublishResponseSchema>;

export interface RollbackRequest {
  toVersionId: string;
  confirm: boolean;
}

// ---------------------------------------------------------------- 3.7

export interface ApprovalsQuery extends ListParams {
  state?: z.infer<typeof ApprovalStateSchema>;
  bundleType?: z.infer<typeof BundleTypeSchema>;
}

/** POST /api/approvals/:id/decision returns only part of the approval (API.md 3.7). */
export const DecisionResponseSchema = z.object({
  approval: ApprovalRequestSchema.partial().extend({ id: z.string(), state: ApprovalStateSchema }),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

// ---------------------------------------------------------------- 3.8 to 3.12

export interface OrdersQuery extends ListParams {
  /** One or more OrderStatus values, sent as a comma list. */
  status?: string[];
  callId?: string;
}

/** GET /api/orders/:id/checkout. `message` holds MessageDispatch fields and is absent when no dispatch exists. */
export const OrderCheckoutSchema = z.object({
  orderId: z.string(),
  ready: z.boolean(),
  environment: z.literal("sandbox"),
  checkoutUrl: z.string().optional(),
  qrText: z.string().optional(),
  squarePaymentLinkId: z.string().optional(),
  message: MessageDispatchSchema.pick({ id: true, channel: true, status: true, sentAt: true }).optional(),
});
export type OrderCheckout = z.infer<typeof OrderCheckoutSchema>;

export interface BookingsQuery extends ListParams {
  status?: string[];
  from?: string;
  to?: string;
}

export interface ActivityQuery extends ListParams {
  types?: string[];
  correlationId?: string;
  since?: string;
}

export interface CallsQuery extends ListParams {
  agentId?: string;
  since?: string;
}

export const OrderEnvelopeSchema = z.object({ order: OrderSchema });
export const ExecutionEnvelopeSchema = z.object({ execution: ActionExecutionSchema });
export interface ExecutionResolveRequest {
  action: "retry" | "abandon";
}

export const TelemetryMetricNameSchema = z.enum([
  "call_answer_latency",
  "first_audio",
  "tool_latency",
  "approval_time",
  "webhook_delay",
]);
export const TelemetryResponseSchema = z.object({
  metrics: z.array(
    z.object({ name: TelemetryMetricNameSchema, p50Ms: z.number(), p95Ms: z.number(), count: z.number().int() }),
  ),
});
export type TelemetryResponse = z.infer<typeof TelemetryResponseSchema>;

export const OrderPageSchema = pageSchema(OrderSchema);
export const BookingPageSchema = pageSchema(BookingSchema);
export const ApprovalPageSchema = pageSchema(ApprovalRequestSchema);
export const ActivityPageSchema = pageSchema(ActivityEventSchema);
export const AgentPageSchema = pageSchema(AgentSchema);
export const AgentVersionPageSchema = pageSchema(AgentVersionSchema);
export const BusinessPageSchema = pageSchema(BusinessListItemSchema);
export const CallPageSchema = pageSchema(CallSchema);
