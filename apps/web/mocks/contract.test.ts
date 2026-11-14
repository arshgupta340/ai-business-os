/**
 * Drift guard: one request to every endpoint in ENDPOINTS through the mock
 * test server, each answer parsed with that endpoint's response schema from
 * @abos/contracts. A new endpoint in the contract fails the typecheck here
 * until it gets a case. The second block reads every fixture row through the
 * list endpoints, so every seeded record is checked too.
 */
import { describe, expect, it } from "vitest";
import { buildPath, ENDPOINTS, type EndpointName } from "@abos/contracts";
import { pizzaSpec } from "./fixtures";
import { getState, mockControls, whenIdle } from "./server";
import { TEST_BASE_URL, useMockServer } from "./test-setup";

useMockServer();

const PIZZA = "biz_pizza_01";
const BARBER = "biz_barber_01";

type Req = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
};

async function send(name: EndpointName, req: Req = {}): Promise<{ status: number; json: unknown }> {
  const def = ENDPOINTS[name];
  const url = new URL(`${TEST_BASE_URL}${buildPath(def.path, req.params)}`);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: "application/json", Authorization: "Bearer test-token", ...req.headers };
  let body: BodyInit | undefined;
  if (req.form) body = req.form;
  else if (req.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.body);
  }
  const res = await fetch(url, { method: def.method, headers, body });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function expectContract(name: EndpointName, req: Req = {}): Promise<unknown> {
  const { status, json } = await send(name, req);
  expect({ name, status, json: status >= 400 ? json : "ok" }).toEqual({ name, status: ENDPOINTS[name].successStatus, json: "ok" });
  const parsed = ENDPOINTS[name].response.safeParse(json);
  if (!parsed.success) throw new Error(`${name}: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data;
}

const biz = (businessId = PIZZA) => ({ businessId });

async function newBuilderSession(): Promise<string> {
  const session = (await expectContract("createBuilderSession", { query: biz(), body: {} })) as { id: string };
  return session.id;
}

/** One case per endpoint. Returns the request; may prepare state first. */
const CASES: Record<EndpointName, () => Req | Promise<Req>> = {
  listBusinesses: () => ({}),
  getBusiness: () => ({ params: { id: PIZZA } }),
  updateBusiness: () => ({ params: { id: PIZZA }, body: { name: "Demo Pizza Co." } }),
  listFacts: () => ({ params: { id: PIZZA } }),
  proposeFact: () => ({ params: { id: PIZZA }, body: { kind: "hours", key: "tue", value: { open: "11:00", close: "22:00" } } }),
  getCatalog: () => ({ params: { id: PIZZA } }),
  syncCatalog: () => ({ params: { id: PIZZA }, body: {} }),
  proposePrice: () => ({ params: { id: PIZZA }, body: { variationId: "SQ_VAR_MARG_LG", newPriceMinor: 2100, currency: "USD" } }),
  resolveConflict: () => ({ params: { id: "cfl_pizza_02" }, query: biz(), body: { resolution: "keep_authoritative" } }),
  uploadFile: () => {
    const form = new FormData();
    form.set("file", new Blob(["%PDF-1.4 menu"], { type: "application/pdf" }), "menu.pdf");
    return { params: { id: PIZZA }, form };
  },
  getFile: () => ({ params: { id: "file_menu_01" }, query: biz() }),
  createBuilderSession: () => ({ query: biz(), body: {} }),
  getBuilderSession: async () => ({ params: { id: await newBuilderSession() }, query: biz() }),
  sendBuilderMessage: async () => ({ params: { id: await newBuilderSession() }, query: biz(), body: { text: "Take pizza orders", inputMode: "text" } }),
  listAgents: () => ({ query: biz() }),
  createAgent: () => ({ query: biz(), body: { spec: pizzaSpec({ status: "draft", version: 1 }) } }),
  getAgent: () => ({ params: { id: "agt_pizza_01" }, query: biz() }),
  previewAgent: () => ({ params: { id: "agt_pizza_01" }, query: biz(), body: {} }),
  testAgent: () => ({ params: { id: "agt_pizza_01" }, query: biz(), body: { message: "How much is it?" } }),
  simCall: () => ({ params: { id: "agt_pizza_01" }, query: biz(), body: { message: "One large margherita" } }),
  publishAgent: () => ({ params: { id: "agt_barber_01" }, query: biz(BARBER), body: { confirm: true } }),
  pauseAgent: () => ({ params: { id: "agt_pizza_01" }, query: biz(), body: {} }),
  listAgentVersions: () => ({ params: { id: "agt_pizza_01" }, query: biz() }),
  rollbackAgent: async () => {
    // The required conflict blocks a rollback; keep the Square price first.
    await expectContract("resolveConflict", { params: { id: "cfl_pizza_01" }, query: biz(), body: { resolution: "keep_authoritative" } });
    return { params: { id: "agt_pizza_01" }, query: biz(), body: { toVersionId: "agv_pizza_01_v1", confirm: true } };
  },
  createRealtimeClientSecret: async () => ({ query: biz(), body: { builderSessionId: await newBuilderSession() } }),
  getLiveAgent: () => ({}),
  putLiveAgent: () => ({ body: { agentId: "agt_barber_01" } }),
  listApprovals: () => ({ query: biz() }),
  getApproval: () => ({ params: { id: "apv_pizza_pending" }, query: biz() }),
  decideApproval: () => {
    const apv = getState().approvals.find((a) => a.id === "apv_pizza_pending")!;
    return {
      params: { id: apv.id },
      query: biz(),
      headers: { "Idempotency-Key": "contract-test" },
      body: { decision: "approve", payloadHash: apv.payloadHash },
    };
  },
  listOrders: () => ({ query: biz() }),
  getOrder: () => ({ params: { id: "ord_pizza_paid" }, query: biz() }),
  getOrderCheckout: () => ({ params: { id: "ord_pizza_link" }, query: biz() }),
  cancelOrder: () => ({ params: { id: "ord_pizza_link" }, query: biz(), body: {} }),
  resolveExecution: () => {
    // No seeded step needs review, so mark one the way the executor would.
    const exe = getState().executions.find((e) => e.approvalId === "apv_pizza_link" && e.actionType === "message.checkout.send")!;
    exe.status = "NEEDS_REVIEW";
    return { params: { id: exe.id }, query: biz(), body: { action: "retry" } };
  },
  listBookings: () => ({ query: biz(BARBER) }),
  getBooking: () => ({ params: { id: "bkg_barber_booked" }, query: biz(BARBER) }),
  listCalls: () => ({ query: biz() }),
  getCall: () => ({ params: { id: "call_pizza_ready" }, query: biz() }),
  listActivity: () => ({ query: biz() }),
  getIntegrationsHealth: () => ({ query: biz() }),
  getTelemetry: () => ({ query: biz() }),
};

describe("every mocked endpoint answers with its contract response schema", () => {
  it.each(Object.keys(ENDPOINTS) as EndpointName[])("%s", async (name) => {
    const req = await CASES[name]();
    await expectContract(name, req);
    await whenIdle();
  });
});

describe("every seeded row parses under the contract", () => {
  it.each([PIZZA, BARBER])("lists of %s", async (businessId) => {
    const q = { ...biz(businessId), limit: "200" };
    for (const state of ["PENDING", "APPROVED", "REJECTED", "EXPIRED"]) {
      await expectContract("listApprovals", { query: { ...q, state } });
    }
    for (const status of ["draft", "verified", "superseded"]) {
      await expectContract("listFacts", { params: { id: businessId }, query: { status } });
    }
    await expectContract("listOrders", { query: q });
    await expectContract("listBookings", { query: q });
    await expectContract("listCalls", { query: q });
    await expectContract("listActivity", { query: q });
    const agents = (await expectContract("listAgents", { query: q })) as { items: { id: string }[] };
    for (const agent of agents.items) {
      await expectContract("listAgentVersions", { params: { id: agent.id }, query: q });
    }
    for (const order of getState().orders.filter((o) => o.businessId === businessId)) {
      await expectContract("getOrderCheckout", { params: { id: order.id }, query: biz(businessId) });
    }
    for (const file of getState().files.filter((f) => f.businessId === businessId)) {
      await expectContract("getFile", { params: { id: file.id }, query: biz(businessId) });
    }
  });

  it("the scripted timelines write only contract-valid rows and events", async () => {
    const pizza = await mockControls.startPizzaCall();
    const booking = await mockControls.startBookingCall({ slotConflict: true });
    for (const [businessId, approvalId] of [
      [PIZZA, pizza.approvalId],
      [BARBER, booking.approvalId],
    ] as const) {
      const apv = getState().approvals.find((a) => a.id === approvalId)!;
      await expectContract("decideApproval", { params: { id: approvalId }, query: biz(businessId), body: { decision: "approve", payloadHash: apv.payloadHash } });
    }
    await whenIdle();
    for (const businessId of [PIZZA, BARBER]) {
      const q = { ...biz(businessId), limit: "200" };
      await expectContract("listActivity", { query: q });
      await expectContract("listOrders", { query: q });
      await expectContract("listBookings", { query: q });
      await expectContract("listCalls", { query: q });
      await expectContract("listApprovals", { query: { ...q, state: "APPROVED" } });
    }
    await expectContract("getOrderCheckout", { params: { id: pizza.orderId }, query: biz() });
  });
});
