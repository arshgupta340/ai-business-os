import { describe, expect, it } from "vitest";
import * as api from "@/lib/api/client";
import { subscribeMockActivity, subscribeMockReset } from "@/lib/api/mock-bridge";
import type { ActivityEvent } from "@abos/contracts";
import {
  BUILDER_SESSIONS_STORAGE_KEY,
  getState,
  mockControls,
  resetDb,
  restoreBuilderSessions,
  saveBuilderSessions,
  setBuilderSessionStore,
  whenIdle,
} from "./server";
import { useMockServer } from "./test-setup";

useMockServer();

const PIZZA = "biz_pizza_01";

function record(businessId: string) {
  const events: ActivityEvent[] = [];
  const stop = subscribeMockActivity(businessId, (e) => events.push(e));
  return { events, stop };
}

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("simulateExtractionFailed", () => {
  it("fails the next upload only, with no drafts and no conflicts", async () => {
    const { events, stop } = record(PIZZA);
    mockControls.simulateExtractionFailed?.();
    const first = await api.uploadFile(PIZZA, new Blob(["%PDF-1.4 menu"], { type: "application/pdf" }), "broken.pdf");
    await whenIdle();
    const failed = await api.getFile(PIZZA, first.id);
    expect(failed.extractionState).toBe("FAILED");
    expect(failed.draftFactIds).toEqual([]);
    const done = events.find((e) => e.type === "extraction.completed" && e.payload.fileId === first.id);
    expect(done?.payload).toMatchObject({ extractionState: "FAILED", draftFactCount: 0, conflictCount: 0 });

    const second = await api.uploadFile(PIZZA, new Blob(["%PDF-1.4 menu"], { type: "application/pdf" }), "menu3.pdf");
    await whenIdle();
    stop();
    expect((await api.getFile(PIZZA, second.id)).extractionState).toBe("EXTRACTED");
  });
});

describe("simulateCatalogSyncFailed", () => {
  it("ends the next catalog sync with a final sync.failed and keeps syncedAt", async () => {
    const before = await api.getCatalog(PIZZA);
    const { events, stop } = record(PIZZA);
    mockControls.simulateCatalogSyncFailed?.();
    const { jobId } = await api.syncCatalog(PIZZA);
    await whenIdle();
    const mine = events.filter((e) => (e.payload as { jobId?: string }).jobId === jobId).map((e) => e.type);
    expect(mine).toEqual(["sync.queued", "sync.failed"]);
    const failed = events.find((e) => e.type === "sync.failed");
    expect(failed?.payload).toMatchObject({ target: "catalog", jobId, final: true });
    expect((await api.getCatalog(PIZZA)).syncedAt).toBe(before.syncedAt);

    const next = await api.syncCatalog(PIZZA);
    await whenIdle();
    stop();
    expect(events.some((e) => e.type === "sync.succeeded" && e.payload.target === "catalog" && e.payload.jobId === next.jobId)).toBe(true);
  });
});

describe("simulateQrOnlyChannel", () => {
  it("skips the message step of the next pizza call and still reaches a verified sandbox payment", async () => {
    mockControls.simulateQrOnlyChannel?.();
    const { events, stop } = record(PIZZA);
    const { callId, orderId, approvalId } = await mockControls.startPizzaCall();
    const apv = await api.getApproval(PIZZA, approvalId);
    expect((apv.payload as { messageChannel?: string }).messageChannel).toBe("qr_only");
    await api.decideApproval(PIZZA, approvalId, { decision: "approve", payloadHash: apv.payloadHash });
    await whenIdle();
    stop();

    const mine = events.filter((e) => e.correlationId === callId);
    expect(mine.some((e) => e.type === "message.sent" || e.type === "message.failed")).toBe(false);
    const statuses = mine.filter((e) => e.type === "order.status_changed").map((e) => e.payload.to);
    expect(statuses).not.toContain("MESSAGE_SENT");
    const linkReady = statuses.indexOf("PAYMENT_LINK_READY");
    expect(linkReady).toBeGreaterThan(-1);
    expect(statuses[linkReady + 1]).toBe("PAYMENT_PENDING");

    expect(getState().dispatches.some((d) => d.subjectId === orderId)).toBe(false);
    const step = getState().executions.find((x) => x.approvalId === approvalId && x.actionType === "message.checkout.send");
    expect(step?.status).toBe("SKIPPED");
    const checkout = await api.getOrderCheckout(PIZZA, orderId);
    expect(checkout.ready).toBe(true);
    expect(checkout.message).toBeUndefined();
    expect((await api.getOrder(PIZZA, orderId)).status).toBe("FULFILLMENT_READY");
  });

  it("applies to one call only", async () => {
    mockControls.simulateQrOnlyChannel?.();
    await mockControls.startPizzaCall();
    const { approvalId } = await mockControls.startPizzaCall();
    const apv = await api.getApproval(PIZZA, approvalId);
    expect((apv.payload as { messageChannel?: string }).messageChannel).toBe("surge");
  });
});

