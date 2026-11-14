# Security notes

**Task:** S-06. **Written:** 2026-11-14. **Describes:** the code on branch `arsh/integration` at commit `1588eaa`, which this branch (`arsh/S-06-docs`) starts from.

This file lists the eight rules from `AGENTS.md` that are never broken. For each rule it says where the code enforces it, which tests cover it, and what is not yet enforced or not yet tested. It then describes the restricted database role, webhook handling, idempotency keys, secrets, and the known limits.

## 1. How to read the status words

Every control in this file has one of three statuses.

| Status | Meaning |
|---|---|
| Built and tested with fakes | The code is on this branch and automated tests cover it. The tests use an in-process Postgres (PGlite) with migrations 0001 to 0005 applied, and fake Square, Google, message and model providers. No real provider is called. |
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

Not verified with any real service: a phone call through Twilio to the voice worker, a paid Square link and its webhook, payment reconciliation, Google Calendar and Sheets (there are no credentials yet), the WhatsApp sandbox, any message delivery, and the integration branch deployed.

## 3. Test results from this checkout

I ran these on 2026-11-14 in a cloud container with 4 cores and Node 22.23.4. The spec and CI name Node 24.

| Command | Result |
|---|---|
| `npm run typecheck` | Passed for all four workspaces (`@abos/server`, `@abos/web`, `@abos/contracts`, `@abos/db`). |
| `npm test`, first run | 83 test files, 1558 tests. 1554 passed and 4 failed. |
| `npm test`, second run | 83 test files, 1558 tests. 1553 passed and 5 failed. |
| `npx vitest run --maxWorkers=2` | 83 test files, 1558 tests. All 1558 passed. |
| `npm test -w @abos/web` | 41 test files, 465 tests. 464 passed and 1 failed. |

Every failure in the two `npm test` runs was the message "Test timed out in 5000ms" in a database test under `packages/db/test/` (`constraints.test.ts`, `guarded-updates.test.ts`, `migrations.test.ts`, `runtime-hardening.test.ts`). The failing tests were not the same in both runs. Run alone, the three files that failed in the first run passed 77 of 77. `vitest.config.ts` allows 6 workers and each database test file starts its own in-process Postgres, so on 4 cores some tests pass the default 5 second limit. I did not see an assertion fail in any server or package test. I did not run the suite on Node 24 myself.

