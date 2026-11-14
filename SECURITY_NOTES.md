# Security notes

**Task:** S-06. **Updated:** 2026-11-14. **Describes:** the code on `main` at commit `4f1bed8`, merged into branch `arsh/S-06-docs`.

This file lists the eight rules from `AGENTS.md` that are never broken. For each rule it says where the code enforces it, which tests cover it, what has been verified against a real service, and what is not yet enforced or not yet tested. It then describes the restricted database role, webhook handling, idempotency keys, secrets, and the known limits.

## 1. How to read the status words

Every control in this file has one of three statuses.

| Status | Meaning |
|---|---|
| Built and tested with fakes | The code is on `main` and automated tests cover it. The tests use an in-process Postgres (PGlite) with migrations 0001 to 0006 applied, and fake Square, Google, Twilio, message and model providers. No real provider is called. |
| Verified against the real service | A person or a script ran it against the real service, and the result is in the list in section 2. |
| Not built | The code is not on `main`. |

A control that is built and tested with fakes is not proven to work live. Where this file does not say "verified against the real service", read "not verified".

## 2. What has been verified against real services

This is the complete list as of 2026-11-14 10:00 Pacific. I did not rerun any of it for this document, and I did not connect to the real accounts. It was given to me as fact by the lead session.

**Supabase**

- Migrations 0001 to 0006 are applied.
- As the server's restricted role `abos_app`, on the real database, each of these is refused: changing a business's owner, inserting a business, editing a user, inserting an approval directly, inserting a payment receipt directly, inserting an already-paid order, disabling triggers, and switching role. A business rename is allowed.
- The startup role check reports the restricted role for both the login and the active role.

**Render**

- The full server is deployed at `https://abos-server.onrender.com` from `main` on a paid instance.
- On it, the smoke script passes 9 of 9: health, sign-in, businesses, facts, approvals, integration health, live agent, a request with no token (401), and a request with a malformed token (401).
- On it, integration health from live read-only probes reports Square, Twilio, OpenAI, Google Calendar, Google Sheets and the message channel connected.
- On it, unsigned requests to `/webhooks/square`, `/webhooks/twilio/voice` and `/webhooks/twilio/status` are refused, with 401, 403 and 401.

**A pizza order on the deployed server** (`scripts/live/run-demo.ts pizza,pay`)

- A simulated call on the real model quoted through Square and proposed an order.
- The owner approval returned in under a second.
- One Square sandbox payment link was created with the database's idempotency key, and the order reached `PAYMENT_PENDING`.
- A SIMULATED sandbox payment completed. The script opened the Square order with UpdateOrder and paid it through the API with Square's sandbox test nonce. There was no card form and no real money.
- About 4 seconds later there was one payment receipt, the order was `PAID_VERIFIED` and then `FULFILLMENT_READY`, and its row was read back from the Orders tab of the demo sheet.
- Two Square webhook events were stored and processed by the deployed server around that time.

**On a local server against the same real backend**

- Approving twice makes no second link.
- A wrong payload hash is refused.
- A rejected order makes zero Square writes.
- A barbershop booking created a real Google Calendar event, reached `BOOKED_VERIFIED`, and wrote a row to the Bookings tab.
- An opening-hours fact moved to a new version.
- A brand-new fact key was confirmed.

**Vendor findings**

- A Square order created through a payment link stays `DRAFT` until the hosted checkout opens it. A direct payment on it is refused until it is `OPEN`.
- Twilio SMS from the unregistered US number fails with error 30034.
- The Twilio account is a full account, not a trial.
- The Twilio voice and status webhooks, and a Square sandbox webhook subscription for `payment.created` and `payment.updated`, are registered at the Render address.

**OpenAI**

- A realtime session probe passed 11 of 11 on `gpt-realtime-2.1`.
- The builder interview and the test console ran on the real model.

**Not verified with any real service**

- A real phone call through Twilio to the voice worker.
- Paying through Square's hosted checkout page with a test card.
- Any customer message delivery. The message channel is `qr_only`, so the checkout link is shown as a QR code.
- The web app run against the deployed server.
- The booking flow on the deployed server. It passed on a local server.
- AgentPhone (decision D-12). It is built behind a provider switch on a branch, with no live test. Outbound calls need account funds.

**Three things to keep in mind when reading the list**

- The list names `scripts/live/run-demo.ts` for the pizza run. That script drives the server over HTTP as the seeded owner, with a simulated call in text. The checks on a local server match the script's other flows (`negative`, `booking`, `hours`), and I have assumed the same script made them. Where this file or the other three say "by script" for a local check, it rests on that assumption. The list records no run of these flows by a person at the web screens, and no rehearsal.
- The list does not name the commit the deployed server was running. Pull requests #104 and #110 were merged into `main` at about 10:10 Pacific, after the time of the list. What they changed (the AgentPhone contract values, and keeping the current value on a database conflict) is tested with fakes only.
- The smoke script the list cites is not in the repository on `main`. I found no `smoke` script in any `package.json` or under `scripts/`.

## 3. Test results from this checkout

I ran these on 2026-11-14 in a cloud container with 4 cores and Node 22.23.4, on `main` at `4f1bed8` merged with the four documents. I also ran them one commit earlier, at `50d4c80`, with the same totals: the commit between changed only Markdown files. The spec and CI name Node 24.

| Command | Result |
|---|---|
| `npm run typecheck` | Passed for all four workspaces (`@abos/server`, `@abos/web`, `@abos/contracts`, `@abos/db`). |
| `npm test` | 121 test files, 2172 tests. 2170 passed. 2 are marked as expected failures. |
| `npm test -w @abos/web` | 52 test files, 600 tests. All 600 passed. |

