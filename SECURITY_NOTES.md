# Security notes

**Task:** S-06. **Written:** 2026-11-14. **Describes:** the code on branch `arsh/integration` at commit `7486c7e`, merged into this branch (`arsh/S-06-docs`).

An earlier version of this file described commit `1588eaa`. The integration branch then moved 20 commits. This version was checked again against the new code.

This file lists the eight rules from `AGENTS.md` that are never broken. For each rule it says where the code enforces it, which tests cover it, and what is not yet enforced or not yet tested. It then describes the restricted database role, webhook handling, idempotency keys, secrets, and the known limits.

## 1. How to read the status words

Every control in this file has one of three statuses.

| Status | Meaning |
|---|---|
| Built and tested with fakes | The code is on this branch and automated tests cover it. The tests use an in-process Postgres (PGlite) with migrations 0001 to 0005 applied, and fake Square, Google, Twilio, message and model providers. No real provider is called. |
| Verified against the real service | A person or a script ran it against the real service, and the result is in the list in section 2. |
| Not built | The code is not on this branch. |

A control that is built and tested with fakes is not proven to work live. Where this file does not say "verified against the real service", read "not verified".

## 2. What has been verified against real services

This is the complete list as of 2026-11-14 03:00 Pacific. I did not rerun any of it for this document. It was given to me as fact by the lead session.

- **Supabase.** Migrations 0001 to 0004 are applied. Migration 0005 is not applied. The server role `abos_app` can read, and is refused with error 42501 on a direct write to `approval_requests`, `action_executions`, `message_dispatches` and `sync_jobs`. The database is seeded with one owner, two businesses, 33 facts, two agents with published versions, and 6 catalog items.
- **Server, read only.** An earlier head of the integration server ran against the real database. Health, sign-in, businesses, facts, approvals, integration health and live agent returned 200. A request with no token and a request with a malformed token returned 401. This was `npm run smoke`, 9 of 9. The `smoke` script is not in `package.json` on this branch.
- **OpenAI.** A realtime session probe passed 11 of 11 checks on `gpt-realtime-2.1`. One strict structured-output call on the builder model returned valid JSON. The builder interview and the test console ran on the real model from the UI lead's machine.
- **Square sandbox.** The demo catalog was seeded (13 objects). A CalculateOrder quote matched the catalog prices (subtotal 4300, tax 376, total 4676 cents). A payment link was created and read back with the right total. The same idempotency key returned the same link. The link has not been paid.
- **Twilio.** An SMS from the unregistered US number failed with error 30034.
- **Render.** The service `abos-server` is deployed from `main` at `https://abos-server.onrender.com` and its `/health` returns 200. `main` serves only the health route and the builder today.

Not verified with any real service: a phone call through Twilio to the voice worker, a paid Square link and its webhook, payment reconciliation, a Square price change, Google Calendar and Sheets (there are no credentials yet), the WhatsApp sandbox, any message delivery, a call handed to a person, and the integration branch deployed.

The migration 0005 file on this branch was rewritten after that list was made. It is now 877 lines. I do not know whether any version of it has been applied since.

## 3. Test results from this checkout

I ran these on 2026-11-14 in a cloud container with 4 cores and Node 22.23.4, at commit `7486c7e` plus the four documents. The spec and CI name Node 24.

| Command | Result |
|---|---|
| `npm run typecheck` | Passed for all four workspaces (`@abos/server`, `@abos/web`, `@abos/contracts`, `@abos/db`). |
| `npx vitest run --maxWorkers=2` | 94 test files, 1866 tests. All 1866 passed. |
| `npm test` (the default, 6 workers) | 94 test files, 1866 tests. 1861 passed and 5 failed. Every failure was "Test timed out in 5000ms" in `packages/db/test/` (`constraints.test.ts`, `guarded-updates.test.ts`, `runtime-hardening.test.ts`). |
| `npm test -w @abos/web` | 43 test files, 515 tests. 514 passed and 1 failed: `app/(dashboard)/build/voice/VoiceControl.test.tsx`, the test "after RATE_LIMITED it explains in one sentence and releases the microphone". On the earlier commit it also failed when run alone. I did not investigate the cause. |

On the earlier commit `1588eaa` the default `npm test` failed 4 and then 5 of 1558 tests in two runs. Every failure was "Test timed out in 5000ms" in a database test under `packages/db/test/`, and the same files passed when run alone. `vitest.config.ts` allows 6 workers and each database test file starts its own in-process Postgres, so on 4 cores some tests and setup hooks pass their time limits. I did not see an assertion fail in any server or package test on either commit.

