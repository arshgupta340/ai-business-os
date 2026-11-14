// Reads a payment from Square and applies the paid check against last-link.json.
// Always trusts the read, never a webhook body (FLOWS B26).
import type { SquareClient } from "square";
import type { LastLink } from "./common.js";
import { checkPayment } from "./verify.js";

export type ReconcileResult = "PAID_VERIFIED" | "MISMATCH" | "NOT_COMPLETED";

export async function reconcilePayment(client: SquareClient, paymentId: string, expected: LastLink): Promise<ReconcileResult> {
  const res = await client.payments.get({ paymentId });
  const p = res.payment;
  if (!p) throw new Error(`GetPayment ${paymentId} returned no payment`);
  const label = expected.source === "simulated_fallback" ? "SANDBOX, SIMULATED" : "SANDBOX";
  const check = checkPayment(p, {
    orderId: expected.orderId,
    amountMinor: expected.amountMinor,
    currency: expected.currency,
    locationId: expected.locationId,
  });
  const amount = p.amountMoney?.amount?.toString() ?? "?";
  console.log(`[${label}] payment ${paymentId}: status=${p.status ?? "?"} order=${p.orderId ?? "?"} amount=${amount} ${p.amountMoney?.currency ?? ""} location=${p.locationId ?? "?"}`);
  if (check.verified) {
    console.log(`PAID_VERIFIED [${label}] payment ${paymentId} for order ${expected.orderId}, ${expected.amountMinor} ${expected.currency}`);
    return "PAID_VERIFIED";
  }
  // A status that is not COMPLETED is not a mismatch, only "not paid yet" (or failed).
  const onlyStatus = check.reasons.length === 1 && check.reasons[0]!.startsWith("status");
  if (onlyStatus) {
    console.log(`NOT PAID YET: ${check.reasons[0]}`);
    return "NOT_COMPLETED";
  }
  console.log(`MISMATCH for payment ${paymentId}: ${check.reasons.join("; ")}`);
  return "MISMATCH";
}

/** Payment IDs on an order, read from its tenders (RetrieveOrder). */
export async function paymentIdsForOrder(client: SquareClient, orderId: string): Promise<string[]> {
  const res = await client.orders.get({ orderId });
  const ids = (res.order?.tenders ?? []).map((t) => t.paymentId ?? t.id).filter((x): x is string => !!x);
  return Array.from(new Set(ids));
}

/** Fallback lookup: list recent payments at the location and filter by order_id. */
export async function paymentIdsByListing(client: SquareClient, orderId: string, locationId: string, sinceIso: string): Promise<string[]> {
  const out: string[] = [];
  const page = await client.payments.list({ locationId, beginTime: sinceIso, sortOrder: "DESC", limit: 100 });
  for await (const p of page) {
    if (p.orderId === orderId && p.id) out.push(p.id);
  }
  return out;
}
