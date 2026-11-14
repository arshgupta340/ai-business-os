// Integrations health and telemetry through the web client against the real server.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api/client";
import { BUSINESSES, markProvidersHealthy, PIZZA, startRealServer, type RealServer } from "./harness";

vi.mock("@/lib/supabase/client", async () => (await import("./harness")).fakeSupabaseModule);

const PROVIDERS = ["square", "twilio", "openai", "google_calendar", "google_sheets", "message_channel"] as const;

let s: RealServer;
beforeAll(async () => {
  s = await startRealServer();
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe("integrations health", () => {
  it.each(BUSINESSES)("getIntegrationsHealth %s answers one entry per provider with a state the badges read", async (businessId) => {
    const health = await api.getIntegrationsHealth(businessId);
    for (const p of PROVIDERS) {
      expect(health[p], p).toBeDefined();
      expect(["connected", "degraded", "disconnected"]).toContain(health[p].state);
      expect(typeof health[p].lastCheckedAt).toBe("string");
    }
    expect(s.requests.at(-1)!.url.searchParams.has("refresh")).toBe(false);
  });

  it("the world has no phone voice settings, so Twilio is not reported as connected", async () => {
    const health = await api.getIntegrationsHealth(PIZZA);
    expect(health.twilio.state).not.toBe("connected");
  });

  it("refresh sends refresh=1 and runs the probes", async () => {
    markProvidersHealthy(s.world);
    const health = await api.getIntegrationsHealth(PIZZA, { refresh: true });
    expect(s.requests.at(-1)!.url.searchParams.get("refresh")).toBe("1");
    for (const p of PROVIDERS) expect(health[p].state, p).toBe("connected");
  });
});

describe("telemetry", () => {
  it.each(BUSINESSES)("getTelemetry %s answers metrics with p50, p95 and count", async (businessId) => {
    // A few requests first, so the recorder has something to report.
    await api.listOrders(businessId);
    await api.listApprovals(businessId);
    const res = await api.getTelemetry(businessId);
    expect(Array.isArray(res.metrics)).toBe(true);
    for (const m of res.metrics) {
      expect(typeof m.name).toBe("string");
      expect(m.count).toBeGreaterThanOrEqual(0);
      expect(m.p95Ms).toBeGreaterThanOrEqual(m.p50Ms);
    }
  });

  it("getTelemetry sends since as a query parameter", async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    await api.getTelemetry(PIZZA, { since });
    expect(s.requests.at(-1)!.url.searchParams.get("since")).toBe(since);
  });
});
