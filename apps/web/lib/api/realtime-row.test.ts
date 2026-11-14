import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { activityEventFromRow } from "@abos/contracts";
import { handleRealtimeRow, resetRealtimeWarnings } from "./realtime-row";

const PIZZA = "biz_pizza_01";

function row(type: unknown, payload: unknown) {
  return {
    id: "evt_rt_1",
    business_id: PIZZA,
    type,
    correlation_id: "call_rt_1",
    actor_type: "system",
    occurred_at: "2026-11-14 19:06:30+00",
    payload,
  };
}

function spyClient() {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  const keys = () => spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  return { qc, keys };
}

beforeEach(() => resetRealtimeWarnings());

describe("handleRealtimeRow", () => {
  it("parses a row that matches the contract, normalizes the time and refetches", () => {
    const { qc, keys } = spyClient();
    const event = handleRealtimeRow(
      qc,
      PIZZA,
      row("payment.verified", { orderId: "ord_1", squarePaymentId: "SQ_PAY_1", amountMinor: 4731, currency: "USD", sandbox: true }),
    );
    expect(event?.type).toBe("payment.verified");
    expect(event?.occurredAt).toBe("2026-11-14T19:06:30.000Z");
    expect(keys()).toContain(JSON.stringify(["api", "biz", PIZZA, "orders"]));
  });

  it("refetches for a stored status row { subjectId, from, to }, does not throw, and keeps it out of the feed", () => {
    const stored = row("order.status_changed", { subjectId: "ord_1", from: "PAYMENT_PENDING", to: "PAID_VERIFIED" });
    // The contract function itself refuses this row: callId is required in the payload.
    expect(() => activityEventFromRow(stored)).toThrow();
    const { qc, keys } = spyClient();
    const warn = vi.fn();
    let event: unknown = "not called";
    expect(() => {
      event = handleRealtimeRow(qc, PIZZA, stored, warn);
    }).not.toThrow();
    expect(event).toBeNull();
    expect(keys()).toContain(JSON.stringify(["api", "biz", PIZZA, "orders"]));
    expect(keys()).toContain(JSON.stringify(["api", "biz", PIZZA, "activity"]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("order.status_changed");
    expect(warn.mock.calls[0][0]).not.toContain("ord_1");
  });

  it("warns once per unparsable type", () => {
    const { qc } = spyClient();
    const warn = vi.fn();
    handleRealtimeRow(qc, PIZZA, row("booking.status_changed", { subjectId: "bkg_1", to: "BOOKED_VERIFIED", from: 7 }), warn);
    handleRealtimeRow(qc, PIZZA, row("booking.status_changed", { subjectId: "bkg_2", to: 3 }), warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refetches everything of the business when the type is unknown or missing", () => {
    for (const type of ["not.a.type", undefined]) {
      const { qc, keys } = spyClient();
      expect(handleRealtimeRow(qc, PIZZA, row(type, {}), () => {})).toBeNull();
      expect(keys()).toContain(JSON.stringify(["api", "biz", PIZZA]));
      expect(keys()).toContain(JSON.stringify(["api", "live-agent"]));
    }
  });

  it("never throws on a row that is not an object", () => {
    const { qc, keys } = spyClient();
    expect(handleRealtimeRow(qc, PIZZA, null, () => {})).toBeNull();
    expect(keys()).toContain(JSON.stringify(["api", "biz", PIZZA]));
  });
});
