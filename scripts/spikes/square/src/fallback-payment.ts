// npm run fallback-payment: ONLY for the case where the hosted payment link
// cannot be paid in sandbox (SPEC 4 spike). CreateOrder plus CreatePayment with
// the sandbox test nonce, then the same paid check. Labelled SIMULATED.
// This writes last-link.json with source "simulated_fallback", so run
// create-link again afterward if you go back to testing the hosted link.
import { requireSquareEnv } from "./env.js";
import {
  LAST_LINK_FILE,
  buildSampleOrder,
  idempotencyKey,
  loadCatalogIds,
  makeClient,
  minor,
  run,
  sampleKeyParts,
  writeJson,
  type LastLink,
} from "./common.js";
import { calculateSampleQuote } from "./pricing.js";
import { reconcilePayment } from "./reconcile.js";

// Sandbox test payment token for a card payment that succeeds:
// https://developer.squareup.com/docs/devtools/sandbox/payments
const SANDBOX_CARD_NONCE = "cnon:card-nonce-ok";
// CreatePayment caps idempotency_key at 45 characters (API reference, CreatePayment).
const CREATE_PAYMENT_KEY_MAX = 45;

const env = requireSquareEnv(["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]);
const client = makeClient(env.SQUARE_ACCESS_TOKEN);

await run("fallback-payment", async () => {
  console.log("SIMULATED SANDBOX PAYMENT: this path does not use the hosted payment link.");
  const { summary: quote } = await calculateSampleQuote(env.SQUARE_ACCESS_TOKEN, env.SQUARE_LOCATION_ID);
  console.log(`quote: totalMinor=${quote.totalMinor} currency=${quote.currency}`);

  const orderKey = idempotencyKey(...sampleKeyParts("square.order.create.simulated"));
  const created = await client.orders.create({
    idempotencyKey: orderKey,
    order: buildSampleOrder(loadCatalogIds(), env.SQUARE_LOCATION_ID),
  });
  const order = created.order;
  if (!order?.id || !order.totalMoney?.amount) throw new Error("CreateOrder returned no order id or total");
  console.log(`CreateOrder: id=${order.id} total=${minor(order.totalMoney)} state=${order.state ?? ""}`);
  if (order.totalMoney.amount.toString() !== quote.totalMinor) {
    console.error(`MISMATCH: order total ${order.totalMoney.amount} != quote ${quote.totalMinor}. NO-GO.`);
    process.exit(2);
  }

  const fullKey = idempotencyKey(...sampleKeyParts("square.payment.create.simulated"));
  const paymentKey = fullKey.slice(0, CREATE_PAYMENT_KEY_MAX);
  console.log(`CreatePayment idempotency key: first ${CREATE_PAYMENT_KEY_MAX} of ${fullKey.length} hex chars`);

  const paid = await client.payments.create({
    sourceId: SANDBOX_CARD_NONCE,
    idempotencyKey: paymentKey,
    amountMoney: order.totalMoney,
    orderId: order.id,
    locationId: env.SQUARE_LOCATION_ID,
    autocomplete: true,
    note: "AI Business OS spike B-02, SIMULATED sandbox payment",
  });
  const payment = paid.payment;
  if (!payment?.id) throw new Error("CreatePayment returned no payment id");
  console.log(`CreatePayment: id=${payment.id} status=${payment.status ?? ""}`);

  const saved: LastLink = {
    paymentLinkId: "",
    url: "",
    orderId: order.id,
    amountMinor: order.totalMoney.amount.toString(),
    currency: order.totalMoney.currency ?? "",
    locationId: order.locationId,
    idempotencyKey: paymentKey,
    createdAt: order.createdAt ?? new Date().toISOString(),
    source: "simulated_fallback",
  };
  writeJson(LAST_LINK_FILE, saved);
  console.log(`Wrote ${LAST_LINK_FILE} (source simulated_fallback)`);

  const result = await reconcilePayment(client, payment.id, saved);
  if (result !== "PAID_VERIFIED") process.exitCode = 3;
});
