# Security notes

## Evidence and status

This is an offline review of this branch. Status labels are: **built and tested with fakes**, **verified against the real service**, **built on another branch and not merged**, and **not built**. Fake coverage means a test exists for the named component. It does not mean the whole acceptance criterion passes. Fresh tests and typechecking did not pass in this checkout. See IMPLEMENTATION_NOTES.md for the commands and errors. All live behavior outside the checks below is not verified.

The complete real-service evidence supplied for this task is:

- **Verified against the real service:** Supabase has four migrations applied. The runtime role `abos_app` can read. Direct writes to `approval_requests`, `action_executions`, `message_dispatches` and `sync_jobs`, trigger disabling, role switching, table creation and reading `auth.users` were refused with permission error 42501. One owner, two businesses, 33 facts and two agents with published versions are seeded. The owner can sign in.
- **Verified against the real service:** The integration server used the real database read-only. Health, businesses, facts, approvals, integration health and live agent returned 200. A request without a token returned 401. This does not verify writes or deployment.
- **Verified against the real service:** An OpenAI Realtime session probe passed 11 of 11 checks on `gpt-realtime-2.1`. One strict structured-output call on the builder model returned valid JSON. Neither result verifies a phone call or complete builder workflow.
- **Verified against the real service:** Twilio rejected an SMS from the unregistered US number with error 30034. No message delivery is verified. D-08 in docs/SPEC.md defines the MessageAdapter channel ladder.

No real phone call to this worker, Square sandbox interaction, Google Calendar or Sheets interaction, WhatsApp sandbox interaction, delivered message or deployed server is verified.

## The eight required rules

### 1. No external write happens before the owner approves the exact payload

**Built and tested with fakes:** `apps/server/src/policy/engine.ts` creates material payloads and calls the checked database routines. `apps/server/src/auth/verify.ts` verifies Supabase JWT issuer and audience and checks business ownership. `apps/server/src/api/routes.ts` passes the displayed payload hash into the decision. Migration `packages/db/migrations/0004_runtime_role_and_routines.sql` implements `private.create_approval`, `private.decide_and_enqueue` and `private.claim_execution`. They bind the business, subject, actions, expiry and hash, check ownership and sequence steps. Tests are `apps/server/test/policy/engine.test.ts`, `apps/server/test/e2e/main-flow.test.ts` and `packages/db/test/runtime.test.ts`.

**Built on another branch and not merged:** The executor is reported on `arsh/B-11-executor`. On this branch `apps/server/src/compose/seams.ts` supplies `notWiredExecutor`; approved external steps remain QUEUED. The policy engine does run the approved local fact update itself. Provider adapters expose write methods and do not authenticate owners themselves. An executor must claim an approved step before using them. Execution against any real provider is not verified.

### 2. Every webhook is signature-verified and deduplicated before it changes state

**Built and tested with fakes:** `apps/server/src/voice/plugin.ts` uses Twilio's request validator before starting a call. `dbCallsPort` in `apps/server/src/compose/ports.ts` inserts calls with `ON CONFLICT (provider_call_id) DO NOTHING`. Migration 0002 makes that provider call ID unique. Tests are `apps/server/test/voice/plugin.test.ts` and `apps/server/test/compose/compose.test.ts`. A repeated valid voice webhook can still mint another stream token for the same call, so call-row dedupe is not proof of deduped audio sessions.

**Built and tested with fakes:** `verifyWebhookSignature` in `apps/server/src/adapters/square/index.ts` compares HMAC-SHA256 over the exact notification URL and raw body using a timing-safe comparison. `apps/server/test/adapters/square/square.test.ts` covers this helper. Migration 0002 gives `webhook_events` a unique `(source, provider_event_id)` constraint. The insert helper `recordWebhookEvent` in `packages/db/src/guarded-updates.ts` provides storage dedupe, not signature verification.

**Built on another branch and not merged:** Square webhook processing, Twilio status callbacks and reconciliation are reported on `arsh/B-13-webhooks`. The default in `apps/server/src/compose/seams.ts` returns 503 for `/webhooks/square` and `/webhooks/twilio/status` without processing events. Signature verification followed by event dedupe and payment reconciliation is not wired here and is not verified live. Rejected voice signatures log a warning but do not emit `webhook.rejected` activity events.

### 3. Every external write carries a stable idempotency key

**Built and tested with fakes:** `private.decide_and_enqueue` derives hex SHA-256 of `businessId:subjectId:actionType:approvalId`. `private.record_dispatch` reuses the execution key. `private.enqueue_sheets_sync` derives the corresponding Sheets action key. Migration 0004 accepts no caller-selected replacement keys. Migration 0002 adds unique execution, dispatch and sync identities. Tests are `packages/db/test/runtime.test.ts`, `packages/db/test/runtime-hardening.test.ts`, `apps/server/test/policy/engine.test.ts` and `apps/server/test/e2e/main-flow.test.ts`.

