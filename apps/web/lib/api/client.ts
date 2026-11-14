/**
 * Typed fetch client for apps/server (docs/API.md section 3).
 *
 * - Base URL from NEXT_PUBLIC_API_URL, bearer token from getAccessToken().
 * - Business scope (SPEC 2.9): businessId is in the path for /api/businesses/...
 *   and a query parameter on every other business-scoped route.
 * - Every non-2xx answer and every network failure throws ApiError.
 * - Every 2xx body is validated with the contract schema.
 */
import { z } from "zod";
import {
  AgentRunResponseSchema,
  type AgentRunResponse,
  ApprovalRequestSchema,
  type ApprovalRequest,
  BookingSchema,
  type Booking,
  IntegrationHealthSchema,
  type IntegrationHealth,
  LiveAgentSchema,
  type LiveAgent,
  OrderSchema,
  type Order,
  RealtimeClientSecretSchema,
  type RealtimeClientSecret,
  type ApprovalDecision,
  CallSchema,
  type Call,
  type FileRecord,
} from "./pending-contracts";
import {
  ActivityPageSchema,
  type ActivityQuery,
  AgentPageSchema,
  AgentSchema,
  type Agent,
  AgentVersionPageSchema,
  type AgentVersion,
  type AgentsQuery,
  ApprovalEnvelopeSchema,
  type ApprovalEnvelope,
  ApprovalPageSchema,
  type ApprovalsQuery,
  BookingPageSchema,
  type BookingsQuery,
  BuilderTurnResponseSchema,
  type BuilderMessageRequest,
  type BuilderTurnResponse,
  BuilderSessionResponseSchema,
  type BuilderSessionResponse,
  BusinessPageSchema,
  BusinessSchema,
  type BusinessPatch,
  type Business,
  type BusinessListItem,
  CatalogSyncResponseSchema,
  type CatalogSyncResponse,
  OrderCheckoutSchema,
  type OrderCheckout,
  type CreateAgentRequest,
  DecisionResponseSchema,
  type DecisionResponse,
  type FactProposeRequest,
  type FactsQuery,
  FactsListResponseSchema,
  type FactsListResponse,
  FileEnvelopeSchema,
  type ListParams,
  OrderPageSchema,
  type OrdersQuery,
  type Page,
  PreviewResponseSchema,
  type PreviewResponse,
  type PriceProposeRequest,
  type PublishRequest,
  PublishResponseSchema,
  type PublishResponse,
  type RollbackRequest,
  CallPageSchema,
  type CallsQuery,
  CatalogResponseSchema,
  type CatalogResponse,
  ConflictEnvelopeSchema,
  type ConflictEnvelope,
  type ConflictResolveRequest,
  ExecutionEnvelopeSchema,
  type ExecutionResolveRequest,
  OrderEnvelopeSchema,
  TelemetryResponseSchema,
  type TelemetryResponse,
} from "./api-shapes";
import type { ActionExecution } from "./pending-contracts";
import type { ActivityEvent } from "./pending-contracts";
import { defaultBaseUrl } from "./config";
import { errorFromResponse, invalidResponseError, networkError } from "./errors";

// ------------------------------------------------------------ configuration

type TokenGetter = () => Promise<string | null>;

interface ClientConfig {
  baseUrl: string;
  getAccessToken: TokenGetter;
  fetch: typeof fetch;
}

const defaultTokenGetter: TokenGetter = async () => {
  // Imported lazily so tests and mock mode do not need a Supabase session module at load time.
  const mod = await import("@/lib/session/auth");
  return mod.getAccessToken();
};

const config: ClientConfig = {
  baseUrl: defaultBaseUrl(),
  getAccessToken: defaultTokenGetter,
  fetch: (...args) => globalThis.fetch(...args),
};

/** Override the base URL, token source or fetch. Used by tests; the app never needs it. */
export function configureApiClient(overrides: Partial<ClientConfig>): void {
  Object.assign(config, overrides);
  if (overrides.baseUrl !== undefined) config.baseUrl = overrides.baseUrl.replace(/\/+$/, "");
}

// ------------------------------------------------------------------ core

type QueryValue = string | number | boolean | string[] | undefined;

interface RequestOptions<T> {
  method: "GET" | "POST" | "PATCH" | "PUT";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  formData?: FormData;
  headers?: Record<string, string>;
  schema: z.ZodType<T>;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return `${config.baseUrl}${path}${qs ? `?${qs}` : ""}`;
}

