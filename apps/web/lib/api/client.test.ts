import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import * as api from "./client";
import { configureApiClient } from "./client";
import { ApiError } from "./errors";
import { invalidationFor } from "./invalidation";
import { activityEventFromRow } from "@abos/contracts";
import { server } from "@/mocks/server";
import { requests, TEST_BASE_URL, useMockServer } from "@/mocks/test-setup";

useMockServer();

const PIZZA = "biz_pizza_01";

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("business scoping", () => {
  it("puts businessId in the path for /api/businesses/... routes", async () => {
    await api.getFacts(PIZZA, { kind: "hours" });
    const url = new URL(requests.at(-1)!.url);
    expect(url.pathname).toBe("/api/businesses/biz_pizza_01/facts");
    expect(url.searchParams.get("businessId")).toBeNull();
    expect(url.searchParams.get("kind")).toBe("hours");
  });

  it("puts businessId in the query on every other business-scoped route", async () => {
    await api.listOrders(PIZZA, { status: ["PAYMENT_PENDING", "PAID_VERIFIED"] });
    await api.getApproval(PIZZA, "apv_pizza_pending");
    await api.listCalls(PIZZA);
    for (const req of requests.slice(-3)) {
      expect(new URL(req.url).searchParams.get("businessId")).toBe(PIZZA);
    }
    expect(new URL(requests[0].url).searchParams.get("status")).toBe("PAYMENT_PENDING,PAID_VERIFIED");
  });

  it("keeps the owner-scoped routes free of businessId", async () => {
    await api.getLiveAgent();
    await api.listBusinesses();
    for (const req of requests) expect(new URL(req.url).searchParams.has("businessId")).toBe(false);
  });

  it("sends the bearer token", async () => {
    await api.listBusinesses();
    expect(requests[0].headers.get("Authorization")).toBe("Bearer test-token");
  });

  it("returns NOT_FOUND for another business's resource, never confirming it exists", async () => {
    const err = await caught(api.getOrder("biz_barber_01", "ord_pizza_paid"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
  });
});

describe("error mapping", () => {
  it("maps the envelope to ApiError with the correlation id from the header", async () => {
    const err = await caught(api.getOrder("biz_other_99", "ord_x"));
    expect(err.code).toBe("FORBIDDEN_BUSINESS");
    expect(err.status).toBe(403);
    expect(err.kind).toBe("http");
    expect(err.retryable).toBe(false);
    expect(err.correlationId).toMatch(/^cor_/);
  });

  it("keeps details from the server", async () => {
    const err = await caught(api.publishAgent(PIZZA, "agt_pizza_01", { confirm: true }));
    expect(err.code).toBe("CONFLICT_UNRESOLVED");
    expect(err.details?.conflictIds).toEqual(["cfl_pizza_01"]);
  });

  it("turns a network failure into a retryable ApiError", async () => {
    configureApiClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const err = await caught(api.listBusinesses());
    expect(err.kind).toBe("network");
    expect(err.code).toBe("INTERNAL");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(0);
  });

  it("rejects a 2xx body that does not match the contract", async () => {
    server.use(http.get(`${TEST_BASE_URL}/api/businesses/:id`, () => HttpResponse.json({ id: 42 })));
    const err = await caught(api.getBusiness(PIZZA));
    expect(err.kind).toBe("invalid_response");
    expect(err.retryable).toBe(false);
  });

  it("falls back to a code from the status when the body is not an envelope", async () => {
    server.use(http.get(`${TEST_BASE_URL}/api/live-agent`, () => new HttpResponse("busy", { status: 429 })));
    const err = await caught(api.getLiveAgent());
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
  });
});

describe("approval decision request", () => {
  it("sends the payload hash in the body and an Idempotency-Key header", async () => {
    const apv = await api.getApproval(PIZZA, "apv_pizza_pending");
    await api.decideApproval(PIZZA, apv.id, { decision: "reject", payloadHash: apv.payloadHash }, { idempotencyKey: "key-1" });
    const req = requests.at(-1)!;
    expect(req.headers.get("Idempotency-Key")).toBe("key-1");
    expect(await req.json()).toEqual({ decision: "reject", payloadHash: apv.payloadHash });
  });
});

describe("realtime helpers", () => {
  it("maps a snake_case activity_events row to an ActivityEvent", () => {
    const event = activityEventFromRow({
      id: "evt_1",
      business_id: PIZZA,
      type: "payment.verified",
      correlation_id: "call_1",
      actor_type: "provider",
      occurred_at: "2026-11-14T19:06:30Z",
      payload: { orderId: "ord_1", squarePaymentId: "SQ_PAY_1", amountMinor: 4731, currency: "USD", sandbox: true },
    });
    expect(event.businessId).toBe(PIZZA);
    // The contract's mapping throws on a row it cannot read (useActivityFeed catches it; see realtime-row.ts).
    expect(() => activityEventFromRow({ id: "evt_2", type: "not.a.type" })).toThrow();
  });

  it("refetches orders on payment and order status events", () => {
    expect(invalidationFor("payment.verified").resources).toContain("orders");
    expect(invalidationFor("order.status_changed").resources).toContain("orders");
    expect(invalidationFor("live_agent.changed").liveAgent).toBe(true);
  });
});
