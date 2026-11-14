import { describe, expect, it } from "vitest";
import * as api from "@/lib/api/client";
import { subscribeMockActivity } from "@/lib/api/mock-bridge";
import type { ActivityEvent } from "@abos/contracts";
import { advanceMockClock, getState, mockControls, whenIdle } from "./server";
import { useMockServer } from "./test-setup";

useMockServer();

const PIZZA = "biz_pizza_01";
const BARBER = "biz_barber_01";

function record(businessId: string) {
  const seen: { event: ActivityEvent; orderStatus?: string; paymentId?: string }[] = [];
  const stop = subscribeMockActivity(businessId, (event) => {
    const payload = event.payload as { orderId?: string; subjectId?: string };
    const orderId = payload.orderId ?? payload.subjectId;
    const order = getState().orders.find((o) => o.id === orderId);
    seen.push({ event, orderStatus: order?.status, paymentId: order?.squarePaymentId });
  });
  return { seen, stop };
}

function assertInOrder(types: string[], expected: string[]) {
  let last = -1;
  for (const t of expected) {
    const i = types.indexOf(t, last + 1);
    expect(i, `${t} after index ${last} in ${types.join(", ")}`).toBeGreaterThan(last);
    last = i;
  }
}

describe("pizza timeline", () => {
  it("runs from the incoming call to a verified sandbox payment, in order", async () => {
    const { seen, stop } = record(PIZZA);
    const { callId, orderId, approvalId } = await mockControls.startPizzaCall();

    const pending = await api.getOrder(PIZZA, orderId);
    expect(pending.status).toBe("AWAITING_OWNER_APPROVAL");
    expect((await api.getOrderCheckout(PIZZA, orderId)).ready).toBe(false);
    expect((await api.getCall(PIZZA, callId)).stage).toBe("CUSTOMER_CONFIRMED");

    const apv = await api.getApproval(PIZZA, approvalId);
    const res = await api.decideApproval(PIZZA, approvalId, { decision: "approve", payloadHash: apv.payloadHash });
    expect(res.approval.state).toBe("APPROVED");
    // The response returns before any provider step ran.
    expect((await api.getOrder(PIZZA, orderId)).squarePaymentId).toBeUndefined();

    await whenIdle();
    stop();

    const order = await api.getOrder(PIZZA, orderId);
    expect(order.squarePaymentId).toBeDefined();
    expect(order.status).toBe("FULFILLMENT_READY");
    const checkout = await api.getOrderCheckout(PIZZA, orderId);
    expect(checkout).toMatchObject({ ready: true, environment: "sandbox", message: { status: "SENT" } });

    const mine = seen.filter((s) => s.event.correlationId === callId);
    const types = mine.map((s) => s.event.type);
    assertInOrder(types, [
      "call.started",
      "order.status_changed",
      "proposal.created",
      "approval.requested",
      "approval.decided",
      "execution.started",
      "checkout.created",
      "execution.succeeded",
      "message.sent",
      "payment.verified",
      "sync.queued",
      "sync.succeeded",
    ]);
    const statuses = mine.flatMap((s) => (s.event.type === "order.status_changed" && s.event.payload.orderId ? [s.event.payload.to] : []));
    expect(statuses).toEqual([
      "AWAITING_OWNER_APPROVAL",
      "APPROVED",
      "CREATING_CHECKOUT",
      "PAYMENT_LINK_READY",
      "MESSAGE_SENT",
      "PAYMENT_PENDING",
      "PAID_VERIFIED",
      "FULFILLMENT_READY",
    ]);

    // Nothing shows as paid before payment.verified.
    const verifiedAt = types.indexOf("payment.verified");
    for (const s of mine.slice(0, verifiedAt)) {
      expect(s.orderStatus).not.toBe("PAID_VERIFIED");
      expect(s.paymentId).toBeUndefined();
    }
    expect((mine[verifiedAt].event.payload as { sandbox?: boolean }).sandbox).toBe(true);
  });

  it("ends at REJECTED with no checkout when the owner rejects", async () => {
    const { seen, stop } = record(PIZZA);
    const { callId, orderId, approvalId } = await mockControls.startPizzaCall();
    const apv = await api.getApproval(PIZZA, approvalId);
    await api.decideApproval(PIZZA, approvalId, { decision: "reject", payloadHash: apv.payloadHash });
    await whenIdle();
    stop();
    expect((await api.getOrder(PIZZA, orderId)).status).toBe("REJECTED");
    const types = seen.filter((s) => s.event.correlationId === callId).map((s) => s.event.type);
    expect(types).not.toContain("checkout.created");
    expect(types).not.toContain("execution.started");
  });

  it("ends at APPROVAL_EXPIRED when nobody decides in time", async () => {
    const { orderId, approvalId } = await mockControls.startPizzaCall();
    advanceMockClock(11 * 60_000);
    expect((await api.getOrder(PIZZA, orderId)).status).toBe("APPROVAL_EXPIRED");
    expect((await api.getApproval(PIZZA, approvalId)).state).toBe("EXPIRED");
  });

  it("can end in PAYMENT_FAILED", async () => {
    mockControls.simulatePaymentFailed();
    const { orderId, approvalId } = await mockControls.startPizzaCall();
    const apv = await api.getApproval(PIZZA, approvalId);
    await api.decideApproval(PIZZA, approvalId, { decision: "approve", payloadHash: apv.payloadHash });
    await whenIdle();
    const order = await api.getOrder(PIZZA, orderId);
    expect(order.status).toBe("PAYMENT_FAILED");
    expect(order.squarePaymentId).toBeUndefined();
  });

  it("can retry the Sheets sync once before it succeeds", async () => {
    mockControls.simulateSyncRetry();
    const { callId, approvalId } = await mockControls.startPizzaCall();
    const apv = await api.getApproval(PIZZA, approvalId);
    await api.decideApproval(PIZZA, approvalId, { decision: "approve", payloadHash: apv.payloadHash });
    await whenIdle();
    const types = (await api.listActivity(PIZZA, { correlationId: callId })).items.map((e) => e.type).reverse();
    assertInOrder(types, ["sync.queued", "sync.failed", "sync.succeeded"]);
  });

  it("drops a call before the order is confirmed and leaves no order (AC-18)", async () => {
    const ordersBefore = getState().orders.length;
    const { callId } = await mockControls.simulateCallLost();
    await whenIdle();
    const call = await api.getCall(PIZZA, callId);
    expect(call.status).toBe("DROPPED");
    expect(getState().orders.length).toBe(ordersBefore);
  });
});