describe("price_edit", () => {
  it("runs the scripted steps after approval and the catalog shows the new price", async () => {
    const catalog = await api.getCatalog(PIZZA);
    const variation = catalog.items[0].variations[0];
    const { approval } = await api.proposePrice(PIZZA, { variationId: variation.id, newPriceMinor: variation.priceMinor + 100, currency: "USD" });
    expect((await api.getCatalog(PIZZA)).items[0].variations[0].priceMinor).toBe(variation.priceMinor);
    await api.decideApproval(PIZZA, approval.id, { decision: "approve", payloadHash: approval.payloadHash });
    await whenIdle();
    const after = (await api.getCatalog(PIZZA)).items.flatMap((i) => i.variations).find((v) => v.id === variation.id);
    expect(after?.priceMinor).toBe(variation.priceMinor + 100);
    const steps = getState().executions.filter((x) => x.approvalId === approval.id).map((x) => [x.actionType, x.status]);
    expect(steps).toEqual([
      ["square.catalog.price.update", "SUCCEEDED"],
      ["local.catalog.sync", "SUCCEEDED"],
    ]);
  });
});

describe("simulateSheetsDisconnected", () => {
  it("switches Google Sheets to the shared disconnected health until reset, keeping the degraded calendar", async () => {
    const before = await api.getIntegrationsHealth(PIZZA);
    expect(before.google_sheets.state).toBe("connected");
    expect(before.google_calendar.state).toBe("degraded");
    mockControls.simulateSheetsDisconnected?.();
    const after = await api.getIntegrationsHealth(PIZZA);
    expect(after.google_sheets).toMatchObject({ state: "disconnected", detail: "Reconnect Google Sheets to resume sync." });
    expect(after.google_calendar.state).toBe("degraded");
    await mockControls.reset();
    expect((await api.getIntegrationsHealth(PIZZA)).google_sheets.state).toBe("connected");
  });
});

describe("reset", () => {
  it("tells subscribers so the activity feed can drop its events", async () => {
    let calls = 0;
    const stop = subscribeMockReset(() => (calls += 1));
    await mockControls.reset();
    stop();
    await mockControls.reset();
    expect(calls).toBe(1);
  });
});

describe("builder session persistence", () => {
  it("is off in the node test server", () => {
    // server.ts turns it off, so saving writes nowhere and nothing throws.
    expect(() => saveBuilderSessions()).not.toThrow();
  });

  it("round-trips builder sessions through a store, and reset clears them", async () => {
    const store = memoryStore();
    setBuilderSessionStore(store);
    try {
      const session = await api.createBuilderSession(PIZZA);
      expect(store.data.get(BUILDER_SESSIONS_STORAGE_KEY)).toContain(session.id);

      // A reload: fresh fixtures, then the stored sessions come back.
      const saved = store.data.get(BUILDER_SESSIONS_STORAGE_KEY)!;
      await resetDb();
      store.data.set(BUILDER_SESSIONS_STORAGE_KEY, saved);
      restoreBuilderSessions();
      const resumed = await api.getBuilderSession(PIZZA, session.id);
      expect(resumed.id).toBe(session.id);
      expect(resumed.messages.length).toBe(session.messages.length);

      await mockControls.reset();
      expect(JSON.parse(store.data.get(BUILDER_SESSIONS_STORAGE_KEY)!)).toEqual([]);
    } finally {
      setBuilderSessionStore(null);
    }
  });

  it("ignores malformed stored data", () => {
    const store = memoryStore();
    store.data.set(BUILDER_SESSIONS_STORAGE_KEY, "{not json");
    setBuilderSessionStore(store);
    try {
      expect(() => restoreBuilderSessions()).not.toThrow();
      expect(getState().builderSessions).toEqual([]);
    } finally {
      setBuilderSessionStore(null);
    }
  });
});

