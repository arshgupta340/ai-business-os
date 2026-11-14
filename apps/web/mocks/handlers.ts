/**
 * MSW v2 handlers for every endpoint the client calls (docs/API.md section 3,
 * including 3.12). Paths start with a wildcard so any NEXT_PUBLIC_API_URL
 * origin is intercepted. Each handler adds a small latency, sweeps expired
 * approvals, and answers errors with the API.md envelope and real codes.
 */
import { delay, http, HttpResponse, type HttpResponseResolver } from "msw";
import { ERROR_CODE_INFO } from "@abos/contracts";
import * as db from "./db";
import * as scripts from "./scripts";
import { latencyMs } from "./scheduler";

type Ctx = { url: URL; request: Request; params: Record<string, string>; correlationId: string };

function correlation(request: Request): string {
  return request.headers.get("X-Correlation-Id") ?? `cor_${Math.random().toString(36).slice(2, 10)}`;
}

function errorResponse(err: db.MockHttpError, correlationId: string) {
  const info = ERROR_CODE_INFO[err.code];
  return HttpResponse.json(
    {
      code: err.code,
      message: err.message,
      correlationId,
      retryable: info.retryable,
      ...(err.details ? { details: err.details } : {}),
    },
    { status: info.httpStatus, headers: { "X-Correlation-Id": correlationId } },
  );
}

/** Wraps a handler body: latency, expiry sweep, JSON answer, error envelope. */
function route(fn: (ctx: Ctx) => unknown | Promise<unknown>, okStatus = 200): HttpResponseResolver {
  return async ({ request, params }) => {
    const correlationId = correlation(request);
    await delay(latencyMs());
    try {
      await db.ready();
      db.sweepExpired();
      const forced = db.takeRequestFailure(request.method, new URL(request.url).pathname);
      if (forced?.mode === "invalid") {
        // A 2xx body that does not match the contract, so the client reports invalid_response.
        return HttpResponse.json({ unexpected: "mock invalid response" } as never, { status: 200, headers: { "X-Correlation-Id": correlationId } });
      }
      if (forced) {
        throw new db.MockHttpError(forced.code ?? "INTERNAL", forced.message ?? "The server could not answer. This is a simulated failure.");
      }
      const result = await fn({ url: new URL(request.url), request, params: params as Record<string, string>, correlationId });
      if (result instanceof Response) {
        result.headers.set("X-Correlation-Id", correlationId);
        return result as never;
      }
      return HttpResponse.json(result as never, { status: okStatus, headers: { "X-Correlation-Id": correlationId } });
    } catch (err) {
      if (err instanceof db.MockHttpError) return errorResponse(err, correlationId);
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(new db.MockHttpError("INTERNAL", `Mock handler error: ${message}`), correlationId);
    } finally {
      // Browser mock only: keeps builder sessions across a reload (no effect in tests).
      db.saveBuilderSessions();
    }
  };
}

const biz = (ctx: Ctx) => db.requireBusiness(ctx.url.searchParams.get("businessId"));
const pathBiz = (ctx: Ctx) => db.requireBusiness(ctx.params.id);
const q = (ctx: Ctx, name: string) => ctx.url.searchParams.get(name);
const limit = (ctx: Ctx) => (q(ctx, "limit") ? Number(q(ctx, "limit")) : undefined);
const page = <T>(ctx: Ctx, rows: T[]) => db.paginate(rows, limit(ctx), q(ctx, "cursor"));

async function json(ctx: Ctx): Promise<Record<string, unknown>> {
  const text = await ctx.request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new db.MockHttpError("VALIDATION_FAILED", "The body must be a JSON object.", { issues: [{ path: "", message: "Invalid JSON" }] });
}

const A = "*/api";