async function request<T>(opts: RequestOptions<T>): Promise<T> {
  const url = buildUrl(opts.path, opts.query);
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };

  let token: string | null = null;
  try {
    token = await config.getAccessToken();
  } catch {
    token = null;
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData; // the browser sets the multipart boundary
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await config.fetch(url, { method: opts.method, headers, body });
  } catch (cause) {
    throw networkError(cause);
  }

  const correlationId = res.headers.get("X-Correlation-Id");
  const text = await res.text().catch(() => "");
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) throw errorFromResponse(res.status, json, correlationId);

  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) throw invalidResponseError(opts.path, res.status, correlationId, parsed.error.issues);
  return parsed.data;
}

const enc = encodeURIComponent;
const Ignored = z.unknown();

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// ------------------------------------------------- 3.1 businesses and facts

export function listBusinesses(): Promise<Page<BusinessListItem>> {
  return request({ method: "GET", path: "/api/businesses", schema: BusinessPageSchema });
}

export function getBusiness(businessId: string): Promise<Business> {
  return request({ method: "GET", path: `/api/businesses/${enc(businessId)}`, schema: BusinessSchema });
}

export function updateBusiness(businessId: string, patch: BusinessPatch): Promise<Business> {
  return request({ method: "PATCH", path: `/api/businesses/${enc(businessId)}`, body: patch, schema: BusinessSchema });
}

export function getFacts(businessId: string, query: FactsQuery = {}): Promise<FactsListResponse> {
  return request({
    method: "GET",
    path: `/api/businesses/${enc(businessId)}/facts`,
    query: { kind: query.kind, status: query.status },
    schema: FactsListResponseSchema,
  });
}

/** Creates a fact_edit approval (actorType owner). Nothing changes until the decision is approved. */
export function proposeFact(businessId: string, body: FactProposeRequest): Promise<ApprovalEnvelope> {
  return request({
    method: "POST",
    path: `/api/businesses/${enc(businessId)}/facts/propose`,
    body,
    schema: ApprovalEnvelopeSchema,
  });
}

export function syncCatalog(businessId: string): Promise<CatalogSyncResponse> {
  return request({
    method: "POST",
    path: `/api/businesses/${enc(businessId)}/catalog/sync`,
    body: {},
    schema: CatalogSyncResponseSchema,
  });
}

/** SHOULD tier. Creates a price_edit approval. */
export function proposePrice(businessId: string, body: PriceProposeRequest): Promise<ApprovalEnvelope> {
  return request({
    method: "POST",
    path: `/api/businesses/${enc(businessId)}/catalog/prices/propose`,
    body,
    schema: ApprovalEnvelopeSchema,
  });
}

/** GET /api/businesses/:id/catalog (API.md 3.12): items grouped by squareItemId, display prices only. */
export function getCatalog(businessId: string): Promise<CatalogResponse> {
  return request({ method: "GET", path: `/api/businesses/${enc(businessId)}/catalog`, schema: CatalogResponseSchema });
}

/**
 * POST /api/conflicts/:id/resolve (API.md 3.12). Keeps the authoritative value:
 * the conflict becomes resolved and the draft fact superseded, with no approval.
 * Preferring the uploaded price is a price change through proposePrice instead.
 */
export function resolveConflict(
  businessId: string,
  conflictId: string,
  body: ConflictResolveRequest = { resolution: "keep_authoritative" },
): Promise<ConflictEnvelope> {
  return request({
    method: "POST",
    path: `/api/conflicts/${enc(conflictId)}/resolve`,
    query: { businessId },
    body,
    schema: ConflictEnvelopeSchema,
  });
}

// ------------------------------------------------------------- 3.2 files

export async function uploadFile(businessId: string, file: Blob, fileName?: string): Promise<FileRecord> {
  const form = new FormData();
  const name = fileName ?? (file as File).name ?? "upload";
  form.set("file", file, name);
  const res = await request({
    method: "POST",
    path: `/api/businesses/${enc(businessId)}/files`,
    formData: form,
    schema: FileEnvelopeSchema,
  });
  return res.file;
}

export async function getFile(businessId: string, fileId: string): Promise<FileRecord> {
  const res = await request({
    method: "GET",
    path: `/api/files/${enc(fileId)}`,
    query: { businessId },
    schema: FileEnvelopeSchema,
  });
  return res.file;
}

// ------------------------------------------------------ 3.3 builder sessions

export function createBuilderSession(businessId: string, body: { agentId?: string } = {}): Promise<BuilderSessionResponse> {
  return request({
    method: "POST",
    path: "/api/builder/sessions",
    query: { businessId },
    body,
    schema: BuilderSessionResponseSchema,
  });
}

export function getBuilderSession(businessId: string, sessionId: string): Promise<BuilderSessionResponse> {
  return request({
    method: "GET",
    path: `/api/builder/sessions/${enc(sessionId)}`,
    query: { businessId },
    schema: BuilderSessionResponseSchema,
  });
}