describe("simulateEmptyBusiness", () => {
  it("leaves one business with nothing until reset, and keeps the other business as it was", async () => {
    const BARBER = "biz_barber_01";
    const barberAgentsBefore = (await api.listAgents(BARBER)).items.length;
    mockControls.simulateEmptyBusiness?.(PIZZA);
    expect((await api.listAgents(PIZZA)).items).toEqual([]);
    expect((await api.listCalls(PIZZA)).items).toEqual([]);
    expect((await api.listOrders(PIZZA)).items).toEqual([]);
    expect((await api.listApprovals(PIZZA, { state: "PENDING" })).items).toEqual([]);
    expect((await api.listActivity(PIZZA)).items).toEqual([]);
    const facts = await api.getFacts(PIZZA);
    expect(facts.items).toEqual([]);
    expect(facts.conflicts).toEqual([]);
    expect((await api.getCatalog(PIZZA)).items).toEqual([]);
    expect((await api.getTelemetry(PIZZA)).metrics).toEqual([]);
    // The business is still there, and nothing answers the number for it.
    expect((await api.getBusiness(PIZZA)).id).toBe(PIZZA);
    expect((await api.getLiveAgent()).agentId).toBeUndefined();
    expect((await api.listAgents(BARBER)).items.length).toBe(barberAgentsBefore);

    await mockControls.reset();
    expect((await api.listAgents(PIZZA)).items.length).toBeGreaterThan(0);
    expect((await api.getTelemetry(PIZZA)).metrics.length).toBeGreaterThan(0);
  });
});

describe("simulateRequestFailure", () => {
  it("fails matching GET requests with the error envelope until cleared", async () => {
    mockControls.simulateRequestFailure?.({ path: "/api/calls" });
    await expect(api.listCalls(PIZZA)).rejects.toMatchObject({ code: "INTERNAL", retryable: true, kind: "http" });
    await expect(api.listCalls(PIZZA)).rejects.toMatchObject({ code: "INTERNAL" });
    // Other paths and other methods still answer.
    await expect(api.listOrders(PIZZA)).resolves.toBeDefined();
    mockControls.clearRequestFailures?.();
    await expect(api.listCalls(PIZZA)).resolves.toBeDefined();
  });

  it("answers an invalid body, a chosen code, a limited number of times, and stops at reset", async () => {
    mockControls.simulateRequestFailure?.({ path: "/api/agents", mode: "invalid", times: 1 });
    await expect(api.listAgents(PIZZA)).rejects.toMatchObject({ kind: "invalid_response" });
    await expect(api.listAgents(PIZZA)).resolves.toBeDefined();

    mockControls.simulateRequestFailure?.({ path: "/api/approvals", method: "POST", code: "INTEGRATION_UNAVAILABLE", message: "Square is not answering." });
    const { items } = await api.listApprovals(PIZZA, { state: "PENDING" });
    await expect(
      api.decideApproval(PIZZA, items[0].id, { decision: "approve", payloadHash: items[0].payloadHash }),
    ).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE", message: "Square is not answering." });
    await mockControls.reset();
    const fresh = await api.listApprovals(PIZZA, { state: "PENDING" });
    await expect(
      api.decideApproval(PIZZA, fresh.items[0].id, { decision: "approve", payloadHash: fresh.items[0].payloadHash }),
    ).resolves.toBeDefined();
  });
});
