// npm run poll: the fallback when no webhook arrives. Looks up the payments for
// the saved order and applies the same paid check as the webhook server.
// Default: one pass. --watch: every 30 seconds for 15 minutes (SPEC 2.9).
import { requireSquareEnv } from "./env.js";
import { loadLastLink, makeClient, run } from "./common.js";
import { paymentIdsByListing, paymentIdsForOrder, reconcilePayment } from "./reconcile.js";

const env = requireSquareEnv(["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]);
const client = makeClient(env.SQUARE_ACCESS_TOKEN);
const watch = process.argv.includes("--watch");
const INTERVAL_MS = 30_000;
const WINDOW_MS = 15 * 60_000;

async function onePass(): Promise<boolean> {
  const link = loadLastLink();
  let ids = await paymentIdsForOrder(client, link.orderId);
  let via = "order tenders (RetrieveOrder)";
  if (ids.length === 0) {
    // Start the listing an hour before the link was made to allow for clock skew.
    const since = new Date(Date.parse(link.createdAt) - 60 * 60_000).toISOString();
    ids = await paymentIdsByListing(client, link.orderId, link.locationId, since);
    via = "ListPayments filtered by order_id";
  }
  console.log(`${new Date().toISOString()} order ${link.orderId}: ${ids.length} payment(s) found via ${via}`);
  for (const id of ids) {
    if ((await reconcilePayment(client, id, link)) === "PAID_VERIFIED") return true;
  }
  return false;
}

await run("poll", async () => {
  const start = Date.now();
  for (;;) {
    if (await onePass()) return;
    if (!watch || Date.now() - start + INTERVAL_MS > WINDOW_MS) break;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log("NOT PAID: no COMPLETED payment matched the saved order.");
  process.exitCode = 3;
});
