/**
 * Typed fetch client for apps/server (docs/API.md section 3).
 *
 * - Method, path and response schema of every call come from ENDPOINTS in
 *   @abos/contracts. Bodies and queries are typed with EndpointBody and
 *   EndpointQuery, responses with EndpointResponse.
 * - Base URL from NEXT_PUBLIC_API_URL, bearer token from getAccessToken().
 * - Business scope (SPEC 2.9): businessId is in the path for /api/businesses/...
 *   and a query parameter on every other business-scoped route.
 * - Every non-2xx answer and every network failure throws ApiError.
 * - Every 2xx body is validated with the endpoint's response schema.
 */
import {
  buildPath,
  ENDPOINTS,
  type ActionExecution,
  type ApprovalDecision,
  type EndpointBody,
  type EndpointName,
  type EndpointQuery,
  type EndpointResponse,
  type FileRecord,
  type Order,
} from "@abos/contracts";
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

/**
 * An endpoint's query without businessId. The client functions take
 * businessId as their first argument and add it themselves.
 */
export type ScopedQuery<N extends EndpointName> = Omit<NonNullable<EndpointQuery<N>>, "businessId">;

// ------------------------------------------------------------------ core

type QueryValue = string | number | boolean | readonly string[] | undefined;

interface CallOptions<N extends EndpointName> {
  params?: Record<string, string>;
  query?: Record<string, QueryValue>;
  body?: EndpointBody<N>;
  formData?: FormData;
  headers?: Record<string, string>;
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

/** Sends one request to the endpoint `name` and validates the answer with its response schema. */
async function call<N extends EndpointName>(name: N, opts: CallOptions<N> = {}): Promise<EndpointResponse<N>> {
  const def = ENDPOINTS[name];
  const path = buildPath(def.path, opts.params);
  const url = buildUrl(path, opts.query);
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
    res = await config.fetch(url, { method: def.method, headers, body });
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

  const parsed = def.response.safeParse(json);
  if (!parsed.success) throw invalidResponseError(path, res.status, correlationId, parsed.error.issues);
  return parsed.data as EndpointResponse<N>;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// ------------------------------------------------- 3.1 businesses and facts

export function listBusinesses(): Promise<EndpointResponse<"listBusinesses">> {
  return call("listBusinesses");
}

export function getBusiness(businessId: string): Promise<EndpointResponse<"getBusiness">> {
  return call("getBusiness", { params: { id: businessId } });
}

export function updateBusiness(businessId: string, patch: EndpointBody<"updateBusiness">): Promise<EndpointResponse<"updateBusiness">> {
  return call("updateBusiness", { params: { id: businessId }, body: patch });
}

export function getFacts(businessId: string, query: EndpointQuery<"listFacts"> = {}): Promise<EndpointResponse<"listFacts">> {
  return call("listFacts", { params: { id: businessId }, query: { kind: query.kind, status: query.status } });
}

/** Creates a fact_edit approval (actorType owner). Nothing changes until the decision is approved. */
export function proposeFact(businessId: string, body: EndpointBody<"proposeFact">): Promise<EndpointResponse<"proposeFact">> {
  return call("proposeFact", { params: { id: businessId }, body });
}

export function syncCatalog(businessId: string): Promise<EndpointResponse<"syncCatalog">> {
  return call("syncCatalog", { params: { id: businessId }, body: {} });
}

/** SHOULD tier. Creates a price_edit approval. */
export function proposePrice(businessId: string, body: EndpointBody<"proposePrice">): Promise<EndpointResponse<"proposePrice">> {
  return call("proposePrice", { params: { id: businessId }, body });
}

/** Items grouped by squareItemId, display prices only. */
export function getCatalog(businessId: string): Promise<EndpointResponse<"getCatalog">> {
  return call("getCatalog", { params: { id: businessId } });
}

/**
 * Keeps the authoritative value: the conflict becomes resolved and the draft
 * fact superseded, with no approval. Preferring the uploaded price is a price
 * change through proposePrice instead.
 */
export function resolveConflict(
  businessId: string,
  conflictId: string,
  body: EndpointBody<"resolveConflict"> = { resolution: "keep_authoritative" },
): Promise<EndpointResponse<"resolveConflict">> {
  return call("resolveConflict", { params: { id: conflictId }, query: { businessId }, body });
}

// ------------------------------------------------------------- 3.2 files

export async function uploadFile(businessId: string, file: Blob, fileName?: string): Promise<FileRecord> {
  const form = new FormData();
  const name = fileName ?? (file as File).name ?? "upload";
  form.set("file", file, name);
  const res = await call("uploadFile", { params: { id: businessId }, formData: form });
  return res.file;
}

/** GET /api/files/:id answers with the FileRecord itself, not wrapped in { file }. */
export function getFile(businessId: string, fileId: string): Promise<FileRecord> {
  return call("getFile", { params: { id: fileId }, query: { businessId } });
}

// ------------------------------------------------------ 3.3 builder sessions

export function createBuilderSession(
  businessId: string,
  body: EndpointBody<"createBuilderSession"> = {},
): Promise<EndpointResponse<"createBuilderSession">> {
  return call("createBuilderSession", { query: { businessId }, body });
}

export function getBuilderSession(businessId: string, sessionId: string): Promise<EndpointResponse<"getBuilderSession">> {
  return call("getBuilderSession", { params: { id: sessionId }, query: { businessId } });
}

export function sendBuilderMessage(
  businessId: string,
  sessionId: string,
  body: EndpointBody<"sendBuilderMessage">,
): Promise<EndpointResponse<"sendBuilderMessage">> {
  return call("sendBuilderMessage", { params: { id: sessionId }, query: { businessId }, body });
}

// ---------------------------------------------------------------- 3.4 agents

export function listAgents(businessId: string, query: ScopedQuery<"listAgents"> = {}): Promise<EndpointResponse<"listAgents">> {
  return call("listAgents", { query: { businessId, state: query.state, limit: query.limit, cursor: query.cursor } });
}

export function createAgent(businessId: string, body: EndpointBody<"createAgent">): Promise<EndpointResponse<"createAgent">> {
  return call("createAgent", { query: { businessId }, body });
}

export function getAgent(businessId: string, agentId: string): Promise<EndpointResponse<"getAgent">> {
  return call("getAgent", { params: { id: agentId }, query: { businessId } });
}

/** Mock toolset only. Never causes a write (AC-03). */
export function previewAgent(
  businessId: string,
  agentId: string,
  body: EndpointBody<"previewAgent"> = {},
): Promise<EndpointResponse<"previewAgent">> {
  return call("previewAgent", { params: { id: agentId }, query: { businessId }, body });
}

/** Test console turn. Mock toolset only; approvals in the trace are apv_mock_ and never stored (AC-03). */
export function testAgent(businessId: string, agentId: string, body: EndpointBody<"testAgent">): Promise<EndpointResponse<"testAgent">> {
  return call("testAgent", { params: { id: agentId }, query: { businessId }, body });
}

/** Simulated call on a published agent. Real read and propose tools; label it "simulated call" in the UI. */
export function simCall(businessId: string, agentId: string, body: EndpointBody<"simCall">): Promise<EndpointResponse<"simCall">> {
  return call("simCall", { params: { id: agentId }, query: { businessId }, body });
}

export function publishAgent(businessId: string, agentId: string, body: EndpointBody<"publishAgent">): Promise<EndpointResponse<"publishAgent">> {
  return call("publishAgent", { params: { id: agentId }, query: { businessId }, body });
}

/** Answers with the paused Agent. */
export function pauseAgent(businessId: string, agentId: string): Promise<EndpointResponse<"pauseAgent">> {
  return call("pauseAgent", { params: { id: agentId }, query: { businessId }, body: {} });
}

export function listAgentVersions(
  businessId: string,
  agentId: string,
  query: ScopedQuery<"listAgentVersions"> = {},
): Promise<EndpointResponse<"listAgentVersions">> {
  return call("listAgentVersions", { params: { id: agentId }, query: { businessId, limit: query.limit, cursor: query.cursor } });
}

/** SHOULD tier. */
export function rollbackAgent(businessId: string, agentId: string, body: EndpointBody<"rollbackAgent">): Promise<EndpointResponse<"rollbackAgent">> {
  return call("rollbackAgent", { params: { id: agentId }, query: { businessId }, body });
}

// --------------------------------------------------------- 3.5 owner voice

export function createRealtimeClientSecret(
  businessId: string,
  body: EndpointBody<"createRealtimeClientSecret">,
): Promise<EndpointResponse<"createRealtimeClientSecret">> {
  return call("createRealtimeClientSecret", { query: { businessId }, body });
}

// --------------------------------------------------- 3.6 live agent (owner-scoped)

export function getLiveAgent(): Promise<EndpointResponse<"getLiveAgent">> {
  return call("getLiveAgent");
}

export function setLiveAgent(body: EndpointBody<"putLiveAgent">): Promise<EndpointResponse<"putLiveAgent">> {
  return call("putLiveAgent", { body });
}

// -------------------------------------------------------------- 3.7 approvals

export function listApprovals(businessId: string, query: ScopedQuery<"listApprovals"> = {}): Promise<EndpointResponse<"listApprovals">> {
  return call("listApprovals", {
    query: { businessId, state: query.state, bundleType: query.bundleType, limit: query.limit, cursor: query.cursor },
  });
}

export function getApproval(businessId: string, approvalId: string): Promise<EndpointResponse<"getApproval">> {
  return call("getApproval", { params: { id: approvalId }, query: { businessId } });
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
): Promise<EndpointResponse<"decideApproval">> {
  return call("decideApproval", {
    params: { id: approvalId },
    query: { businessId },
    body: decision,
    headers: { "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey() },
  });
}

// ----------------------------------------------------------------- 3.8 orders

export function listOrders(businessId: string, query: ScopedQuery<"listOrders"> = {}): Promise<EndpointResponse<"listOrders">> {
  return call("listOrders", {
    query: { businessId, status: query.status, callId: query.callId, limit: query.limit, cursor: query.cursor },
  });
}

export function getOrder(businessId: string, orderId: string): Promise<EndpointResponse<"getOrder">> {
  return call("getOrder", { params: { id: orderId }, query: { businessId } });
}

/** Link and QR data. Always sandbox. `ready` is false until Square created the link. */
export function getOrderCheckout(businessId: string, orderId: string): Promise<EndpointResponse<"getOrderCheckout">> {
  return call("getOrderCheckout", { params: { id: orderId }, query: { businessId } });
}

// --------------------------------------------------------------- 3.9 bookings

export function listBookings(businessId: string, query: ScopedQuery<"listBookings"> = {}): Promise<EndpointResponse<"listBookings">> {
  return call("listBookings", {
    query: { businessId, status: query.status, from: query.from, to: query.to, limit: query.limit, cursor: query.cursor },
  });
}

export function getBooking(businessId: string, bookingId: string): Promise<EndpointResponse<"getBooking">> {
  return call("getBooking", { params: { id: bookingId }, query: { businessId } });
}

// -------------------------------------------------------------- 3.10 activity

export function listActivity(businessId: string, query: ScopedQuery<"listActivity"> = {}): Promise<EndpointResponse<"listActivity">> {
  return call("listActivity", {
    query: {
      businessId,
      types: query.types,
      correlationId: query.correlationId,
      since: query.since,
      limit: query.limit,
      cursor: query.cursor,
    },
  });
}

// ------------------------------------------------------------------- calls

export function listCalls(businessId: string, query: ScopedQuery<"listCalls"> = {}): Promise<EndpointResponse<"listCalls">> {
  return call("listCalls", { query: { businessId, agentId: query.agentId, since: query.since, limit: query.limit, cursor: query.cursor } });
}

export function getCall(businessId: string, callId: string): Promise<EndpointResponse<"getCall">> {
  return call("getCall", { params: { id: callId }, query: { businessId } });
}

/** SHOULD tier (P-19). Screens leave this button out until the server has the route. */
export async function cancelOrder(businessId: string, orderId: string): Promise<Order> {
  const res = await call("cancelOrder", { params: { id: orderId }, query: { businessId }, body: {} });
  return res.order;
}

/** SHOULD tier (P-19). Retry reuses the original idempotency key on the server. Leave the button out until the route exists. */
export async function resolveExecution(
  businessId: string,
  executionId: string,
  body: EndpointBody<"resolveExecution">,
): Promise<ActionExecution> {
  const res = await call("resolveExecution", { params: { id: executionId }, query: { businessId }, body });
  return res.execution;
}

/** SHOULD tier. p50 and p95 per metric. */
export function getTelemetry(businessId: string, query: ScopedQuery<"getTelemetry"> = {}): Promise<EndpointResponse<"getTelemetry">> {
  return call("getTelemetry", { query: { businessId, since: query.since } });
}

// ------------------------------------------------------ 3.11 integrations

export function getIntegrationsHealth(
  businessId: string,
  options: { refresh?: boolean } = {},
): Promise<EndpointResponse<"getIntegrationsHealth">> {
  return call("getIntegrationsHealth", { query: { businessId, refresh: options.refresh ? "1" : undefined } });
}
