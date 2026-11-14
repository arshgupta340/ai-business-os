import { describe, expect, it, vi } from "vitest";
import { buildWebhookApp } from "../src/webhook-app.js";
import { computeSignature } from "../src/verify.js";

const URL = "https://example.test/webhooks/square";
const KEY = "test-signature-key-not-a-real-secret";

function post(app: ReturnType<typeof buildWebhookApp>, body: string, sig: string | undefined) {
  return app.inject({
    method: "POST",
    url: "/webhooks/square",
    headers: { "content-type": "application/json", ...(sig ? { "x-square-hmacsha256-signature": sig } : {}) },
    payload: body,
  });
}

describe("webhook route", () => {
  it("403 on a bad or missing signature, and never calls reconcile", async () => {
    const onPayment = vi.fn(async () => {});
    const app = buildWebhookApp({ notificationUrl: URL, signatureKey: KEY, onPayment });
    const body = '{"event_id":"e1","type":"payment.updated","data":{"id":"pay_1"}}';
    expect((await post(app, body, "bad")).statusCode).toBe(403);
    expect((await post(app, body, undefined)).statusCode).toBe(403);
    expect(onPayment).not.toHaveBeenCalled();
  });

  it("verifies the raw body byte for byte, deduplicates on event_id, reconciles once", async () => {
    const onPayment = vi.fn(async () => {});
    const app = buildWebhookApp({ notificationUrl: URL, signatureKey: KEY, onPayment });
    // Odd spacing on purpose: a parse-and-reserialize server would fail this.
    const body = '{ "event_id" : "e2", "type":"payment.updated", "data":{"id":"pay_2","object":{"payment":{"id":"pay_2"}}}}';
    const sig = computeSignature(URL, body, KEY);
    const first = await post(app, body, sig);
    const second = await post(app, body, sig);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, duplicate: true });
    await new Promise((r) => setImmediate(r));
    expect(onPayment).toHaveBeenCalledTimes(1);
    expect(onPayment).toHaveBeenCalledWith("pay_2", "e2");
  });

  it("ignores verified non-payment events", async () => {
    const onPayment = vi.fn(async () => {});
    const app = buildWebhookApp({ notificationUrl: URL, signatureKey: KEY, onPayment });
    const body = '{"event_id":"e3","type":"order.updated","data":{"id":"o1"}}';
    expect((await post(app, body, computeSignature(URL, body, KEY))).statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(onPayment).not.toHaveBeenCalled();
  });
});