export function sendBuilderMessage(
  businessId: string,
  sessionId: string,
  body: BuilderMessageRequest,
): Promise<BuilderTurnResponse> {
  return request({
    method: "POST",
    path: `/api/builder/sessions/${enc(sessionId)}/messages`,
    query: { businessId },
    body,
    schema: BuilderTurnResponseSchema,
  });
}

// ---------------------------------------------------------------- 3.4 agents

export function listAgents(businessId: string, query: AgentsQuery = {}): Promise<Page<Agent>> {
  return request({
    method: "GET",
    path: "/api/agents",
    query: { businessId, state: query.state, limit: query.limit, cursor: query.cursor },
    schema: AgentPageSchema,
  });
}

export function createAgent(businessId: string, body: CreateAgentRequest): Promise<Agent> {
  return request({ method: "POST", path: "/api/agents", query: { businessId }, body, schema: AgentSchema });
}

export function getAgent(businessId: string, agentId: string): Promise<Agent> {
  return request({ method: "GET", path: `/api/agents/${enc(agentId)}`, query: { businessId }, schema: AgentSchema });
}

/** Mock toolset only. Never causes a write (AC-03). */
export function previewAgent(businessId: string, agentId: string, body: { scenarios?: string[] } = {}): Promise<PreviewResponse> {
  return request({
    method: "POST",
    path: `/api/agents/${enc(agentId)}/preview`,
    query: { businessId },
    body,
    schema: PreviewResponseSchema,
  });
}

/** Test console turn. Mock toolset only; approvals in the trace are apv_mock_ and never stored (AC-03). */
export function testAgent(
  businessId: string,
  agentId: string,
  body: { message: string; testSessionId?: string },
): Promise<AgentRunResponse> {
  return request({
    method: "POST",
    path: `/api/agents/${enc(agentId)}/test`,
    query: { businessId },
    body,
    schema: AgentRunResponseSchema,
  });
}

/** Simulated call on a published agent. Real read and propose tools; label it "simulated call" in the UI. */
export function simCall(
  businessId: string,
  agentId: string,
  body: { message: string; callId?: string; end?: boolean },
): Promise<AgentRunResponse> {
  return request({
    method: "POST",
    path: `/api/agents/${enc(agentId)}/sim-call`,
    query: { businessId },
    body,
    schema: AgentRunResponseSchema,
  });
}

export function publishAgent(businessId: string, agentId: string, body: PublishRequest): Promise<PublishResponse> {
  return request({
    method: "POST",
    path: `/api/agents/${enc(agentId)}/publish`,
    query: { businessId },
    body,
    schema: PublishResponseSchema,
  });
}

/** API.md does not define the pause response body, so this resolves to nothing. Refetch the agent afterwards. */
export async function pauseAgent(businessId: string, agentId: string): Promise<void> {
  await request({ method: "POST", path: `/api/agents/${enc(agentId)}/pause`, query: { businessId }, body: {}, schema: Ignored });
}

export function listAgentVersions(businessId: string, agentId: string, query: ListParams = {}): Promise<Page<AgentVersion>> {
  return request({
    method: "GET",
    path: `/api/agents/${enc(agentId)}/versions`,
    query: { businessId, limit: query.limit, cursor: query.cursor },
    schema: AgentVersionPageSchema,
  });
}

/** SHOULD tier. */
export function rollbackAgent(businessId: string, agentId: string, body: RollbackRequest): Promise<PublishResponse> {
  return request({
    method: "POST",
    path: `/api/agents/${enc(agentId)}/rollback`,
    query: { businessId },
    body,
    schema: PublishResponseSchema,
  });
}

// --------------------------------------------------------- 3.5 owner voice

export function createRealtimeClientSecret(businessId: string, body: { builderSessionId: string }): Promise<RealtimeClientSecret> {
  return request({
    method: "POST",
    path: "/api/realtime/client-secret",
    query: { businessId },
    body,
    schema: RealtimeClientSecretSchema,
  });
}

// --------------------------------------------------- 3.6 live agent (owner-scoped)

export function getLiveAgent(): Promise<LiveAgent> {
  return request({ method: "GET", path: "/api/live-agent", schema: LiveAgentSchema });
}

export function setLiveAgent(body: { agentId: string }): Promise<LiveAgent> {
  return request({ method: "PUT", path: "/api/live-agent", body, schema: LiveAgentSchema });
}

// -------------------------------------------------------------- 3.7 approvals

export function listApprovals(businessId: string, query: ApprovalsQuery = {}): Promise<Page<ApprovalRequest>> {
  return request({
    method: "GET",
    path: "/api/approvals",
    query: { businessId, state: query.state, bundleType: query.bundleType, limit: query.limit, cursor: query.cursor },
    schema: ApprovalPageSchema,
  });
}

export function getApproval(businessId: string, approvalId: string): Promise<ApprovalRequest> {
  return request({
    method: "GET",
    path: `/api/approvals/${enc(approvalId)}`,
    query: { businessId },
    schema: ApprovalRequestSchema,
  });
}