**Built and tested with fakes:** Square checkout passes the key to CreatePaymentLink. Calendar can use the execution key as a deterministic event ID and looks up existing events before inserting. `sendOnce` in `apps/server/src/adapters/message/index.ts` records a durable attempt before sending and refuses to resend consumed keys, including UNKNOWN results. Sheets reads the record ID column before append. Adapter tests are under `apps/server/test/adapters/`.

**Built on another branch and not merged:** The executor and reporting loop still need to carry these keys through real operations. Provider support differs: Surge metadata is tracing, not provider dedupe, and Sheets has no atomic conditional append. Sheets serialization is per adapter instance, so the checked single-job lease remains necessary across processes. No real retry or duplicate external-action test is verified.

### 4. Payment data is always labeled sandbox and SQUARE_ENVIRONMENT must be sandbox

**Built and tested with fakes:** `apps/server/src/env.ts` refuses any non-sandbox setting. `apps/server/src/compose/providers.ts` constructs only `SquareEnvironment.Sandbox`. The Square adapter refuses other environments, and the policy engine refuses payment approval outside sandbox. Checkout and health responses in `apps/server/src/api/routes.ts` include sandbox labels. `orderRow` in `apps/server/src/adapters/sheets/index.ts` includes sandbox in reporting rows. Tests are `apps/server/test/compose/compose.test.ts`, `apps/server/test/adapters/square/square.test.ts`, `apps/server/test/policy/engine.test.ts` and `apps/server/test/adapters/sheets/index.test.ts`.

Square credentials and payment flows are not verified. These server checks do not establish that every payment screen has the required label. UI review remains not verified.

### 5. No success state is shown or stored before the provider confirms it

**Built and tested with fakes:** Square `createCheckout` requires link and order references and rereads the order to compare the approved amount and currency. `checkPayment` requires COMPLETED, matching payment ID, order ID, amount, currency and location. Calendar returns success only with an event ID or a recovered existing event. Sheets requires one confirmed appended row. Message SENT requires a recognized acknowledgment with a provider ID; SENT means accepted by the gateway, not delivered. Tests are the Square, Calendar, Sheets and message adapter tests under `apps/server/test/adapters/` and `apps/server/test/api/routes.test.ts`.

**Built and tested with fakes:** `private.finish_execution` requires a provider reference for an external step, and a sent dispatch with the same reference for a successful message step. Migration 0002 requires Square references for checkout states, a payment reference for paid states and a Google event reference for BOOKED_VERIFIED. These checks validate stored references, not the authenticity of provider responses.

**Built on another branch and not merged:** Payment reconciliation and executed provider steps are absent from the default composition. The runtime role can update orders and bookings directly, subject to constraints. It can store plausible reference strings. Provider-confirmed truth remains a server responsibility. Live success, UI success gating and the full paid-state path are not verified.

### 6. The deployed agent has only read and propose tools

**Built and tested with fakes:** `apps/server/src/tools/real/index.ts` asserts exactly seven registered tools and checks their effects at module load. It validates arguments, business context and the agent's capability allowlist. `apps/server/src/voice/relay.ts` filters session tools and rejects unknown or unauthorized capabilities. Agent specs may list write capabilities belonging to an approval bundle, but those capabilities never become model tools. Tests are `apps/server/test/tools/real-toolset.test.ts`, `apps/server/test/voice/relay.test.ts`, `apps/server/src/builder/registry.test.ts` and `apps/server/test/e2e/main-flow.test.ts`.

**Built on another branch and not merged:** The fixed voice worker is reported on `arsh/B-15-voice-worker`. An older worker is present here. Its fake tests and the OpenAI probe do not verify Twilio transport, spoken refusals or real tool selection during a call.

### 7. Caller text, uploaded files, menus and third-party API text are data, never instructions

**Built and tested with fakes:** The voice instructions in `apps/server/src/voice/prompt.ts` state this boundary. The real toolset enforces registered schemas and scopes outside model prose. Builder extraction sanitization is in `apps/server/src/builder/extraction/sanitize.ts`; builder runner refusals are in `apps/server/src/builder/runner/guardrails.ts`. Tests are `apps/server/test/voice/prompt.test.ts`, `apps/server/test/tools/real-toolset.test.ts`, `apps/server/src/builder/extraction/sanitize.test.ts` and `apps/server/src/builder/runner/text-runner.test.ts`. Sheets uses RAW input so text is not interpreted as a spreadsheet formula.

