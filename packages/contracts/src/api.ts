// docs/API.md section 3, plus the additions from the UI contract review (issue #56).
// The web app builds its typed client and mock handlers from ENDPOINTS; the server validates with the same schemas.
import { z } from 'zod';
import {
  ApprovalStateSchema,
  BookingStatusSchema,
  BundleTypeSchema,
  CapabilityIdSchema,
  FactKindSchema,
  FactStatusSchema,
  InputModeSchema,
  MessageChannelSchema,
  MessageDispatchStatusSchema,
  OrderStatusSchema,
  type Tier,
} from './enums';
import { ActivityEventTypeSchema, ActivityEventSchema } from './events';
import { ErrorCodeSchema, type ErrorCode } from './errors';
import {
  AgentIdSchema,
  AgentVersionIdSchema,
  ApprovalIdSchema,
  BookingIdSchema,
  BuilderSessionIdSchema,
  BusinessIdSchema,
  CallIdSchema,
  ExecutionIdSchema,
  FactConflictIdSchema,
  FileIdSchema,
  JobIdSchema,
  MessageDispatchIdSchema,
  OrderIdSchema,
} from './ids';
import { CurrencySchema, E164Schema, IsoDateTimeSchema, JsonValueSchema, MinorAmountSchema } from './primitives';
import { PAGE_LIMIT_MAX } from './constants';
import { AgentRunRequestSchema, AgentRunResponseSchema, AgentSchema, AgentSpecSchema, AgentVersionSchema, CallSchema, DraftAgentSpecSchema, LiveAgentSchema, ToolTraceEntrySchema } from './schemas/agents';
import { ApprovalDecisionSchema, ApprovalRequestSchema, FactEditApprovalRequestSchema, PriceEditApprovalRequestSchema } from './schemas/approvals';
import { BuilderMessageSchema, BuilderProgressSchema, BuilderSessionSchema, RealtimeClientSecretSchema } from './schemas/builder';
import { BusinessContactSchema, BusinessSchema, BusinessSummarySchema, FileRecordSchema, IntegrationHealthSchema } from './schemas/business';
import { CatalogItemSchema } from './schemas/catalog';
import { ActionExecutionSchema } from './schemas/executions';
import { BusinessFactSchema, FactConflictSchema } from './schemas/facts';
import { BookingSchema, OrderSchema } from './schemas/orders';

// ---- Shared building blocks ----

/** API 1 pagination envelope. `nextCursor` is absent on the last page. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().optional() });
}
export type Page<T> = { items: T[]; nextCursor?: string | undefined };

/** A query integer: accepts a number or its decimal string. */
const QueryLimitSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.int().min(1).max(PAGE_LIMIT_MAX));

/** A comma list in the query string (`status=A,B`), or an array. */
function commaList<T extends z.ZodType<string, string>>(item: T) {
  return z.union([z.array(item), z.string().transform((s) => s.split(',').filter((x) => x.length > 0)).pipe(z.array(item))]);
}

export const PaginationQuerySchema = z.object({ limit: QueryLimitSchema.optional(), cursor: z.string().optional() });
/** SPEC 2.9: `businessId` is a query parameter on every business-scoped route outside `/api/businesses/...`. */
export const BusinessScopeQuerySchema = z.object({ businessId: BusinessIdSchema });

const EmptyBodySchema = z.object({});

const BusinessPathSchema = z.object({ id: BusinessIdSchema });
const AgentPathSchema = z.object({ id: AgentIdSchema });
const ApprovalPathSchema = z.object({ id: ApprovalIdSchema });
const OrderPathSchema = z.object({ id: OrderIdSchema });
const BookingPathSchema = z.object({ id: BookingIdSchema });
const FilePathSchema = z.object({ id: FileIdSchema });
const BuilderSessionPathSchema = z.object({ id: BuilderSessionIdSchema });
const CallPathSchema = z.object({ id: CallIdSchema });
const ConflictPathSchema = z.object({ id: FactConflictIdSchema });
const ExecutionPathSchema = z.object({ id: ExecutionIdSchema });