/**
 * Sends the owner's decision with the payloadHash the UI displayed, plus an
 * Idempotency-Key header. Pass the same key when retrying the same click, so
 * the server replays the first answer (API.md section 1 and 3.7).
 */
export function decideApproval(
  businessId: string,
  approvalId: string,
  decision: ApprovalDecision,
  options: { idempotencyKey?: string } = {},
): Promise<DecisionResponse> {
  return request({
    method: "POST",
    path: `/api/approvals/${enc(approvalId)}/decision`,
    query: { businessId },
    body: decision,
    headers: { "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey() },
    schema: DecisionResponseSchema,
  });
}

// ----------------------------------------------------------------- 3.8 orders

export function listOrders(businessId: string, query: OrdersQuery = {}): Promise<Page<Order>> {
  return request({
    method: "GET",
    path: "/api/orders",
    query: { businessId, status: query.status, callId: query.callId, limit: query.limit, cursor: query.cursor },
    schema: OrderPageSchema,
  });
}

export function getOrder(businessId: string, orderId: string): Promise<Order> {
  return request({ method: "GET", path: `/api/orders/${enc(orderId)}`, query: { businessId }, schema: OrderSchema });
}

/** Link and QR data. Always sandbox. `ready` is false until Square created the link. */
export function getOrderCheckout(businessId: string, orderId: string): Promise<OrderCheckout> {
  return request({
    method: "GET",
    path: `/api/orders/${enc(orderId)}/checkout`,
    query: { businessId },
    schema: OrderCheckoutSchema,
  });
}

// --------------------------------------------------------------- 3.9 bookings

export function listBookings(businessId: string, query: BookingsQuery = {}): Promise<Page<Booking>> {
  return request({
    method: "GET",
    path: "/api/bookings",
    query: { businessId, status: query.status, from: query.from, to: query.to, limit: query.limit, cursor: query.cursor },
    schema: BookingPageSchema,
  });
}

export function getBooking(businessId: string, bookingId: string): Promise<Booking> {
  return request({ method: "GET", path: `/api/bookings/${enc(bookingId)}`, query: { businessId }, schema: BookingSchema });
}

// -------------------------------------------------------------- 3.10 activity

export function listActivity(businessId: string, query: ActivityQuery = {}): Promise<Page<ActivityEvent>> {
  return request({
    method: "GET",
    path: "/api/activity",
    query: {
      businessId,
      types: query.types,
      correlationId: query.correlationId,
      since: query.since,
      limit: query.limit,
      cursor: query.cursor,
    },
    schema: ActivityPageSchema,
  });
}

// ------------------------------------------------------------- 3.12 calls

export function listCalls(businessId: string, query: CallsQuery = {}): Promise<Page<Call>> {
  return request({
    method: "GET",
    path: "/api/calls",
    query: { businessId, agentId: query.agentId, since: query.since, limit: query.limit, cursor: query.cursor },
    schema: CallPageSchema,
  });
}

export function getCall(businessId: string, callId: string): Promise<Call> {
  return request({ method: "GET", path: `/api/calls/${enc(callId)}`, query: { businessId }, schema: CallSchema });
}

/** SHOULD tier (P-19). Screens leave this button out until the server has the route. */
export async function cancelOrder(businessId: string, orderId: string): Promise<Order> {
  const res = await request({
    method: "POST",
    path: `/api/orders/${enc(orderId)}/cancel`,
    query: { businessId },
    body: {},
    schema: OrderEnvelopeSchema,
  });
  return res.order;
}

/** SHOULD tier (P-19). Retry reuses the original idempotency key on the server. Leave the button out until the route exists. */
export async function resolveExecution(
  businessId: string,
  executionId: string,
  body: ExecutionResolveRequest,
): Promise<ActionExecution> {
  const res = await request({
    method: "POST",
    path: `/api/executions/${enc(executionId)}/resolve`,
    query: { businessId },
    body,
    schema: ExecutionEnvelopeSchema,
  });
  return res.execution;
}

/** SHOULD tier. p50 and p95 per metric. */
export function getTelemetry(businessId: string, query: { since?: string } = {}): Promise<TelemetryResponse> {
  return request({ method: "GET", path: "/api/telemetry", query: { businessId, since: query.since }, schema: TelemetryResponseSchema });
}

// ------------------------------------------------------ 3.11 integrations

export function getIntegrationsHealth(businessId: string, options: { refresh?: boolean } = {}): Promise<IntegrationHealth> {
  return request({
    method: "GET",
    path: "/api/integrations/health",
    query: { businessId, refresh: options.refresh ? 1 : undefined },
    schema: IntegrationHealthSchema,
  });
}
