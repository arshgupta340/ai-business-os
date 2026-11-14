// npm run webhook-server: Fastify on PORT (default 4010), POST /webhooks/square.
// Reads the raw body, verifies x-square-hmacsha256-signature, rejects a bad one
// with 403, deduplicates on event_id in memory, answers 200 at once, then for
// payment events reads the payment from Square and applies the paid check.
import { existsSync } from "node:fs";
import { requireSquareEnv } from "./env.js";
import { LAST_LINK_FILE, loadLastLink, makeClient } from "./common.js";
import { reconcilePayment } from "./reconcile.js";
import { buildWebhookApp } from "./webhook-app.js";

const env = requireSquareEnv([
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_WEBHOOK_URL",
]);
const client = makeClient(env.SQUARE_ACCESS_TOKEN);
const port = Number(process.env.PORT ?? 4010);

const app = buildWebhookApp({
  notificationUrl: env.SQUARE_WEBHOOK_URL,
  signatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  onPayment: async (paymentId) => {
    if (!existsSync(LAST_LINK_FILE)) {
      console.log(`No ${LAST_LINK_FILE}, so nothing to compare payment ${paymentId} with. Run create-link first.`);
      return;
    }
    await reconcilePayment(client, paymentId, loadLastLink());
  },
});

await app.listen({ port, host: "0.0.0.0" });
console.log(`SANDBOX webhook server listening on http://localhost:${port}/webhooks/square`);
console.log(`Signature URL in use: ${env.SQUARE_WEBHOOK_URL} (must equal the URL registered in the Developer Console)`);
