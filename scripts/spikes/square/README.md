# Spike B-02: Square sandbox

This folder proves, against the real Square sandbox, the payment steps of Flow B in `docs/FLOWS.md`: the quote (B8), the payment link (B18, B19), the webhook (B25), the paid check (B26) and the poller (B27). It also holds the fallback from SPEC section 4 for the case where the hosted link cannot be paid in sandbox.

It is a self-contained npm project. It is not part of the root workspaces. Everything runs in sandbox only: every script exits at once unless `SQUARE_ENVIRONMENT` is exactly `sandbox`. No script prints a secret.

## What is here

| Script | What it does |
|---|---|
| `npm run locations` | Lists your sandbox locations so you can copy the location ID. |
| `npm run seed-catalog` | Creates two pizzas (Margherita, Pepperoni), each with Small, Medium and Large, a "Toppings" modifier list with three priced toppings on both pizzas, and one 8.75% sales tax on both items. One BatchUpsertCatalogObjects call with `#temp` IDs. Run it again and it finds the objects by name and updates them instead of making copies. Writes `catalog-ids.json`. |
| `npm run quote` | CalculateOrder for 1 Large Margherita plus 1 Medium Pepperoni with Extra cheese, with `pricing_options.auto_apply_taxes = true` and no `order.taxes`. Prints subtotal, tax and total in cents and confirms no order ID came back. |
| `npm run create-link` | Quotes again, then CreatePaymentLink with the same order and the same tax option and a stable idempotency key. Prints the URL, payment link ID and order ID, reads the order back with RetrieveOrder and exits with code 2 if its total differs from the quote. Writes `last-link.json`. |
| `npm run webhook-server` | Fastify on `PORT` (default 4010) with `POST /webhooks/square`. Verifies the signature on the raw body, answers 403 to a bad one, deduplicates on `event_id`, answers 200, then reads the payment from Square and prints `PAID_VERIFIED` only if it matches `last-link.json`. |
| `npm run poll` | The fallback when no webhook arrives. Finds the payments for the saved order and applies the same check. Add `-- --watch` to repeat every 30 seconds for 15 minutes. |
| `npm run fallback-payment` | Only if the hosted link cannot be paid. CreateOrder plus CreatePayment with the sandbox test token, then the same check. Everything it prints is labelled SIMULATED. |
| `npm test` | Unit tests for the signature check, the webhook route, the paid check and the idempotency key. No keys needed. |
| `npm run typecheck` | `tsc --noEmit`. |

Files the scripts write (`catalog-ids.json`, `last-link.json`, `last-quote.json`) are git-ignored by the local `.gitignore`.

## Steps from zero

You need Node 24 and a phone or a second computer for the payment.

1. **Install.** In this folder (`scripts/spikes/square`):

   ```bash
   npm install
   npm test
   ```

   The tests should pass before you have any keys.

2. **Get sandbox credentials.**
   1. Sign in at https://developer.squareup.com/apps (create a free developer account if you have none).
   2. Create an application, or open the existing one.
   3. At the top of the application page, switch the toggle to **Sandbox**.
   4. Open **Credentials**. Copy the **Sandbox Access Token**. This is `SQUARE_ACCESS_TOKEN`.
   5. Do not copy the production token. The scripts refuse to run unless `SQUARE_ENVIRONMENT=sandbox`, and the client always talks to `https://connect.squareupsandbox.com`.

3. **Create `.env.local`** in the repo root (`C:\Users\arshg\AI HACK CALPOLY\.env.local`, the main checkout). The scripts walk up from this folder until they find a `.env.local`, so the one in the main checkout is found from any worktree under it. Start from `.env.example` and fill in:

   ```text
   SQUARE_ENVIRONMENT=sandbox
   SQUARE_ACCESS_TOKEN=<sandbox access token from step 2>
   SQUARE_LOCATION_ID=<from step 4>
   SQUARE_WEBHOOK_SIGNATURE_KEY=<from step 7>
   SQUARE_WEBHOOK_URL=<from step 6, for example https://your-name.ngrok-free.app/webhooks/square>
   ```

   A script that needs a variable you have not set yet stops and names exactly which one is missing. `locations` needs only the first two. `seed-catalog`, `quote`, `create-link`, `poll` and `fallback-payment` need the first three. `webhook-server` needs all five.

   Note: `.env.example` sets `PORT=4000`. If your `.env.local` has a `PORT`, the webhook server uses it instead of 4010. The server prints the port it listens on; point the tunnel at that port.

4. **Find the location ID.**

   ```bash
   npm run locations
   ```

   Copy the `id` of an `ACTIVE` location into `SQUARE_LOCATION_ID`.