describe("booking timeline", () => {
  it("books after approval and reaches BOOKED_VERIFIED", async () => {
    const { bookingId, approvalId } = await mockControls.startBookingCall();
    const apv = await api.getApproval(BARBER, approvalId);
    await api.decideApproval(BARBER, approvalId, { decision: "approve", payloadHash: apv.payloadHash });
    await whenIdle();
    const booking = await api.getBooking(BARBER, bookingId);
    expect(booking.status).toBe("BOOKED_VERIFIED");
    expect(booking.googleEventId).toBeDefined();
  });

  it("ends in SLOT_CONFLICT with alternatives when the slot was taken", async () => {
    const { callId, bookingId, approvalId } = await mockControls.startBookingCall({ slotConflict: true });
    const apv = await api.getApproval(BARBER, approvalId);
    await api.decideApproval(BARBER, approvalId, { decision: "approve", payloadHash: apv.payloadHash });
    await whenIdle();
    expect((await api.getBooking(BARBER, bookingId)).status).toBe("SLOT_CONFLICT");
    const events = (await api.listActivity(BARBER, { correlationId: callId, types: ["booking.slot_conflict"] })).items;
    expect(events[0].type === "booking.slot_conflict" && events[0].payload.alternatives.length).toBe(3);
  });
});

describe("simulated call", () => {
  it("creates a test_console call and a real pending approval", async () => {
    const t1 = await api.simCall(PIZZA, "agt_pizza_01", { message: "One large margherita and one large pepperoni" });
    const t2 = await api.simCall(PIZZA, "agt_pizza_01", { message: "Yes, send it", callId: t1.callId });
    const proposal = t2.toolTrace.find((t) => t.tool === "propose_order")!;
    expect(proposal.mocked).toBe(false);
    const approvalId = (proposal.output as { approvalId: string }).approvalId;
    expect(approvalId).not.toMatch(/^apv_mock_/);
    expect((await api.getApproval(PIZZA, approvalId)).state).toBe("PENDING");
    const call = await api.getCall(PIZZA, t1.callId!);
    expect(call.channel).toBe("test_console");
    expect(call.providerCallId).toBeUndefined();
    await api.simCall(PIZZA, "agt_pizza_01", { message: "", callId: t1.callId, end: true });
    expect((await api.getCall(PIZZA, t1.callId!)).status).toBe("COMPLETED");
  });
});
