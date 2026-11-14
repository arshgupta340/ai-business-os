import { createHash, createHmac } from "node:crypto";
import { WebhooksHelper } from "square";
import { describe, expect, it } from "vitest";
import { checkPayment, computeSignature, headerFormat, verifySignature } from "../src/verify.js";
import { idempotencyKey } from "../src/common.js";

const KEY = "test-signature-key-not-a-real-secret";
const URL = "https://example.ngrok.app/webhooks/square";
const BODY = '{"merchant_id":"M1","type":"payment.updated","event_id":"evt-1","data":{"type":"payment","id":"pay_1"}}';
// Computed independently here so the test does not only check the code against itself.
const GOOD = createHmac("sha256", KEY).update(URL + BODY).digest("base64");

describe("webhook signature", () => {
  it("accepts a valid signature", () => {
    expect(computeSignature(URL, BODY, KEY)).toBe(GOOD);
    expect(verifySignature({ notificationUrl: URL, rawBody: BODY, signatureKey: KEY, signatureHeader: GOOD })).toBe(true);
  });

  it("rejects an altered body", () => {
    const altered = BODY.replace("evt-1", "evt-2");
    expect(verifySignature({ notificationUrl: URL, rawBody: altered, signatureKey: KEY, signatureHeader: GOOD })).toBe(false);
    // Whitespace counts: a re-serialized body must fail.
    const reformatted = JSON.stringify(JSON.parse(BODY), null, 1);
    expect(verifySignature({ notificationUrl: URL, rawBody: reformatted, signatureKey: KEY, signatureHeader: GOOD })).toBe(false);
  });

  it("rejects an altered URL", () => {
    for (const u of [URL + "/", URL.replace("https", "http"), "https://other.example/webhooks/square"]) {
      expect(verifySignature({ notificationUrl: u, rawBody: BODY, signatureKey: KEY, signatureHeader: GOOD })).toBe(false);
    }
  });

  it("rejects a wrong key, a missing header and a hex digest", () => {
    expect(verifySignature({ notificationUrl: URL, rawBody: BODY, signatureKey: KEY + "x", signatureHeader: GOOD })).toBe(false);
    expect(verifySignature({ notificationUrl: URL, rawBody: BODY, signatureKey: KEY, signatureHeader: undefined })).toBe(false);
    const hex = createHmac("sha256", KEY).update(URL + BODY).digest("hex");
    expect(verifySignature({ notificationUrl: URL, rawBody: BODY, signatureKey: KEY, signatureHeader: hex })).toBe(false);
    expect(headerFormat(hex)).toBe("hex-like");
    expect(headerFormat(GOOD)).toBe("base64-like");
  });

  it("agrees with the SDK's WebhooksHelper", async () => {
    await expect(
      WebhooksHelper.verifySignature({ requestBody: BODY, signatureHeader: GOOD, signatureKey: KEY, notificationUrl: URL }),
    ).resolves.toBe(true);
    await expect(
      WebhooksHelper.verifySignature({ requestBody: BODY + " ", signatureHeader: GOOD, signatureKey: KEY, notificationUrl: URL }),
    ).resolves.toBe(false);
  });
});

describe("paid check", () => {
  const exp = { orderId: "ord_1", amountMinor: "3264", currency: "USD", locationId: "L1" };
  const good = { status: "COMPLETED", orderId: "ord_1", locationId: "L1", amountMoney: { amount: 3264n, currency: "USD" } };

  it("verifies a matching COMPLETED payment", () => {
    expect(checkPayment(good, exp)).toEqual({ verified: true, reasons: [] });
  });

  it("refuses any status other than COMPLETED", () => {
    for (const status of ["APPROVED", "PENDING", "FAILED", "CANCELED"]) {
      expect(checkPayment({ ...good, status }, exp).verified).toBe(false);
    }
  });

  it("refuses a mismatch on order, amount, currency or location", () => {
    expect(checkPayment({ ...good, orderId: "ord_2" }, exp).verified).toBe(false);
    expect(checkPayment({ ...good, amountMoney: { amount: 3263n, currency: "USD" } }, exp).verified).toBe(false);
    expect(checkPayment({ ...good, amountMoney: { amount: 3264n, currency: "CAD" } }, exp).verified).toBe(false);
    expect(checkPayment({ ...good, locationId: "L2" }, exp).verified).toBe(false);
  });
});

describe("idempotency key (SPEC 2.9)", () => {
  it("is stable sha256 hex of the four values joined by colons", () => {
    const k = idempotencyKey("biz_pizza_01", "ord_SPIKE01", "square.checkout.create", "apv_SPIKE01");
    expect(k).toBe(idempotencyKey("biz_pizza_01", "ord_SPIKE01", "square.checkout.create", "apv_SPIKE01"));
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).toBe(createHash("sha256").update("biz_pizza_01:ord_SPIKE01:square.checkout.create:apv_SPIKE01").digest("hex"));
  });
});