export const handlers = [
  // ------------------------------------------------------------ 3.1
  http.get(`${A}/businesses`, route(() => ({ items: db.listBusinesses() }))),
  http.get(`${A}/businesses/:id`, route((ctx) => db.getBusiness(pathBiz(ctx)))),
  http.patch(`${A}/businesses/:id`, route(async (ctx) => db.updateBusiness(pathBiz(ctx), await json(ctx)))),
  http.get(
    `${A}/businesses/:id/facts`,
    route((ctx) => db.listFacts(pathBiz(ctx), q(ctx, "kind"), q(ctx, "status"))),
  ),
  http.post(
    `${A}/businesses/:id/facts/propose`,
    route(async (ctx) => {
      const businessId = pathBiz(ctx);
      const body = await json(ctx);
      if (!("resolvesConflictId" in body) && (typeof body.kind !== "string" || typeof body.key !== "string")) {
        throw new db.MockHttpError("VALIDATION_FAILED", "Send kind and key, or resolvesConflictId.", { issues: [{ path: "kind", message: "Required" }] });
      }
      if (!("value" in body)) throw new db.MockHttpError("VALIDATION_FAILED", "value is required.", { issues: [{ path: "value", message: "Required" }] });
      return await db.proposeFact(businessId, body as never);
    }, 201),
  ),
  http.get(`${A}/businesses/:id/catalog`, route((ctx) => db.getCatalog(pathBiz(ctx)))),
  http.post(`${A}/businesses/:id/catalog/sync`, route((ctx) => db.syncCatalog(pathBiz(ctx)), 202)),
  http.post(
    `${A}/businesses/:id/catalog/prices/propose`,
    route(async (ctx) => await db.proposePrice(pathBiz(ctx), (await json(ctx)) as never), 201),
  ),
  http.post(
    `${A}/conflicts/:id/resolve`,
    route(async (ctx) => db.resolveConflict(biz(ctx), ctx.params.id, (await json(ctx)).resolution)),
  ),

  // ------------------------------------------------------------ 3.2
  http.post(
    `${A}/businesses/:id/files`,
    route(async (ctx) => {
      const businessId = pathBiz(ctx);
      let form: FormData;
      try {
        form = await ctx.request.formData();
      } catch {
        throw new db.MockHttpError("VALIDATION_FAILED", "Send a multipart form with one field named file.", { issues: [{ path: "file", message: "Required" }] });
      }
      const file = form.get("file");
      if (!file || typeof file === "string") {
        throw new db.MockHttpError("VALIDATION_FAILED", "Send a multipart form with one field named file.", { issues: [{ path: "file", message: "Required" }] });
      }
      const blob = file as File;
      const bytes = blob.size <= db.MAX_UPLOAD_BYTES ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
      return { file: await db.createFile(businessId, { name: blob.name || "upload", mime: blob.type, size: blob.size, bytes }) };
    }, 202),
  ),
  // API 3.2: the bare FileRecord, not wrapped in { file }.
  http.get(`${A}/files/:id`, route((ctx) => db.getFile(biz(ctx), ctx.params.id))),

  // ------------------------------------------------------------ 3.3
  http.post(
    `${A}/builder/sessions`,
    route(async (ctx) => {
      const body = await json(ctx);
      return scripts.createBuilderSession(biz(ctx), typeof body.agentId === "string" ? body.agentId : undefined);
    }, 201),
  ),
  http.get(`${A}/builder/sessions/:id`, route((ctx) => scripts.builderSessionView(biz(ctx), ctx.params.id))),
  http.post(
    `${A}/builder/sessions/:id/messages`,
    route(async (ctx) => await scripts.sendBuilderMessage(biz(ctx), ctx.params.id, await json(ctx))),
  ),

  // ------------------------------------------------------------ 3.4
  http.get(`${A}/agents`, route((ctx) => page(ctx, db.listAgents(biz(ctx), q(ctx, "state"))))),
  http.post(`${A}/agents`, route(async (ctx) => db.createAgent(biz(ctx), (await json(ctx)) as never), 201)),
  http.get(`${A}/agents/:id`, route((ctx) => db.agentView(db.getAgentRecord(biz(ctx), ctx.params.id)))),
  http.post(
    `${A}/agents/:id/preview`,
    route((ctx) => scripts.previewFor(db.agentView(db.getAgentRecord(biz(ctx), ctx.params.id)))),
  ),
  http.post(
    `${A}/agents/:id/test`,
    route(async (ctx) => {
      const businessId = biz(ctx);
      const agent = db.agentView(db.getAgentRecord(businessId, ctx.params.id));
      return await scripts.testTurn(businessId, agent, await json(ctx));
    }),
  ),
  http.post(
    `${A}/agents/:id/sim-call`,
    route(async (ctx) => {
      const businessId = biz(ctx);
      const agent = db.agentView(db.getAgentRecord(businessId, ctx.params.id));
      return await scripts.simCallTurn(businessId, agent, await json(ctx));
    }),
  ),
  http.post(`${A}/agents/:id/publish`, route(async (ctx) => db.publishAgent(biz(ctx), ctx.params.id, await json(ctx)))),
  http.post(
    `${A}/agents/:id/pause`,
    route((ctx) => {
      const businessId = biz(ctx);
      db.pauseAgent(businessId, ctx.params.id);
      return db.agentView(db.getAgentRecord(businessId, ctx.params.id));
    }),
  ),
  http.get(`${A}/agents/:id/versions`, route((ctx) => page(ctx, db.listVersions(biz(ctx), ctx.params.id)))),
  http.post(`${A}/agents/:id/rollback`, route(async (ctx) => db.rollbackAgent(biz(ctx), ctx.params.id, (await json(ctx)) as never))),

  // ------------------------------------------------------------ 3.5
  http.post(
    `${A}/realtime/client-secret`,
    route(async (ctx) => {
      const businessId = biz(ctx);
      const body = await json(ctx);
      if (typeof body.builderSessionId !== "string") {
        throw new db.MockHttpError("VALIDATION_FAILED", "builderSessionId is required.", { issues: [{ path: "builderSessionId", message: "Required" }] });
      }
      scripts.getBuilderSession(businessId, body.builderSessionId);
      return {
        clientSecret: "ek_mock_not_a_real_secret",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        model: "gpt-realtime-2.1",
        builderSessionId: body.builderSessionId,
      };
    }),
  ),

  // ------------------------------------------------------------ 3.6
  http.get(`${A}/live-agent`, route(() => db.getLiveAgent())),
  http.put(`${A}/live-agent`, route(async (ctx) => db.putLiveAgent((await json(ctx)).agentId))),

  // ------------------------------------------------------------ 3.7
  http.get(
    `${A}/approvals`,
    route((ctx) => page(ctx, db.listApprovals(biz(ctx), { state: q(ctx, "state"), bundleType: q(ctx, "bundleType") }))),
  ),
  http.get(`${A}/approvals/:id`, route((ctx) => db.getApproval(biz(ctx), ctx.params.id))),
  http.post(
    `${A}/approvals/:id/decision`,
    route(async (ctx) => {
      const businessId = biz(ctx);
      const result = await db.decideApproval(businessId, ctx.params.id, await json(ctx), ctx.request.headers.get("Idempotency-Key"));
      return HttpResponse.json(result.body as never, { status: result.status });
    }),
  ),

  // ------------------------------------------------------------ 3.8, 3.9
  http.get(`${A}/orders`, route((ctx) => page(ctx, db.listOrders(biz(ctx), { status: q(ctx, "status"), callId: q(ctx, "callId") })))),
  http.get(`${A}/orders/:id`, route((ctx) => db.getOrder(biz(ctx), ctx.params.id))),
  http.get(`${A}/orders/:id/checkout`, route((ctx) => db.getCheckout(biz(ctx), ctx.params.id))),
  http.post(`${A}/orders/:id/cancel`, route((ctx) => db.cancelOrder(biz(ctx), ctx.params.id))),
  http.get(
    `${A}/bookings`,
    route((ctx) => page(ctx, db.listBookings(biz(ctx), { status: q(ctx, "status"), from: q(ctx, "from"), to: q(ctx, "to") }))),
  ),
  http.get(`${A}/bookings/:id`, route((ctx) => db.getBooking(biz(ctx), ctx.params.id))),
  http.post(
    `${A}/executions/:id/resolve`,
    route(async (ctx) => db.resolveExecution(biz(ctx), ctx.params.id, (await json(ctx)).action)),
  ),

  // ------------------------------------------------------------ 3.10 to 3.12
  http.get(
    `${A}/activity`,
    route((ctx) =>
      page(ctx, db.listActivity(biz(ctx), { types: q(ctx, "types"), correlationId: q(ctx, "correlationId"), since: q(ctx, "since") })),
    ),
  ),
  http.get(`${A}/integrations/health`, route((ctx) => (biz(ctx), db.getHealth(q(ctx, "refresh") === "1")))),
  http.get(`${A}/calls`, route((ctx) => page(ctx, db.listCalls(biz(ctx), { agentId: q(ctx, "agentId"), since: q(ctx, "since") })))),
  http.get(`${A}/calls/:id`, route((ctx) => db.getCall(biz(ctx), ctx.params.id))),
  http.get(`${A}/telemetry`, route((ctx) => db.getTelemetry(biz(ctx)))),
];
