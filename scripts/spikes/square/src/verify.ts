// Pure verification logic: webhook signature and the paid check.
// No env, no network, so the unit tests can import it directly.
import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 over notificationUrl + rawBody with the subscription signature key, base64. */
export function computeSignature(notificationUrl: string, rawBody: string, signatureKey: string): string {
  return createHmac("sha256", signatureKey).update(notificationUrl + rawBody, "utf8").digest("base64");
}

/** Hex variant, used only to answer the spike question "is the header base64?". */
export function computeSignatureHex(notificationUrl: string, rawBody: string, signatureKey: string): string {
  return createHmac("sha256", signatureKey).update(notificationUrl + rawBody, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Constant-time check of the x-square-hmacsha256-signature header (base64). */
export function verifySignature(args: {
  notificationUrl: string;
  rawBody: string;
  signatureKey: string;
  signatureHeader: string | undefined;
}): boolean {
  const { notificationUrl, rawBody, signatureKey, signatureHeader } = args;
  if (!signatureHeader || !signatureKey || !notificationUrl) return false;
  return safeEqual(computeSignature(notificationUrl, rawBody, signatureKey), signatureHeader.trim());
}

/** Describes the header's character set without printing it. */
export function headerFormat(header: string | undefined): "missing" | "base64-like" | "hex-like" | "other" {
  if (!header) return "missing";
  if (/^[0-9a-f]{64}$/i.test(header)) return "hex-like";
  if (/^[A-Za-z0-9+/]{43}=$/.test(header)) return "base64-like";
  return "other";
}

// ---------- paid check (SPEC 4, FLOWS B26) ----------

export interface ExpectedPayment {
  orderId: string;
  amountMinor: string; // decimal string of minor units
  currency: string;
  locationId: string;
}

export interface PaymentLike {
  id?: string;
  status?: string;
  orderId?: string;
  locationId?: string;
  amountMoney?: { amount?: bigint | null; currency?: string };
  totalMoney?: { amount?: bigint | null; currency?: string };
}

export interface PaidCheck {
  verified: boolean;
  reasons: string[];
}

/**
 * Paid only when status is COMPLETED and order ID, amount, currency and
 * location all match. Amount is compared on amount_money (the order amount, no tip),
 * falling back to total_money when amount_money is absent.
 */
export function checkPayment(p: PaymentLike, exp: ExpectedPayment): PaidCheck {
  const reasons: string[] = [];
  if (p.status !== "COMPLETED") reasons.push(`status is ${p.status ?? "(none)"}, not COMPLETED`);
  if (p.orderId !== exp.orderId) reasons.push(`order_id ${p.orderId ?? "(none)"} != ${exp.orderId}`);
  if (p.locationId !== exp.locationId) reasons.push(`location_id ${p.locationId ?? "(none)"} != ${exp.locationId}`);
  const money = p.amountMoney ?? p.totalMoney;
  const amount = money?.amount;
  if (amount === undefined || amount === null || amount.toString() !== exp.amountMinor) {
    reasons.push(`amount ${amount?.toString() ?? "(none)"} != ${exp.amountMinor}`);
  }
  if (money?.currency !== exp.currency) reasons.push(`currency ${money?.currency ?? "(none)"} != ${exp.currency}`);
  return { verified: reasons.length === 0, reasons };
}