**CI is red.** GitHub Actions ran the `check` job on `1588eaa`, on `7486c7e` (both through draft pull request #97) and on this branch's earlier commits, which add only Markdown. Every run failed at the `npm test` step, so CI never reached the web tests. I read the job logs. On `1588eaa` and on this branch the errors were "Hook timed out in 10000ms" in the setup hooks that start and migrate the in-process Postgres, and "Test timed out in 5000ms", in `packages/db/test/`. When a setup hook times out, every test in that file fails. On `7486c7e` the log shows the same hook timeouts and one assertion failure: `apps/server/test/voice/fallback/review-regressions.test.ts` line 53, in the test "returns safely and aborts a nonsettling dispatch fence before any call update". That test sets a 10 millisecond deadline. It passed in both of my local runs. I did not investigate why it failed in CI.

## 4. The eight rules

### Rule 1. No external write happens before the owner approves the exact payload

**Status:** built and tested with fakes. The restricted role's write refusal is verified against the real database (section 2). The executor has never run against a real provider.

**Where it is enforced**

- **The agent has no write tool.** See rule 6.
- **A proposal only writes our own database.** `createOrderProposal` and `createBookingProposal` in `apps/server/src/policy/engine.ts` store the order or booking and open an approval. They call no provider. They refuse a call that has ended.
- **The server cannot write approvals or executions directly.** Migration `0004_runtime_role_and_routines.sql` gives `abos_app` SELECT only on `approval_requests`, `action_executions`, `message_dispatches` and `sync_jobs`. Every change goes through a checked routine (section 5).
- **The approval is bound to its payload.** `private.create_approval` rebuilds the material fields itself with `private.material`, compares them with the canonical text the server sent, and recomputes the SHA-256 hash. `private.check_subject` compares the approval with the stored order, booking, fact or catalog row.
- **The decision is checked in the database.** `private.decide_and_enqueue` requires the business owner, the exact stored hash and an unexpired approval. It inserts execution rows only when the state is `APPROVED`.
- **An approval is used once.** The trigger `approval_requests_guard` allows a row to be created only as `PENDING`, freezes the payload, and refuses any change after a decision. A unique index allows one `PENDING` approval per subject.
- **An execution row needs an approved bundle.** The trigger `action_executions_match_approval` (0002) refuses an execution row unless its approval is `APPROVED`, in the same business, and lists that action at that position. `execution_claim_allowed` refuses a step until the earlier steps have finished.
- **A message goes only to the approved recipient.** The trigger `message_dispatches_guard` (0002) requires the dispatch recipient and channel to equal the approved payload. `private.record_dispatch` reads both from the approval, not from the server.
- **The executor checks again before each provider call.** `runTick` in `apps/server/src/executor/index.ts` calls `authorizeStep` (in `policy/engine.ts`) before the handler, and the `external` wrapper calls it again immediately before every provider call. `orderFor` and `bookingFor` in `apps/server/src/executor/handlers.ts` compare the stored order or booking with the approved material and refuse a mismatch.
- **A price change is a bundle like the others.** `POST /api/businesses/:id/catalog/prices/propose` (`apps/server/src/api/prices/index.ts`) reads the current Square price and stores a `PENDING` `price_edit` approval through `createPriceEditApproval`. It does not write to Square. The write runs in the executor step `square.catalog.price.update` after the owner approves.
- **The Sheets row needs the same approval.** `private.enqueue_sheets_sync` and `private.claim_sync_job` require a verified subject and an approved bundle that lists the Sheets action.
- **Unwired pieces fail closed.** Without a database, `notWiredExecutor` in `apps/server/src/compose/seams.ts` leaves approved steps `QUEUED` and runs nothing.

**Tests:** `packages/db/test/direct-dml.test.ts`, `packages/db/test/guarded-updates.test.ts`, `packages/db/test/constraints.test.ts`, `packages/db/test/runtime.test.ts`, `packages/db/test/runtime-hardening.test.ts`, `apps/server/test/policy/engine.test.ts`, `apps/server/test/executor/executor.test.ts`, `apps/server/test/executor/review.test.ts`, `apps/server/test/api/prices/index.test.ts`, `apps/server/test/e2e/main-flow.test.ts` (reject leaves no steps, a wrong hash is refused, an expired approval is refused, another owner cannot decide), `apps/server/test/e2e/flows.test.ts`, where every test counts the external writes that ran, and `apps/server/test/e2e/routines.test.ts` (the price change runs once after approval).

**Not yet enforced or tested**

- **Handing a call to a person has no owner approval.** `apps/server/src/compose/fallback.ts` can redirect a live call to the business's fallback number through a Twilio call update. The notes in `apps/server/src/voice/fallback/NOTES.md` call this a proposal that the owner must still ratify. It is refused today for every published version, because no contract field enables it and the default in `compose/index.ts` answers no. It is not one of the four writes rule 1 names. The lead should rule on it before it is enabled.
- **Two operator commands write to providers outside the approval engine.** `npm run seed:square` writes the demo catalog to the Square sandbox. `npm run register-webhooks -- --apply` changes the webhook settings on the Twilio number and the Square sandbox subscription. Both are run by a person from a laptop. Neither is reachable from the server or the agent.
- No executor step has run against real Square, a real message channel or real Google.

### Rule 2. Every webhook is signature-verified and deduplicated before it changes state

**Status:** built and tested with fakes. No real Square or Twilio webhook has reached this code.

**Where it is enforced**

- **Square.** `apps/server/src/webhooks/plugin.ts` reads the raw bytes in its own parser scope. `verifyWebhookSignature` in `apps/server/src/adapters/square/core.ts` computes HMAC-SHA256 over the notification URL plus the raw body with the signature key, encodes it as base64, and compares it with `timingSafeEqual`. A bad or missing signature gets 401, a `webhook.rejected` activity event, and nothing is stored (`rejectWebhook` in `apps/server/src/webhooks/square.ts`).
- **Square dedupe.** `recordOnce` in `apps/server/src/compose/webhooks.ts` inserts into `webhook_events` with `on conflict (source, provider_event_id) do nothing`. Only a newly inserted row is processed.
- **The body is never trusted.** `parseSquareEvent` keeps only the event ID, the event type, the payment ID and the Square order ID. `processPayment` reads the payment from Square for its status and amount.
- **Twilio call status.** The same plugin validates the request with `twilio.validateRequest` and the account auth token against `PUBLIC_SERVER_URL` plus the route path. The dedupe key is the call SID plus the status.
- **Twilio voice.** `apps/server/src/voice/plugin.ts` validates `X-Twilio-Signature` and answers 403 on failure. A rejected request writes `webhook.rejected` against the business that holds the Twilio number in `live_agent` (`dbVoiceEventsPort` in `compose/ports.ts`). A repeated webhook for the same call gets the same pending stream token or a 409. `calls.provider_call_id` is unique, so there is never a second call row.
- **Missing settings.** Without `PUBLIC_SERVER_URL`, `SQUARE_WEBHOOK_SIGNATURE_KEY` or a database, `/webhooks/square` and `/webhooks/twilio/status` answer 503 without reading the body (`notWiredWebhooks`). Without the voice settings, `/webhooks/twilio/voice` answers 503 and `/ws/phone` does not exist (`apps/server/src/app.ts`).

**Tests:** `apps/server/test/webhooks/plugin.test.ts`, `apps/server/test/webhooks/review.test.ts`, `apps/server/test/adapters/square/square.test.ts`, `apps/server/test/voice/plugin.test.ts`, `apps/server/test/e2e/voice-wiring.test.ts`, and in `apps/server/test/e2e/flows.test.ts` the tests "a duplicate webhook delivery changes nothing" and "a bad signature is rejected with 401, writes webhook.rejected and stores nothing".

**Not yet enforced or tested**

- The Square signature check assumes the header value is base64. `docs/SPEC.md` section 2.9 asks spike B-02 to confirm this. It is not verified with a real Square webhook.
- The Square check signs over `PUBLIC_SERVER_URL` plus `/webhooks/square`. The variable `SQUARE_WEBHOOK_URL` is parsed by `apps/server/src/env.ts` but the server does not use it for the check. The two must describe the same address.
- A rejected Square webhook is recorded against the business with the most rows in `catalog_items`. SPEC 2.9 says to read the owner from `integrations`.
- `webhook_events.processed_at` is never set. `abos_app` has no UPDATE on that table and no routine exists for it. After a restart, stored events from the last 15 minutes are processed again (`recoverNow` in `compose/webhooks.ts`). Processing is safe to repeat.
- A WhatsApp delivery receipt is verified and stored, but it does not update the dispatch row (`updateStatus` in `compose/webhooks.ts` returns false).
- There is no timestamp or nonce check. Replay protection is the event ID.

### Rule 3. Every external write carries a stable idempotency key

**Status:** built and tested with fakes. For Square payment links, verified against the real sandbox in a spike: the same key returned the same link. The executor path that uses the database key has not run against real Square.

**Where it is enforced**

- **The database derives the key.** `private.decide_and_enqueue` computes `sha256(businessId:subjectId:actionType:approvalId)` in hex for each step when it inserts the execution row. `private.enqueue_sheets_sync` does the same for the Sheets job. The server never creates or replaces a key (`apps/server/src/compose/executor.ts`).
- **The key cannot change or disappear.** `action_executions.idempotency_key` is unique. The trigger `action_executions_match_approval` refuses a change to it. The trigger function `private.retain_identity` (0004) refuses deleting an execution or a dispatch and refuses changing a sync job's identity.
- **The executor confirms the key.** `authorizeStep` recomputes the key with `idempotencyKey` from `packages/contracts/src/hash.ts` and refuses a mismatch.
- **Each provider gets the row's key.** Square `CreatePaymentLink` receives it as `idempotencyKey` (`createCheckout` in `adapters/square/core.ts`). The Square price write receives it (`updateCatalogPrice` in `executor/handlers.ts`). The Google Calendar event ID is the key, and the adapter looks the event up before every insert (`apps/server/src/adapters/calendar/index.ts`). A message has one `message_dispatches` row per execution. A Sheets row is found by its record ID in the first column.
- **A timeout is never retried blindly.** `classifyFailure` in `executor/index.ts` sends a timeout or an unknown result to `NEEDS_REVIEW`. A claim gives the worker a 15 minute lease (`lease_deadline`, 0005). A step still `RUNNING` after its lease goes to `NEEDS_REVIEW` through `private.recover_stale_executions`, never back to `QUEUED`.
- **Review keeps the key.** `POST /api/executions/:id/resolve` goes through `private.resolve_execution`. It completes the step when a provider read proves the effect exists, requeues it only when a read proves nothing was written, and refuses when the read is unsure (`apps/server/src/api/recovery/index.ts`).

**Tests:** `packages/contracts/src/hash.test.ts`, `packages/db/test/guarded-updates.test.ts`, `packages/db/test/payments-and-recovery.test.ts`, `packages/db/test/review-0005.test.ts`, `apps/server/test/executor/executor.test.ts`, `apps/server/test/api/recovery/recovery.test.ts`, `apps/server/test/adapters/message/message.test.ts`, `apps/server/test/adapters/calendar/index.test.ts`, `apps/server/test/adapters/sheets/index.test.ts`, `apps/server/test/adapters/square/price.test.ts`, in `apps/server/test/e2e/flows.test.ts` the paid path (checkout with the database key), "Square create timeout: NEEDS_REVIEW, order RECOVERY_REQUIRED, no link sent, no second create", "approving twice runs the steps once" and the crash recovery test, and in `apps/server/test/e2e/routines.test.ts` the recovery of a `NEEDS_REVIEW` checkout.

**Not yet enforced or tested**

- No message provider accepts an idempotency key. The dispatch row is the only guard against a second message.
- The Calendar event ID, the Sheets record ID check and the Square price write are not verified against the real services. `apps/server/src/api/prices/NOTES.md` says the key length limit for the Square catalog write is not established.
- The routines `renew_execution_lease` and `renew_sync_lease` exist in 0005. I found no call to them in `apps/server/src`. A step that runs longer than 15 minutes would be sent to review.
- The decision endpoint's `Idempotency-Key` replay cache is in server memory (`apps/server/src/api/routes.ts`). It is lost on restart. The database one-use rule still holds.

### Rule 4. Payment data is always labeled sandbox, and `SQUARE_ENVIRONMENT` must be `sandbox`

**Status:** built and tested with fakes. The quote and payment link checks in section 2 were made on the Square sandbox.

**Where it is enforced**

- `apps/server/src/env.ts` accepts only the literal `sandbox` for `SQUARE_ENVIRONMENT`. `apps/server/src/index.ts` exits when the environment does not parse.
- `decide` and `authorizeStep` in `policy/engine.ts` refuse with `ENVIRONMENT_MISMATCH` when the environment is not `sandbox`.
- `createSandboxSquareClient` in `apps/server/src/adapters/square/client.ts` builds the only Square client.
- The database refuses a payment observation whose environment is not `sandbox` (`private.check_payment`, 0005), and the table `payment_receipts` has a check constraint for it.
- `/health` returns `squareEnvironment`. `GET /api/orders/:id/checkout` returns `environment: "sandbox"`. The `checkout.created`, `payment.verified` and `payment.failed` events carry `sandbox: true`. The checkout message text in `apps/server/src/adapters/message/templates.ts` says "Sandbox test payment."
- The reset script and the webhook registration command refuse to run unless `SQUARE_ENVIRONMENT` is `sandbox`.

**Tests:** `apps/server/test/app.test.ts` ("refuses any Square environment other than sandbox (AC-19)"), `apps/server/test/adapters/square/square.test.ts`, `apps/server/test/policy/engine.test.ts`, `packages/db/test/seed.test.ts`, `packages/db/test/payments-and-recovery.test.ts`, `apps/server/test/scripts/register-webhooks.test.ts`.

**Not yet enforced or tested**

- I did not check the sandbox labels on the web screens in a browser.

### Rule 5. No success state is shown or stored before the provider confirms it

**Status:** built and tested with fakes. A paid Square link has never been verified against the real service.

**Where it is enforced**

- **Paid and booked states belong to routines.** The triggers `orders_runtime_guard` and `bookings_runtime_guard` (0005) refuse any direct write by `abos_app` that sets or leaves `PAID_VERIFIED`, `FULFILLMENT_READY` or `BOOKED_VERIFIED`, or that changes a payment ID, a Google event ID or a stored checkout reference. Only the routines below can make those changes.
- **Checkout.** `private.save_checkout` stores the Square order ID, link ID and URL and moves the order to `PAYMENT_LINK_READY`, only for the worker that holds the step's lease. The server calls it after `verifyLinkTotal` in `adapters/square/core.ts` has read the Square order and matched its total (`completeCheckout` in `compose/executor.ts`).
- **Payment.** `checkPayment` in `adapters/square/core.ts` verifies a payment only when its status is `COMPLETED`, it is not refunded, and its order ID, amount, currency and location match. `private.mark_order_paid` then checks the observation against the signed approval and the order, writes an append-only row in `payment_receipts`, and sets `PAID_VERIFIED`. `private.fulfill_order` requires that completed receipt before `FULFILLMENT_READY`.
- **Booking.** `private.verify_booking` stores the Google event ID and sets `BOOKED_VERIFIED` in the calendar step, under the step's lease.
- **Steps.** `private.finish_execution` accepts `SUCCEEDED` for a provider step only with a provider reference. For a message step it also requires a dispatch that is `SENT` or `DELIVERED` with that provider message ID. `private.finish_sync_job` requires a reference for `DONE`.
- **Table constraints (0002):** `orders_link_states_need_square_refs`, `orders_paid_states_need_payment`, `bookings_verified_needs_event`, `message_dispatches_sent_needs_provider_id`.
- **No message, no claim.** When the approved channel is `qr_only`, the message step is created `SKIPPED` and no dispatch row exists. The call is told "approved" with `messageSent` always false (`apps/server/src/compose/decisions.ts`).
- `GET /api/orders/:id/checkout` reports `ready` only when the link ID, the Square order ID and the URL are all stored.

**Tests:** `packages/db/test/payments-and-recovery.test.ts`, `packages/db/test/review-0005.test.ts`, `packages/db/test/constraints.test.ts`, `apps/server/test/webhooks/plugin.test.ts`, `apps/server/test/reconcile/index.test.ts`, `apps/server/test/compose/phase3.test.ts`, in `apps/server/test/e2e/flows.test.ts` "a payment amount mismatch does not reach PAID_VERIFIED" and "a refunded payment does not verify", and in `apps/server/test/e2e/routines.test.ts` "a payment that arrives before the order waits for it".

**Not yet enforced or tested**

- The stated limit in section 9 applies here.
- **Pause reports success that is not stored.** `POST /api/agents/:id/pause` answers 200 with `state: "paused"`, but the `agents` row in Postgres stays `live`. I ran it against the test database and read the row. The store in `apps/server/src/compose/builder.ts` writes only the draft fields. This is not a provider confirmation, but it is a success shown that did not happen. See limit 3 in section 10.
- A message marked `SENT` means the channel accepted it. It does not mean the customer received it.
- I did not check in a browser that the web screens show green only for verified states.

### Rule 6. The deployed agent has only `read` and `propose` tools

**Status:** built and tested with fakes. Not exercised on a real phone call.

**Where it is enforced**

- `apps/server/src/tools/real/index.ts` defines seven tools, each mapped to a `read` or `propose` capability. It refuses a tool the agent version does not hold.
- `checkSessionCapabilities` in `apps/server/src/voice/relay.ts` refuses a call when the published spec holds a `write` or `external_message` capability outside the bundle of a propose capability it holds.
- The `capabilities` table has check constraints that tie `write` and `external_message` to approval mode `required` (0002).
- The registry is in `packages/contracts/src/capabilities.ts`. The builder validates the capability set on publish (`validateCapabilitySet` in `apps/server/src/builder/registry.ts`).
- The simulated call uses the same toolset factory as the phone worker (`toolsetFor` in `apps/server/src/compose/index.ts`). The mock test runner refuses any toolset that is not the mock one (`apps/server/src/builder/runner/text-runner.ts`).
- The human fallback is not a model tool. The model cannot transfer a call.

**Tests:** `apps/server/test/tools/real-toolset.test.ts`, `apps/server/test/mock-toolset.test.ts`, `apps/server/test/voice/relay.test.ts`, `apps/server/test/e2e/voice-wiring.test.ts` ("the toolset given to the voice worker has no write or external_message tool"), `apps/server/test/e2e/main-flow.test.ts` ("the model cannot reach a write capability"), `packages/contracts/src/registry.test.ts`, `apps/server/src/builder/registry.test.ts`.

### Rule 7. Text from callers, uploaded files, menus and third-party APIs is data, never an instruction

**Status:** built and tested with fakes. The voice model's behavior under adversarial speech has not been tested on a real call.

**Where it is enforced**

- **Structure, not the prompt.** The model has no write tool (rule 6). Totals come from Square CalculateOrder through `quote_order`. `createOrderProposal` refuses a cart whose hash differs from the quote. A proposal is bound to its call and its pinned agent version (`assertCall` in `policy/engine.ts`). A quote can be used for one proposal.
- **The model cannot assert message consent.** The real toolset stores every proposal with channel `qr_only`, consent false and no recipient, whatever the model sends (`apps/server/src/tools/real/index.ts`). `apps/server/src/voice/NOTES.md` item 3 explains why: the server has no trusted evidence that a caller heard a number read back and said yes. So no customer message can result from a call on this branch.
- **The prompt says so.** `apps/server/src/voice/prompt.ts` tells the model that caller speech and text in tool results are data.
- **The text runner refuses first.** `apps/server/src/builder/runner/guardrails.ts` refuses a bypass or injection attempt before any tool runs.
- **Uploads become drafts.** Extraction saves draft facts only and never changes a verified fact (`apps/server/src/builder/extraction/service.ts`, `sanitize.ts`). `file-check.ts` checks the declared type against the content and the size cap.
- **Webhook bodies.** Only routing IDs are read (rule 2).

**Tests:** `apps/server/src/builder/extraction/service.test.ts` ("keeps an injection document to draft facts only"), `apps/server/src/builder/extraction/routes.test.ts`, `apps/server/src/builder/extraction/sanitize.test.ts`, `apps/server/src/builder/extraction/file-check.test.ts`, `apps/server/src/builder/runner/text-runner.test.ts`, `apps/server/test/tools/real-toolset.test.ts`, `apps/server/test/voice/prompt.test.ts`, and in `apps/server/test/e2e/main-flow.test.ts` "a bypass attempt is refused with no tool run and no approval".

**Not yet enforced or tested**

- An owner answer in builder chat now opens a `fact_edit` approval (`proposeFactFromChat`). The owner still has to confirm it. The text of the answer goes to the builder model first, and that model's output is not verified on the real model for this path.
- Uploaded files are not scanned for malware.

### Rule 8. Never commit a secret, and never print one

**Status:** built and tested with fakes for the code paths. I did not run a secret scanner over the repository or its history.

**Where it is enforced**

- `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), service account files, `*.pem` and `*.key`. `.env.example` holds variable names only.
- `parseEnv` in `apps/server/src/env.ts` reports variable names and its own messages, never a value. `scripts/check-env.mjs` shows which variables are set and never prints a value.
- `safeLogger` in `apps/server/src/voice/logic.ts` redacts the OpenAI key and the Twilio auth token from voice logs. `compose/index.ts` passes both to it.
- Integration health returns fixed detail text and names of missing settings (`apps/server/src/compose/providers.ts`, `compose/health.ts`).
- The error handler in `apps/server/src/app.ts` replaces parser messages with fixed text, so request values are not echoed.
- The browser never gets the long-lived OpenAI key. `apps/server/src/builder/voice/minter.ts` mints a short-lived client secret on the server.
- The seed and reset commands print only an error message, because a database error object can echo connection details (`runCli` in `packages/db/src/seed/cli.ts`).
- `npm run register-webhooks -- --apply` writes the Square signature key into `.env.local` and does not print it (`scripts/register-webhooks-lib.ts`).

**Tests:** `apps/server/test/voice/logic.test.ts` (redaction and the safe logger), `apps/server/test/voice/relay.test.ts`, `apps/server/src/builder/voice/routes.test.ts`, `apps/server/test/scripts/register-webhooks.test.ts`. The other items in this list have no test that I found.

**What I checked by hand:** on commit `1588eaa`, a pattern search of tracked files for strings shaped like OpenAI keys, Square tokens, Twilio account SIDs and private key headers found only test placeholders and a README template. This is a simple search, not a full scan.

## 5. The restricted database role and the checked routines

**Status:** built and tested with fakes for 0001 to 0005. Verified against the real database for 0001 to 0004. Migration 0005 is not applied to the real database as of the list in section 2.

The server connects with `DATABASE_URL` as the login `abos_app` (SPEC decision D-10). Migrations, seed and reset use the owner connection. `abos_app` is created `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, and migration 0004 stops if an existing `abos_app` has an unsafe attribute or can create objects in a schema.

What `abos_app` may do directly:

| Tables | Rights |
|---|---|
| `approval_requests`, `action_executions`, `message_dispatches`, `sync_jobs`, `capabilities`, `payment_receipts` | SELECT only |
| `activity_events`, `webhook_events` | SELECT and INSERT |
| `orders`, `bookings` | SELECT, INSERT and UPDATE, with every write checked by a guard trigger (below) |
| `businesses`, `users`, `business_facts`, `files`, `catalog_items`, `fact_conflicts`, `agents`, `agent_versions`, `live_agent`, `builder_sessions`, `calls`, `integrations` | SELECT, INSERT and UPDATE |
| `builder_sessions`, `files`, `fact_conflicts`, `catalog_items`, `live_agent` | DELETE as well |

No table grants TRUNCATE to `abos_app`.

The guard triggers on `orders` and `bookings` (0005) apply to `abos_app` only. They refuse a status move that is not in the state machine, any move into or out of a paid or booked state, a change to the row's identity or approval, and a change to a stored Square or Google reference.

The routines `abos_app` may call, all in the `private` schema, all `SECURITY DEFINER` with an empty search path:

| Routine | Migration | What it checks |
|---|---|---|
| `create_approval` | 0004 | Rebuilds the material fields, checks the canonical text, the hash, the subject row, and an expiry of at most 11 minutes ahead |
| `decide_and_enqueue` | 0004, replaced in 0005 | Owner, hash, expiry, subject still awaiting approval. Inserts the steps with their keys |
| `claim_execution`, `claim_next_execution` | 0004, the first replaced in 0005 | One worker per step, at most 3 attempts, earlier steps finished, subject still matches. Gives a 15 minute lease. Moves an approved order to `CREATING_CHECKOUT` |
| `finish_execution` | 0004, replaced in 0005 | The worker holds the lease. A provider step needs a reference. A message step needs its sent dispatch |
| `record_dispatch`, `update_dispatch` | 0004 | Recipient and channel come from the approval. A dispatch status only moves forward |
| `enqueue_sheets_sync`, `claim_sync_job`, `finish_sync_job` | 0004, the last two replaced in 0005 | Verified subject, approved Sheets action, matching key, at most 5 attempts |
| `expire_approvals` | 0004, replaced in 0005 | Moves past-due approvals and their subjects, and writes the events |
| `save_checkout` | 0005 | The checkout step's current lease. References cannot change once stored |
| `mark_order_paid`, `mark_order_payment_failed` | 0005 | The observation (amount, currency, Square order, location, status, sandbox) against the signed approval, the order and the business's Square location. One receipt per payment. A paid order never moves back |
| `fulfill_order` | 0005 | A completed receipt for the order's payment |
| `verify_booking` | 0005 | The calendar step's current lease. The event ID cannot change once stored. Creates the one Sheets job |
| `apply_fact_update` | 0005 | The fact step's lease and the signed before and after values |
| `resolve_execution` | 0005 | Only a `NEEDS_REVIEW` step. Completes, requeues or abandons it from the evidence given |
| `recover_stale_executions`, `recover_stale_sync_jobs` | 0005 | A step whose lease ran out goes to `NEEDS_REVIEW`. A Sheets job whose lease ran out goes to `RETRYING`, or `FAILED` after 5 attempts, and must look up its record ID before appending |
| `renew_execution_lease`, `renew_sync_lease` | 0005 | The current worker and attempt |

Other guards in the database: `activity_events` and `payment_receipts` reject every UPDATE and DELETE. A published `agent_versions` row rejects UPDATE and DELETE (`agent_versions_immutable`). `bookings_no_overlap` prevents two bookings on one calendar in overlapping time while one is `RECHECKING_SLOT` or `BOOKED_VERIFIED`. Unique indexes stop one Square order, payment link, payment or Google event from attaching to two local rows. Row-level security lets a signed-in owner read only rows of a business they own (`private.owns_business`), and `anon` and `authenticated` can write nothing.

**Tests:** all of `packages/db/test/`, including `direct-dml.test.ts`, `rls.test.ts`, `runtime-hardening.test.ts`, `payments-and-recovery.test.ts` and `review-0005.test.ts`. The server's own database tests run as `abos_app` (`apps/server/test/support/db.ts`), and the end-to-end files assert it ("runs as abos_app").

## 6. Webhook signature and dedupe

See rule 2 for the detail. In short: the raw body is captured before any parser, the signature is checked against the public address the server is configured with, only a verified event is stored, the unique pair of source and provider event ID stops a duplicate, and the payment is always read from Square before any order changes. A reconciliation poll runs every 30 seconds for 15 minutes after the link is ready and covers a missed webhook (`apps/server/src/reconcile/index.ts`, test "a missed webhook is recovered by the reconcile poll").

## 7. Idempotency keys derived by the database

See rule 3 for the detail. In short: the key for each step is computed inside `private.decide_and_enqueue` from the business, the subject, the action type and the approval ID. The server reads it from the row and passes it to the provider. Nothing in `apps/server/src` writes a key.

## 8. Secrets handling

- Values live in `.env.local` on a laptop and in the host's variable settings. Neither is committed.
- `DATABASE_ADMIN_URL`, the owner connection, must never be set on the host. `npm run check-env -- --for host` exits with an error when it is.
- The server connects to Postgres with TLS and certificate checks on. `apps/server/src/db/index.ts` removes every TLS parameter from the connection string so a parameter there cannot turn checks off, and adds the Supabase root certificate in `apps/server/certs/`. Test: `apps/server/test/api/db.test.ts`.
- The Supabase JWT is verified against the project's public keys with issuer and audience checks (`apps/server/src/auth/verify.ts`, test `apps/server/test/api/auth.test.ts`).
- Every `/api` route needs the owner's token unless it declares the builder's own auth, which uses the same check. Tests: `apps/server/test/e2e/route-auth.test.ts`, `apps/server/src/builder/route-auth.test.ts`.
- Provider credentials are not stored in our tables. They are not encrypted by this code. They rely on the host's secret store.
- Only the last four digits of a recipient are written to activity events and logs.

## 9. The stated limit on payment verification

The database enforces consistency. It enforces one payment per order: the unique index `orders_square_payment_id_key`, the primary key of `payment_receipts`, and the checks in `private.mark_order_paid`. It enforces forward-only states: the guard trigger on `orders` refuses any direct move into or out of a paid state, `mark_order_paid` accepts only `PAYMENT_PENDING` or `PAYMENT_FAILED`, and `mark_order_payment_failed` never moves a paid order.

The database does not talk to Square. It trusts the server's read of the Square payment. The comment above `private.check_payment` in 0005 says it plainly: "Consistency checks are not a provider read. The server supplies its redacted Square observation." The server reads the payment, checks it in `checkPayment`, and passes the payment ID, amount, currency, Square order ID, location, status and environment to `mark_order_paid`. In `apps/server/src/compose/webhooks.ts` the amount, currency, order ID and location passed are the order's own, after the adapter has compared them with Square's, and the status is the literal `COMPLETED`.

A server that is compromised or wrong could therefore record a payment that Square never completed. The database would still refuse a wrong amount, a wrong Square order or location, a second payment on the order, a payment ID already recorded with different details, and anything not marked sandbox.

## 10. Other known limits

1. **Migration 0005 is not applied to the real database** as of the list in section 2, and the file was rewritten after that. The code on this branch calls its routines, its triggers and its new columns throughout. Until it is applied, the executor, payment marking, recovery, fact edits and saving a builder draft agent will fail against the real database.
2. **Some order and booking moves are still plain updates.** `MESSAGE_SENT`, `PAYMENT_PENDING`, `RECOVERY_REQUIRED`, `UNAVAILABLE`, `CANCELLED`, `SLOT_CONFLICT` and `RETRY_REQUIRED` have no routine. The server makes them with a conditional update (`guardedMove` in `compose/executor.ts`, `cancelOrder` in `compose/recovery.ts`), and the 0005 guard trigger checks each one against the state machine.
3. **Pause is not stored, so it does not stop the phone agent.** See rule 5. The phone worker reads `agents.state` from Postgres (`dbLiveAgentPort` in `compose/ports.ts`), and pause does not change that row. To stop calls, switch the live agent or stop the server.
4. **Publish is partly stored.** Published versions and the live-agent row are now written to Postgres (`apps/server/src/compose/builder-publish.ts`). The `agents` row's `state` and `active_version_id` are not written by the same store. I could not run a successful publish against the test database, because publish refused with `INTEGRATION_UNAVAILABLE` (see limit 5), so the full publish path through Postgres is not verified by me.
5. **Publish refuses when a provider the agent needs is not connected.** It reads the last stored integration health. A configured provider counts as disconnected until a check with `refresh=1` has run. The pizza agent needs Square, the message channel and Google Sheets, so it cannot be published while Google Sheets has no credentials. A message channel other than `qr_only` has no health check in `compose/providers.ts`, so it always reads as disconnected and also stops a publish.
6. **Uploads keep their state in server memory.** `compose/index.ts` passes no `extraction` option to the builder plugin. Uploaded files, extracted facts and conflicts are lost on a restart.
7. **No customer message can be sent from a call.** The agent always proposes `qr_only` (rule 7). The message adapter and the message step are built and tested, but only through proposals that tests create directly in the engine.
8. **No re-check of item availability at checkout.** `docs/FLOWS.md` step B18 describes it. `createCheckout` does not do it. Availability is checked when the order is quoted.
9. **The agent cannot end a call on its own goodbye.** The relay supports a trusted finish signal (`finishes` in `voice/relay.ts`), but `compose/index.ts` does not pass that port. Calls end on hang-up, on the idle limit, or on the session limit.
10. **Human fallback keeps its reservation in server memory** and has no checked routine (`compose/fallback.ts`). It is refused for every version today.
11. **Rate limiting.** Only the realtime client secret route has a rate limit (`apps/server/src/builder/voice/rate-limit.ts`). The REST API, the webhooks and the phone path have none.
12. **In-memory state.** Quotes before a proposal, stream tokens, test console sessions, telemetry, the owner-decision bus for live calls, and the queue of webhook jobs live in server memory. Stored webhook rows are re-read after a restart.
13. **`BUILDER_DEV_AUTH=1`** makes the builder routes accept any bearer token from the loopback address when no real auth is configured. It is refused when `NODE_ENV` is `production` (`apps/server/src/builder/index.ts`). It must not be set on a host.
14. **The table owner is outside the boundary.** The owner connection can disable triggers and change grants, and the guard triggers on `orders` and `bookings` do not apply to it. The reset script clears run data with TRUNCATE, which fires no row trigger. It does not clear `payment_receipts`.
15. **`service_role`** may still execute the 0004 routines that 0005 does not replace (`create_approval`, `claim_next_execution`, `record_dispatch`, `update_dispatch`, `enqueue_sheets_sync`). 0005 revokes it from every routine it replaces or adds.
16. **Not built from the PRD's security list:** anti-malware scanning of uploads, a nonce or timestamp check on webhooks, and transcript redaction (no transcript is stored).
17. **Legal checks.** AI disclosure is in the prompt. Recording, consent and messaging rules for real customers have not been reviewed. This build is for a sandbox demo.