5. **Seed the catalog, then quote.**

   ```bash
   npm run seed-catalog
   npm run seed-catalog
   npm run quote
   ```

   The second `seed-catalog` should print `Created 0` and list everything as updated. If it creates new objects, that is a no-go for idempotent seeding. `quote` should print a tax above 0 and the line `OK: no order id in the response, so nothing was persisted.`

6. **Expose the webhook server on a fixed address.** Square signs each event with the exact URL you register, so the address must not change between runs. A free ngrok account includes one static domain:
   1. Install ngrok and sign in (`ngrok config add-authtoken <token>`).
   2. In the ngrok dashboard, open **Domains** and claim your free static domain.
   3. Start the server and the tunnel in two terminals:

      ```bash
      npm run webhook-server
      ngrok http --url=<your-static-domain> 4010
      ```

   4. Set `SQUARE_WEBHOOK_URL=https://<your-static-domain>/webhooks/square` in `.env.local` and restart the server.

   A Cloudflare named tunnel on your own domain also works. A quick tunnel with a random address does not, because the address changes each time.

7. **Create the webhook subscription.**
   1. In the Developer Console, open your application, keep the **Sandbox** toggle on, and open **Webhooks**, then **Subscriptions**.
   2. Click **Add subscription**.
   3. URL: paste exactly the value of `SQUARE_WEBHOOK_URL`, character for character: same scheme, host, path, no trailing slash. The signature covers this URL, so any difference makes every real event fail with 403.
   4. Events: select `payment.created` and `payment.updated`.
   5. Save. Open the subscription and copy its **Signature key** into `SQUARE_WEBHOOK_SIGNATURE_KEY`.
   6. Restart `npm run webhook-server`. It prints the URL it uses for signatures. Compare it with the console.

8. **Create the payment link, twice.**

   ```bash
   npm run create-link
   npm run create-link
   ```

   Each run must end with `MATCH: link order total ... equals the quote total. GO.` Compare the two runs: the same idempotency key should return the same `url`, `paymentLinkId` and `orderId`. To make a genuinely new link later (for example after you have paid the first one), pass a new approval ID: `npm run create-link -- --approval apv_SPIKE02`.

9. **Pay on a second device.** Open the printed `url` on your phone (or another computer). Pay with:
   - card number `4111 1111 1111 1111`
   - CVV `111`
   - any future expiry date
   - any postal code the page accepts

   To test a decline, repeat with a new link and card `4000 0000 0000 0002`.

10. **Watch the webhook server.** Within a short time it should print, in order, `VERIFIED SIGNATURE: event_id=... type=payment.created` and `payment.updated` lines, then a `PAID_VERIFIED [SANDBOX] payment ...` line. Square may resend an event; the second copy prints `DUPLICATE EVENT` and changes nothing.

11. **If no webhook arrives**, run the poller:

    ```bash
    npm run poll
    npm run poll -- --watch
    ```

12. **Only if step 9 fails** because the hosted page cannot take a sandbox payment (SPEC section 4 warns about this), run:

    ```bash
    npm run fallback-payment
    ```

    It uses the sandbox payment token `cnon:card-nonce-ok`, listed on the official page https://developer.squareup.com/docs/devtools/sandbox/payments as "card payment succeeds". The result is labelled SIMULATED. It overwrites `last-link.json`, so run `create-link` again before you go back to the hosted link. If the webhook server is running, it should also print `PAID_VERIFIED [SANDBOX, SIMULATED]` for this payment.

## Reading the output: go or no-go

| Output | Meaning |
|---|---|
| `ENV ERROR: missing ...` | A variable is not set. The message names it. |
| `ENV ERROR: SQUARE_ENVIRONMENT must be exactly "sandbox"` | Refused on purpose. Fix `.env.local`. |
| `SQUARE ERROR during ...: HTTP 401` | Wrong token, or a production token used against sandbox. |
| `OK: no order id in the response` (quote) | Go: CalculateOrder did not persist anything. |
| `NOT EXPECTED: CalculateOrder returned an order id` | No-go: the quote may have created an order. |
| `WARN: tax is 0` | No-go for tax: the items did not pick up the tax. |
| `MATCH: ... GO.` (create-link, exit 0) | Go: quote total equals the link's order total, tax included. |
| `MISMATCH: ... NO-GO.` (create-link, exit 2) | No-go: the totals differ. Flow B would stop at B19. |
| `BAD SIGNATURE: rejected with 403` | Expected for forged requests. For real Square events it means the URL or key is wrong. If it adds `a hex digest would have matched`, the header is hex, not base64. |
| `VERIFIED SIGNATURE ... header=base64-like` | Go: real events verify, and the header looks like base64. |
| `DUPLICATE EVENT` | Go: deduplication on `event_id` works. |
| `NOT PAID YET: status is APPROVED` (or other) | The payment exists but is not `COMPLETED`. Not a success. |
| `MISMATCH for payment ...` | No-go: a payment exists but its order, amount, currency or location does not match. |
| `PAID_VERIFIED [SANDBOX] ...` | Go: the hosted link took a payment and it verified. |
| `PAID_VERIFIED [SANDBOX, SIMULATED] ...` | The fallback works. The hosted link did not, so the demo must label the payment simulated. |
| `NOT PAID: no COMPLETED payment matched` (poll, exit 3) | Nothing paid yet for the saved order. |

