# Implementation notes

## Evidence and status

This is an offline branch review for task S-06. docs/SPEC.md takes precedence over docs/PRD.md. docs/FEATURE-MATRIX.md maps all twenty acceptance criteria and twelve P0 items to implementation, tests and pending human work. No complete live acceptance flow is verified.

The four status categories are **built and tested with fakes**, **verified against the real service**, **built on another branch and not merged**, and **not built**. Fake status identifies implemented components with fake or local database tests, not a passing acceptance result. The fresh test run below failed. Uncertain behavior is not verified.

**Verified against the real service, as supplied for this task:** Four Supabase migrations were applied. The restricted runtime role can read and was denied direct writes on the four protected tables, disabling triggers, changing roles, creating tables and reading auth.users with error 42501. Seed data has one owner, two businesses, 33 facts and two agents with published versions. The seeded owner can sign in. An integration server read the real database and returned 200 for health, businesses, facts, approvals, integration health and live agent, and 401 without a token. OpenAI passed an 11-of-11 Realtime session probe on `gpt-realtime-2.1` and one strict structured-output builder call. Twilio SMS failed with error 30034. These are the entire real-service evidence set.

A phone call through Twilio to this worker, Square, Google Calendar and Sheets, WhatsApp sandbox, all message delivery and every deployed server remain not verified. Square sandbox keys are not available according to the task evidence.

## Architecture as built

**Built and tested with fakes:** `apps/server/src/index.ts` loads configuration, builds the Fastify application, listens and starts jobs. `apps/server/src/app.ts` registers correlation IDs, sanitized errors, CORS, authentication, core REST routes, simulated calls, the builder, conditional phone voice and provider webhook seams. One persistent Node server holds these components. The default port is 4000 and WEB_ORIGIN defaults to the local web origin. The Next.js client is in apps/web. This review does not establish that its screens are wired or rehearsed against this server.

`apps/server/src/compose/index.ts` is the composition root. It creates one database pool, JWT verifier, policy engine and provider set. `compose/ports.ts` connects database catalog, facts, order status, calls and live routing to the real toolset. Square supplies quotes and Calendar supplies availability through adapters. The sim-call endpoint uses a published version, stores a call with channel `test_console` and uses the same real read and propose tools. A fake provider in a test still makes the overall test fake even when a trace says `mocked: false`.

`compose/builder.ts` supplies database stores for builder sessions, agent drafts, chat draft facts, business knowledge and the live-agent reader. Builder interview and text runner services use strict schemas. With no OpenAI key, the builder and agent model can use recorded responses. This is a fallback and is not live model verification. Browser voice has a client-secret endpoint in `builder/voice/`; a real microphone session is not verified.

Extraction has size, type and content checks, CSV and spreadsheet parsing, structured extraction and conflict handling under `builder/extraction/`. The composition root does not inject its persistent file, upload fact, conflict, catalog or event stores. Those extraction stores default to memory and a fixture catalog. Upload persistence to Supabase Storage and database-wide conflict blocking are not verified. Existing session and draft database stores do not make the upload subsystem durable.

Provider adapters are `adapters/square`, `adapters/calendar`, `adapters/message` and `adapters/sheets`. Provider health reports configuration rather than a connectivity probe. Missing settings usually leave the provider unavailable. Android messaging is a concrete exception to that simple description: the adapter requires a gateway kind, and SMSGate also needs username and password. `compose/providers.ts` passes only its URL and API key. Selecting that channel is not a ready fallback and can fail construction.

**Built on another branch and not merged:** `arsh/B-11-executor`, `arsh/B-13-webhooks`, `arsh/B-15-voice-worker` and `arsh/B-30-telemetry` are reported pending integration. This branch contains an older voice plugin and relay with fake tests. It does not contain the fixed worker from the named branch. `compose/seams.ts` supplies a no-op executor and 503 provider webhook routes. It is not an executing integration.

## Database design

**Built and tested with fakes:** `packages/db/migrations/0001_extensions_and_helpers.sql` installs extensions and private helpers and closes default privileges. `0002_core_tables.sql` defines the 21 application tables, constraints, RLS and guards. `0003_realtime.sql` adds activity events to Supabase Realtime publication. `0004_runtime_role_and_routines.sql` adds the restricted runtime role, checked routines, leases and retention guards. The migration runner records checksums and uses an advisory lock. Schema application is in the supplied real-service evidence; a browser Realtime subscription is not verified.