These are bounded controls. They do not prove that a model always refuses prompt injection or asks for genuine caller confirmation. The prompt instructs the model to get a yes before proposing; a tool invocation alone does not prove that a person said yes. Live adversarial coverage is not verified.

### 8. Never commit a secret or print one in a log, issue or pull request

**Built and tested with fakes:** `.gitignore` excludes environment and credential files with `.env.example` as the exception. `apps/server/src/env.ts` loads local configuration without copying values into these documents. `apps/server/src/app.ts` uses sanitized error envelopes. `apps/server/src/policy/activity.ts` validates event schemas, drops card and checkout URL fields and masks phone text. The real toolset masks message recipients in traces. Voice redaction removes configured secrets and key-like strings. Message and Google adapters suppress raw provider errors. Tests are `apps/server/test/policy/engine.test.ts`, `apps/server/test/voice/logic.test.ts`, `apps/server/test/voice/relay.test.ts` and adapter failure tests.

Ignored files and redaction are not a complete secret audit. No repository-wide history scan or hosted log audit is verified. Full recipients remain necessary in approved payloads and dispatch rows; names and other free text are not comprehensively anonymized. Do not print environment files, raw connection errors, tokens or provider bodies during setup.

## Database role and checked routines

**Verified against the real service:** The narrow Supabase permission checks in the evidence section passed. Other checks below have local test coverage, with fresh execution not verified in this checkout.

Migration 0004 creates `abos_app` with restricted attributes, removes role memberships and checks schema creation privileges. It initially creates a NOLOGIN role; an operator must provision login separately. `DATABASE_URL` is the runtime connection. `DATABASE_ADMIN_URL` is for migrations, seed and reset. `apps/server/src/db/index.ts` builds verified TLS using public roots plus a hash-pinned Supabase root certificate. It removes URL SSL options that could replace that configuration.

The runtime role has application-wide reads and selected ordinary writes. It has no direct writes on the four protected tables. Browser authenticated reads use owner-scoped RLS from migration 0002. Runtime RLS intentionally permits cross-business reads, so server authorization and query scope are essential. The database compares asserted owner IDs; it does not authenticate a human.

The checked SECURITY DEFINER entry points in migration 0004 use an empty search path and qualified objects. PUBLIC, anon and authenticated cannot execute them. Runtime grants cover `abos_app` and the legacy `service_role`.

- `private.create_approval` rebuilds material fields, checks the canonical payload and hash, validates subject bindings and enforces a future expiry within 11 minutes, allowing one minute of clock skew around the ten-minute server window.
- `private.decide_and_enqueue` locks the approval, checks owner, business, hash and deadline, records the decision and audit, and derives ordered step keys. Identical decisions reuse rows.
- `private.claim_execution` and `private.claim_next_execution` enforce approved bundles, predecessors, due time, three attempts and a worker lease. The first step revalidates subject material.
- `private.finish_execution` checks worker and attempt and requires provider references for external success.
- `private.record_dispatch` derives the approved recipient, channel, template and key. `private.update_dispatch` restricts outcome changes under the current execution lease.
- `private.enqueue_sheets_sync`, `private.claim_sync_job` and `private.finish_sync_job` bind an approved reporting action to a verified subject, derive its key, enforce five attempts and require a provider reference for DONE.
- `private.expire_approvals` expires pending approvals and updates subjects and audit using the database clock.

Migration 0002 supplies `public.approval_requests_guard`, `public.action_executions_match_approval`, `public.execution_claim_allowed`, `public.message_dispatches_guard`, `public.agent_versions_immutable` and `public.activity_events_append_only`. Migration 0004 adds `private.retain_identity`. ALWAYS triggers protect retained and immutable records. Relevant tests are `packages/db/test/direct-dml.test.ts`, `runtime.test.ts`, `runtime-hardening.test.ts`, `constraints.test.ts` and `rls.test.ts`.

## Known limits

**Not built:** A complete deployed security boundary and a rehearsed provider workflow are not established here. The executor and reconciliation are separate unmerged work. No lease timeout automatically reclaims a RUNNING step. A crashed worker can leave work stuck for review. Recovery endpoints are not wired in the core route implementation.

The database administrator can change guards and grants. Reset uses administrator TRUNCATE and bypasses row triggers. The legacy service role remains more privileged than `abos_app`. Do not give the running server the administrator connection.

Stream tokens are single-use and tied to CallSid but live in one process's memory. Approval HTTP replay caching also lives in process memory; the checked decision routine provides durable decision dedupe. Multi-process voice token handling and rejected-signature activity events are not built here. Real-service signature, replay, recovery, retention and complete redaction tests are not verified.