## Questions this spike answers

Fill in the Result column after the run.

| Question | How to answer it | Result |
|---|---|---|
| Does the hosted link accept payment in sandbox? | Step 9, then a `PAID_VERIFIED [SANDBOX]` line from step 10 or 11 | |
| Do the quote total and the link total match with tax? | Step 8 prints `MATCH` and exits 0 | |
| Does the payment webhook arrive and verify? | Step 10 prints `VERIFIED SIGNATURE` for `payment.*` events | |
| Is the signature header base64? | Step 10 prints `header=base64-like` on verified events. The SDK's own `WebhooksHelper` compares against a base64 digest. | |
| Does a repeated idempotency key return the same link? | Step 8: both runs print the same `url`, `paymentLinkId` and `orderId` | |
| Is there a length cap on idempotency keys for CreatePaymentLink and CreatePayment? | The API reference lists a maximum of 192 characters for CreatePaymentLink and 45 for CreatePayment. The SPEC 2.9 key is 64 hex characters, so CreatePayment needs a shortened key (`fallback-payment` uses the first 45). Confirm live: the 64-character key in step 8 is accepted, and step 12 works with 45. | |

## Not verified without keys

None of these has been run against Square. Each is an assumption in the code until the steps above confirm it.

1. CalculateOrder applies the catalog tax to items that list it in `tax_ids` when `auto_apply_taxes` is true, and returns no order `id`.
2. ListCatalog with `types=ITEM,MODIFIER_LIST,TAX` returns item variations nested in `item_data.variations` and modifiers nested in `modifier_list_data.modifiers`, which the re-run logic in `seed-catalog` relies on to update rather than duplicate.
3. BatchUpsert accepts a mix of new `#temp` objects and existing objects with their real ID and current `version` in one batch, and returns `id_mappings` for every `#temp` ID.
4. Modifier price is added to the line total and taxed, so a cart with a modifier still matches between the quote and the link.
5. A repeated CreatePaymentLink call with the same key and the same body returns the same link instead of an error or a new link.
6. CreatePaymentLink accepts the 64-character hex key (the reference says the cap is 192).
7. RetrieveOrder (`GET /v2/orders/{order_id}`) returns the link's order with `total_money` right after the link is created. This is the read endpoint and field that FLOWS B19 asks the spike to confirm.
8. The hosted checkout page can be paid in sandbox with the test card (SPEC 4 says this is in doubt).
9. The webhook header is base64. The SDK helper and the sample header on the official validation page both point to base64, but the page does not state it.
10. A `payment.*` event carries the payment ID at `data.object.payment.id` (with `data.id` as a fallback). The server never trusts any other field of the body.
11. A payment made through the link reaches status `COMPLETED` on its own, and its `amount_money` equals the order total (no tip is added on the hosted page by default).
12. The order's `tenders[].payment_id` lists the payment once it is paid; if not, `poll` falls back to ListPayments for the location filtered by `order_id`.
13. The full list of payment status names, and which one a declined card produces. The reference page shows `COMPLETED` and mentions `APPROVED`; the SDK type lists `APPROVED`, `PENDING`, `COMPLETED`, `CANCELED`, `FAILED`.
14. CreateOrder with a fixed idempotency key returns the same order on a re-run, and CreatePayment with `autocomplete: true` and `cnon:card-nonce-ok` completes at once.
15. Square delivers sandbox webhooks to an ngrok static domain without extra setup.
16. The console steps (where the Sandbox toggle, Credentials, Locations and Webhooks pages are) match the current Developer Console layout.

## Differences from the project docs

- FLOWS section 4 says a bad webhook signature returns 401. This spike returns 403 because the B-02 task asked for 403. The server build should pick one; API.md is the tie-breaker for error codes.
