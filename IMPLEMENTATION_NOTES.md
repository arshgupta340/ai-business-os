# Implementation notes

**Task:** S-06. **Written:** 2026-11-14. **Describes:** the code on branch `arsh/integration` at commit `1588eaa`.

This file describes the server as it is built on this branch, how the database is designed, how an approval becomes executed steps, where the build differs from `docs/PRD.md`, and what is still open. The PRD asks for unverified assumptions and blockers to be written here. They are in sections 6 and 7.

Status words are used as in `SECURITY_NOTES.md` section 1: built and tested with fakes, verified against the real service, or not built. The complete list of what has been verified against real services is in `SECURITY_NOTES.md` section 2. Test totals are in section 3 of that file.

## 1. Where things stand

- The wired server is on `arsh/integration` (draft pull request #97). It is not deployed.
- `main` is deployed on Render as `abos-server` and serves only the health route and the builder.
- The real database has migrations 0001 to 0004. This branch needs 0005 as well.
- `npm run typecheck` passes. All 1558 server and package tests pass with two workers. The default `npm test` run had 4 and then 5 timeouts in database tests on a 4-core container.
- CI is red on this branch's base commit and on this branch, at the `npm test` step, with timeouts in the database tests' setup hooks. Details are in `SECURITY_NOTES.md` section 3.
- No phone call, paid payment link, webhook, message, Calendar event or Sheets row has gone through this code against a real service.

## 2. Architecture as built

### 2.1 One Node server

The server is one Fastify process (`apps/server`), run directly from TypeScript with `tsx`. It holds the REST API, the provider webhooks, the phone WebSocket and the background jobs (SPEC proposal P-11). The Next.js app in `apps/web` has no API routes.

`apps/server/src/index.ts` loads `.env.local`, parses the environment, builds the app, listens, starts the jobs, and closes cleanly on `SIGTERM` and `SIGINT`. `parseEnv` in `apps/server/src/env.ts` refuses to start unless `SQUARE_ENVIRONMENT` is `sandbox`. Every other integration variable is optional at startup. A missing key turns its feature off and integration health reports it.

### 2.2 The composition root

`composeServer` in `apps/server/src/compose/index.ts` is the one place that builds real dependencies from the environment and connects each port to the piece that implements it. `buildApp` in `apps/server/src/app.ts` registers every route group with what the composition root made. Tests pass overrides (database, token verifier, providers, model, clock) through the same options.

| File in `apps/server/src/compose/` | What it wires |
|---|---|
| `index.ts` | The composition root: database pool, verifier, providers, policy engine, toolset factory, executor, webhooks, builder options, voice options, telemetry, jobs |
| `providers.ts` | Provider clients from the environment: Square sandbox, Google Calendar, Google Sheets, the message channel, the Twilio validator, the OpenAI socket factory. Each is undefined when its keys are missing |
| `ports.ts` | The ports the tools and the voice worker declared, implemented on Postgres, the engine and the adapters |
| `executor.ts` | The executor and the Sheets job runner on the database routines and the adapters |
| `webhooks.ts` | The webhooks plugin, payment reconciliation and stored-event recovery |
| `interim-db.ts` | Database writes behind one port: the 0005 routines, and two writes that still have no routine |
| `builder.ts` | Postgres stores for the builder's sessions, draft agents, draft facts and business knowledge |
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
| Voice worker | `apps/server/src/voice/` | `POST /webhooks/twilio/voice`, the `/ws/phone` Media Stream socket, and the relay to the OpenAI Realtime API |
| Webhooks | `apps/server/src/webhooks/`, `apps/server/src/reconcile/` | Square and Twilio status webhooks and the payment poll |
| REST API | `apps/server/src/api/` | Owner routes, health, live agent, simulated call |
| Auth | `apps/server/src/auth/verify.ts` | Supabase JWT verification and the route guard |
| Builder | `apps/server/src/builder/` | Interview, spec, mock test runner, publish and versions, extraction, owner voice secret. Registered as one plugin with its own auth seam |
| Telemetry | `apps/server/src/telemetry/` | `GET /api/telemetry` from an in-memory recorder and activity events |

Shared code is in two packages. `packages/contracts` holds the Zod schemas, the capability registry, the state machines, hashing and fixtures. `packages/db` holds the migrations, the migration runner, typed wrappers for the database routines, and the seed and reset logic.

### 2.4 Routes on this branch

Read from the running app with an empty environment. The auth column is the policy declared where the route is registered. `apps/server/test/e2e/route-auth.test.ts` checks that every `/api` route has one and that none is public.

| Auth | Routes |
|---|---|
| None | `GET /health` |
| Provider signature | `POST /webhooks/square`, `POST /webhooks/twilio/status`, `POST /webhooks/twilio/voice`. The socket `/ws/phone` exists only when voice is configured and needs a valid stream token |
| Owner (Supabase JWT, business ownership checked) | `GET /api/businesses`, `GET` and `PATCH /api/businesses/:id`, `GET /api/businesses/:id/facts`, `POST /api/businesses/:id/facts/propose`, `GET /api/businesses/:id/catalog`, `POST /api/businesses/:id/catalog/sync`, `GET /api/approvals`, `GET /api/approvals/:id`, `POST /api/approvals/:id/decision`, `GET /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/checkout`, `GET /api/bookings`, `GET /api/bookings/:id`, `GET /api/calls`, `GET /api/calls/:id`, `GET /api/activity`, `GET /api/integrations/health`, `GET` and `PUT /api/live-agent`, `POST /api/agents/:id/sim-call`, `GET /api/telemetry` |
| Builder (the builder's own auth seam, filled with the same JWT check) | `POST /api/builder/sessions`, `GET /api/builder/sessions/:id`, `POST /api/builder/sessions/:id/messages`, `GET` and `POST /api/agents`, `GET /api/agents/:id`, `POST /api/agents/:id/preview`, `POST /api/agents/:id/test`, `POST /api/agents/:id/publish`, `POST /api/agents/:id/pause`, `GET /api/agents/:id/versions`, `POST /api/agents/:id/rollback`, `POST /api/businesses/:id/files`, `GET /api/files/:id`, `POST /api/conflicts/:id/resolve`, `POST /api/realtime/client-secret`, `GET /api/builder/ping` |

Routes in `docs/API.md` that are not on this branch: `POST /api/businesses/:id/catalog/prices/propose`, `POST /api/orders/:id/cancel`, `POST /api/executions/:id/resolve`.

### 2.5 Background jobs

Jobs are timers inside the server process. The work they pick up is stored in Postgres. `pg-boss` is not a dependency.

| Job | Interval | Code |
|---|---|---|
| Executor steps and Sheets jobs | Every 2 seconds, and at once after an approval or a verified payment | `createDbExecutor` in `compose/executor.ts` |
| Approval expiry sweep | Every 30 seconds | `startJobs` in `compose/index.ts`, routine `private.expire_approvals` |
| Payment reconciliation poll | Every 30 seconds, for 15 minutes after a link is ready | `pollPendingPayments` in `reconcile/index.ts` |
| Stored webhook recovery | At start and every 2 minutes | `recoverNow` in `compose/webhooks.ts` |
| Stale step recovery | Before each executor tick, for steps `RUNNING` longer than 15 minutes | `recoverStale` in `executor/index.ts`, routine `private.recover_stale_executions` |

## 3. The database design

The database is Supabase Postgres. The SQL is in `packages/db/migrations/`.

| Migration | What it adds | Applied to the real database |
|---|---|---|
| `0001_extensions_and_helpers.sql` | Extensions, the `private` schema, closed default privileges, `gen_id` | Yes |
| `0002_core_tables.sql` | 21 tables, constraints, row-level security, guard triggers, indexes | Yes |
| `0003_realtime.sql` | `activity_events` in the Supabase Realtime publication | Yes |
| `0004_runtime_role_and_routines.sql` | The restricted role `abos_app` and the checked routines | Yes |
| `0005_payments_and_stale_leases.sql` | `agents.spec_revision`, unique `orders.square_payment_id`, payment outcome routines, stale lease recovery | No |

The 21 tables are the PRD's seventeen plus `catalog_items`, `message_dispatches`, `live_agent` and `fact_conflicts` (SPEC 2.7). The migration runner adds `schema_migrations`.

Design points:

- **IDs** are text with a type prefix, for example `ord_` and `apv_` (SPEC 2.1).
- **Three kinds of database user.** A signed-in owner (`authenticated`) can only read rows of a business they own, through row-level security. The server (`abos_app`) reads everything and writes ordinary tables, but can change approvals, executions, dispatches and sync jobs only through routines. The table owner runs migrations, seed and reset.
- **The approval row carries its own proof.** It stores the payload, the canonical JSON text, and the SHA-256 hash of that text. A check constraint ties the hash to the text.
- **Invariants are in the database**, so they hold whatever the server does: one pending approval per subject, one-use approvals, executions only for approved bundles and only in bundle order, immutable idempotency keys, dispatch recipient equal to the approved recipient, no deleting executions, dispatches, sync jobs or approvals, append-only activity events, immutable published agent versions, no overlapping bookings on one calendar, and unique Square and Google references.
- **Orders and bookings are ordinary tables** the server may update. Their status moves are checked in the server against the contract state machine. Table constraints require Square references for link states, a payment ID for paid states, and a Google event ID for a verified booking.
- **The Sheets step has no execution row.** A sync job is created when the subject becomes verified (SPEC 2.9).

The role and routine list is in `SECURITY_NOTES.md` section 5. The typed wrappers are in `packages/db/src/runtime.ts`.

## 4. How an approval becomes executed steps

This is the pizza order. The booking follows the same path with its own steps.

1. **Quote.** The agent calls `quote_order`. `squareQuotePort` in `compose/ports.ts` checks availability in `catalog_items` and calls Square CalculateOrder through the adapter. The quote lives in server memory for 5 minutes.
2. **Propose.** The agent calls `propose_order`. For a caller who consented to a message, the tool wants the recipient presented once and confirmed again at least 3 seconds later. `createOrderProposal` in `policy/engine.ts` then, in one transaction, checks the call and its pinned agent version, checks the cart hash against the quote, inserts the `orders` row as `AWAITING_OWNER_APPROVAL`, and calls `private.create_approval`. The payload holds exactly the material fields of SPEC 2.9. The expiry is 10 minutes from the database clock. No provider is called.
3. **Decide.** The owner sends `POST /api/approvals/:id/decision` with the payload hash the screen showed. The route guard has already checked the JWT and the business. `decide` calls `private.decide_and_enqueue`, which locks the approval, checks owner, hash and expiry, marks it `APPROVED`, moves the order to `APPROVED`, writes the activity events, and inserts one `action_executions` row per step except the Sheets step. Each row gets its idempotency key there. When the approved channel is `qr_only` the message step is inserted as `SKIPPED`. A repeat of the same decision changes nothing and returns the same approval.
4. **Kick.** The route tells the executor to look for work.
5. **Claim.** `private.claim_next_execution` gives one `QUEUED` step to one worker, only if the earlier steps are finished and the subject still matches the approval.
6. **Authorize.** `authorizeStep` re-reads the approval, checks its state, its hash, the step's position, the capability's effect in the registry table, the sandbox setting and the idempotency key. A refusal writes `guardrail.refused`.
7. **`square.checkout.create`.** The handler moves the order to `CREATING_CHECKOUT`, authorizes again, and calls Square CreatePaymentLink once with the row's key and automatic taxes. It saves the Square order ID and link ID at once. The adapter reads the Square order and compares its total with the approved total. On a match the URL is stored and the order becomes `PAYMENT_LINK_READY`. On a mismatch the step fails and the order becomes `RECOVERY_REQUIRED`. On a timeout the step becomes `NEEDS_REVIEW` and nothing is created again.
8. **`message.checkout.send`.** `private.record_dispatch` inserts the one dispatch row with the recipient and channel from the approval. The adapter sends once. A failed, unknown or unavailable send never stops the bundle. On `SENT` the order becomes `MESSAGE_SENT`.
9. **`local.order.record`.** The order becomes `PAYMENT_PENDING`.
10. **Payment.** A verified Square webhook, or the poll, reads the payment from Square. If it is `COMPLETED`, not refunded, and matches the order ID, amount, currency and location, `private.mark_order_paid` writes `PAID_VERIFIED`, the payment ID, the events and the Sheets sync job in one transaction. The server then moves the order to `FULFILLMENT_READY`.
11. **Sheets.** The job runner claims the sync job through `private.claim_sync_job`, checks the record ID column, appends one row, and finishes the job. A failure retries up to 5 times and never changes the order.

Every step result is written with `private.finish_execution` in the same transaction as the order or booking change. A retryable failure goes back to `QUEUED` up to 3 attempts with a delay that doubles from 1 second.

The booking bundle: `calendar.event.create` re-reads free/busy, looks for an event whose ID is the step's key, and inserts one event with no attendees and no notifications. Then `message.booking.confirm`, then `local.booking.record`, which moves the booking to `BOOKED_VERIFIED` and creates the Sheets job. A busy slot ends in `SLOT_CONFLICT` with up to 3 alternatives and no event.

The fact edit: `decide` runs `local.fact.update` in the same request. It supersedes the old verified fact and inserts the new version.

End-to-end tests of these paths, with fakes: `apps/server/test/e2e/main-flow.test.ts` and `apps/server/test/e2e/flows.test.ts`.

## 5. Deviations from the PRD

Each row names the SPEC decision or ruling that covers the change. `docs/SPEC.md` wins over the PRD.

| PRD says | As built | Covered by |
|---|---|---|
| The checkout link goes by Twilio SMS (`sms.checkout.send`, state `SMS_SENT`) | A channel-agnostic message adapter with channels `surge`, `android_gateway`, `whatsapp_sandbox` and `qr_only`. The capability is `message.checkout.send` and the state is `MESSAGE_SENT`. Twilio SMS failed with error 30034 | D-08, D-11, SPEC 2.2, 2.4 |
| Effects are `read`, `write`, `external_message` | A fourth effect, `propose`, writes only our database and opens an approval | SPEC 2.2 |
| No endpoint named for the pre-approval quote | Square CalculateOrder, through the tool `quote_order` | P-02 |
| "Realtime/live voice endpoint" | OpenAI Realtime API (`gpt-realtime-2.1`) over Twilio Media Streams, relayed by this server | P-03 |
| The live edit demo changes an item price | The live edit changes opening hours. The price change is a SHOULD item and is not built on this branch | P-05 |
| One number, two agents | One number and a live-agent switch (`PUT /api/live-agent`) | P-06 |
| Approval wait and expiry undefined | A wait script in the prompt and a 10 minute expiry | P-07 |
| The booking flow never tells the customer | A confirmation message step in the booking bundle | P-08 |
| Fact writes "require approval" | An owner confirmation that reuses the approval table with `actorType` `owner` | P-09 |
| "Knowledge snapshot" undefined | A `catalog_items` cache of the Square catalog, and a fact snapshot taken once per call | P-10, FLOWS B2 |
| API routes plus a separate worker, and a durable job queue such as pg-boss | One Node server. Timers in the process poll work stored in Postgres tables. No pg-boss | P-11. SPEC 3.2 names pg-boss or a polled table. The in-process timers are this build's choice |
| `GET /api/activity/stream` (server-sent events) | No stream route. The server writes `activity_events` and the web app listens through Supabase Realtime | P-16 |
| Only a mock preview | The mock test (`POST /api/agents/:id/test`) and a simulated call with the real read and propose tools (`POST /api/agents/:id/sim-call`) | P-18 |
| The second agent is a salon agent (an assumption) | A barbershop booking agent | D-03 |
| The server uses one database login | A restricted login `abos_app` and checked routines | D-10 |
| Pre-approval order states on the order | They are the call's `stage`. The order row is created by the propose tool already in `AWAITING_OWNER_APPROVAL` | SPEC 2.4 |
| The Sheets step is part of the executed bundle | It is authorized by the approval and runs as a sync job after the subject is verified | SPEC 2.3, 2.9 |
| `PATCH /api/businesses/:id` updates the profile through an approval | It changes name, contact and settings only. Facts change through `facts/propose` | SPEC 2.8 |
| "Preconnected test credentials" for Google | One service account, with the calendar and sheet shared to it | P-15 |
| Encrypt integration credentials | Credentials are environment variables on the host. Nothing is stored in our tables | SPEC 3.3 |
| Raw transcripts short-lived or redacted | No audio and no transcript is stored | FLOWS section 9 |

Differences from the SPEC and `docs/FLOWS.md` themselves that no decision covers yet. These are open items, not rulings.

| SPEC or FLOWS says | As built on this branch |
|---|---|
| Publish writes an immutable `agent_versions` row (FLOWS A15) | The publish routes run, but their stores are in server memory, because `compose/index.ts` passes no `publish` option to the builder plugin |
| Uploads save files, draft facts and conflicts (FLOWS A8 to A10) | The extraction stores are in server memory for the same reason |
| The executor re-checks item availability before CreatePaymentLink (FLOWS B18) | Not built. Availability is checked at quote time |
| The call hears the owner's decision (FLOWS 3.1) | The relay supports it. The composition root does not pass the `decisions` port |
| `webhook.rejected` is written against the integration owner from `integrations` (SPEC 2.9) | Square: the business with the most catalog rows. Twilio status: the business in `live_agent`. Twilio voice: no event |
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
- Twilio's signature validates against `PUBLIC_SERVER_URL` plus the path when the server is behind Render's proxy.
- The Twilio Media Stream fields the relay reads, barge-in by voice, and that closing the stream ends the call. `apps/server/src/voice/NOTES.md` item 7 lists the OpenAI events that the probe did not cover.
- A Google Calendar event can be inserted with our key as its ID, and a 409 means it exists.
- A Sheets append to tabs named `Orders` and `Bookings` works with the service account.
- A Square link passes the carrier filter on the Surge demo number. No message has been sent through any channel.
- The message channel variables `TWILIO_WHATSAPP_FROM`, `ANDROID_GATEWAY_KIND`, `ANDROID_GATEWAY_USERNAME`, `ANDROID_GATEWAY_PASSWORD`, `SURGE_BASE_URL` and `SURGE_LINK_SHORTENING` appear in adapter or spike code. `apps/server/src/env.ts` does not read them, so setting them has no effect on the server.

## 7. Open items

In the order I would do them.

1. **Apply migration 0005** to the real database. Without it, payment marking, stale step recovery and saving a builder draft agent fail.
2. **Deploy the integration branch** and repeat the read-only smoke check against it.
3. **Register the Square and Twilio webhooks** at the deployed address and set `SQUARE_WEBHOOK_SIGNATURE_KEY`.
4. **Place a real phone call** to the voice worker. This is the largest unproven piece.
5. **Pay a sandbox link** on a second device and confirm the webhook, the reconciliation and the paid state.
6. **Create Google credentials**, share the demo calendar and sheet, and run one booking and one export.
7. **Choose and prove a message channel** (D-08), or set `MESSAGE_CHANNEL` to `qr_only` and say so. The `android_gateway` channel needs a code change before it can be chosen (section 5).
8. **Wire the publish and extraction stores to Postgres**, so a published version is durable and pause stops the phone agent.
9. **Pass `decisions` and `twilioBusinessId`** to the voice plugin.
10. **Add a routine for `webhook_events.processed_at`** and for the move to `FULFILLMENT_READY` (both marked `INTERIM(0005)` in `compose/interim-db.ts`).
11. **Build the owner recovery actions** (P-19) or accept the reset script as the way out of a stuck record.
12. **Raise the test and hook timeouts or lower the worker count** for the database tests, so `npm test` is stable on small machines and CI can go green. CI is red today for this reason.
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