**CI is red for the same reason.** GitHub Actions ran the `check` job on the base commit `1588eaa` (draft pull request #97) and on this branch's first commit, which adds only Markdown. Both runs failed at the `npm test` step. The errors were "Hook timed out in 10000ms" in the setup hooks that start and migrate the in-process Postgres, and "Test timed out in 5000ms", in `packages/db/test/` (`migrations.test.ts`, `rls.test.ts`, `runtime-hardening.test.ts`, `seed.test.ts` and others). When a setup hook times out, every test in that file fails. The job stops at that step, so CI did not reach the web tests. I read the job logs. I did not find an assertion failure in them.

The one web failure is `app/(dashboard)/build/voice/VoiceControl.test.tsx`, the test "after RATE_LIMITED it explains in one sentence and releases the microphone". It also failed when I ran that file alone. I did not investigate the cause. The web app is outside the scope of this task.

## 4. The eight rules

### Rule 1. No external write happens before the owner approves the exact payload

**Status:** built and tested with fakes. The restricted role's write refusal is verified against the real database (section 2). The executor has never run against a real provider.

**Where it is enforced**

- **The agent has no write tool.** See rule 6.
- **A proposal only writes our own database.** `createOrderProposal` and `createBookingProposal` in `apps/server/src/policy/engine.ts` store the order or booking and open an approval. They call no provider.
- **The server cannot write approvals or executions directly.** Migration `0004_runtime_role_and_routines.sql` gives `abos_app` SELECT only on `approval_requests`, `action_executions`, `message_dispatches` and `sync_jobs`. Every change goes through a checked routine (section 5).
- **The approval is bound to its payload.** `private.create_approval` rebuilds the material fields itself with `private.material`, compares them with the canonical text the server sent, and recomputes the SHA-256 hash. `private.check_subject` compares the approval with the stored order, booking, fact or catalog row.
- **The decision is checked in the database.** `private.decide_and_enqueue` requires the business owner, the exact stored hash and an unexpired approval. It inserts execution rows only when the state is `APPROVED`.
- **An approval is used once.** The trigger `approval_requests_guard` (0002, replaced in 0004) allows a row to be created only as `PENDING`, freezes the payload, and refuses any change after a decision. A unique index allows one `PENDING` approval per subject.
- **An execution row needs an approved bundle.** The trigger `action_executions_match_approval` (0002) refuses an execution row unless its approval is `APPROVED`, in the same business, and lists that action at that position. `execution_claim_allowed` refuses a step until the earlier steps have finished.
- **A message goes only to the approved recipient.** The trigger `message_dispatches_guard` (0002) requires the dispatch recipient and channel to equal the approved payload. `private.record_dispatch` reads both from the approval, not from the server.
- **The executor checks again before each provider call.** `runTick` in `apps/server/src/executor/index.ts` calls `authorizeStep` (in `policy/engine.ts`) before the handler, and the `external` wrapper calls it again immediately before every provider call. `orderFor` and `bookingFor` in `apps/server/src/executor/handlers.ts` compare the stored order or booking with the approved material and refuse a mismatch.
- **The Sheets row needs the same approval.** `private.enqueue_sheets_sync` and `private.claim_sync_job` require a verified subject and an approved bundle that lists the Sheets action.
- **Unwired pieces fail closed.** Without a database, `notWiredExecutor` in `apps/server/src/compose/seams.ts` leaves approved steps `QUEUED` and runs nothing.

**Tests:** `packages/db/test/direct-dml.test.ts`, `packages/db/test/guarded-updates.test.ts`, `packages/db/test/constraints.test.ts`, `packages/db/test/runtime.test.ts`, `packages/db/test/runtime-hardening.test.ts`, `apps/server/test/policy/engine.test.ts`, `apps/server/test/executor/executor.test.ts`, `apps/server/test/executor/review.test.ts`, `apps/server/test/e2e/main-flow.test.ts` (reject leaves no steps, a wrong hash is refused, an expired approval is refused, another owner cannot decide), and `apps/server/test/e2e/flows.test.ts`, where every test counts the external writes that ran.

**Not yet enforced or tested**

- `npm run seed:square` writes the demo catalog to the Square sandbox. It is an operator command that uses the owner database connection. It does not go through the approval engine.
- The price change bundle is not built. No route creates a `price_edit` approval, and the two handlers `updateCatalogPrice` and `syncCatalog` in `executor/handlers.ts` return `CAPABILITY_NOT_ALLOWED`.
- No executor step has run against real Square, a real message channel or real Google.

### Rule 2. Every webhook is signature-verified and deduplicated before it changes state

**Status:** built and tested with fakes. No real Square or Twilio webhook has reached this code.

**Where it is enforced**

- **Square.** `apps/server/src/webhooks/plugin.ts` reads the raw bytes in its own parser scope. `verifyWebhookSignature` in `apps/server/src/adapters/square/core.ts` computes HMAC-SHA256 over the notification URL plus the raw body with the signature key, encodes it as base64, and compares it with `timingSafeEqual`. A bad or missing signature gets 401, a `webhook.rejected` activity event, and nothing is stored (`rejectWebhook` in `apps/server/src/webhooks/square.ts`).
- **Square dedupe.** `recordOnce` in `apps/server/src/compose/webhooks.ts` inserts into `webhook_events` with `on conflict (source, provider_event_id) do nothing`. Only a newly inserted row is processed.
- **The body is never trusted.** `parseSquareEvent` keeps only the event ID, the event type, the payment ID and the Square order ID. `processPayment` reads the payment from Square for its status and amount.
- **Twilio call status.** The same plugin validates the request with `twilio.validateRequest` and the account auth token against `PUBLIC_SERVER_URL` plus the route path. The dedupe key is the call SID plus the status.
- **Twilio voice.** `apps/server/src/voice/plugin.ts` validates `X-Twilio-Signature` and answers 403 on failure. A repeated webhook for the same call gets the same pending stream token or a 409. `calls.provider_call_id` is unique, so there is never a second call row.
- **Missing settings.** Without `PUBLIC_SERVER_URL`, `SQUARE_WEBHOOK_SIGNATURE_KEY` or a database, `/webhooks/square` and `/webhooks/twilio/status` answer 503 without reading the body (`notWiredWebhooks`). Without the voice settings, `/webhooks/twilio/voice` answers 503 and `/ws/phone` does not exist (`apps/server/src/app.ts`).

**Tests:** `apps/server/test/webhooks/plugin.test.ts`, `apps/server/test/webhooks/review.test.ts`, `apps/server/test/adapters/square/square.test.ts`, `apps/server/test/voice/plugin.test.ts`, `apps/server/test/e2e/voice-wiring.test.ts`, and in `apps/server/test/e2e/flows.test.ts` the tests "a duplicate webhook delivery changes nothing" and "a bad signature is rejected with 401, writes webhook.rejected and stores nothing".

**Not yet enforced or tested**

- The Square signature check assumes the header value is base64. `docs/SPEC.md` section 2.9 asks spike B-02 to confirm this. It is not verified with a real Square webhook.
- The Square check signs over `PUBLIC_SERVER_URL` plus `/webhooks/square`. The variable `SQUARE_WEBHOOK_URL` is parsed by `apps/server/src/env.ts` but the server does not use it for the check. The two must describe the same address.
- A rejected Twilio voice webhook gets its 403 but writes no `webhook.rejected` event on this branch, because `compose/index.ts` does not pass `twilioBusinessId` to the voice plugin.
- A rejected Square webhook is recorded against the business with the most rows in `catalog_items`. SPEC 2.9 says to read the owner from `integrations`.
- `webhook_events.processed_at` is never set. `abos_app` has no UPDATE on that table and no routine exists for it (`markWebhookProcessed` in `apps/server/src/compose/interim-db.ts` returns false). After a restart, stored events from the last 15 minutes are processed again. Processing is safe to repeat.
- A WhatsApp delivery receipt is verified and stored, but it does not update the dispatch row (`updateStatus` in `compose/webhooks.ts` returns false).
- There is no timestamp or nonce check. Replay protection is the event ID.

### Rule 3. Every external write carries a stable idempotency key

**Status:** built and tested with fakes. For Square payment links, verified against the real sandbox in a spike: the same key returned the same link. The executor path that uses the database key has not run against real Square.

**Where it is enforced**

- **The database derives the key.** `private.decide_and_enqueue` computes `sha256(businessId:subjectId:actionType:approvalId)` in hex for each step when it inserts the execution row. `private.enqueue_sheets_sync` does the same for the Sheets job. The server never creates or replaces a key (`apps/server/src/compose/executor.ts`).
- **The key cannot change or disappear.** `action_executions.idempotency_key` is unique. The trigger `action_executions_match_approval` refuses a change to it. The trigger function `private.retain_identity` (0004) refuses deleting an execution or a dispatch and refuses changing a sync job's identity.
- **The executor confirms the key.** `authorizeStep` recomputes the key with `idempotencyKey` from `packages/contracts/src/hash.ts` and refuses a mismatch.
- **Each provider gets the row's key.** Square `CreatePaymentLink` receives it as `idempotencyKey` (`createCheckout` in `adapters/square/core.ts`). The Google Calendar event ID is the key, and the adapter looks the event up before every insert (`apps/server/src/adapters/calendar/index.ts`). A message has one `message_dispatches` row per execution. A Sheets row is found by its record ID in the first column.
- **A timeout is never retried blindly.** `classifyFailure` in `executor/index.ts` sends a timeout or an unknown result to `NEEDS_REVIEW`. A saved Square order ID makes `createCheckout` in `executor/handlers.ts` read the link back instead of creating one. A step left `RUNNING` by a crash goes to `NEEDS_REVIEW` through `private.recover_stale_executions` (0005).

**Tests:** `packages/contracts/src/hash.test.ts`, `packages/db/test/guarded-updates.test.ts`, `packages/db/test/payments-and-recovery.test.ts`, `apps/server/test/executor/executor.test.ts`, `apps/server/test/adapters/message/message.test.ts`, `apps/server/test/adapters/calendar/index.test.ts`, `apps/server/test/adapters/sheets/index.test.ts`, and in `apps/server/test/e2e/flows.test.ts` the paid path (checkout with the database key), "Square create timeout: NEEDS_REVIEW, order RECOVERY_REQUIRED, no link sent, no second create", "approving twice runs the steps once", and the crash recovery test.

**Not yet enforced or tested**

- No message provider accepts an idempotency key. The dispatch row is the only guard against a second message.
- The Calendar event ID and the Sheets record ID check are not verified against Google.
- The decision endpoint's `Idempotency-Key` replay cache is in server memory (`apps/server/src/api/routes.ts`). It is lost on restart. The database one-use rule still holds.

### Rule 4. Payment data is always labeled sandbox, and `SQUARE_ENVIRONMENT` must be `sandbox`

**Status:** built and tested with fakes. The quote and payment link checks in section 2 were made on the Square sandbox.

**Where it is enforced**

- `apps/server/src/env.ts` accepts only the literal `sandbox` for `SQUARE_ENVIRONMENT`. `apps/server/src/index.ts` exits when the environment does not parse.
- `decide` and `authorizeStep` in `policy/engine.ts` refuse with `ENVIRONMENT_MISMATCH` when the environment is not `sandbox`.
- `createSandboxSquareClient` in `apps/server/src/adapters/square/client.ts` builds the only Square client.
- `/health` returns `squareEnvironment`. `GET /api/orders/:id/checkout` returns `environment: "sandbox"`. The `checkout.created`, `payment.verified` and `payment.failed` events carry `sandbox: true`. The checkout message text in `apps/server/src/adapters/message/templates.ts` says "Sandbox test payment."
- The reset script refuses to run unless `SQUARE_ENVIRONMENT` is `sandbox` (`packages/db/src/seed/reset.ts`).

**Tests:** `apps/server/test/app.test.ts` ("refuses any Square environment other than sandbox (AC-19)"), `apps/server/test/adapters/square/square.test.ts`, `apps/server/test/policy/engine.test.ts`, `packages/db/test/seed.test.ts`.

**Not yet enforced or tested**

- I did not check the sandbox labels on the web screens in a browser.

### Rule 5. No success state is shown or stored before the provider confirms it

**Status:** built and tested with fakes. A paid Square link has never been verified against the real service.

**Where it is enforced**

- `private.finish_execution` accepts `SUCCEEDED` for a provider step only with a provider reference. For a message step it also requires a dispatch that is `SENT` or `DELIVERED` with that provider message ID.
- Table constraints in 0002: `orders_link_states_need_square_refs`, `orders_paid_states_need_payment`, `bookings_verified_needs_event`, and `message_dispatches_sent_needs_provider_id`. `private.finish_sync_job` requires a reference for `DONE`.
- The checkout URL is stored on the order only after the Square order total has been read and matched (`completeCheckout` in `compose/executor.ts`, `verifyLinkTotal` in `adapters/square/core.ts`).
- `checkPayment` in `adapters/square/core.ts` verifies a payment only when its status is `COMPLETED`, it is not refunded, and its order ID, amount, currency and location match.
- `private.mark_order_paid` (0005) compares the amount and currency with the signed approval and the order row before it writes `PAID_VERIFIED`.
- When the approved channel is `qr_only`, the message step is created `SKIPPED` and no dispatch row exists.
- `GET /api/orders/:id/checkout` reports `ready` only when the link ID, the Square order ID and the URL are all stored.

**Tests:** `packages/db/test/payments-and-recovery.test.ts`, `packages/db/test/constraints.test.ts`, `apps/server/test/webhooks/plugin.test.ts`, `apps/server/test/reconcile/index.test.ts`, and in `apps/server/test/e2e/flows.test.ts` "a payment amount mismatch does not reach PAID_VERIFIED" and "a refunded payment does not verify".

**Not yet enforced or tested**

- The stated limit in section 9 applies here.
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

**Tests:** `apps/server/test/tools/real-toolset.test.ts` ("has exactly seven tools, every one read or propose"), `apps/server/test/mock-toolset.test.ts`, `apps/server/test/voice/relay.test.ts`, `apps/server/test/e2e/voice-wiring.test.ts` ("the toolset given to the voice worker has no write or external_message tool"), `apps/server/test/e2e/main-flow.test.ts` ("the model cannot reach a write capability"), `packages/contracts/src/registry.test.ts`, `apps/server/src/builder/registry.test.ts`.

### Rule 7. Text from callers, uploaded files, menus and third-party APIs is data, never an instruction

**Status:** built and tested with fakes. The voice model's behavior under adversarial speech has not been tested on a real call.

**Where it is enforced**

- **Structure, not the prompt.** The model has no write tool (rule 6). Totals come from Square CalculateOrder through `quote_order`. `createOrderProposal` refuses a cart whose hash differs from the quote. A proposal is bound to its call and its pinned agent version (`assertCall` in `policy/engine.ts`).
- **The recipient is checked twice.** The proposal tools require a consented recipient to be presented once and confirmed by a second call at least 3 seconds later (`READBACK_MIN_MS` in `tools/real/index.ts`). The owner then approves the exact recipient.
- **The prompt says so.** `apps/server/src/voice/prompt.ts` tells the model that caller speech and text in tool results are data.
- **The text runner refuses first.** `apps/server/src/builder/runner/guardrails.ts` refuses a bypass or injection attempt before any tool runs.
- **Uploads become drafts.** Extraction saves draft facts only and never changes a verified fact (`apps/server/src/builder/extraction/service.ts`, `sanitize.ts`). `file-check.ts` checks the declared type against the content and the size cap.
- **Webhook bodies.** Only routing IDs are read (rule 2).

**Tests:** `apps/server/src/builder/extraction/service.test.ts` ("keeps an injection document to draft facts only"), `apps/server/src/builder/extraction/routes.test.ts`, `apps/server/src/builder/extraction/sanitize.test.ts`, `apps/server/src/builder/extraction/file-check.test.ts`, `apps/server/src/builder/runner/text-runner.test.ts`, `apps/server/test/tools/real-toolset.test.ts`, `apps/server/test/voice/prompt.test.ts`, and in `apps/server/test/e2e/main-flow.test.ts` "a bypass attempt is refused with no tool run and no approval".

**Not yet enforced or tested**

- The server does not hear the caller and reads no transcript. It cannot prove the caller said yes to a message. A model that waits and repeats the proposal call can pass the read-back. The owner's approval of the exact recipient is the remaining check. This is recorded in `apps/server/src/voice/NOTES.md`.
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

**Tests:** `apps/server/test/voice/logic.test.ts` (redaction and the safe logger), `apps/server/test/voice/relay.test.ts`, `apps/server/src/builder/voice/routes.test.ts`. The other items in this list have no test that I found.

**What I checked by hand:** a pattern search of tracked files for strings shaped like OpenAI keys, Square tokens, Twilio account SIDs and private key headers found only test placeholders and a README template. This is a simple search, not a full scan.

## 5. The restricted database role and the checked routines

**Status:** built and tested with fakes for 0001 to 0005. Verified against the real database for 0001 to 0004. Migration 0005 is not applied to the real database.

The server connects with `DATABASE_URL` as the login `abos_app` (SPEC decision D-10). Migrations, seed and reset use the owner connection. `abos_app` is created `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, and migration 0004 stops if an existing `abos_app` has an unsafe attribute or can create objects in a schema.

What `abos_app` may do directly:

| Tables | Rights |
|---|---|
| `approval_requests`, `action_executions`, `message_dispatches`, `sync_jobs`, `capabilities` | SELECT only |
| `activity_events`, `webhook_events` | SELECT and INSERT |
| `businesses`, `users`, `business_facts`, `files`, `catalog_items`, `fact_conflicts`, `agents`, `agent_versions`, `live_agent`, `builder_sessions`, `calls`, `orders`, `bookings`, `integrations` | SELECT, INSERT and UPDATE |
| `builder_sessions`, `files`, `fact_conflicts`, `catalog_items`, `live_agent` | DELETE as well |

No table grants TRUNCATE to `abos_app`.

The routines `abos_app` may call, all in the `private` schema, all `SECURITY DEFINER` with an empty search path:

| Routine | Migration | What it checks |
|---|---|---|
| `create_approval` | 0004 | Rebuilds the material fields, checks the canonical text, the hash, the subject row, and an expiry of at most 11 minutes ahead |
| `decide_and_enqueue` | 0004 | Owner, hash, expiry, subject still awaiting approval. Inserts the steps with their keys |
| `claim_execution`, `claim_next_execution` | 0004 | One worker per step, at most 3 attempts, earlier steps finished, subject still matches |
| `finish_execution` | 0004 | The worker holds the lease. A provider step needs a reference. A message step needs its sent dispatch |
| `record_dispatch`, `update_dispatch` | 0004 | Recipient and channel come from the approval. A dispatch status only moves forward |
| `enqueue_sheets_sync`, `claim_sync_job`, `finish_sync_job` | 0004 | Verified subject, approved Sheets action, matching key, at most 5 attempts |
| `expire_approvals` | 0004 | Moves past-due approvals and their subjects, and writes the events |
| `mark_order_paid`, `mark_order_payment_failed` | 0005 | Amount and currency equal the signed approval and the order. One payment per order. A paid order never moves back |
| `recover_stale_executions` | 0005 | A stale `RUNNING` step goes to `NEEDS_REVIEW`, never back to `QUEUED` |

Other guards in the database: `activity_events` rejects every UPDATE and DELETE (`activity_events_append_only`). A published `agent_versions` row rejects UPDATE and DELETE (`agent_versions_immutable`). `bookings_no_overlap` prevents two bookings on one calendar in overlapping time while one is `RECHECKING_SLOT` or `BOOKED_VERIFIED`. Unique indexes stop one Square order, payment link, payment or Google event from attaching to two local rows. Row-level security lets a signed-in owner read only rows of a business they own (`private.owns_business`), and `anon` and `authenticated` can write nothing.

**Tests:** all of `packages/db/test/`, including `direct-dml.test.ts`, `rls.test.ts`, `runtime-hardening.test.ts` and `payments-and-recovery.test.ts`. The server's own database tests run as `abos_app` (`apps/server/test/support/db.ts`), and the end-to-end files assert it ("runs as abos_app").

## 6. Webhook signature and dedupe

See rule 2 for the detail. In short: the raw body is captured before any parser, the signature is checked against the public address the server is configured with, only a verified event is stored, the unique pair of source and provider event ID stops a duplicate, and the payment is always read from Square before any order changes. A reconciliation poll runs every 30 seconds for 15 minutes after the link is ready and covers a missed webhook (`apps/server/src/reconcile/index.ts`, test "a missed webhook is recovered by the reconcile poll").

## 7. Idempotency keys derived by the database

See rule 3 for the detail. In short: the key for each step is computed inside `private.decide_and_enqueue` from the business, the subject, the action type and the approval ID. The server reads it from the row and passes it to the provider. Nothing in `apps/server/src` writes a key.

## 8. Secrets handling

- Values live in `.env.local` on a laptop and in the host's variable settings. Neither is committed.
- `DATABASE_ADMIN_URL`, the owner connection, must never be set on the host. `npm run check-env -- --for host` exits with an error when it is.
- The server connects to Postgres with TLS and certificate checks on. `apps/server/src/db/index.ts` removes every TLS parameter from the connection string so a parameter there cannot turn checks off, and adds the Supabase root certificate in `apps/server/certs/`. Test: `apps/server/test/api/db.test.ts`.
- The Supabase JWT is verified against the project's public keys with issuer and audience checks (`apps/server/src/auth/verify.ts`, test `apps/server/test/api/auth.test.ts`).
- Provider credentials are not stored in our tables. They are not encrypted by this code. They rely on the host's secret store.
- Only the last four digits of a recipient are written to activity events and logs.

## 9. The stated limit on payment verification

The database enforces consistency. It enforces one payment per order (the unique index `orders_square_payment_id_key` and the checks in `private.mark_order_paid`). It enforces forward-only payment states inside its routines: `mark_order_paid` accepts only `PAYMENT_PENDING` or `PAYMENT_FAILED`, and `mark_order_payment_failed` never moves a paid order.

The database does not talk to Square. It trusts the server's read of the Square payment. The server reads the payment, checks it in `checkPayment`, and then passes the payment ID, amount and currency to `mark_order_paid`. In `apps/server/src/compose/webhooks.ts` the amount and currency passed are the order's own, after the adapter has compared them with Square's. A server that is compromised or wrong could therefore mark an order paid without a real payment. The database would still refuse a wrong amount, a second payment on the order, or a payment ID already used on another order.

## 10. Other known limits

1. **Migration 0005 is not applied to the real database.** The code on this branch calls its routines and uses its column `agents.spec_revision`. Until it is applied, marking an order paid or failed, recovering a stale step, and saving a builder draft agent will fail against the real database.
2. **Orders and bookings are directly writable by the server role.** Their status moves are guarded in the server by `canTransition` and conditional updates (`dbSubjects` in `compose/executor.ts`) and by table constraints, not by a database routine. The move from `PAID_VERIFIED` to `FULFILLMENT_READY` is a plain update in `compose/interim-db.ts`.
3. **Publish, pause, rollback and uploads keep their state in server memory on this branch.** `compose/index.ts` passes no `publish` or `extraction` options to the builder plugin, so it uses its in-memory stores for agent versions, the builder's live-agent pointer, uploaded files, extracted facts and conflicts. A restart loses them. A version published through the API is not written to `agent_versions`. The phone worker reads `live_agent` and the published version from Postgres, so it answers with the seeded versions. The pause route therefore does not stop the phone agent on this branch. `PUT /api/live-agent` does write Postgres.
4. **A step that needs review has no owner action.** `POST /api/orders/:id/cancel` and `POST /api/executions/:id/resolve` (SPEC P-19) are not built. A stuck record is cleared with the reset script.
5. **No re-check of item availability at checkout.** `docs/FLOWS.md` step B18 describes it. `createCheckout` does not do it. Availability is checked when the order is quoted.
6. **The call is not told about the owner's decision.** The relay supports it (`decisions` in `voice/relay.ts`), but `compose/index.ts` does not pass that port.
7. **Rate limiting.** Only the realtime client secret route has a rate limit (`apps/server/src/builder/voice/rate-limit.ts`). The REST API, the webhooks and the phone path have none.
8. **In-memory state.** Quotes before a proposal, stream tokens, test console sessions, telemetry and the queue of webhook jobs live in server memory. Stored webhook rows are re-read after a restart.
9. **`BUILDER_DEV_AUTH=1`** makes the builder routes accept any bearer token from the loopback address when no real auth is configured. It is refused when `NODE_ENV` is `production` (`apps/server/src/builder/index.ts`). It must not be set on a host.
10. **The table owner is outside the boundary.** The owner connection can disable triggers and change grants. The reset script clears run data with TRUNCATE, which fires no row trigger.
11. **`service_role`** may also execute the 0004 routines. It may not delete or truncate the four guarded tables.
12. **Not built from the PRD's security list:** anti-malware scanning of uploads, a nonce or timestamp check on webhooks, and transcript redaction (no transcript is stored).
13. **Legal checks.** AI disclosure is in the prompt and message consent is asked. Recording, consent and messaging rules for real customers have not been reviewed. This build is for a sandbox demo.