// ---- 3.1 Businesses, facts and catalog ----
export const ListBusinessesResponseSchema = z.object({ items: z.array(BusinessSummarySchema) });
export type ListBusinessesResponse = z.infer<typeof ListBusinessesResponseSchema>;

/** SPEC 2.8: name, contact and settings only. Any fact field is refused (strict). */
export const UpdateBusinessBodySchema = z.strictObject({
  name: z.string().min(1).optional(),
  contact: BusinessContactSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateBusinessBody = z.infer<typeof UpdateBusinessBodySchema>;

export const ListFactsQuerySchema = z.object({ kind: FactKindSchema.optional(), status: FactStatusSchema.optional() });
export type ListFactsQuery = z.infer<typeof ListFactsQuerySchema>;
export const FactsListResponseSchema = z.object({ items: z.array(BusinessFactSchema), conflicts: z.array(FactConflictSchema) });
export type FactsListResponse = z.infer<typeof FactsListResponseSchema>;

export const ProposeFactBodySchema = z.union([
  z.strictObject({ kind: FactKindSchema, key: z.string().min(1), value: JsonValueSchema, reason: z.string().optional() }),
  z.strictObject({ resolvesConflictId: FactConflictIdSchema, value: JsonValueSchema, reason: z.string().optional() }),
]);
export type ProposeFactBody = z.infer<typeof ProposeFactBodySchema>;
export const ProposeFactResponseSchema = z.object({ approval: FactEditApprovalRequestSchema });
export type ProposeFactResponse = z.infer<typeof ProposeFactResponseSchema>;

export const CatalogResponseSchema = z.object({ items: z.array(CatalogItemSchema), syncedAt: IsoDateTimeSchema });
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

export const CatalogSyncResponseSchema = z.object({ jobId: JobIdSchema });
export type CatalogSyncResponse = z.infer<typeof CatalogSyncResponseSchema>;

export const ProposePriceBodySchema = z.strictObject({ variationId: z.string().min(1), newPriceMinor: MinorAmountSchema, currency: CurrencySchema });
export type ProposePriceBody = z.infer<typeof ProposePriceBodySchema>;
export const ProposePriceResponseSchema = z.object({ approval: PriceEditApprovalRequestSchema });
export type ProposePriceResponse = z.infer<typeof ProposePriceResponseSchema>;

/** Issue #56: keep the authoritative value; the draft becomes superseded. No approval, nothing external. */
export const ResolveConflictBodySchema = z.strictObject({ resolution: z.literal('keep_authoritative') });
export type ResolveConflictBody = z.infer<typeof ResolveConflictBodySchema>;
export const ResolveConflictResponseSchema = z.object({ conflict: FactConflictSchema });
export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponseSchema>;

// ---- 3.2 Files ----
export const FileResponseSchema = z.object({ file: FileRecordSchema });
export type FileResponse = z.infer<typeof FileResponseSchema>;

// ---- 3.3 Builder sessions ----
export const CreateBuilderSessionBodySchema = z.strictObject({ agentId: AgentIdSchema.optional() });
export type CreateBuilderSessionBody = z.infer<typeof CreateBuilderSessionBodySchema>;

export const BuilderMessageBodySchema = z.strictObject({ text: z.string().min(1), inputMode: InputModeSchema });
export type BuilderMessageBody = z.infer<typeof BuilderMessageBodySchema>;

export const StopConditionSchema = z.object({ code: z.string().min(1) });
export type StopCondition = z.infer<typeof StopConditionSchema>;

export const BuilderTurnResponseSchema = z.object({
  reply: BuilderMessageSchema,
  draftSpec: DraftAgentSpecSchema,
  missingFields: z.array(z.string()),
  suggestions: z.array(z.string()),
  stopConditions: z.array(StopConditionSchema),
  progress: BuilderProgressSchema,
  unsupportedRequests: z.array(z.string()), // issue #56: always present, may be empty
  proposedChange: z.object({ approvalId: ApprovalIdSchema, bundleType: BundleTypeSchema.extract(['fact_edit', 'price_edit']) }).optional(),
});
export type BuilderTurnResponse = z.infer<typeof BuilderTurnResponseSchema>;

// ---- 3.4 Agents ----
export const ListAgentsQuerySchema = PaginationQuerySchema.extend({ state: z.enum(['draft', 'live', 'paused']).optional() });
export type ListAgentsQuery = z.infer<typeof ListAgentsQuerySchema>;

export const CreateAgentBodySchema = z.union([
  z.strictObject({ builderSessionId: BuilderSessionIdSchema }),
  z.strictObject({ spec: AgentSpecSchema }),
]);
export type CreateAgentBody = z.infer<typeof CreateAgentBodySchema>;

export const PreviewBodySchema = z.strictObject({ scenarios: z.array(z.string().min(1)).optional() });
export type PreviewBody = z.infer<typeof PreviewBodySchema>;

export const PreviewResponseSchema = z.object({
  agentId: AgentIdSchema,
  specRevision: z.int().min(0),
  permissions: z.object({
    readOnly: z.array(CapabilityIdSchema),
    proposes: z.array(CapabilityIdSchema),
    approvalRequired: z.array(CapabilityIdSchema),
  }),
  examples: z.array(
    z.object({
      scenario: z.string(),
      transcript: z.array(z.object({ role: z.enum(['caller', 'agent']), text: z.string() })),
      toolTrace: z.array(ToolTraceEntrySchema),
    }),
  ),
});
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

export const PublishBodySchema = z.strictObject({ confirm: z.literal(true), makeLive: z.boolean().optional() });
export type PublishBody = z.infer<typeof PublishBodySchema>;

export const RollbackBodySchema = z.strictObject({ toVersionId: AgentVersionIdSchema, confirm: z.literal(true), makeLive: z.boolean().optional() });
export type RollbackBody = z.infer<typeof RollbackBodySchema>;

/** The `agent` here may be a subset of the summary; `id` and `state` are always present. */
export const PublishResponseSchema = z.object({
  agent: AgentSchema.partial().required({ id: true, state: true }),
  version: AgentVersionSchema,
  phoneNumber: E164Schema,
});
export type PublishResponse = z.infer<typeof PublishResponseSchema>;

// ---- 3.5 Owner voice ----
export const ClientSecretBodySchema = z.strictObject({ builderSessionId: BuilderSessionIdSchema });
export type ClientSecretBody = z.infer<typeof ClientSecretBodySchema>;

// ---- 3.6 Live agent ----
export const PutLiveAgentBodySchema = z.strictObject({ agentId: AgentIdSchema });
export type PutLiveAgentBody = z.infer<typeof PutLiveAgentBodySchema>;

// ---- 3.7 Approvals ----
export const ListApprovalsQuerySchema = BusinessScopeQuerySchema.extend({
  state: ApprovalStateSchema.optional(), // default PENDING
  bundleType: BundleTypeSchema.optional(),
}).extend(PaginationQuerySchema.shape);
export type ListApprovalsQuery = z.infer<typeof ListApprovalsQuerySchema>;

export const IdempotencyHeadersSchema = z.object({ 'idempotency-key': z.string().min(1).optional() });

/** The decision response may carry only these fields. */
export const DecisionResponseSchema = z.object({
  approval: z.object({
    id: ApprovalIdSchema,
    state: ApprovalStateSchema,
    decidedBy: z.string().optional(),
    decidedAt: IsoDateTimeSchema.optional(),
  }),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

// ---- 3.8 Orders ----
export const ListOrdersQuerySchema = BusinessScopeQuerySchema.extend({
  status: commaList(OrderStatusSchema).optional(),
  callId: CallIdSchema.optional(),
}).extend(PaginationQuerySchema.shape);
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

export const OrderCheckoutSchema = z.object({
  orderId: OrderIdSchema,
  ready: z.boolean(), // false until the Square payment link exists
  environment: z.literal('sandbox'),
  checkoutUrl: z.url().optional(),
  qrText: z.string().optional(),
  squarePaymentLinkId: z.string().optional(),
  // Absent when no dispatch exists (always under qr_only). Fields are MessageDispatch fields.
  message: z
    .object({
      id: MessageDispatchIdSchema,
      channel: MessageChannelSchema,
      status: MessageDispatchStatusSchema,
      sentAt: IsoDateTimeSchema.optional(),
      deliveredAt: IsoDateTimeSchema.optional(),
      errorCode: ErrorCodeSchema.optional(),
    })
    .optional(),
});
export type OrderCheckout = z.infer<typeof OrderCheckoutSchema>;

export const CancelOrderResponseSchema = z.object({ order: OrderSchema });
export type CancelOrderResponse = z.infer<typeof CancelOrderResponseSchema>;

export const ResolveExecutionBodySchema = z.strictObject({ action: z.enum(['retry', 'abandon']) });
export type ResolveExecutionBody = z.infer<typeof ResolveExecutionBodySchema>;
export const ResolveExecutionResponseSchema = z.object({ execution: ActionExecutionSchema });
export type ResolveExecutionResponse = z.infer<typeof ResolveExecutionResponseSchema>;

// ---- 3.9 Bookings ----
export const ListBookingsQuerySchema = BusinessScopeQuerySchema.extend({
  status: commaList(BookingStatusSchema).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
}).extend(PaginationQuerySchema.shape);
export type ListBookingsQuery = z.infer<typeof ListBookingsQuerySchema>;

// ---- Calls (issue #56) ----
export const ListCallsQuerySchema = BusinessScopeQuerySchema.extend({
  agentId: AgentIdSchema.optional(),
  since: IsoDateTimeSchema.optional(),
}).extend(PaginationQuerySchema.shape);
export type ListCallsQuery = z.infer<typeof ListCallsQuerySchema>;

// ---- 3.10 Activity ----
export const ListActivityQuerySchema = BusinessScopeQuerySchema.extend({
  types: commaList(ActivityEventTypeSchema).optional(),
  correlationId: z.string().optional(),
  since: IsoDateTimeSchema.optional(),
}).extend(PaginationQuerySchema.shape);
export type ListActivityQuery = z.infer<typeof ListActivityQuerySchema>;

// ---- 3.11 Integrations ----
export const IntegrationsHealthQuerySchema = BusinessScopeQuerySchema.extend({ refresh: z.literal('1').optional() });
export type IntegrationsHealthQuery = z.infer<typeof IntegrationsHealthQuerySchema>;

// ---- Telemetry (issue #56, SHOULD) ----
export const TelemetryMetricNameSchema = z.enum(['call_answer_latency', 'tool_latency', 'approval_time', 'webhook_delay', 'first_audio']);
export type TelemetryMetricName = z.infer<typeof TelemetryMetricNameSchema>;
export const TelemetryQuerySchema = BusinessScopeQuerySchema.extend({ since: IsoDateTimeSchema.optional() });
export type TelemetryQuery = z.infer<typeof TelemetryQuerySchema>;
export const TelemetryResponseSchema = z.object({
  metrics: z.array(z.object({ name: TelemetryMetricNameSchema, p50Ms: z.number().min(0), p95Ms: z.number().min(0), count: z.int().min(0) })),
});
export type TelemetryResponse = z.infer<typeof TelemetryResponseSchema>;

// ---- Named entity responses ----
export const AgentsPageSchema = pageOf(AgentSchema);
export const AgentVersionsPageSchema = pageOf(AgentVersionSchema);
export const ApprovalsPageSchema = pageOf(ApprovalRequestSchema);
export const OrdersPageSchema = pageOf(OrderSchema);
export const BookingsPageSchema = pageOf(BookingSchema);
export const CallsPageSchema = pageOf(CallSchema);
export const ActivityPageSchema = pageOf(ActivityEventSchema);

// ---- The endpoint table ----
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';
export type Owner = 'arsh' | 'saina';

export type EndpointDefinition = {
  method: HttpMethod;
  path: string; // Fastify style, `:id` for path params
  owner: Owner;
  tier: Tier;
  successStatus: 200 | 201 | 202;
  params?: z.ZodType;
  query?: z.ZodType;
  headers?: z.ZodType;
  /** `multipart`: one form field named `file`, at most 10 MB (API 3.2). */
  bodyKind: 'none' | 'json' | 'multipart';
  body?: z.ZodType;
  response: z.ZodType;
  /** Errors beyond the common set (UNAUTHENTICATED, FORBIDDEN_BUSINESS, VALIDATION_FAILED, RATE_LIMITED, INTERNAL). */
  errors: readonly ErrorCode[];
};

export const ENDPOINTS = {
  // 3.1
  listBusinesses: { method: 'GET', path: '/api/businesses', owner: 'arsh', tier: 'MUST', successStatus: 200, bodyKind: 'none', response: ListBusinessesResponseSchema, errors: [] },
  getBusiness: { method: 'GET', path: '/api/businesses/:id', owner: 'arsh', tier: 'MUST', successStatus: 200, params: BusinessPathSchema, bodyKind: 'none', response: BusinessSchema, errors: ['NOT_FOUND'] },
  updateBusiness: { method: 'PATCH', path: '/api/businesses/:id', owner: 'arsh', tier: 'MUST', successStatus: 200, params: BusinessPathSchema, bodyKind: 'json', body: UpdateBusinessBodySchema, response: BusinessSchema, errors: ['NOT_FOUND'] },
  listFacts: { method: 'GET', path: '/api/businesses/:id/facts', owner: 'arsh', tier: 'MUST', successStatus: 200, params: BusinessPathSchema, query: ListFactsQuerySchema, bodyKind: 'none', response: FactsListResponseSchema, errors: ['NOT_FOUND'] },
  proposeFact: { method: 'POST', path: '/api/businesses/:id/facts/propose', owner: 'arsh', tier: 'MUST', successStatus: 201, params: BusinessPathSchema, bodyKind: 'json', body: ProposeFactBodySchema, response: ProposeFactResponseSchema, errors: ['NOT_FOUND', 'INVALID_STATE'] },
  getCatalog: { method: 'GET', path: '/api/businesses/:id/catalog', owner: 'arsh', tier: 'MUST', successStatus: 200, params: BusinessPathSchema, bodyKind: 'none', response: CatalogResponseSchema, errors: ['NOT_FOUND'] },
  syncCatalog: { method: 'POST', path: '/api/businesses/:id/catalog/sync', owner: 'arsh', tier: 'MUST', successStatus: 202, params: BusinessPathSchema, bodyKind: 'json', body: EmptyBodySchema, response: CatalogSyncResponseSchema, errors: ['INTEGRATION_UNAVAILABLE', 'ENVIRONMENT_MISMATCH'] },
  proposePrice: { method: 'POST', path: '/api/businesses/:id/catalog/prices/propose', owner: 'arsh', tier: 'SHOULD', successStatus: 201, params: BusinessPathSchema, bodyKind: 'json', body: ProposePriceBodySchema, response: ProposePriceResponseSchema, errors: ['NOT_FOUND', 'INTEGRATION_UNAVAILABLE', 'ENVIRONMENT_MISMATCH'] },
  resolveConflict: { method: 'POST', path: '/api/conflicts/:id/resolve', owner: 'saina', tier: 'MUST', successStatus: 200, params: ConflictPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: ResolveConflictBodySchema, response: ResolveConflictResponseSchema, errors: ['NOT_FOUND', 'INVALID_STATE'] },
  // 3.2
  uploadFile: { method: 'POST', path: '/api/businesses/:id/files', owner: 'saina', tier: 'MUST', successStatus: 202, params: BusinessPathSchema, bodyKind: 'multipart', response: FileResponseSchema, errors: [] },
  getFile: { method: 'GET', path: '/api/files/:id', owner: 'saina', tier: 'MUST', successStatus: 200, params: FilePathSchema, query: BusinessScopeQuerySchema, bodyKind: 'none', response: FileRecordSchema, errors: ['NOT_FOUND'] },
  // 3.3
  createBuilderSession: { method: 'POST', path: '/api/builder/sessions', owner: 'saina', tier: 'MUST', successStatus: 201, query: BusinessScopeQuerySchema, bodyKind: 'json', body: CreateBuilderSessionBodySchema, response: BuilderSessionSchema, errors: ['NOT_FOUND'] },
  getBuilderSession: { method: 'GET', path: '/api/builder/sessions/:id', owner: 'saina', tier: 'MUST', successStatus: 200, params: BuilderSessionPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'none', response: BuilderSessionSchema, errors: ['NOT_FOUND'] },
  sendBuilderMessage: { method: 'POST', path: '/api/builder/sessions/:id/messages', owner: 'saina', tier: 'MUST', successStatus: 200, params: BuilderSessionPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: BuilderMessageBodySchema, response: BuilderTurnResponseSchema, errors: ['NOT_FOUND', 'INTEGRATION_UNAVAILABLE'] },
  // 3.4
  listAgents: { method: 'GET', path: '/api/agents', owner: 'saina', tier: 'MUST', successStatus: 200, query: BusinessScopeQuerySchema.extend(ListAgentsQuerySchema.shape), bodyKind: 'none', response: AgentsPageSchema, errors: [] },
  createAgent: { method: 'POST', path: '/api/agents', owner: 'saina', tier: 'MUST', successStatus: 201, query: BusinessScopeQuerySchema, bodyKind: 'json', body: CreateAgentBodySchema, response: AgentSchema, errors: ['NOT_FOUND', 'CAPABILITY_NOT_ALLOWED'] },
  getAgent: { method: 'GET', path: '/api/agents/:id', owner: 'saina', tier: 'MUST', successStatus: 200, params: AgentPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'none', response: AgentSchema, errors: ['NOT_FOUND'] },
  previewAgent: { method: 'POST', path: '/api/agents/:id/preview', owner: 'saina', tier: 'MUST', successStatus: 200, params: AgentPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: PreviewBodySchema, response: PreviewResponseSchema, errors: ['NOT_FOUND', 'CAPABILITY_NOT_ALLOWED', 'INTEGRATION_UNAVAILABLE'] },
  testAgent: { method: 'POST', path: '/api/agents/:id/test', owner: 'saina', tier: 'MUST', successStatus: 200, params: AgentPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: AgentRunRequestSchema, response: AgentRunResponseSchema, errors: ['NOT_FOUND', 'INTEGRATION_UNAVAILABLE'] },
  simCall: { method: 'POST', path: '/api/agents/:id/sim-call', owner: 'arsh', tier: 'MUST', successStatus: 200, params: AgentPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: AgentRunRequestSchema, response: AgentRunResponseSchema, errors: ['NOT_FOUND', 'INVALID_STATE', 'INTEGRATION_UNAVAILABLE', 'QUOTE_EXPIRED'] },
  publishAgent: { method: 'POST', path: '/api/agents/:id/publish', owner: 'saina', tier: 'MUST', successStatus: 200, params: AgentPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: PublishBodySchema, response: PublishResponseSchema, errors: ['NOT_FOUND', 'CONFLICT_UNRESOLVED', 'CAPABILITY_NOT_ALLOWED', 'INTEGRATION_UNAVAILABLE', 'ENVIRONMENT_MISMATCH'] },
  pauseAgent: { method: 'POST', path: '/api/agents/:id/pause', owner: 'saina', tier: 'MUST', successStatus: 200, params: AgentPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: EmptyBodySchema, response: AgentSchema, errors: ['NOT_FOUND', 'INVALID_STATE'] },
  listAgentVersions: { method: 'GET', path: '/api/agents/:id/versions', owner: 'saina', tier: 'MUST', successStatus: 200, params: AgentPathSchema, query: BusinessScopeQuerySchema.extend(PaginationQuerySchema.shape), bodyKind: 'none', response: AgentVersionsPageSchema, errors: ['NOT_FOUND'] },
  rollbackAgent: { method: 'POST', path: '/api/agents/:id/rollback', owner: 'saina', tier: 'SHOULD', successStatus: 200, params: AgentPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: RollbackBodySchema, response: PublishResponseSchema, errors: ['NOT_FOUND', 'INVALID_STATE', 'CONFLICT_UNRESOLVED'] },
  // 3.5
  createRealtimeClientSecret: { method: 'POST', path: '/api/realtime/client-secret', owner: 'saina', tier: 'MUST', successStatus: 200, query: BusinessScopeQuerySchema, bodyKind: 'json', body: ClientSecretBodySchema, response: RealtimeClientSecretSchema, errors: ['NOT_FOUND', 'INTEGRATION_UNAVAILABLE'] },
  // 3.6 (owner-scoped: no businessId)
  getLiveAgent: { method: 'GET', path: '/api/live-agent', owner: 'arsh', tier: 'MUST', successStatus: 200, bodyKind: 'none', response: LiveAgentSchema, errors: [] },
  putLiveAgent: { method: 'PUT', path: '/api/live-agent', owner: 'arsh', tier: 'MUST', successStatus: 200, bodyKind: 'json', body: PutLiveAgentBodySchema, response: LiveAgentSchema, errors: ['NOT_FOUND', 'INVALID_STATE'] },
  // 3.7
  listApprovals: { method: 'GET', path: '/api/approvals', owner: 'arsh', tier: 'MUST', successStatus: 200, query: ListApprovalsQuerySchema, bodyKind: 'none', response: ApprovalsPageSchema, errors: [] },
  getApproval: { method: 'GET', path: '/api/approvals/:id', owner: 'arsh', tier: 'MUST', successStatus: 200, params: ApprovalPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'none', response: ApprovalRequestSchema, errors: ['NOT_FOUND'] },
  decideApproval: { method: 'POST', path: '/api/approvals/:id/decision', owner: 'arsh', tier: 'MUST', successStatus: 200, params: ApprovalPathSchema, query: BusinessScopeQuerySchema, headers: IdempotencyHeadersSchema, bodyKind: 'json', body: ApprovalDecisionSchema, response: DecisionResponseSchema, errors: ['NOT_FOUND', 'PAYLOAD_HASH_MISMATCH', 'APPROVAL_ALREADY_DECIDED', 'APPROVAL_EXPIRED', 'ENVIRONMENT_MISMATCH'] },
  // 3.8
  listOrders: { method: 'GET', path: '/api/orders', owner: 'arsh', tier: 'MUST', successStatus: 200, query: ListOrdersQuerySchema, bodyKind: 'none', response: OrdersPageSchema, errors: [] },
  getOrder: { method: 'GET', path: '/api/orders/:id', owner: 'arsh', tier: 'MUST', successStatus: 200, params: OrderPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'none', response: OrderSchema, errors: ['NOT_FOUND'] },
  getOrderCheckout: { method: 'GET', path: '/api/orders/:id/checkout', owner: 'arsh', tier: 'MUST', successStatus: 200, params: OrderPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'none', response: OrderCheckoutSchema, errors: ['NOT_FOUND'] },
  cancelOrder: { method: 'POST', path: '/api/orders/:id/cancel', owner: 'arsh', tier: 'SHOULD', successStatus: 200, params: OrderPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: EmptyBodySchema, response: CancelOrderResponseSchema, errors: ['NOT_FOUND', 'INVALID_STATE'] },
  resolveExecution: { method: 'POST', path: '/api/executions/:id/resolve', owner: 'arsh', tier: 'SHOULD', successStatus: 200, params: ExecutionPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'json', body: ResolveExecutionBodySchema, response: ResolveExecutionResponseSchema, errors: ['NOT_FOUND', 'INVALID_STATE', 'APPROVAL_EXPIRED'] },
  // 3.9
  listBookings: { method: 'GET', path: '/api/bookings', owner: 'arsh', tier: 'MUST', successStatus: 200, query: ListBookingsQuerySchema, bodyKind: 'none', response: BookingsPageSchema, errors: [] },
  getBooking: { method: 'GET', path: '/api/bookings/:id', owner: 'arsh', tier: 'MUST', successStatus: 200, params: BookingPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'none', response: BookingSchema, errors: ['NOT_FOUND'] },
  // Calls (issue #56)
  listCalls: { method: 'GET', path: '/api/calls', owner: 'arsh', tier: 'MUST', successStatus: 200, query: ListCallsQuerySchema, bodyKind: 'none', response: CallsPageSchema, errors: [] },
  getCall: { method: 'GET', path: '/api/calls/:id', owner: 'arsh', tier: 'MUST', successStatus: 200, params: CallPathSchema, query: BusinessScopeQuerySchema, bodyKind: 'none', response: CallSchema, errors: ['NOT_FOUND'] },
  // 3.10
  listActivity: { method: 'GET', path: '/api/activity', owner: 'arsh', tier: 'MUST', successStatus: 200, query: ListActivityQuerySchema, bodyKind: 'none', response: ActivityPageSchema, errors: [] },
  // 3.11
  getIntegrationsHealth: { method: 'GET', path: '/api/integrations/health', owner: 'arsh', tier: 'MUST', successStatus: 200, query: IntegrationsHealthQuerySchema, bodyKind: 'none', response: IntegrationHealthSchema, errors: [] },
  // Telemetry (issue #56)
  getTelemetry: { method: 'GET', path: '/api/telemetry', owner: 'arsh', tier: 'SHOULD', successStatus: 200, query: TelemetryQuerySchema, bodyKind: 'none', response: TelemetryResponseSchema, errors: [] },
} as const satisfies Record<string, EndpointDefinition>;

export type EndpointName = keyof typeof ENDPOINTS;
type Def<N extends EndpointName> = (typeof ENDPOINTS)[N];
type SchemaOut<S> = S extends z.ZodType ? z.output<S> : never;
type SchemaIn<S> = S extends z.ZodType ? z.input<S> : never;
/** What a client sends (input types: query numbers may be strings, comma lists may be strings). */
export type EndpointParams<N extends EndpointName> = Def<N> extends { params: infer S } ? SchemaIn<S> : undefined;
export type EndpointQuery<N extends EndpointName> = Def<N> extends { query: infer S } ? SchemaIn<S> : undefined;
export type EndpointBody<N extends EndpointName> = Def<N> extends { body: infer S } ? SchemaIn<S> : undefined;
export type EndpointResponse<N extends EndpointName> = SchemaOut<Def<N>['response']>;

/** Fills `:param` segments, for example `buildPath('/api/orders/:id', { id: 'ord_1' })`. */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`buildPath: missing param ${name}`);
    return encodeURIComponent(value);
  });
}

// ---- Webhooks and the phone socket (API 4 and 5). Provider-called, no JWT; listed for completeness. ----
export const WEBHOOK_ENDPOINTS = {
  twilioVoice: { method: 'POST', path: '/webhooks/twilio/voice', owner: 'arsh', tier: 'MUST', signatureHeader: 'x-twilio-signature', contentType: 'application/x-www-form-urlencoded', responds: 'TwiML' },
  twilioStatus: { method: 'POST', path: '/webhooks/twilio/status', owner: 'arsh', tier: 'MUST', signatureHeader: 'x-twilio-signature', contentType: 'application/x-www-form-urlencoded', responds: '204' },
  square: { method: 'POST', path: '/webhooks/square', owner: 'arsh', tier: 'MUST', signatureHeader: 'x-square-hmacsha256-signature', contentType: 'application/json', responds: '200' },
} as const;
export const PHONE_SOCKET_PATH = '/ws/phone';