The schema stores owners and businesses, verified and draft facts, catalog cache and conflicts, files and integrations, agent drafts and immutable versions, live routing, builder sessions, calls, orders and bookings, approvals, executions, dispatches, webhook events, reporting sync jobs and activity events. IDs are prefixed text. Money uses integer minor units and USD. Times use timestamptz and business time zones. Snake-case database rows map to camel-case contracts in `api/rows.ts`.

Approvals retain material payloads, canonical JSON, hashes, ordered bundles, expiry and decisions. Unique identities prevent duplicate pending approvals, provider records, dispatches and sync jobs. A booking exclusion constraint prevents overlaps for the locked and verified local booking states. Published versions are immutable and activity is append-only. Quote state is held in a toolset's memory until proposal storage. Verified facts are read once per real toolset so a running call keeps its snapshot.

`DATABASE_URL` is the restricted `abos_app` connection. `DATABASE_ADMIN_URL` is for operator migrations, seed and reset. The runtime role cannot directly mutate approvals, executions, dispatches or sync jobs. It can read across businesses and update orders, bookings and business ownership, so server scope, owner authentication and provider verification remain essential. SECURITY_NOTES.md names the checked routines and their limits.

**Not built:** The general pg-boss queue or fallback `jobs` table described in SPEC section 3.2 and DATA-MODEL section 7 is not present in these migrations or server dependencies. The current composition uses a 30-second interval for approval expiry. A full execution, payment poller and reporting scheduler is not wired here.

## Approval and execution flow

**Built and tested with fakes:** A real toolset validates a proposed cart against a quote it holds for that call. The Square adapter validates catalog IDs and calls CalculateOrder without creating an order. A changed or expired quote requires another quote and confirmation. Proposal policy stores the subject and pending approval in one transaction, pinned to the call's agent version. A caller who declines messages uses `qr_only` and has no recipient. Approvals last ten minutes and quotes last five minutes under SPEC section 2.9.

The owner decision route passes business ID, owner ID, decision and the displayed payload hash to `private.decide_and_enqueue`. The database locks, checks and decides atomically and derives keys. Rejection creates no executable steps. Approval queues the ordered non-Sheets steps. An order becomes APPROVED. A booking becomes RECHECKING_SLOT, which takes the local overlap lock. The QR-only message step is SKIPPED. Repeated identical decisions reuse the original rows and keys. The composition calls `executor.kick`, but its default executor performs no work.

The one implemented local execution path is `local.fact.update` in `policy/engine.ts`. It claims the approved step, checks the prior fact version and value, supersedes the old fact, inserts a new verified version, resolves conflicts and finishes with audit in a transaction. The edit targets the current verified fact, rather than a mutable draft. Tests cover existing calls keeping old hours and new calls reading new hours. The helper `createProposeFactFromChat` exists, but the builder plugin has no option that wires it into a real owner chat turn.

**Built on another branch and not merged:** After integration, the executor must claim a checked step before it calls any adapter and finish under the same worker and attempt. The intended pizza sequence is `square.checkout.create`, `message.checkout.send`, `local.order.record`, then deferred `sheets.order.append`. The intended booking sequence is `calendar.event.create`, `message.booking.confirm`, `local.booking.record`, then deferred `sheets.booking.append`. These sequences come from SPEC section 2.3 and are not a claim of executed behavior on this branch.

**Built and tested with fakes:** Square checkout creates the order through CreatePaymentLink, rereads totals and refuses mismatches. Calendar checks for an existing deterministic event and rechecks availability before insertion. Message dispatch uses a durable attempt gate and does not resend unknown outcomes. Sheets uses RAW append after reading record IDs and requires a confirmed row count. The database permits a Sheets job only for an approved reporting action on a paid order or verified booking. Neither a reporting loop nor payment reconciliation calls these components in the default server.

## Differences from the PRD

The following SPEC entries explain intended differences. Entries labeled P are proposals in SPEC section 1.2, not ratified decisions. Their presence is not permission to describe them as Arsh's decisions.

