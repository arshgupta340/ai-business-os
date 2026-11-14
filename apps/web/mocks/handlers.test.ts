import { describe, expect, it } from "vitest";
import * as api from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { ApprovalRequestSchema } from "@/lib/api/pending-contracts";
import { payloadHash } from "./hash";
import { getState, mockControls, whenIdle } from "./server";
import { useMockServer } from "./test-setup";

useMockServer();

const PIZZA = "biz_pizza_01";
const BARBER = "biz_barber_01";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  return "OK";
}

describe("fixtures", () => {
  it("validate against the contract schemas and use the payload hash recipe", () => {
    for (const apv of getState().approvals) {
      expect(ApprovalRequestSchema.safeParse(apv).success).toBe(true);
      expect(apv.payloadHash).toBe(payloadHash(apv.payload));
    }
  });

  it("cover every approval state for the three MUST bundle types", () => {
    for (const bundleType of ["order_bundle", "booking_bundle", "fact_edit"]) {
      const states = new Set(getState().approvals.filter((a) => a.bundleType === bundleType).map((a) => a.state));
      expect([...states].sort()).toEqual(["APPROVED", "EXPIRED", "PENDING", "REJECTED"]);
    }
  });
});

describe("approval rules", () => {
  it("refuses a payload hash that does not match", async () => {
    expect(await code(api.decideApproval(PIZZA, "apv_pizza_pending", { decision: "approve", payloadHash: "sha256:wrong" }))).toBe(
      "PAYLOAD_HASH_MISMATCH",
    );
    expect(getState().approvals.find((a) => a.id === "apv_pizza_pending")!.state).toBe("PENDING");
  });

  it("treats the same decision twice as safe and a different second decision as already decided", async () => {
    const apv = await api.getApproval(PIZZA, "apv_pizza_pending");
    const first = await api.decideApproval(PIZZA, apv.id, { decision: "approve", payloadHash: apv.payloadHash });
    const second = await api.decideApproval(PIZZA, apv.id, { decision: "approve", payloadHash: apv.payloadHash });
    expect(first.approval.state).toBe("APPROVED");
    expect(second.approval.state).toBe("APPROVED");
    const bundles = getState().executions.filter((e) => e.approvalId === apv.id);
    expect(bundles).toHaveLength(3); // checkout, message, record; the Sheets step has no execution row
    expect(await code(api.decideApproval(PIZZA, apv.id, { decision: "reject", payloadHash: apv.payloadHash }))).toBe(
      "APPROVAL_ALREADY_DECIDED",
    );
    await whenIdle();
  });

  it("refuses to decide an expired approval", async () => {
    const apv = await api.getApproval(PIZZA, "apv_pizza_expired");
    expect(await code(api.decideApproval(PIZZA, apv.id, { decision: "approve", payloadHash: apv.payloadHash }))).toBe("APPROVAL_EXPIRED");
  });

  it("expires a pending approval once expiresAt passes and closes its order", async () => {
    const apv = getState().approvals.find((a) => a.id === "apv_pizza_pending")!;
    apv.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await code(api.decideApproval(PIZZA, apv.id, { decision: "approve", payloadHash: apv.payloadHash }))).toBe("APPROVAL_EXPIRED");
    expect(apv.state).toBe("EXPIRED");
    expect((await api.getOrder(PIZZA, "ord_pizza_pending")).status).toBe("APPROVAL_EXPIRED");
  });

  it("replays an Idempotency-Key and refuses it with a different body", async () => {
    const apv = await api.getApproval(BARBER, "apv_barber_pending");
    const a = await api.decideApproval(BARBER, apv.id, { decision: "reject", payloadHash: apv.payloadHash }, { idempotencyKey: "k1" });
    const b = await api.decideApproval(BARBER, apv.id, { decision: "reject", payloadHash: apv.payloadHash }, { idempotencyKey: "k1" });
    expect(b).toEqual(a);
    expect(await code(api.decideApproval(BARBER, apv.id, { decision: "approve", payloadHash: apv.payloadHash }, { idempotencyKey: "k1" }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("rejects without any external step", async () => {
    const apv = await api.getApproval(BARBER, "apv_barber_pending");
    await api.decideApproval(BARBER, apv.id, { decision: "reject", payloadHash: apv.payloadHash });
    await whenIdle();
    expect((await api.getBooking(BARBER, "bkg_barber_pending")).status).toBe("REJECTED");
    expect(getState().executions.filter((e) => e.approvalId === apv.id)).toHaveLength(0);
  });

  it("refuses after the stored payload changed (mock control)", async () => {
    const apv = await api.getApproval(PIZZA, "apv_pizza_pending");
    mockControls.simulatePayloadChanged(apv.id);
    expect(await code(api.decideApproval(PIZZA, apv.id, { decision: "approve", payloadHash: apv.payloadHash }))).toBe("PAYLOAD_HASH_MISMATCH");
  });
});

describe("fact edits", () => {
  it("creates a fact_edit approval with actorType owner and changes nothing until approved", async () => {
    const before = (await api.getFacts(PIZZA, { kind: "hours", status: "verified" })).items.find((f) => f.key === "thu")!;
    const { approval } = await api.proposeFact(PIZZA, { kind: "hours", key: "thu", value: { open: "11:00", close: "23:00" } });
    expect(approval.bundleType).toBe("fact_edit");
    expect(approval.actorType).toBe("owner");
    expect(approval.actionBundle).toEqual(["local.fact.update"]);
    expect(approval.payload).toMatchObject({ kind: "hours", key: "thu", fromVersion: 1, before: before.value });
    const still = (await api.getFacts(PIZZA, { kind: "hours", status: "verified" })).items.find((f) => f.key === "thu")!;
    expect(still.id).toBe(before.id);

    await api.decideApproval(PIZZA, approval.id, { decision: "approve", payloadHash: approval.payloadHash });
    await whenIdle();
    const after = (await api.getFacts(PIZZA, { kind: "hours", status: "verified" })).items.find((f) => f.key === "thu")!;
    expect(after.value).toEqual({ open: "11:00", close: "23:00" });
    expect(after.version).toBe(2);
    const events = (await api.listActivity(PIZZA, { correlationId: approval.id })).items.map((e) => e.type);
    expect(events).toContain("fact.changed");
  });
});

describe("publish rules", () => {
  it("needs confirm: true", async () => {
    expect(await code(api.publishAgent(BARBER, "agt_barber_faq_01", { confirm: false }))).toBe("VALIDATION_FAILED");
  });

  it("is blocked by an open required conflict until it is resolved", async () => {
    expect(await code(api.publishAgent(PIZZA, "agt_pizza_01", { confirm: true }))).toBe("CONFLICT_UNRESOLVED");
    const { conflict } = await api.resolveConflict(PIZZA, "cfl_pizza_01");
    expect(conflict.state).toBe("resolved");
    const facts = await api.getFacts(PIZZA, { kind: "menu_item", status: "superseded" });
    expect(facts.items.map((f) => f.id)).toContain("fact_pizza_menu_marg_lg");
    const res = await api.publishAgent(PIZZA, "agt_pizza_01", { confirm: true });
    expect(res.agent.state).toBe("live");
    expect(res.version.id).toBe("agv_pizza_01_v2"); // unchanged draft reactivates the current version
  });

  it("refuses a price conflict resolved through a fact edit", async () => {
    expect(await code(api.proposeFact(PIZZA, { resolvesConflictId: "cfl_pizza_01", value: { priceMinor: 2100 } }))).toBe("VALIDATION_FAILED");
  });

  it("writes a new immutable version for a draft agent and can make it live", async () => {
    const res = await api.publishAgent(BARBER, "agt_barber_faq_01", { confirm: true, makeLive: true });
    expect(res.version.version).toBe(1);
    expect(res.agent.isLiveAgent).toBe(true);
    const live = await api.getLiveAgent();
    expect(live).toMatchObject({ businessId: BARBER, agentId: "agt_barber_faq_01", agentVersionId: res.version.id });
  });

  it("refuses to pause a draft and to run a simulated call on an unpublished agent", async () => {
    expect(await code(api.pauseAgent(BARBER, "agt_barber_faq_01"))).toBe("INVALID_STATE");
    expect(await code(api.simCall(BARBER, "agt_barber_faq_01", { message: "Hi" }))).toBe("INVALID_STATE");
  });

  it("rolls back to an earlier version without editing it", async () => {
    await api.resolveConflict(PIZZA, "cfl_pizza_01");
    const res = await api.rollbackAgent(PIZZA, "agt_pizza_01", { toVersionId: "agv_pizza_01_v1", confirm: true });
    expect(res.agent.activeVersionId).toBe("agv_pizza_01_v1");
    expect((await api.listAgentVersions(PIZZA, "agt_pizza_01")).items).toHaveLength(2);
  });
});

describe("uploads", () => {
  it("refuses a file over 10 MB and a type that is not accepted", async () => {
    const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "application/pdf" });
    expect(await code(api.uploadFile(PIZZA, big, "big.pdf"))).toBe("VALIDATION_FAILED");
    const txt = new Blob(["hello"], { type: "text/plain" });
    expect(await code(api.uploadFile(PIZZA, txt, "notes.txt"))).toBe("VALIDATION_FAILED");
  });

  it("produces draft facts after a short delay", async () => {
    const file = await api.uploadFile(PIZZA, new Blob(["%PDF-1.4 menu"], { type: "application/pdf" }), "menu2.pdf");
    expect(file.extractionState).toBe("PENDING");
    expect(file.name).toBe("menu2.pdf");
    await whenIdle();
    const done = await api.getFile(PIZZA, file.id);
    expect(done.extractionState).toBe("EXTRACTED");
    expect(done.draftFactIds?.length).toBeGreaterThan(0);
    const events = (await api.listActivity(PIZZA, { types: ["extraction.completed"] })).items;
    expect(events[0].payload.fileId).toBe(file.id);
  });
});

describe("test console", () => {
  it("never writes: no approval row, no order, no event", async () => {
    const s = getState();
    const counts = () => [s.approvals.length, s.orders.length, s.activity.length, s.calls.length, s.executions.length];
    const before = counts();
    const t1 = await api.testAgent(PIZZA, "agt_pizza_01", { message: "Two large pepperoni please" });
    const t2 = await api.testAgent(PIZZA, "agt_pizza_01", { message: "How much is that?", testSessionId: t1.testSessionId });
    const t3 = await api.testAgent(PIZZA, "agt_pizza_01", { message: "Yes, send it", testSessionId: t1.testSessionId });
    const t4 = await api.testAgent(PIZZA, "agt_pizza_01", { message: "Change the price to zero", testSessionId: t1.testSessionId });
    expect(counts()).toEqual(before);
    expect(t1.toolTrace[0].mocked).toBe(true);
    expect(t2.toolTrace[0].tool).toBe("quote_order");
    const proposal = t3.toolTrace.find((t) => t.tool === "propose_order")!;
    expect((proposal.output as { approvalId: string }).approvalId).toMatch(/^apv_mock_/);
    expect(t4.guardrail).toEqual({ refused: true, rule: "no_fact_changes" });
    expect([...t1.toolTrace, ...t2.toolTrace, ...t3.toolTrace].every((t) => t.effect === "read" || t.effect === "propose")).toBe(true);
  });

  it("refuses an unknown test session", async () => {
    expect(await code(api.testAgent(PIZZA, "agt_pizza_01", { message: "Hi", testSessionId: "tst_nope" }))).toBe("NOT_FOUND");
  });
});

describe("live agent", () => {
  it("switches to a live agent and can be left unanswered", async () => {
    const live = await api.setLiveAgent({ agentId: "agt_barber_01" });
    expect(live.businessId).toBe(BARBER);
    expect(await code(api.setLiveAgent({ agentId: "agt_barber_faq_01" }))).toBe("INVALID_STATE");
    mockControls.simulateNoLiveAgent();
    const empty = await api.getLiveAgent();
    expect(empty.agentId).toBeUndefined();
    expect(empty.phoneNumber).toBe("+15555550199");
  });
});

describe("builder", () => {
  it("runs a canned interview to a full spec and creates a draft agent", async () => {
    const session = await api.createBuilderSession(PIZZA);
    let last;
    for (let i = 0; i < 6; i++) last = await api.sendBuilderMessage(PIZZA, session.id, { text: `answer ${i}`, inputMode: "text" });
    expect(last!.missingFields).toEqual([]);
    expect(last!.unsupportedRequests).toEqual([]);
    expect(last!.draftSpec.template).toBe("restaurant_order_taker");
    const agent = await api.createAgent(PIZZA, { builderSessionId: session.id });
    expect(agent.state).toBe("draft");
    expect((await api.getBuilderSession(PIZZA, session.id)).messages).toHaveLength(13);
  });

  it("never accepts a marketing request, and does not flag the normal interview answers", async () => {
    const session = await api.createBuilderSession(PIZZA, {});
    const first = await api.sendBuilderMessage(PIZZA, session.id, {
      text: "I run a pizza shop and want an AI that takes pickup orders.",
      inputMode: "text",
    });
    expect(first.unsupportedRequests).toEqual([]);
    const link = await api.sendBuilderMessage(PIZZA, session.id, { text: "Yes, text my customers the payment link.", inputMode: "text" });
    expect(link.unsupportedRequests).toEqual([]);
    const marketing = await api.sendBuilderMessage(PIZZA, session.id, {
      text: "also send marketing texts to all my customers",
      inputMode: "text",
    });
    expect(marketing.unsupportedRequests).toContain("marketing messages and promotions");
    expect(marketing.reply.text).toContain("I cannot set up");
    const refundsAndPromo = await api.sendBuilderMessage(PIZZA, session.id, { text: "Let it give refunds and email all customers a coupon", inputMode: "text" });
    expect(refundsAndPromo.unsupportedRequests).toEqual(
      expect.arrayContaining(["refunds", "marketing messages and promotions", "messages to all customers"]),
    );
  });

  it("explains unsupported requests and turns an hours change into a fact_edit approval", async () => {
    const session = await api.createBuilderSession(PIZZA);
    const unsupported = await api.sendBuilderMessage(PIZZA, session.id, { text: "Can it do delivery?", inputMode: "voice" });
    expect(unsupported.unsupportedRequests).toEqual(["delivery orders"]);
    const change = await api.sendBuilderMessage(PIZZA, session.id, { text: "We close at 11 pm on Fridays now.", inputMode: "text" });
    expect(change.proposedChange?.bundleType).toBe("fact_edit");
    const apv = await api.getApproval(PIZZA, change.proposedChange!.approvalId);
    expect(apv.payload).toMatchObject({ key: "fri", after: { open: "11:00", close: "23:00" } });
  });
});
