// npm run create-link: CreatePaymentLink with the sample order and the same tax
// option as the quote, with a stable idempotency key (SPEC 2.9). Then reads the
// order back and exits non-zero if its total differs from the quote.
// Pass --approval <id> to make a new key, and so a new link.
import { requireSquareEnv } from "./env.js";
import { LAST_LINK_FILE, type LastLink, buildSampleOrder, idempotencyKey, loadCatalogIds, makeClient, minor, run, sampleKeyParts, writeJson } from "./common.js";
import { calculateSampleQuote } from "./pricing.js";

const env = requireSquareEnv(["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]);
const client = makeClient(env.SQUARE_ACCESS_TOKEN);


await run("create-link", async () => {
  // 1. Fresh quote, same cart, same tax option.
  const { summary: quote } = await calculateSampleQuote(env.SQUARE_ACCESS_TOKEN, env.SQUARE_LOCATION_ID);
  console.log(`quote: totalMinor=${quote.totalMinor} taxMinor=${quote.taxMinor} currency=${quote.currency}`);

  // 2. Payment link with an order object. Never CreateOrder (SPEC 4).
  const parts = sampleKeyParts("square.checkout.create");
  const key = idempotencyKey(...parts);
  console.log(`idempotency key = sha256(${parts.join(":")}) = ${key} (${key.length} chars)`);

  const order = buildSampleOrder(loadCatalogIds(), env.SQUARE_LOCATION_ID);
  const res = await client.checkout.paymentLinks.create({
    idempotencyKey: key,
    description: "AI Business OS spike B-02 (SANDBOX)",
    order,
  });
  const link = res.paymentLink;
  if (!link?.id || !link.url || !link.orderId) {
    throw new Error("CreatePaymentLink response is missing payment_link.id, url or order_id");
  }
  console.log("SANDBOX payment link");
  console.log(`  url=${link.url}`);
  console.log(`  paymentLinkId=${link.id}`);
  console.log(`  orderId=${link.orderId}`);
  console.log(`  createdAt=${link.createdAt ?? ""} version=${link.version}`);

  const related = res.relatedResources?.orders?.find((o) => o.id === link.orderId);
  console.log(`  related_resources order total=${minor(related?.totalMoney)} (from the create response)`);

  // 3. Read the order back (the B19 read): GET /v2/orders/{order_id}, field total_money.
  const got = await client.orders.get({ orderId: link.orderId });
  const o = got.order;
  const total = o?.totalMoney?.amount?.toString();
  const currency = o?.totalMoney?.currency;
  console.log(`  RetrieveOrder total_money=${minor(o?.totalMoney)} total_tax_money=${minor(o?.totalTaxMoney)} state=${o?.state ?? ""} location=${o?.locationId ?? ""}`);

  const saved: LastLink = {
    paymentLinkId: link.id,
    url: link.url,
    orderId: link.orderId,
    amountMinor: total ?? "",
    currency: currency ?? "",
    locationId: o?.locationId ?? env.SQUARE_LOCATION_ID,
    idempotencyKey: key,
    createdAt: link.createdAt ?? new Date().toISOString(),
    source: "payment_link",
  };
  writeJson(LAST_LINK_FILE, saved);
  console.log(`Wrote ${LAST_LINK_FILE}`);

  // 4. Compare with the quote.
  if (total !== quote.totalMinor || currency !== quote.currency) {
    console.error(`MISMATCH: link order total ${total} ${currency} != quote total ${quote.totalMinor} ${quote.currency}. NO-GO.`);
    process.exit(2);
  }
  console.log(`MATCH: link order total ${total} ${currency} equals the quote total. GO.`);
});
