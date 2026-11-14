// npm run quote: CalculateOrder on the sample cart with auto_apply_taxes and no
// order.taxes. Prints subtotal, tax and total in minor units. Nothing is persisted.
import { requireSquareEnv } from "./env.js";
import { LAST_QUOTE_FILE, minor, run, writeJson } from "./common.js";
import { calculateSampleQuote } from "./pricing.js";

const env = requireSquareEnv(["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]);
await run("CalculateOrder", async () => {
  const { order, summary } = await calculateSampleQuote(env.SQUARE_ACCESS_TOKEN, env.SQUARE_LOCATION_ID);
  console.log("SANDBOX quote from Square CalculateOrder");
  for (const li of order.lineItems ?? []) {
    const mods = (li.modifiers ?? []).map((m) => `+${m.name ?? m.catalogObjectId}`).join(" ");
    console.log(`  ${li.quantity} x ${li.name ?? ""} ${li.variationName ?? ""} ${mods}  total=${minor(li.totalMoney)}  tax=${minor(li.totalTaxMoney)}`);
  }
  console.log(`  applied taxes: ${(order.taxes ?? []).map((t) => `${t.name ?? t.catalogObjectId} ${t.percentage ?? ""}% scope=${t.scope ?? ""}`).join(", ") || "(none)"}`);
  console.log(`subtotalMinor=${summary.subtotalMinor} taxMinor=${summary.taxMinor} totalMinor=${summary.totalMinor} currency=${summary.currency}`);
  if (summary.taxMinor === "0") console.log("WARN: tax is 0. Check that the items carry the tax ID (seed-catalog sets tax_ids).");
  if (order.id) {
    console.log(`NOT EXPECTED: CalculateOrder returned an order id (${order.id}). It may have been persisted.`);
    process.exitCode = 1;
  } else {
    console.log("OK: no order id in the response, so nothing was persisted.");
  }
  writeJson(LAST_QUOTE_FILE, { ...summary, quotedAt: new Date().toISOString() });
});
