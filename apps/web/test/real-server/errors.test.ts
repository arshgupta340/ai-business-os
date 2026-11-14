// Error envelopes from the real server, read by the web client: no token, a bad token, another
// owner's business, an unknown id and a validation error each become the ApiError the screens and
// the session layer (SessionErrorHandler through session-errors.ts) expect.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { reportApiError, subscribeApiErrors, type ApiErrorReport } from "@/lib/api/session-errors";
import { BARBER, OTHER_BUSINESS, PIZZA, rejection, setToken, startRealServer, type RealServer } from "./harness";

vi.mock("@/lib/supabase/client", async () => (await import("./harness")).fakeSupabaseModule);

let s: RealServer;
beforeAll(async () => {
  s = await startRealServer();
}, 120_000);
afterAll(async () => {
  await s?.close();
});
afterEach(() => {
  setToken("owner");
});

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err = await rejection(p);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

type Case = readonly [name: string, run: () => Promise<unknown>];

/** Calls on owner routes, builder routes and /api/businesses/:id routes. */
const scopedCalls = (businessId: string): Case[] => [
  ["listOrders", () => api.listOrders(businessId)],
  ["listApprovals", () => api.listApprovals(businessId)],
  ["listAgents", () => api.listAgents(businessId)],
  ["createBuilderSession", () => api.createBuilderSession(businessId)],
  ["getFacts", () => api.getFacts(businessId)],
  ["getBusiness", () => api.getBusiness(businessId)],
  ["getTelemetry", () => api.getTelemetry(businessId)],
];

describe("no token (signed out)", () => {
  it("sends no Authorization header", async () => {
    setToken(null);
    await rejection(api.listBusinesses());
    expect(s.requests.at(-1)!.headers.has("Authorization")).toBe(false);
  });

  const signedOutCases: Case[] = [["listBusinesses", () => api.listBusinesses()], ["getLiveAgent", () => api.getLiveAgent()], ...scopedCalls(PIZZA)];
  it.each(signedOutCases)(
    "%s answers UNAUTHENTICATED, which signs the owner out",
    async (_name, run) => {
      setToken(null);
      const err = await apiError(run());
      expect(err).toMatchObject({ code: "UNAUTHENTICATED", status: 401, kind: "http", retryable: false });
      expect(err.message.length).toBeGreaterThan(0);
    },
  );

  it("a token the server cannot verify also answers UNAUTHENTICATED", async () => {
    setToken("not-a-real-token");
    const err = await apiError(api.listOrders(PIZZA));
    expect(err.code).toBe("UNAUTHENTICATED");
    const builder = await apiError(api.listAgents(PIZZA));
    expect(builder.code).toBe("UNAUTHENTICATED");
  });
});

describe("another owner's business", () => {
  it.each(scopedCalls(PIZZA))("%s with the stranger's token answers FORBIDDEN_BUSINESS", async (_name, run) => {
    setToken("other");
    const err = await apiError(run());
    expect(err).toMatchObject({ code: "FORBIDDEN_BUSINESS", status: 403, kind: "http", retryable: false });
  });

  it.each(scopedCalls(OTHER_BUSINESS))("%s with the owner's token on the stranger's business answers FORBIDDEN_BUSINESS", async (_name, run) => {
    const err = await apiError(run());
    expect(err.code).toBe("FORBIDDEN_BUSINESS");
  });

  it("the stranger sees only their own business", async () => {
    setToken("other");
    const res = await api.listBusinesses();
    expect(res.items.map((b) => b.id)).toEqual([OTHER_BUSINESS]);
  });

  it("the session layer receives FORBIDDEN_BUSINESS with the business of the failed query", async () => {
    setToken("other");
    const reports: ApiErrorReport[] = [];
    const unsubscribe = subscribeApiErrors((r) => reports.push(r));
    try {
      const err = await rejection(api.listOrders(PIZZA));
      reportApiError(err, ["api", "biz", PIZZA, "orders"]);
    } finally {
      unsubscribe();
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]!.businessId).toBe(PIZZA);
    expect(reports[0]!.error.code).toBe("FORBIDDEN_BUSINESS");
  });
});

describe("unknown ids", () => {
  const unknownIds: Case[] = [
    ["getOrder", () => api.getOrder(PIZZA, "ord_missing")],
    ["getOrderCheckout", () => api.getOrderCheckout(PIZZA, "ord_missing")],
    ["getApproval", () => api.getApproval(PIZZA, "apv_missing")],
    ["getBooking", () => api.getBooking(BARBER, "bkg_missing")],
    ["getCall", () => api.getCall(PIZZA, "call_missing")],
    ["getAgent", () => api.getAgent(PIZZA, "agt_missing")],
    ["listAgentVersions", () => api.listAgentVersions(PIZZA, "agt_missing")],
    ["getBuilderSession", () => api.getBuilderSession(PIZZA, "bld_missing")],
    ["getFile", () => api.getFile(PIZZA, "file_missing")],
    ["decideApproval", () => api.decideApproval(PIZZA, "apv_missing", { decision: "approve", payloadHash: `sha256:${"0".repeat(64)}` })],
    ["setLiveAgent", () => api.setLiveAgent({ agentId: "agt_missing" })],
  ];
  it.each(unknownIds)("%s answers NOT_FOUND", async (_name, run) => {
    const err = await apiError(run());
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404, kind: "http", retryable: false });
  });

  it("an order of the other seeded business answers NOT_FOUND, never confirming it exists", async () => {
    const order = await s.world.t.db.query("select id from orders limit 1");
    const id = (order.rows[0] as { id: string } | undefined)?.id ?? "ord_missing";
    const err = await apiError(api.getOrder(BARBER, id));
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("validation errors", () => {
  it("decideApproval with a malformed hash answers VALIDATION_FAILED", async () => {
    const err = await apiError(api.decideApproval(PIZZA, "apv_missing", { decision: "approve", payloadHash: "not-a-hash" }));
    expect(err).toMatchObject({ code: "VALIDATION_FAILED", status: 400, retryable: false });
  });

  it("a limit above the page maximum answers VALIDATION_FAILED", async () => {
    const err = await apiError(api.listOrders(PIZZA, { limit: 100000 }));
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(s.requests.at(-1)!.url.searchParams.get("limit")).toBe("100000");
  });

  it("an unknown order status in the filter answers VALIDATION_FAILED", async () => {
    const err = await apiError(api.listOrders(PIZZA, { status: ["NOT_A_STATUS" as never] }));
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  it("a builder message over the length cap answers VALIDATION_FAILED", async () => {
    const session = await api.createBuilderSession(PIZZA);
    const err = await apiError(api.sendBuilderMessage(PIZZA, session.id, { text: "x".repeat(4001), inputMode: "text" }));
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  it("updateBusiness with an empty name answers VALIDATION_FAILED", async () => {
    const err = await apiError(api.updateBusiness(PIZZA, { name: "" }));
    expect(err.code).toBe("VALIDATION_FAILED");
  });
});

describe("correlation ids", () => {
  it("every error carries the server's X-Correlation-Id", async () => {
    const err = await apiError(api.getOrder(PIZZA, "ord_missing"));
    expect(err.correlationId).toBeTruthy();
    setToken(null);
    const signedOut = await apiError(api.listAgents(PIZZA));
    expect(signedOut.correlationId).toBeTruthy();
  });
});