- **Built and tested with fakes:** P-11 places REST, voice, webhooks and jobs in one Node server instead of Next.js API routes plus a separate worker. The job seams remain incomplete.
- **Built and tested with fakes:** P-02 and SPEC section 4 use CalculateOrder for quotes and one CreatePaymentLink path for checkout. The real Square spike is not verified.
- **Built and tested with fakes:** P-03 uses OpenAI Realtime rather than GPT-Live. The session probe is verified against the real service. The phone and browser audio paths are not verified.
- **Built and tested with fakes:** D-08 and SPEC section 2.2 replace `sms.checkout.send` with `message.checkout.send`. D-11 records the Twilio upgrade and 30034 failure. The ladder is Surge, Android gateway, WhatsApp sandbox, then QR. The adapter selects one configured channel; it does not automatically try every channel after a send. Changing an approved channel requires a new proposal.
- **Built and tested with fakes:** P-06 uses one number and a live-agent switch. P-10 caches Square catalog data but keeps quotes authoritative. P-14 uses one owner and two businesses. P-15 uses a Google service account. Real routing, quotes and Google access are not verified.
- **Built and tested with fakes:** P-07 defines an asynchronous approval wait and ten-minute expiry. P-08 adds a booking confirmation message. P-09 reuses owner confirmation for fact edits. P-05 uses hours for the edit demo; Square price edits remain SHOULD scope. Booking message execution is not merged, and natural-language hours edit wiring is incomplete.
- **Built and tested with fakes:** P-18 separates mock preview `/api/agents/:id/test` from published `/api/agents/:id/sim-call` using real read and propose tools. It does not authorize external writes without owner approval.
- **Built and tested with fakes:** P-16 replaces a custom activity stream with Supabase Realtime publication and refetch. Publication migration is present; browser subscription behavior is not verified.
- **Built and tested with fakes:** D-10 places the server behind a restricted database role. SPEC section 2.9 allows QR-only customers without a recipient, superseding the older contradictory consent step in FLOWS.

Some gaps have no SPEC decision that declares them complete. Publish and pause routes are not implemented in `builder/agents.ts`; seeded immutable versions do not prove AC-04. Extraction still has in-memory defaults. The fact-edit helper is not connected to owner chat. The general queue is absent. Phone tokens are in memory rather than persisted against calls. These are open implementation gaps, not approved PRD reductions. D-09 retains every P0 item and all twenty criteria.

## Verification in this checkout

No network requests were made. Tests use ancestor node_modules because this worktree has no local installation. The ancestor `@abos/contracts/package.json` differs from this branch and lacks this branch's root fixtures export. Missing packages include `@fastify/cors` and `@electric-sql/pglite`. This dependency setup prevents a trustworthy passing branch verification.

- `npm test -- --maxWorkers=1` failed before tests with EPERM while Vite attempted to write its temporary config in ancestor node_modules.
- `npm test -- --maxWorkers=1 --configLoader=native --cache=false` reached Vitest but could not spawn fork workers, with EPERM. No tests ran in that attempt.
- `npm test -- --pool=threads --maxWorkers=1 --configLoader=native --cache=false` exited 1: 39 test files failed and 19 passed; 154 tests failed and 417 passed. Failures included missing packages, the ancestor fixtures export and undefined contract schemas. This is not a passing test result and does not establish that each failed assertion is a product defect.
- `npm run typecheck` exited 1 with missing contract exports and missing dependency declarations. No dependency installation or source fix was attempted because this task permits only four documentation files and has no network.

## Open items

**Built on another branch and not merged:** Integrate and review the executor, webhook reconciliation, fixed voice worker and telemetry branches. Recheck these documents against the merged composition before presenting a live demo.

**Not built on this branch:** Complete publish and pause behavior, durable extraction stores, owner chat to fact-confirmation wiring, the full reporting loop and recovery endpoints. B-20 has a Sheets adapter and checked sync routines, but no wired job runner. The deployment document `docs/DEPLOY.md` is absent. No deployment is verified.

**Not verified:** Repair the isolated worktree dependency setup and rerun typecheck and tests. Obtain Square sandbox keys and prove catalog, quote, checkout, payment and reconciliation. Prove Google availability, booking and Sheets reporting. Deliver a message through one approved channel. Make a real phone call and exercise hang-up, barge-in and injection refusal. Speak through browser voice. Review every dashboard success and sandbox label. Run three full rehearsals including failure and recovery, injection refusal and a changed menu price. Conduct the outside-owner pilot for AC-20 and record observed errors and resulting changes. DEMO_RUNBOOK.md remains DRAFT until those rehearsals are recorded.
