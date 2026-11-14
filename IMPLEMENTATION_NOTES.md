# Implementation notes

**Task:** S-06. **Written:** 2026-11-14. **Describes:** the code on branch `arsh/integration` at commit `7486c7e`.

An earlier version of this file described commit `1588eaa`. The integration branch then moved 20 commits, and this version was checked again against the new code.

This file describes the server as it is built on this branch, how the database is designed, how an approval becomes executed steps, where the build differs from `docs/PRD.md`, and what is still open. The PRD asks for unverified assumptions and blockers to be written here. They are in sections 6 and 7.

Status words are used as in `SECURITY_NOTES.md` section 1: built and tested with fakes, verified against the real service, or not built. The complete list of what has been verified against real services is in `SECURITY_NOTES.md` section 2. Test totals are in section 3 of that file.

## 1. Where things stand

- The wired server is on `arsh/integration` (draft pull request #97). It is not deployed.
- `main` is deployed on Render as `abos-server` and serves only the health route and the builder.
- The real database has migrations 0001 to 0004. This branch needs 0005 as well, and the 0005 file was rewritten after the list of real checks was made.
- `npm run typecheck` passes. All 1866 server and package tests pass with two workers. The default `npm test` run had 5 timeouts in database tests on a 4-core container.
- CI is red on `arsh/integration` and on this branch, at the `npm test` step. Details are in `SECURITY_NOTES.md` section 3.
- No phone call, paid payment link, webhook, message, price change, Calendar event or Sheets row has gone through this code against a real service.

## 2. Architecture as built

### 2.1 One Node server

The server is one Fastify process (`apps/server`), run directly from TypeScript with `tsx`. It holds the REST API, the provider webhooks, the phone WebSocket and the background jobs (SPEC proposal P-11). The Next.js app in `apps/web` has no API routes.

`apps/server/src/index.ts` loads `.env.local`, parses the environment, builds the app, listens, starts the jobs, and closes cleanly on `SIGTERM` and `SIGINT`. `parseEnv` in `apps/server/src/env.ts` refuses to start unless `SQUARE_ENVIRONMENT` is `sandbox`. Every other integration variable is optional at startup. A missing key turns its feature off and integration health reports it.

### 2.2 The composition root

`composeServer` in `apps/server/src/compose/index.ts` is the one place that builds real dependencies from the environment and connects each port to the piece that implements it. `buildApp` in `apps/server/src/app.ts` registers every route group with what the composition root made. Tests pass overrides (database, token verifier, providers, model, clock) through the same options.

| File in `apps/server/src/compose/` | What it wires |
|---|---|
| `index.ts` | The composition root: database pool, verifier, providers, policy engine, toolset factory, executor, webhooks, builder options, voice options, price proposals, recovery, human fallback, the decision bus, telemetry, jobs |
| `providers.ts` | Provider clients from the environment: Square sandbox, the Square price adapter, Google Calendar, Google Sheets, the message channel, the Twilio validator, the Twilio call update, the OpenAI socket factory. Each is undefined when its keys are missing |
| `ports.ts` | The ports the tools and the voice worker declared, implemented on Postgres, the engine and the adapters |
| `executor.ts` | The executor and the Sheets job runner on the database routines and the adapters |
| `webhooks.ts` | The webhooks plugin, payment reconciliation and stored-event recovery |
| `recovery.ts` | Order cancel and the resolution of a step that needs review, with provider reads as evidence |
| `builder.ts` | Postgres stores for the builder's sessions, draft agents, draft facts and business knowledge, and the fact proposal from a chat answer |
| `builder-publish.ts` | Postgres stores for published versions, the live-agent row and publish events, and the catalog sync at publish |
| `decisions.ts` | An in-process bus that tells a live call about the owner's decision |
| `fallback.ts` | Human fallback: the three conditions and the Twilio call update. Switched off by default |
| `health.ts` | Integration health: configuration plus cached read-only probes |
| `seams.ts` | The fail-closed defaults: an executor that runs nothing and webhook routes that answer 503 |

### 2.3 Ports and adapters

Each piece declares the interfaces it needs and imports no provider SDK outside its adapter.

| Piece | Path | Role |
|---|---|---|
| Approval engine | `apps/server/src/policy/` | Builds the approval payload, stores the subject, calls the database routines, and answers `authorizeStep` for the executor |
| Executor | `apps/server/src/executor/` | Claims one step at a time, runs its handler, classifies the result, and runs Sheets jobs |
| Adapters | `apps/server/src/adapters/square`, `message`, `calendar`, `sheets` | The only code that calls Square, a message channel or Google |
| Agent tools | `apps/server/src/tools/real`, `tools/mock` | Seven read and propose tools behind one handler interface, with a real and a mock implementation |
| Voice worker | `apps/server/src/voice/` | `POST /webhooks/twilio/voice`, the `/ws/phone` Media Stream socket, the relay to the OpenAI Realtime API, and the fallback router |
| Webhooks | `apps/server/src/webhooks/`, `apps/server/src/reconcile/` | Square and Twilio status webhooks and the payment poll |
| REST API | `apps/server/src/api/` | Owner routes, health, live agent, simulated call, price proposals, recovery |
| Auth | `apps/server/src/auth/verify.ts` | Supabase JWT verification and the route guard |
| Builder | `apps/server/src/builder/` | Interview, spec, mock test runner, publish and versions, extraction, owner voice secret. Registered as one plugin with its own auth seam |
| Telemetry | `apps/server/src/telemetry/` | `GET /api/telemetry` from an in-memory recorder and activity events |

Shared code is in two packages. `packages/contracts` holds the Zod schemas, the capability registry, the state machines, hashing and fixtures. `packages/db` holds the migrations, the migration runner, typed wrappers for the database routines, and the seed and reset logic.

### 2.4 Routes on this branch

Read from the running app with an empty environment. The auth column is the policy declared where the route is registered. `apps/server/test/e2e/route-auth.test.ts` checks that every `/api` route has one and that none is public.

| Auth | Routes |
|---|---|
| None | `GET /health` (with `?refresh=1` it also checks the database) |
| Provider signature | `POST /webhooks/square`, `POST /webhooks/twilio/status`, `POST /webhooks/twilio/voice`. The socket `/ws/phone` exists only when voice is configured and needs a valid stream token |
| Owner (Supabase JWT, business ownership checked) | `GET /api/businesses`, `GET` and `PATCH /api/businesses/:id`, `GET /api/businesses/:id/facts`, `POST /api/businesses/:id/facts/propose`, `GET /api/businesses/:id/catalog`, `POST /api/businesses/:id/catalog/sync`, `POST /api/businesses/:id/catalog/prices/propose`, `GET /api/approvals`, `GET /api/approvals/:id`, `POST /api/approvals/:id/decision`, `GET /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/checkout`, `POST /api/orders/:id/cancel`, `POST /api/executions/:id/resolve`, `GET /api/bookings`, `GET /api/bookings/:id`, `GET /api/calls`, `GET /api/calls/:id`, `GET /api/activity`, `GET /api/integrations/health`, `GET` and `PUT /api/live-agent`, `POST /api/agents/:id/sim-call`, `GET /api/telemetry` |
| Builder (the builder's own auth seam, filled with the same JWT check) | `POST /api/builder/sessions`, `GET /api/builder/sessions/:id`, `POST /api/builder/sessions/:id/messages`, `GET` and `POST /api/agents`, `GET /api/agents/:id`, `POST /api/agents/:id/preview`, `POST /api/agents/:id/test`, `POST /api/agents/:id/publish`, `POST /api/agents/:id/pause`, `GET /api/agents/:id/versions`, `POST /api/agents/:id/rollback`, `POST /api/businesses/:id/files`, `GET /api/files/:id`, `POST /api/conflicts/:id/resolve`, `POST /api/realtime/client-secret`, `GET /api/builder/ping` |

### 2.5 Background jobs

Jobs are timers inside the server process. The work they pick up is stored in Postgres. `pg-boss` is not a dependency.

| Job | Interval | Code |
|---|---|---|
| Executor steps and Sheets jobs | Every 2 seconds, and at once after an approval or a verified payment | `createDbExecutor` in `compose/executor.ts` |
| Approval expiry sweep | Every 30 seconds | `startJobs` in `compose/index.ts`, routine `private.expire_approvals` |
| Payment reconciliation poll | Every 30 seconds, for 15 minutes after a link is ready | `pollPendingPayments` in `reconcile/index.ts` |
| Stored webhook recovery | At start and every 2 minutes | `recoverNow` in `compose/webhooks.ts` |
| Stale step and stale Sheets job recovery | With the executor, for a step or job whose 15 minute lease ran out | routines `private.recover_stale_executions` and `private.recover_stale_sync_jobs` |

## 3. The database design

The database is Supabase Postgres. The SQL is in `packages/db/migrations/`.

| Migration | What it adds | Applied to the real database |
|---|---|---|
| `0001_extensions_and_helpers.sql` | Extensions, the `private` schema, closed default privileges, `gen_id` | Yes |
| `0002_core_tables.sql` | 21 tables, constraints, row-level security, guard triggers, indexes | Yes |
| `0003_realtime.sql` | `activity_events` in the Supabase Realtime publication | Yes |
| `0004_runtime_role_and_routines.sql` | The restricted role `abos_app` and the checked routines | Yes |
| `0005_payments_and_stale_leases.sql` | The table `payment_receipts`, guard triggers on `orders` and `bookings`, worker leases, checkout, payment, booking, fact and recovery routines, `agents.spec_revision`, `orders.link_ready_at` | No, as of the list of real checks |

There are 22 tables: the PRD's seventeen, plus `catalog_items`, `message_dispatches`, `live_agent` and `fact_conflicts` (SPEC 2.7), plus `payment_receipts` (0005). The migration runner adds `schema_migrations`.

Design points:

- **IDs** are text with a type prefix, for example `ord_` and `apv_` (SPEC 2.1).
- **Three kinds of database user.** A signed-in owner (`authenticated`) can only read rows of a business they own, through row-level security. The server (`abos_app`) reads everything and writes ordinary tables, but can change approvals, executions, dispatches and sync jobs only through routines. The table owner runs migrations, seed and reset.
- **The approval row carries its own proof.** It stores the payload, the canonical JSON text, and the SHA-256 hash of that text. A check constraint ties the hash to the text.
- **Invariants are in the database**, so they hold whatever the server does: one pending approval per subject, one-use approvals, executions only for approved bundles and only in bundle order, immutable idempotency keys, dispatch recipient equal to the approved recipient, no deleting executions, dispatches, sync jobs or approvals, append-only activity events and payment receipts, immutable published agent versions, no overlapping bookings on one calendar, and unique Square and Google references.
- **Orders and bookings are guarded.** The server may still update them, but a trigger checks every server write against the state machine. Paid and booked states, payment IDs, Google event IDs and stored checkout references can be written only by a routine.
- **A worker holds a lease.** A claim gives 15 minutes. A step whose lease ran out goes to review.
- **The Sheets step has no execution row.** A sync job is created when the subject becomes verified (SPEC 2.9).

The role and routine list is in `SECURITY_NOTES.md` section 5. The typed wrappers are in `packages/db/src/runtime.ts`.

## 4. How an approval becomes executed steps

This is the pizza order. The booking follows the same path with its own steps.

1. **Quote.** The agent calls `quote_order`. `squareQuotePort` in `compose/ports.ts` checks availability in `catalog_items` and calls Square CalculateOrder through the adapter. The quote lives in server memory for 5 minutes and can be used for one proposal.
2. **Propose.** The agent calls `propose_order`. The toolset stores the proposal with channel `qr_only` and no recipient, whatever the model sends. `createOrderProposal` in `policy/engine.ts` then, in one transaction, checks that the call is still in progress and pinned to the agent version, checks the cart hash against the quote, inserts the `orders` row as `AWAITING_OWNER_APPROVAL`, and calls `private.create_approval`. The payload holds exactly the material fields of SPEC 2.9. The expiry is 10 minutes from the database clock. No provider is called.
3. **Decide.** The owner sends `POST /api/approvals/:id/decision` with the payload hash the screen showed. The route guard has already checked the JWT and the business. `decide` calls `private.decide_and_enqueue`, which locks the approval, checks owner, hash and expiry, marks it `APPROVED`, moves the order to `APPROVED`, writes the activity events, and inserts one `action_executions` row per step except the Sheets step. Each row gets its idempotency key there. When the approved channel is `qr_only` the message step is inserted as `SKIPPED`. A repeat of the same decision changes nothing and returns the same approval.
4. **Tell the call and kick.** The route tells the executor to look for work, and publishes the decision to the call if it is still live. The agent then says the order was approved. It never says a message was sent.
5. **Claim.** `private.claim_execution` gives one `QUEUED` step to one worker with a 15 minute lease, only if the earlier steps are finished and the subject still matches the approval. Claiming the checkout step moves the order to `CREATING_CHECKOUT`.
6. **Authorize.** `authorizeStep` re-reads the approval, checks its state, its hash, the step's position, the capability's effect in the registry table, the sandbox setting and the idempotency key. A refusal writes `guardrail.refused`.
7. **`square.checkout.create`.** The handler authorizes again and calls Square CreatePaymentLink once with the row's key and automatic taxes. The adapter reads the Square order and compares its total with the approved total. On a match `private.save_checkout` stores the references and moves the order to `PAYMENT_LINK_READY`. On a mismatch the step fails and the order becomes `RECOVERY_REQUIRED`. On a timeout the step becomes `NEEDS_REVIEW` and nothing is created again.
8. **`message.checkout.send`.** For an order from a call this step is already `SKIPPED`. When an approval does name a channel, `private.record_dispatch` inserts the one dispatch row with the recipient and channel from the approval, and the adapter sends once. A failed, unknown or unavailable send never stops the bundle.
9. **`local.order.record`.** The order becomes `PAYMENT_PENDING`.
10. **Payment.** A verified Square webhook, or the poll, reads the payment from Square. If it is `COMPLETED`, not refunded, and matches the order ID, amount, currency and location, `private.mark_order_paid` checks the observation again, writes the receipt, sets `PAID_VERIFIED`, and creates the Sheets sync job. `private.fulfill_order` then moves the order to `FULFILLMENT_READY`.
11. **Sheets.** The job runner claims the sync job through `private.claim_sync_job`, checks the record ID column, appends one row, and finishes the job. A failure retries up to 5 times and never changes the order.

A retryable step failure goes back to `QUEUED` up to 3 attempts with a delay that doubles from 1 second.

**When a step needs review.** The owner can call `POST /api/executions/:id/resolve` with `retry` or `abandon`. The server reads the provider first. If the read proves the effect exists, the step is completed with what was found. If it proves nothing was written, the step is requeued or abandoned. If the read is unsure, the request is refused. `POST /api/orders/:id/cancel` cancels an order that has no step running.

**The booking bundle.** `calendar.event.create` re-reads free/busy, looks for an event whose ID is the step's key, and inserts one event with no attendees and no notifications. `private.verify_booking` then stores the event ID, moves the booking to `BOOKED_VERIFIED` and creates the Sheets job, in that same step. `message.booking.confirm` and `local.booking.record` follow. A busy slot ends in `SLOT_CONFLICT` with up to 3 alternatives and no event.

**The fact edit.** `decide` runs `local.fact.update` in the same request through `private.apply_fact_update`. It supersedes the old verified fact and inserts the next version, or promotes a new-key draft to verified version 1.

**The price change.** `POST /api/businesses/:id/catalog/prices/propose` reads Square's current price and stores a pending `price_edit` approval. After the owner approves, `square.catalog.price.update` writes the price for the configured location with the row's key, and `local.catalog.sync` refreshes `catalog_items`.

End-to-end tests of these paths, with fakes: `apps/server/test/e2e/main-flow.test.ts`, `apps/server/test/e2e/flows.test.ts` and `apps/server/test/e2e/routines.test.ts`.

## 5. Deviations from the PRD

Each row names the SPEC decision or ruling that covers the change. `docs/SPEC.md` wins over the PRD.

| PRD says | As built | Covered by |
|---|---|---|
| The checkout link goes by Twilio SMS (`sms.checkout.send`, state `SMS_SENT`) | A channel-agnostic message adapter with channels `surge`, `android_gateway`, `whatsapp_sandbox` and `qr_only`. The capability is `message.checkout.send` and the state is `MESSAGE_SENT`. Twilio SMS failed with error 30034 | D-08, D-11, SPEC 2.2, 2.4 |
| Effects are `read`, `write`, `external_message` | A fourth effect, `propose`, writes only our database and opens an approval | SPEC 2.2 |
| No endpoint named for the pre-approval quote | Square CalculateOrder, through the tool `quote_order` | P-02 |
| "Realtime/live voice endpoint" | OpenAI Realtime API (`gpt-realtime-2.1`) over Twilio Media Streams, relayed by this server | P-03 |
| The live edit demo changes an item price | The live edit changes opening hours. The price change is a SHOULD item. It is now built and tested with fakes | P-05 |
| One number, two agents | One number and a live-agent switch (`PUT /api/live-agent`) | P-06 |
| Approval wait and expiry undefined | A wait script in the prompt and a 10 minute expiry | P-07 |
| The booking flow never tells the customer | A confirmation message step in the booking bundle | P-08 |
| Fact writes "require approval" | An owner confirmation that reuses the approval table with `actorType` `owner` | P-09 |
| "Knowledge snapshot" undefined | A `catalog_items` cache of the Square catalog, and a fact snapshot taken once per call | P-10, FLOWS B2 |
| API routes plus a separate worker, and a durable job queue such as pg-boss | One Node server. Timers in the process poll work stored in Postgres tables. No pg-boss | P-11. SPEC 3.2 names pg-boss or a polled table. The in-process timers are this build's choice |
| `GET /api/activity/stream` (server-sent events) | No stream route. The server writes `activity_events` and the web app listens through Supabase Realtime | P-16 |
| Only a mock preview | The mock test (`POST /api/agents/:id/test`) and a simulated call with the real read and propose tools (`POST /api/agents/:id/sim-call`) | P-18 |
| Stuck states have no way out | Owner recovery routes: cancel, and resolve with retry or abandon | P-19 |
| The second agent is a salon agent (an assumption) | A barbershop booking agent | D-03 |
| The server uses one database login | A restricted login `abos_app` and checked routines | D-10 |
| Pre-approval order states on the order | They are the call's `stage`. The order row is created by the propose tool already in `AWAITING_OWNER_APPROVAL` | SPEC 2.4 |
| The Sheets step is part of the executed bundle | It is authorized by the approval and runs as a sync job after the subject is verified | SPEC 2.3, 2.9 |
| `PATCH /api/businesses/:id` updates the profile through an approval | It changes name, contact and settings only. Facts change through `facts/propose` | SPEC 2.8 |
| "Preconnected test credentials" for Google | One service account, with the calendar and sheet shared to it | P-15 |
| Encrypt integration credentials | Credentials are environment variables on the host. Nothing is stored in our tables | SPEC 3.3 |
| Raw transcripts short-lived or redacted | No audio and no transcript is stored | FLOWS section 9 |

Differences from the SPEC and `docs/FLOWS.md` themselves that no ratified decision covers yet. These are open items, not rulings.

| SPEC or FLOWS says | As built on this branch |
|---|---|
| The agent asks for a number and for consent, and the link goes by message (FLOWS B11, B12, B21) | The agent collects no number. Every proposal from a call is `qr_only`, because the server has no trusted evidence of the caller's consent (`apps/server/src/voice/NOTES.md` item 3). The link is shown as a QR code |
| Pause stops the agent (FLOWS A18) | Pause answers 200 but the `agents` row stays `live`. The store in `compose/builder.ts` writes only the draft fields. I ran it against the test database |
| Publish writes a version and sets `agents.active_version_id` (FLOWS A15) | The version and the live-agent row are written to Postgres. The `agents` row's state and active version are not written by that store. Not verified end to end by me |
| Publish stops when a required integration is unreachable (FLOWS, builder stop condition 4) | Publish reads the last stored health. A configured provider reads as disconnected until a check with `refresh=1` has run. A message channel other than `qr_only` has no check at all, so with `surge` or `whatsapp_sandbox` set, an agent with a message capability cannot be published |
| Uploads save files, draft facts and conflicts (FLOWS A8 to A10) | The extraction stores are in server memory, because `compose/index.ts` passes no `extraction` option |
| The executor re-checks item availability before CreatePaymentLink (FLOWS B18) | Not built. Availability is checked at quote time |
| The agent ends the call after its goodbye (FLOWS 3.1) | The relay needs a trusted finish signal that the composition root does not pass. Calls end on hang-up or on a time limit |
| Human fallback is a SHOULD item with no stated approval rule | Built and switched off. The rule that it needs no per-call approval is a proposal waiting for the owner. SPEC 2.9 has four more rows marked "proposed, waiting for Arsh to ratify" that the code already follows |
| `webhook.rejected` is written against the integration owner from `integrations` (SPEC 2.9) | Square: the business with the most catalog rows. Twilio: the business that holds the number in `live_agent` |
| The Square signature is checked over `SQUARE_WEBHOOK_URL` (FLOWS B25) | It is checked over `PUBLIC_SERVER_URL` plus `/webhooks/square` |
| The decision replay is kept for 24 hours (API.md) | It is kept for 24 hours in server memory and is lost on restart |
| A fallback of CreateOrder plus CreatePayment if a link cannot be paid (SPEC 4) | Not built |
| A WhatsApp delivery receipt updates the dispatch (SPEC 2.8) | The receipt is verified and stored, and the dispatch is not updated |
| `MESSAGE_CHANNEL` may be `android_gateway` (D-08) | With that value the provider setup throws "Missing or invalid setting: ANDROID_GATEWAY_KIND", because `compose/providers.ts` does not pass a gateway kind. I ran `buildProviders` with placeholder values to confirm it. `surge`, `whatsapp_sandbox` and `qr_only` build |
| The server runs on Node 24 (SPEC 3.2) | `package.json` allows Node 22 or later. I ran the tests on Node 22.23.4 |

## 6. Unverified assumptions

Each of these is built on what the vendor documentation or a spike says, and has not been proven end to end.

- A Square sandbox payment link can be paid with the test card, and Square then sends `payment.created` or `payment.updated`.
- The Square webhook signature header is base64.
- Square reports a final failed payment with status `FAILED` or `CANCELED`.
- The Square order read returns the payment in `tenders` soon enough for the poll. Otherwise the poll lists recent payments for the location.
- A Square catalog price write for one location: its idempotency key limit, whether a read right after the write sees it, and how its errors should be classed. `apps/server/src/api/prices/NOTES.md` lists these as not established.
- Twilio's signature validates against `PUBLIC_SERVER_URL` plus the path when the server is behind Render's proxy.
- The Twilio Media Stream fields the relay reads, barge-in by voice, and that closing the stream ends the call. `apps/server/src/voice/NOTES.md` lists the OpenAI events that the probe did not cover.
- A Twilio call update with inline TwiML can move a live Media Stream call to a person. `apps/server/src/voice/fallback/NOTES.md` lists what is unproven.
- A Google Calendar event can be inserted with our key as its ID, and a 409 means it exists.
- A Sheets append to tabs named `Orders` and `Bookings` works with the service account.
- The Square subscription calls in `npm run register-webhooks` match the real API. `docs/DEPLOY.md` says they were not run against a real account.
- The message channel variables `TWILIO_WHATSAPP_FROM`, `ANDROID_GATEWAY_KIND`, `ANDROID_GATEWAY_USERNAME`, `ANDROID_GATEWAY_PASSWORD`, `SURGE_BASE_URL` and `SURGE_LINK_SHORTENING` appear in adapter or spike code. `apps/server/src/env.ts` does not read them, so setting them has no effect on the server.

## 7. Open items

In the order I would do them.

1. **Apply migration 0005** to the real database. Without it the executor, payment marking, recovery, fact edits and saving a builder draft agent fail.
2. **Deploy the integration branch** and repeat the read-only smoke check against it.
3. **Register the Square and Twilio webhooks** at the deployed address (`npm run register-webhooks`) and put the Square signature key on the host.
4. **Place a real phone call** to the voice worker. This is the largest unproven piece.
5. **Pay a sandbox link** on a second device and confirm the webhook, the reconciliation and the paid state.
6. **Create Google credentials**, share the demo calendar and sheet, and run one booking and one export. The pizza agent cannot be published until Google Sheets is connected.
7. **Make pause real.** Write `agents.state` and `agents.active_version_id` from the publish and pause routes, and add a test for the Postgres publish stores. No test covers `compose/builder-publish.ts` today.
8. **Decide the message question.** Either ratify "QR code only" for the demo, or build the trusted consent evidence the voice notes describe. The `android_gateway` channel also needs a code change before it can be chosen.
9. **Rule on human fallback** and on the four SPEC 2.9 rows still marked proposed.
10. **Wire the extraction stores to Postgres**, and pass the call finish signal to the voice plugin.
11. **Add a routine for `webhook_events.processed_at`.**
12. **Raise the test and hook timeouts or lower the worker count** for the database tests, so `npm test` is stable on small machines and CI can go green. Look at the fallback regression test that failed once in CI with a 10 millisecond deadline.
13. **Look at the one failing web test**, `VoiceControl.test.tsx`.
14. **Run the three rehearsals and the outside owner test** (AC-20). Neither has happened.

## 8. Commands

| Command | What it does |
|---|---|
| `npm install` | Install all workspaces |
| `npm run typecheck` | Typecheck every workspace |
| `npm test` | Server and package tests |
| `npm test -w @abos/web` | Web unit tests |
| `npm run check-env` | Show which variables are set, by name only |
| `npm run dev:server` | Run the server with reload |
| `npm run migrate -w @abos/db` | Apply new migrations. The runner reads `DATABASE_URL`, which for this one command must hold the owner connection |
| `npm run seed`, `npm run seed:square` | Seed the owner and demo data. Seed the Square sandbox catalog |
| `npm run reset -- --yes` | Clear run data and reseed |
| `npm run register-webhooks` | Dry run: show what would change on the Twilio number and the Square sandbox subscription. Add `-- --apply` to change them |