**The 2 expected failures.** The adversarial suite marks two known open defects with `it.fails`, so the run passes while they stay open. One: `GET /api/builder/ping` answers without a token (`apps/server/test/adversarial/access.test.ts`, issue #96). Two: after crash recovery a message dispatch stays `QUEUED` where `docs/FLOWS.md` says `UNKNOWN` (`apps/server/test/adversarial/idempotency.test.ts`). The second fails closed: nothing resends a queued dispatch, and the checkout view shows it as unknown.

**CI.** The CI workflow (typecheck, `npm test`, the web tests, on Node 24) finished with success on `main` at `50d4c80` (run 130), the last commit on `main` that changed code before this document. I read that result from GitHub. The result for this branch is in the pull request, not in this file.

## 4. The eight rules

### Rule 1. No external write happens before the owner approves the exact payload

**Status:** built and tested with fakes. Verified against real services in part: see "Verified" below. The message step and the Square price write have never run against a real provider.

**Where it is enforced**

- **The agent has no write tool.** See rule 6.
- **A proposal only writes our own database.** `createOrderProposal` and `createBookingProposal` in `apps/server/src/policy/engine.ts` store the order or booking and open an approval. They call no provider. They refuse a call that has ended.
- **The server cannot write approvals or executions directly.** Migration `0004_runtime_role_and_routines.sql` gives `abos_app` SELECT only on `approval_requests`, `action_executions`, `message_dispatches` and `sync_jobs`. Every change goes through a checked routine (section 5).
- **The approval is bound to its payload.** `private.create_approval` rebuilds the material fields itself with `private.material`, compares them with the canonical text the server sent, and recomputes the SHA-256 hash. `private.check_subject` compares the approval with the stored order, booking, fact or catalog row.
- **The decision is checked in the database.** `private.decide_and_enqueue` requires the business owner, the exact stored hash and an unexpired approval. It inserts execution rows only when the state is `APPROVED`.
- **An approval is used once.** The trigger `approval_requests_guard` allows a row to be created only as `PENDING`, freezes the payload, and refuses any change after a decision. A unique index allows one `PENDING` approval per subject.
- **An execution row needs an approved bundle.** The trigger `action_executions_match_approval` (0002) refuses an execution row unless its approval is `APPROVED`, in the same business, and lists that action at that position. `execution_claim_allowed` refuses a step until the earlier steps have finished.
- **A message goes only to the approved recipient.** The trigger `message_dispatches_guard` (0002) requires the dispatch recipient and channel to equal the approved payload. `private.record_dispatch` reads both from the approval, not from the server.
- **The executor checks again before it writes to a provider.** `runTick` in `apps/server/src/executor/index.ts` calls `authorizeStep` (in `policy/engine.ts`) before the handler. Each handler makes its provider calls inside the `external` wrapper, which calls `authorizeStep` again first. The wrapper runs once for each handler operation, not once for each HTTP request: one wrapped operation covers, for example, CreatePaymentLink and the order read that follows it. Every provider write is inside the wrapper. The catalog read in the step `local.catalog.sync` is outside it. `orderFor` and `bookingFor` in `apps/server/src/executor/handlers.ts` compare the stored order or booking with the approved material and refuse a mismatch.
- **A price change is a bundle like the others.** `POST /api/businesses/:id/catalog/prices/propose` (`apps/server/src/api/prices/index.ts`) reads the current Square price and stores a `PENDING` `price_edit` approval through `createPriceEditApproval`. It does not write to Square. The write runs in the executor step `square.catalog.price.update` after the owner approves.
- **The Sheets row needs the same approval.** `private.enqueue_sheets_sync` and `private.claim_sync_job` require a verified subject and an approved bundle that lists the Sheets action.
- **The server cannot change what was proposed or who owns a business.** Migration `0006_ownership_material_and_receipts.sql` freezes an order's cart, quote, total, contact and pickup, and a booking's material columns, for `abos_app` from the moment the row is inserted. It also stops `abos_app` from creating a user or a business, from changing a user, and from changing a business's owner. The decision routine trusts that owner.
- **Unwired pieces fail closed.** Without a database, `notWiredExecutor` in `apps/server/src/compose/seams.ts` leaves approved steps `QUEUED` and runs nothing.

**Tests:** `packages/db/test/direct-dml.test.ts`, `packages/db/test/guarded-updates.test.ts`, `packages/db/test/constraints.test.ts`, `packages/db/test/runtime.test.ts`, `packages/db/test/runtime-hardening.test.ts`, `apps/server/test/policy/engine.test.ts`, `apps/server/test/executor/executor.test.ts`, `apps/server/test/executor/review.test.ts`, `apps/server/test/api/prices/index.test.ts`, `apps/server/test/e2e/main-flow.test.ts` (reject leaves no steps, a wrong hash is refused, an expired approval is refused, another owner cannot decide), `apps/server/test/e2e/flows.test.ts`, where the flow tests count the external writes that ran, `apps/server/test/e2e/routines.test.ts` (the price change runs once after approval), and the adversarial files `apps/server/test/adversarial/no-write-before-approval.test.ts` and `apps/server/test/adversarial/approvals.test.ts`.

**Verified against real services**

- On the real database, as `abos_app`: inserting an approval directly is refused, and so are changing a business's owner, inserting a business and editing a user.
- On the deployed server: the Square sandbox payment link for the pizza order was created after the owner approved. The script stops if it finds a Square step for the approval before the decision. That check counts execution rows in our database. It does not read Square.
- On a local server against the real backend: a wrong payload hash is refused, and a rejected order makes zero Square writes. The script measures "zero Square writes" as no execution steps and no Square order ID on the order.
- The Calendar event and both Sheets rows in section 2 were written after an approval made through the API.

**Not yet enforced or tested**

- **One local write needs no approval by design.** "Keep the current value" on a fact conflict stored in the database is resolved by `POST /api/conflicts/:id/resolve` with no approval (`apps/server/src/api/conflicts.ts`). It writes only our own `fact_conflicts` row and an activity event. Nothing external is written and no fact version is created. SPEC 2.9 ("Resolving a conflict") allows this.
- **Handing a call to a person has no owner approval.** `apps/server/src/compose/fallback.ts` can redirect a live call to the business's fallback number through a Twilio call update. The notes in `apps/server/src/voice/fallback/NOTES.md` call this a proposal that the owner must still ratify. It is refused today for every published version, because no contract field enables it and the default in `compose/fallback.ts` answers no. It is not one of the four writes rule 1 names. The lead should rule on it before it is enabled.
- **Three operator commands write to providers outside the approval engine.** All three are run by a person from a laptop. None is reachable from the server or the agent.
  - `npm run seed` (when the Square keys are set) and `npm run seed:square` write the demo catalog to the Square sandbox.
  - `npm run register-webhooks -- --apply` changes the webhook settings on the Twilio number and the Square sandbox subscription.
  - The `pay` flow of `scripts/live/run-demo.ts` opens a Square sandbox order with UpdateOrder and pays it with CreatePayment and Square's sandbox test nonce. It stands in for the customer paying, on an order whose checkout the owner already approved. It refuses to run unless `SQUARE_ENVIRONMENT` is `sandbox`, and it labels every line SIMULATED. A comment in the script records it as a decision by the lead on 2026-11-14. The live run in section 2 used it.
- The spike scripts under `scripts/spikes/` also call providers. I did not review them for this document.
- No message step and no Square price write has run against a real provider.

### Rule 2. Every webhook is signature-verified and deduplicated before it changes state

**Status:** built and tested with fakes. Verified against real services in part: see "Verified" below. A signed Twilio request has not reached this code.

**Where it is enforced**

- **Square.** `apps/server/src/webhooks/plugin.ts` reads the raw bytes in its own parser scope. `verifyWebhookSignature` in `apps/server/src/adapters/square/core.ts` computes HMAC-SHA256 over the notification URL plus the raw body with the signature key, encodes it as base64, and compares it with `timingSafeEqual`. A bad or missing signature gets 401, a `webhook.rejected` activity event, and nothing is stored (`rejectWebhook` in `apps/server/src/webhooks/square.ts`).
- **Square dedupe.** `recordOnce` in `apps/server/src/compose/webhooks.ts` inserts into `webhook_events` with `on conflict (source, provider_event_id) do nothing`. Only a newly inserted row is processed.
- **The body is never trusted.** `parseSquareEvent` keeps only the event ID, the event type, the payment ID and the Square order ID. `processPayment` reads the payment from Square for its status and amount.
- **Twilio call status.** The same plugin validates the request with `twilio.validateRequest` and the account auth token against `PUBLIC_SERVER_URL` plus the route path. The dedupe key is the call SID plus the status.
- **Twilio voice.** `apps/server/src/voice/plugin.ts` validates `X-Twilio-Signature` and answers 403 on failure. A rejected request writes `webhook.rejected` against the business that holds the Twilio number in `live_agent` (`dbVoiceEventsPort` in `compose/ports.ts`). A repeated webhook for the same call gets the same pending stream token or a 409. `calls.provider_call_id` is unique, so there is never a second call row.
- **A stored event is marked when its job is done.** `private.mark_webhook_processed` (0006) sets `processed_at`. After a restart every stored row without it is run again, whatever its age (`recoverNow` in `compose/webhooks.ts`). Processing is safe to repeat.
- **Delivery receipts.** A verified WhatsApp receipt moves a sent dispatch forward through `private.update_dispatch_status` (0006). A receipt that arrives while the send step is still running is deferred and applied later.
- **Malformed input stops at the edge on owner routes.** On a route with the owner policy, a malformed ID or a NUL byte is answered 400 before any query uses it (`apps/server/src/auth/verify.ts`, `apps/server/src/api/routes.ts`). The builder routes validate their own input in their handlers.
- **Missing settings.** Without `PUBLIC_SERVER_URL`, `SQUARE_WEBHOOK_SIGNATURE_KEY` or a database, `/webhooks/square` and `/webhooks/twilio/status` answer 503 without reading the body (`notWiredWebhooks`). Without the voice settings, `/webhooks/twilio/voice` answers 503 and `/ws/phone` does not exist (`apps/server/src/app.ts`).

**Tests:** `apps/server/test/webhooks/plugin.test.ts`, `apps/server/test/webhooks/review.test.ts`, `apps/server/test/adapters/square/square.test.ts`, `apps/server/test/voice/plugin.test.ts`, `apps/server/test/e2e/voice-wiring.test.ts`, `apps/server/test/adversarial/webhooks.test.ts` (signature, duplicate delivery, events out of order, a signed event that does not match the order, huge and malformed bodies), and in `apps/server/test/e2e/flows.test.ts` the tests "a duplicate webhook delivery changes nothing" and "a bad signature is rejected with 401, writes webhook.rejected and stores nothing".

**Verified against real services**

- On the deployed server, unsigned requests to `/webhooks/square`, `/webhooks/twilio/voice` and `/webhooks/twilio/status` are refused with 401, 403 and 401.
- Two Square webhook events were stored and processed by the deployed server around the time of the simulated payment. The code stores an event only after its signature check passes, so this is evidence that real Square signatures passed the check, including the base64 encoding that `docs/SPEC.md` section 2.9 asked a spike to confirm.
- The webhooks are registered at the Render address (section 2).

**Not yet enforced or tested**

- A signed Twilio request has not been verified, because no real call has been placed. Whether Twilio's signature validates against `PUBLIC_SERVER_URL` plus the path behind Render's proxy is not known.
- A duplicate delivery of a real webhook is not verified. Square's delivery of an event twice has only been simulated in tests.
- The Square check signs over `PUBLIC_SERVER_URL` plus `/webhooks/square`. The variable `SQUARE_WEBHOOK_URL` is parsed by `apps/server/src/env.ts` but the server does not use it for the check. The two must describe the same address.
- A rejected Square webhook is recorded against the business with the most rows in `catalog_items`. SPEC 2.9 says to read the owner from `integrations`.
- The conflict resolve route reads its conflict by the ID in the path before the builder handler validates that ID (the hook in `apps/server/src/app.ts`). The query is parameterized. I did not test what a NUL byte in that ID does.
- There is no timestamp or nonce check. Replay protection is the event ID.

### Rule 3. Every external write carries a stable idempotency key

**Status:** built and tested with fakes. Verified against real services in part: see "Verified" below.

**Where it is enforced**

- **The database derives the key.** `private.decide_and_enqueue` computes `sha256(businessId:subjectId:actionType:approvalId)` in hex for each step when it inserts the execution row. `private.enqueue_sheets_sync` does the same for the Sheets job. On the approved-step path the server never creates or replaces a key (`apps/server/src/compose/executor.ts`).
- **The key cannot change or disappear.** `action_executions.idempotency_key` is unique. The trigger `action_executions_match_approval` refuses a change to it. The trigger function `private.retain_identity` (0004) refuses deleting an execution or a dispatch and refuses changing a sync job's identity.
- **The executor confirms the key.** `authorizeStep` recomputes the key with `idempotencyKey` from `packages/contracts/src/hash.ts` and refuses a mismatch.
- **Each provider gets the row's key where it accepts one.** Square `CreatePaymentLink` receives it as `idempotencyKey` (`createCheckout` in `adapters/square/core.ts`). The Square price write receives it (`updateCatalogPrice` in `executor/handlers.ts`). The Google Calendar event ID is the key, and the adapter looks the event up before every insert (`apps/server/src/adapters/calendar/index.ts`). A message has one `message_dispatches` row per execution. A Sheets row is found by its record ID in the first column.
- **A timeout is never retried blindly.** `classifyFailure` in `executor/index.ts` sends a timeout or an unknown result to `NEEDS_REVIEW`. A claim gives the worker a 15 minute lease (`lease_deadline`, 0005). A step still `RUNNING` after its lease goes to `NEEDS_REVIEW` through `private.recover_stale_executions`, never back to `QUEUED`.
- **Review keeps the key.** `POST /api/executions/:id/resolve` goes through `private.resolve_execution` and never makes a new key. It refuses when the evidence is unsure (`apps/server/src/api/recovery/index.ts`). What it can do today is narrower than the route's contract. For the checkout step the server reads the link back from Square, and if the link exists and its total matches, the step is completed with that same link. For a message step the evidence is the stored dispatch row, not a provider read: a dispatch that is already sent completes the step. The wired lookup in `apps/server/src/compose/recovery.ts` never reports that an effect is absent, and it always answers "unknown" for a Calendar step and a price step. So on the composed server nothing is requeued or abandoned through this route, and a Calendar or price step in review cannot be resolved through it.

**Tests:** `packages/contracts/src/hash.test.ts`, `packages/db/test/guarded-updates.test.ts`, `packages/db/test/payments-and-recovery.test.ts`, `packages/db/test/review-0005.test.ts`, `apps/server/test/executor/executor.test.ts`, `apps/server/test/api/recovery/recovery.test.ts`, `apps/server/test/adapters/message/message.test.ts`, `apps/server/test/adapters/calendar/index.test.ts`, `apps/server/test/adapters/sheets/index.test.ts`, `apps/server/test/adapters/square/price.test.ts`, in `apps/server/test/e2e/flows.test.ts` the paid path (checkout with the database key), "Square create timeout: NEEDS_REVIEW, order RECOVERY_REQUIRED, no link sent, no second create", "approving twice runs the steps once" and the crash recovery test, in `apps/server/test/e2e/routines.test.ts` the recovery of a `NEEDS_REVIEW` checkout, and `apps/server/test/adversarial/idempotency.test.ts` (a worker that dies between claim and finish, provider timeouts and ambiguous replies).

**Verified against real services**

- On the deployed server, one Square sandbox payment link was created with the database's idempotency key.
- On a local server against the real backend, approving twice made no second link.
- A real Google Calendar event and one row in each Sheets tab were created. The duplicate guards for those two (the event ID as the key, the record ID lookup) were not exercised by a repeat against the real services.

**Not yet enforced or tested**

- Most message channels accept no idempotency key, so the dispatch row is the guard against a second message. The exception in the adapter is the SMSGate kind of `android_gateway`, which is sent the first 36 characters of the key as the message ID. Whether SMSGate refuses a repeated ID is not verified.
- After a worker dies during a send, the dispatch row stays `QUEUED` although the outcome is unknown. No routine can mark it `UNKNOWN`, and the server's review lookup answers "unknown" for a dispatch that is not already sent, so the route cannot resolve it. Nothing resends it, and `GET /api/orders/:id/checkout` shows it as unknown. The adversarial suite records this as an open defect.
- The Square price write is not verified against the real service. `apps/server/src/api/prices/NOTES.md` says the key length limit for the Square catalog write is not established.
- The routines `renew_execution_lease` and `renew_sync_lease` exist in 0005. Nothing in `apps/server/src` calls them. A step that runs longer than 15 minutes would be sent to review.
- The decision endpoint's `Idempotency-Key` replay cache is in server memory (`apps/server/src/api/routes.ts`). It is lost on restart. The database one-use rule still holds.
- Two keys are made by server code outside the approved-step path. The human fallback derives its own key for an in-memory reservation (`compose/fallback.ts`), and it is not sent to Twilio. The Calendar adapter falls back to a hash of the booking ID if no key is passed; the executor always passes the row's key.

### Rule 4. Payment data is always labeled sandbox, and `SQUARE_ENVIRONMENT` must be `sandbox`

**Status:** built and tested with fakes. Every real Square call in section 2 was made on the Square sandbox.

**Where it is enforced**

- `apps/server/src/env.ts` accepts only the literal `sandbox` for `SQUARE_ENVIRONMENT`. An unset or empty value defaults to `sandbox`. `apps/server/src/index.ts` exits when the environment does not parse.
- `authorizeStep` in `policy/engine.ts` refuses every step with `ENVIRONMENT_MISMATCH` when the environment is not `sandbox`. `decide` refuses the approval of an order bundle or a price edit in the same way.
- `createSandboxSquareClient` in `apps/server/src/adapters/square/client.ts` builds the only Square client in the server. The seed, the webhook registration and the live demo script call Square with their own requests to the sandbox address.
- The database refuses a payment observation whose environment is not `sandbox` (`private.check_payment`, 0005), and the table `payment_receipts` has a check constraint for it.
- `/health` returns `squareEnvironment`. `GET /api/orders/:id/checkout` returns `environment: "sandbox"`. The `checkout.created`, `payment.verified` and `payment.failed` events carry `sandbox: true`. The checkout message text in `apps/server/src/adapters/message/templates.ts` says "Sandbox test payment."
- The reset script refuses to run unless `SQUARE_ENVIRONMENT` is `sandbox`. The Square half of the webhook registration command refuses in the same way. Its Twilio half has no such check and runs first.

**Tests:** `apps/server/test/app.test.ts` ("refuses any Square environment other than sandbox (AC-19)"), `apps/server/test/adapters/square/square.test.ts`, `apps/server/test/policy/engine.test.ts`, `packages/db/test/seed.test.ts`, `packages/db/test/payments-and-recovery.test.ts`, `apps/server/test/scripts/register-webhooks.test.ts`, `apps/server/test/adversarial/sandbox.test.ts`.

**Verified against real services**

- The live demo script stops unless the server's `/health` reports the Square sandbox, the checkout route reports `sandbox`, and the QR code points at Square's sandbox link host. The pizza run in section 2 passed those checks on the deployed server.
- The payment in that run was a SIMULATED sandbox payment with the test nonce. No real money moved.

**Not yet enforced or tested**

- The sandbox labels on the web screens have not been checked in a browser against the deployed server.

### Rule 5. No success state is shown or stored before the provider confirms it

**Status:** built and tested with fakes. Verified against real services in part: see "Verified" below.

**Where it is enforced**

- **Paid and booked states belong to routines.** The triggers `orders_runtime_guard` and `bookings_runtime_guard` (0005) refuse any direct write by `abos_app` that sets or leaves `PAID_VERIFIED`, `FULFILLMENT_READY` or `BOOKED_VERIFIED`, or that changes a payment ID or a Google event ID. A stored checkout reference cannot be changed once it is set. Other moves inside the state machine, such as the first write of the checkout references, are not refused by the trigger when `abos_app` makes them directly. The server makes those through the routines below.
- **Checkout.** `private.save_checkout` stores the Square order ID, link ID and URL and moves the order to `PAYMENT_LINK_READY`, only for the worker that holds the step's lease. The server calls it after `verifyLinkTotal` in `adapters/square/core.ts` has read the Square order and matched its total (`completeCheckout` in `compose/executor.ts`).
- **Payment.** `checkPayment` in `adapters/square/core.ts` verifies a payment only when its status is `COMPLETED`, it is not refunded, and its order ID, amount, currency and location match. `private.mark_order_paid` then checks the observation against the signed approval and the order, writes an append-only row in `payment_receipts`, and sets `PAID_VERIFIED`. `private.fulfill_order` requires that completed receipt before `FULFILLMENT_READY`.
- **Booking.** `private.verify_booking` stores the Google event ID and sets `BOOKED_VERIFIED` in the calendar step, under the step's lease.
- **Review.** `private.resolve_execution` can also store checkout references with `PAYMENT_LINK_READY`, or set `BOOKED_VERIFIED`, when a step in review is completed from evidence (rule 3).
- **Steps.** `private.finish_execution` accepts `SUCCEEDED` for a provider step only with a provider reference. For the checkout step that reference must be the Square order ID `save_checkout` stored (0006). For a message step it also requires a dispatch that is `SENT` or `DELIVERED` with that provider message ID. `private.finish_sync_job` requires a reference for `DONE`.
- **Table constraints (0002):** `orders_link_states_need_square_refs`, `orders_paid_states_need_payment`, `bookings_verified_needs_event`, `message_dispatches_sent_needs_provider_id`.
- **No message, no claim.** When the approved channel is `qr_only`, the message step is created `SKIPPED` and no dispatch row exists. The call is told "approved" with `messageSent` always false (`apps/server/src/compose/decisions.ts`).
- `GET /api/orders/:id/checkout` reports `ready` only when the link ID, the Square order ID and the URL are all stored.

**Tests:** `packages/db/test/payments-and-recovery.test.ts`, `packages/db/test/review-0005.test.ts`, `packages/db/test/constraints.test.ts`, `apps/server/test/webhooks/plugin.test.ts`, `apps/server/test/reconcile/index.test.ts`, `apps/server/test/compose/phase3.test.ts`, in `apps/server/test/e2e/flows.test.ts` "a payment amount mismatch does not reach PAID_VERIFIED" and "a refunded payment does not verify", and in `apps/server/test/e2e/routines.test.ts` "a payment that arrives before the order waits for it".

**Verified against real services**

- On the real database, as `abos_app`: inserting an already-paid order and inserting a payment receipt directly are both refused.
- On the deployed server: the order stayed `PAYMENT_PENDING` until the SIMULATED sandbox payment completed. About 4 seconds after the payment there was one payment receipt, and the order was `PAID_VERIFIED` and then `FULFILLMENT_READY`.
- On a local server against the real backend: the booking reached `BOOKED_VERIFIED` after a real Google Calendar event existed.

**Not yet enforced or tested**

- The stated limit in section 9 applies here.
- A payment made on Square's hosted checkout page is not verified. Neither is a failed or abandoned payment against Square.
- Pause is stored in `agents.state`. Its effect on a real call is not verified.
- A message marked `SENT` means the channel accepted it. It does not mean the customer received it.
- Whether the web screens show a success state only for verified states has not been checked in a browser against the deployed server.

### Rule 6. The deployed agent has only `read` and `propose` tools

**Status:** built and tested with fakes. Not exercised on a real phone call. The simulated calls in section 2 ran on the real model with this toolset.

**Where it is enforced**

- `apps/server/src/tools/real/index.ts` defines seven tools, each mapped to a `read` or `propose` capability. It refuses a tool the agent version does not hold.
- `checkSessionCapabilities` in `apps/server/src/voice/relay.ts` refuses a call when the published spec holds a `write` or `external_message` capability outside the bundle of a propose capability it holds.
- The `capabilities` table has check constraints that tie `write` and `external_message` to approval mode `required` (0002).
- The registry is in `packages/contracts/src/capabilities.ts`. The builder validates the capability set on publish (`validateCapabilitySet` in `apps/server/src/builder/registry.ts`).
- The simulated call uses the same toolset factory as the phone worker (`toolsetFor` in `apps/server/src/compose/index.ts`). The mock test runner refuses any toolset that is not the mock one (`apps/server/src/builder/runner/text-runner.ts`).
- The human fallback is not a model tool. The model cannot transfer a call.

**Tests:** `apps/server/test/tools/real-toolset.test.ts`, `apps/server/test/mock-toolset.test.ts`, `apps/server/test/voice/relay.test.ts`, `apps/server/test/e2e/voice-wiring.test.ts` ("the toolset given to the voice worker has no write or external_message tool"), `apps/server/test/e2e/main-flow.test.ts` ("the model cannot reach a write capability"), `packages/contracts/src/registry.test.ts`, `apps/server/src/builder/registry.test.ts`, `apps/server/test/adversarial/toolset.test.ts`.

**Not yet enforced or tested**

- There is no cap on the number of tool calls in one phone call. The relay counts them for its log line and does not limit them (`apps/server/src/voice/relay.ts`). A simulated call is capped at 8 tool calls per turn (`apps/server/src/api/simcall/index.ts`). Each tool is still only a read or a proposal, a quote can be used for one proposal, and one approval can be pending per subject.

### Rule 7. Text from callers, uploaded files, menus and third-party APIs is data, never an instruction

**Status:** built and tested with fakes. The voice model's behavior under adversarial speech has not been tested on a real call or on the real model.

**Where it is enforced**

- **Structure, not the prompt.** The model has no write tool (rule 6). Totals come from Square CalculateOrder through `quote_order`. `createOrderProposal` refuses a cart whose hash differs from the quote. A proposal is bound to its call and its pinned agent version (`assertCall` in `policy/engine.ts`). A quote can be used for one proposal.
- **The model cannot assert message consent.** The real toolset stores every proposal with channel `qr_only`, consent false and no recipient, whatever the model sends (`apps/server/src/tools/real/index.ts`). `apps/server/src/voice/NOTES.md` item 3 explains why: the server has no trusted evidence that a caller heard a number read back and said yes. So no customer message can result from a call.
- **The prompt says so.** `apps/server/src/voice/prompt.ts` tells the model that caller speech and text in tool results are data.
- **The text runner refuses first.** `apps/server/src/builder/runner/guardrails.ts` refuses a bypass or injection attempt before any tool runs.
- **Uploads become drafts.** Extraction saves draft facts only and never changes a verified fact (`apps/server/src/builder/extraction/service.ts`, `sanitize.ts`). `file-check.ts` checks the declared type against the content and the size cap.
- **Webhook bodies.** Only routing IDs are read (rule 2).

**Tests:** `apps/server/src/builder/extraction/service.test.ts` ("keeps an injection document to draft facts only"), `apps/server/src/builder/extraction/routes.test.ts`, `apps/server/src/builder/extraction/sanitize.test.ts`, `apps/server/src/builder/extraction/file-check.test.ts`, `apps/server/src/builder/runner/text-runner.test.ts`, `apps/server/test/tools/real-toolset.test.ts`, `apps/server/test/voice/prompt.test.ts`, `apps/server/test/adversarial/untrusted-text.test.ts` (caller text, menu item names, third-party API strings, uploaded file text, text the owner approves), and in `apps/server/test/e2e/main-flow.test.ts` "a bypass attempt is refused with no tool run and no approval".

**Verified against real services**

- In the pizza run on the deployed server, the simulated caller gave a phone number and asked for no text messages. The script stops unless the approval's channel is `qr_only` and it has no recipient, and the run passed. The caller had declined messages, so this shows the ordinary path on the real model. It is not an adversarial test.

**Not yet enforced or tested**

- An owner answer in builder chat opens a `fact_edit` approval (`proposeFactFromChat`). The owner still has to confirm it. The text of the answer goes to the builder model first, and that path is not verified on the real model.
- Uploaded files are not scanned for malware.

### Rule 8. Never commit a secret, and never print one

**Status:** built and tested with fakes for the code paths. I did not run a secret scanner over the repository history.

**Where it is enforced**

- `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), service account files, `*.pem` and `*.key`. `.env.example` holds variable names and a few defaults that are not secret, such as `SQUARE_ENVIRONMENT=sandbox` and `MESSAGE_CHANNEL=qr_only`.
- `parseEnv` in `apps/server/src/env.ts` reports variable names and its own messages, never a value. `scripts/check-env.mjs` shows which variables are set and never prints a value.
- `safeLogger` in `apps/server/src/voice/logic.ts` redacts the OpenAI key and the Twilio auth token from voice logs. `compose/index.ts` passes both to it.
- Integration health returns fixed detail text and names of missing settings (`apps/server/src/compose/providers.ts`, `compose/health.ts`).
- The error handler in `apps/server/src/app.ts` replaces parser messages with fixed text, so request values are not echoed by it. The not-found handler in the same file does echo the request method and path, without the query string.
- The browser never gets the long-lived OpenAI key. `apps/server/src/builder/voice/minter.ts` mints a short-lived client secret on the server.
- The seed and reset commands print only an error message, because a database error object can echo connection details (`runCli` in `packages/db/src/seed/cli.ts`).
- `npm run register-webhooks -- --apply` writes the Square signature key into `.env.local` and does not print it (`scripts/register-webhooks-lib.ts`).
- `scripts/live/run-demo.ts` prints steps and results only, and shortens IDs to their last six characters.

**Tests:** `apps/server/test/voice/logic.test.ts` (redaction and the safe logger), `apps/server/test/voice/relay.test.ts`, `apps/server/src/builder/voice/routes.test.ts`, `apps/server/test/scripts/register-webhooks.test.ts`, and `apps/server/test/adversarial/secrets.test.ts`, which runs the scenarios with marker secrets and then looks for them. I did not read that file line by line.

**What I checked by hand:** on this checkout, a pattern search of tracked files (not the lock file) for strings shaped like OpenAI keys, Square tokens, Twilio SIDs, Google API keys, JSON web tokens, private key headers and database addresses with a password. It matched six files. All six are test placeholders or a README template. This is a simple search of the current files, not a scan of the history.

## 5. The restricted database role and the checked routines

**Status:** built and tested with fakes for 0001 to 0006. Verified against the real database: all six migrations are applied, the refusals in section 2 hold for `abos_app`, and the startup role check reports the restricted role.

The server connects with `DATABASE_URL` as the login `abos_app` (SPEC decision D-10). Migrations, seed and reset use the owner connection. `abos_app` is created `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, and migration 0004 stops if an existing `abos_app` has an unsafe attribute or can create objects in a schema. At startup, when a database is configured, the server calls `private.runtime_role_check` (0006) and exits unless both the session user and the current user are the restricted `abos_app` (`apps/server/src/index.ts`). A server with no `DATABASE_URL` has nothing to check and starts with its database features off.

What `abos_app` may do directly:

| Tables | Rights |
|---|---|
| `approval_requests`, `action_executions`, `message_dispatches`, `sync_jobs`, `capabilities`, `payment_receipts`, `users` | SELECT only |
| `activity_events`, `webhook_events` | SELECT and INSERT |
| `orders`, `bookings` | SELECT, INSERT and UPDATE, with every write checked by a guard trigger (below) |
| `businesses` | SELECT and UPDATE. A guard trigger refuses a change to its ID or owner (0006) |
| `business_facts`, `files`, `catalog_items`, `fact_conflicts`, `agents`, `agent_versions`, `live_agent`, `builder_sessions`, `calls`, `integrations` | SELECT, INSERT and UPDATE |
| `builder_sessions`, `files`, `fact_conflicts`, `catalog_items`, `live_agent` | DELETE as well |

No migration grants TRUNCATE to `abos_app`.

The guard triggers on `orders` and `bookings` (0005 and 0006) apply to `abos_app` only. They refuse a status move that is not in the state machine, any move into or out of a paid or booked state, a change to the row's identity or approval, a change to a Square or Google reference once it is stored, and a change to what was proposed (cart, quote, total, contact, pickup, service, slot).

The routines `abos_app` may call are listed below. All are in the `private` schema. All are `SECURITY DEFINER` with an empty search path, except `runtime_role_check`, which is `SECURITY INVOKER` on purpose so that it reports the caller's own role. `abos_app` may also call `public.gen_id`, which only makes an ID.

| Routine | Migration | What it checks |
|---|---|---|
| `create_approval` | 0004 | Rebuilds the material fields, checks the canonical text, the hash, the subject row, and an expiry of at most 11 minutes ahead |
| `decide_and_enqueue` | 0004, replaced in 0005 | Owner, hash, expiry, subject still awaiting approval. Inserts the steps with their keys |
| `claim_execution`, `claim_next_execution` | 0004, the first replaced in 0005 | One worker per step, at most 3 attempts, earlier steps finished. The first step of a bundle also re-checks that the subject still matches the approval. Gives a 15 minute lease. Moves an approved order to `CREATING_CHECKOUT` |
| `finish_execution` | 0004, replaced in 0005 and 0006 | The worker holds the lease. A provider step needs a reference. A message step needs its sent dispatch |
| `record_dispatch`, `update_dispatch` | 0004 | Recipient and channel come from the approval. A dispatch status only moves forward |
| `enqueue_sheets_sync`, `claim_sync_job`, `finish_sync_job` | 0004, the last two replaced in 0005 | Verified subject, approved Sheets action, matching key, at most 5 attempts |
| `expire_approvals` | 0004, replaced in 0005 | Moves past-due approvals and their subjects, and writes the events |
| `save_checkout` | 0005 | The checkout step's current lease. References cannot change once stored |
| `mark_order_paid`, `mark_order_payment_failed` | 0005 | The observation (amount, currency, Square order, location, status, sandbox) against the signed approval, the order and the business's Square location. One receipt per payment. A paid order never moves back |
| `fulfill_order` | 0005 | A completed receipt for the order's payment |
| `verify_booking` | 0005 | The calendar step's current lease. The event ID cannot change once stored. Creates the one Sheets job |
| `apply_fact_update` | 0005 | The fact step's lease and the signed before and after values |
| `resolve_execution` | 0005 | Only a `NEEDS_REVIEW` step. Completes, requeues or abandons it from the evidence given |
| `recover_stale_executions`, `recover_stale_sync_jobs` | 0005 | A step whose lease ran out goes to `NEEDS_REVIEW`, and its order or booking moves to `RECOVERY_REQUIRED` or `RETRY_REQUIRED`. A Sheets job whose lease ran out goes to `RETRYING`, or `FAILED` after 5 attempts |
| `renew_execution_lease`, `renew_sync_lease` | 0005 | The current worker and attempt |
| `mark_webhook_processed` | 0006 | A stored webhook row of that business. A processed row is never un-processed |
| `update_dispatch_status` | 0006 | A delivery receipt moves a dispatch forward only, and only after its send step finished |
| `runtime_role_check` | 0006 | Reports the caller's own role, for the startup check |

Other guards in the database: `activity_events` and `payment_receipts` reject every UPDATE and DELETE. A published `agent_versions` row rejects UPDATE and DELETE (`agent_versions_immutable`). `bookings_no_overlap` prevents two bookings of one business on one calendar from overlapping in time while both are `RECHECKING_SLOT` or `BOOKED_VERIFIED`. A booking that is still waiting for approval can overlap a verified one, and the re-check at approval catches it. Unique indexes stop one Square order, payment link, payment or Google event from attaching to two local rows. Row-level security lets a signed-in owner read only rows of a business they own (`private.owns_business`), and `anon` and `authenticated` can write nothing.

The Sheets adapter reads the record ID column before every append (`apps/server/src/adapters/sheets/index.ts`). That lookup is server behavior. The database does not enforce it.

**Tests:** all of `packages/db/test/`, including `direct-dml.test.ts`, `rls.test.ts`, `runtime-hardening.test.ts`, `payments-and-recovery.test.ts`, `review-0005.test.ts` and `migration-0006.test.ts`. The server's own database tests run as `abos_app` (`apps/server/test/support/db.ts`), and two end-to-end files assert it: `apps/server/test/e2e/flows.test.ts` ("runs as abos_app") and `apps/server/test/e2e/main-flow.test.ts`.

## 6. Webhook signature and dedupe

See rule 2 for the detail. In short: the raw body is captured before any parser, the signature is checked against the public address the server is configured with, only a verified event is stored, the unique pair of source and provider event ID stops a duplicate, and the payment is always read from Square before any order changes. A reconciliation poll runs every 30 seconds for 15 minutes after the link is ready and covers a missed webhook (`apps/server/src/reconcile/index.ts`; the test "a missed webhook is recovered by the reconcile poll" is in `apps/server/test/e2e/flows.test.ts`).

## 7. Idempotency keys derived by the database

See rule 3 for the detail. In short: the key for each step is computed inside `private.decide_and_enqueue` from the business, the subject, the action type and the approval ID. The server reads it from the row and passes it to the provider. Nothing in `apps/server/src` writes a key into `action_executions`, `message_dispatches` or `sync_jobs`.

## 8. Secrets handling

- Values live in `.env.local` on a laptop and in the host's variable settings. Neither is committed.
- `DATABASE_ADMIN_URL`, the owner connection, must never be set on the host. `npm run check-env -- --for host` exits with an error when it is.
- The server connects to Postgres with TLS and certificate checks on. `apps/server/src/db/index.ts` removes every TLS parameter from the connection string so a parameter there cannot turn checks off, and adds the Supabase root certificate in `apps/server/certs/`. Test: `apps/server/test/api/db.test.ts`.
- The Supabase JWT is verified against the project's public keys with issuer and audience checks (`apps/server/src/auth/verify.ts`, test `apps/server/test/api/auth.test.ts`).
- Every `/api` route needs the owner's token unless it declares the builder's own auth, which uses the same check. Tests: `apps/server/test/e2e/route-auth.test.ts`, `apps/server/src/builder/route-auth.test.ts`. The second file calls every builder route with no token and expects 401. One exception: `GET /api/builder/ping` has no auth check and answers 200 to anyone. It returns only `{ ok, lane }` and nothing about a business. `apps/server/test/adversarial/access.test.ts` records this as an open defect, tracked in issue #96.
- Provider credentials are not stored in our tables. They are not encrypted by this code. They rely on the host's secret store.
- Only the last four digits of a recipient are written to activity events. `apps/server/test/adversarial/secrets.test.ts` asserts it. I did not read every log call.

## 9. The stated limit on payment verification

The database enforces consistency. It enforces one payment per order: the unique index `orders_square_payment_id_key`, the primary key of `payment_receipts`, and the checks in `private.mark_order_paid`. It enforces forward-only states: the guard trigger on `orders` refuses any direct move into or out of a paid state, `mark_order_paid` accepts only `PAYMENT_PENDING` or `PAYMENT_FAILED`, and `mark_order_payment_failed` never moves a paid order.

The database does not talk to Square. It trusts the server's read of the Square payment. The comment above `private.check_payment` in 0005 says it plainly: "Consistency checks are not a provider read. The server supplies its redacted Square observation." The server reads the payment, checks it in `checkPayment`, and passes the payment ID, amount, currency, Square order ID, location, status and environment to `mark_order_paid`. In `apps/server/src/compose/webhooks.ts` the amount, currency, order ID and location passed are the order's own, after the adapter has compared them with Square's, and the status is the literal `COMPLETED`.

A server that is compromised or wrong could therefore record a payment that Square never completed. The database would still refuse a wrong amount, a wrong Square order or location, a second payment on the order, a payment ID already recorded with different details, and anything not marked sandbox.

The live run in section 2 does not change this limit. It shows the path working once, with the server reading a real sandbox payment.

## 10. Other known limits

1. **The only verified payment is a SIMULATED one.** A Square order created through a payment link stays `DRAFT` until the hosted checkout opens it, and a direct payment on it is refused until it is `OPEN`. The live run opened the order with UpdateOrder and paid through the API with the sandbox test nonce. Paying on Square's hosted checkout page with a test card is not verified. The fallback named in SPEC section 4 (CreateOrder plus CreatePayment inside the server) is not built.
2. **Some order and booking moves are plain updates by the server.** In ordinary running, `MESSAGE_SENT`, `PAYMENT_PENDING`, `RECOVERY_REQUIRED`, `UNAVAILABLE`, `CANCELLED`, `SLOT_CONFLICT` and `RETRY_REQUIRED` are reached with a conditional update (`guardedMove` in `compose/executor.ts`, `cancelOrder` in `compose/recovery.ts`, `markSlotConflict` in `policy/engine.ts`), and the 0005 guard trigger checks each one against the state machine. The stale-lease routine also makes the moves to `RECOVERY_REQUIRED` and `RETRY_REQUIRED`.
3. **Pause is stored. Its effect on a real call is not verified.** The pause route writes `agents.state`, and the phone worker reads that column (`dbLiveAgentPort` in `compose/ports.ts`). No real call has been refused by a paused agent.
4. **Publish is stored, and tested with fakes.** Published versions, the live-agent row and the `agents` row are written to Postgres (`apps/server/src/compose/builder-publish.ts`, `compose/builder.ts`). `apps/server/test/e2e/publish-lifecycle.test.ts` covers publish, pause and rollback on the database and across a restart. No publish has been verified on the deployed server.
5. **Publish refuses when a provider the agent needs is not connected.** Publish runs the read-only health checks itself. A phone agent needs Twilio and OpenAI, the pizza template needs Square, the booking template needs Google Calendar, and each capability adds its provider (`apps/server/src/builder/publish/integrations.ts`). A message channel other than `qr_only` has no health check in `compose/providers.ts`, so it reads as disconnected and stops the publish of an agent with a message capability. An unset `MESSAGE_CHANNEL` reads as disconnected too. On the deployed server all six providers report connected, with the channel `qr_only`.
6. **Uploads and their conflicts are held in server memory.** `compose/index.ts` passes no `extraction` option to the builder plugin. Uploaded files, extracted facts and the conflicts found in them are lost on a restart. A conflict stored in Postgres is different: "keep the current value" resolves it on the database, and any other choice is answered with an error that names the route to use.
7. **No customer message can be sent from a call.** The agent always proposes `qr_only` (rule 7). The message adapter and the message step are built and tested, through proposals that tests create directly in the engine. No message has been delivered through any real channel.
8. **A message that was mid-send during a crash stays `QUEUED`** in the database and is shown as unknown (rule 3).
9. **Some calls never get an end event.** A simulated call ends only when the client sends `end: true` (`apps/server/src/api/simcall/index.ts`). One that is abandoned stays `IN_PROGRESS` with no `call.ended` event. On the phone path the voice webhook creates the call row. If the audio stream never starts, or closes before it is tied to that row, the relay writes no end, and the end then depends on Twilio's status callback. No job sweeps calls that are still `IN_PROGRESS`.
10. **There is no cap on tool calls per phone call** (rule 6).
11. **The availability re-check at checkout reads our cache, not Square.** Before the Square call the executor checks that each cart line's item and variation is still available in `catalog_items` (`cartAvailable` in `compose/executor.ts`). It does not check modifiers, and it does not ask Square. An item that sold out in Square since the last catalog sync is not caught here.
12. **The agent cannot end a call on its own goodbye, with one exception.** If the owner has not decided 90 seconds after a proposal, the agent says goodbye and the relay closes the call. For any other goodbye the relay needs a trusted finish signal (`finishes` in `voice/relay.ts`), and `compose/index.ts` does not pass that port. Otherwise a call ends when the caller hangs up, on the idle limit, on the session limit, or on a failure.
13. **Human fallback is built and switched off.** It keeps its reservation in server memory and has no checked routine (`compose/fallback.ts`). It is refused for every version today.
14. **Rate limiting.** Only the realtime client secret route has a rate limit (`apps/server/src/builder/voice/rate-limit.ts`). The REST API, the webhooks and the phone path have none.
15. **In-memory state.** Quotes before a proposal, stream tokens, test console sessions, telemetry, the owner-decision bus for live calls, and the queue of webhook jobs live in server memory. Stored webhook rows are re-read after a restart.
16. **`BUILDER_DEV_AUTH=1`** makes the builder routes accept any bearer token from the loopback address when no real auth is configured. It is refused when `NODE_ENV` is `production` (`apps/server/src/builder/index.ts`). It must not be set on a host.
17. **The table owner is outside the boundary.** The owner connection can disable triggers and change grants, and the guard triggers on `orders`, `bookings`, `businesses` and `users` do not apply to it. The reset script clears run data with TRUNCATE, which fires no row trigger. It does not clear `payment_receipts`.
18. **`service_role`** is removed from the runtime boundary in 0006: it loses the remaining routine grants and direct writes on `orders` and `bookings`. The server's connection is checked at startup to be `abos_app`.
19. **AgentPhone is not on `main`.** `main` has only the contract values for it (decision D-12, which is not yet a row in `docs/SPEC.md`). The server registers no `/webhooks/agentphone` route, and `apps/server/src/env.ts` does not accept `agentphone` as `MESSAGE_CHANNEL`. The provider is on a branch and has had no live test.
20. **Not built from the PRD's security list:** anti-malware scanning of uploads, a nonce or timestamp check on webhooks, and transcript redaction. No phone audio or phone transcript is stored. Owner builder chat is stored in `builder_sessions`, including speech the browser transcribed.
21. **Legal checks.** AI disclosure is in the prompt. Recording, consent and messaging rules for real customers have not been reviewed. This build is for a sandbox demo.
