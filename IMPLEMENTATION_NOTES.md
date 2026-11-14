# Implementation notes

**Task:** S-06. **Updated:** 2026-11-14. **Describes:** the code on `main` at commit `4d840fd`, merged into branch `arsh/S-06-docs`.

This file describes the server as it is built on `main`, how the database is designed, how an approval becomes executed steps, where the build differs from `docs/PRD.md`, and what is still open. The PRD asks for unverified assumptions and blockers to be written here. They are in sections 6 and 7.

Status words are used as in `SECURITY_NOTES.md` section 1: built and tested with fakes, verified against the real service, or not built. The complete list of what has been verified against real services is in `SECURITY_NOTES.md` section 2. Test totals are in section 3 of that file.

## 1. Where things stand

- The wired server is on `main`. The integration branch was merged as pull request #97.
- The server is deployed from `main` on a paid Render instance at `https://abos-server.onrender.com`. The list of real checks does not name the commit that was deployed. Pull requests #104, #110 and #112 were merged into `main` between 10:09 and 10:39 Pacific on 2026-11-14, after the time of that list, so what they changed (the AgentPhone contract values, keeping the current value on a database conflict, and display names on approvals) is tested with fakes only.
- The real database has migrations 0001 to 0006.
- `npm run typecheck` passes. `npm test` passes: 2199 of 2201 tests, with 2 marked as expected failures for two known open defects. The web tests pass, 600 of 600. I ran all three for this document. Details are in `SECURITY_NOTES.md` section 3.
- On the deployed server a script drove one pizza order from a simulated call to a paid and fulfilled order: Square quote, proposal, owner approval, one Square sandbox payment link, a SIMULATED sandbox payment, one payment receipt, `PAID_VERIFIED`, `FULFILLMENT_READY`, and the row in the Orders tab of the demo sheet.
- On a local server against the same real backend these also passed: a barbershop booking to a real Google Calendar event and a Bookings row, an opening-hours edit, a new fact key, and three negative checks (a second approval, a wrong payload hash, a rejected order).
- Not verified with any real service: a real phone call through Twilio to the voice worker, a payment on Square's hosted checkout page with a test card, any customer message delivery, the web app against the deployed server, the booking flow on the deployed server, and AgentPhone.
- The pizza run was made by `scripts/live/run-demo.ts`. The local checks match that script's other flows, and I have assumed it made them too. The list of real checks records no run by a person at the web screens and no rehearsal.

## 2. Architecture as built

### 2.1 One Node server

The server is one Fastify process (`apps/server`), run directly from TypeScript with `tsx`. It holds the REST API, the provider webhooks, the phone WebSocket and the background jobs (SPEC proposal P-11). The Next.js app in `apps/web` has no API routes.

`apps/server/src/index.ts` loads `.env.local`, parses the environment, builds the app, checks that the database connection is the restricted `abos_app` role and exits if it is not, listens, starts the jobs, and closes cleanly on `SIGTERM` and `SIGINT`. `parseEnv` in `apps/server/src/env.ts` refuses to start unless `SQUARE_ENVIRONMENT` is `sandbox` or unset, which defaults to `sandbox`. Every other integration variable may be left out at startup. A missing key turns its feature off and integration health reports it. A variable that is set but malformed does stop the server: a URL that is not a URL, a phone number that is not in E.164 form, or a `MESSAGE_CHANNEL` that is not one of `surge`, `android_gateway`, `whatsapp_sandbox` and `qr_only`. So does `OPENAI_API_KEY` set without `OPENAI_BUILDER_MODEL` (`apps/server/src/builder/env.ts`).

### 2.2 The composition root

`composeServer` in `apps/server/src/compose/index.ts` is the one place that builds real dependencies from the environment and connects each port to the piece that implements it. `buildApp` in `apps/server/src/app.ts` registers every route group with what the composition root made. Tests pass overrides (database, token verifier, providers, model, clock) through the same options.

| File in `apps/server/src/compose/` | What it wires |
|---|---|
| `index.ts` | The composition root: database pool, verifier, providers, policy engine, toolset factory, executor, webhooks, builder options, voice options, price proposals, recovery, human fallback, the decision bus, telemetry, jobs |
| `providers.ts` | Provider clients from the environment: Square sandbox, the Square price adapter, Google Calendar, Google Sheets, the message channel, the Twilio validator, the Twilio call update, the OpenAI socket factory. Each is undefined when its keys are missing |
| `ports.ts` | The ports the tools and the voice worker declared, implemented on Postgres, the engine and the adapters |
| `executor.ts` | The executor and the Sheets job runner on the database routines and the adapters |
| `webhooks.ts` | The webhooks plugin, payment reconciliation and stored-event recovery |
| `recovery.ts` | Order cancel and the resolution of a step that needs review, with a Square read or the stored dispatch row as evidence |
| `builder.ts` | Postgres stores for the builder's sessions, draft agents, draft facts and business knowledge, and the fact proposal from a chat answer |
| `builder-publish.ts` | Postgres stores for published versions, the live-agent row and publish events, and the catalog sync at publish |
| `decisions.ts` | An in-process bus that tells a live call about the owner's decision |
| `fallback.ts` | Human fallback: the three conditions and the Twilio call update. Switched off by default |
| `health.ts` | Integration health: configuration plus cached read-only probes |
| `seams.ts` | The fail-closed defaults: an executor that runs nothing and webhook routes that answer 503 |

### 2.3 Ports and adapters

Each piece declares the interfaces it needs. The Square SDK is imported only in the Square adapter. Three other places import a provider SDK or call a provider directly: the composition root's provider file (`compose/providers.ts`) builds the Google clients and runs the read-only health probes for Square, Google, Twilio and OpenAI; the voice plugin imports `twilio` to validate signatures; and the builder imports `openai` for its model, its extractor and its agent runner.

| Piece | Path | Role |
|---|---|---|
| Approval engine | `apps/server/src/policy/` | Builds the approval payload, stores the subject, calls the database routines, and answers `authorizeStep` for the executor |
| Executor | `apps/server/src/executor/` | Claims one step at a time, runs its handler, classifies the result, and runs Sheets jobs |
| Adapters | `apps/server/src/adapters/square`, `message`, `calendar`, `sheets` | The code that writes to Square, a message channel or Google. The only other provider calls are the read-only health probes in `compose/providers.ts` |
| Agent tools | `apps/server/src/tools/real`, `tools/mock` | Seven read and propose tools behind one handler interface, with a real and a mock implementation |
| Voice worker | `apps/server/src/voice/` | `POST /webhooks/twilio/voice`, the `/ws/phone` Media Stream socket, the relay to the OpenAI Realtime API, and the fallback router |
| Webhooks | `apps/server/src/webhooks/`, `apps/server/src/reconcile/` | Square and Twilio status webhooks and the payment poll |
| REST API | `apps/server/src/api/` | Owner routes, health, live agent, simulated call, price proposals, recovery |
| Auth | `apps/server/src/auth/verify.ts` | Supabase JWT verification and the route guard |
| Builder | `apps/server/src/builder/` | Interview, spec, mock test runner, publish and versions, extraction, owner voice secret. Registered as one plugin with its own auth seam |
| Telemetry | `apps/server/src/telemetry/` | `GET /api/telemetry` from an in-memory recorder and activity events |

Shared code is in two packages. `packages/contracts` holds the Zod schemas, the capability registry, the state machines, hashing and fixtures. `packages/db` holds the migrations, the migration runner, typed wrappers for the database routines, and the seed and reset logic.

### 2.4 Routes on `main`

Read from the running app with an empty environment. The auth column is the policy declared where the route is registered. `apps/server/test/e2e/route-auth.test.ts` checks that every `/api` route has one and that none is public.

| Auth | Routes |
|---|---|
| None | `GET /health` (with `?refresh=1` it also checks the database) |
| Provider signature | `POST /webhooks/square`, `POST /webhooks/twilio/status`, `POST /webhooks/twilio/voice`. The socket `/ws/phone` exists only when voice is configured and needs a valid stream token |
| Owner (Supabase JWT, business ownership checked) | `GET /api/businesses`, `GET` and `PATCH /api/businesses/:id`, `GET /api/businesses/:id/facts`, `POST /api/businesses/:id/facts/propose`, `GET /api/businesses/:id/catalog`, `POST /api/businesses/:id/catalog/sync`, `POST /api/businesses/:id/catalog/prices/propose`, `GET /api/approvals`, `GET /api/approvals/:id`, `POST /api/approvals/:id/decision`, `GET /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/checkout`, `POST /api/orders/:id/cancel`, `POST /api/executions/:id/resolve`, `GET /api/bookings`, `GET /api/bookings/:id`, `GET /api/calls`, `GET /api/calls/:id`, `GET /api/activity`, `GET /api/integrations/health`, `GET` and `PUT /api/live-agent`, `POST /api/agents/:id/sim-call`, `GET /api/telemetry` |
| Builder (the builder's own auth seam, filled with the same JWT check) | `POST /api/builder/sessions`, `GET /api/builder/sessions/:id`, `POST /api/builder/sessions/:id/messages`, `GET` and `POST /api/agents`, `GET /api/agents/:id`, `POST /api/agents/:id/preview`, `POST /api/agents/:id/test`, `POST /api/agents/:id/publish`, `POST /api/agents/:id/pause`, `GET /api/agents/:id/versions`, `POST /api/agents/:id/rollback`, `POST /api/businesses/:id/files`, `GET /api/files/:id`, `POST /api/conflicts/:id/resolve`, `POST /api/realtime/client-secret`. `GET /api/builder/ping` is registered in this group but has no auth check and answers anyone |

### 2.5 Background jobs

Jobs are timers inside the server process. The work they pick up is stored in Postgres. `pg-boss` is not a dependency.

| Job | Interval | Code |
|---|---|---|
| Executor steps and Sheets jobs | Every 2 seconds, and at once after an approval or a verified payment | `createDbExecutor` in `compose/executor.ts` |
| Approval expiry sweep | Every 30 seconds | `startJobs` in `compose/index.ts`, routine `private.expire_approvals` |
| Payment reconciliation poll | Every 30 seconds, for 15 minutes after a link is ready. It runs even when the webhook routes are off | `pollPendingPayments` in `reconcile/index.ts` |
| Stored webhook recovery | At start and every 2 minutes, for every stored row not yet marked processed. It runs only when the webhook routes are configured | `recoverNow` in `compose/webhooks.ts` |
| Integration health check | Once at start, in the background, and again on each publish | `startJobs` in `compose/index.ts` |
| Stale step and stale Sheets job recovery | With the executor, for a step or job whose 15 minute lease ran out | routines `private.recover_stale_executions` and `private.recover_stale_sync_jobs` |

## 3. The database design

The database is Supabase Postgres. The SQL is in `packages/db/migrations/`.

| Migration | What it adds | Applied to the real database |
|---|---|---|
| `0001_extensions_and_helpers.sql` | Extensions, the `private` schema, closed default privileges, `gen_id` | Yes |
| `0002_core_tables.sql` | 21 tables, constraints, row-level security, guard triggers, indexes | Yes |
| `0003_realtime.sql` | `activity_events` in the Supabase Realtime publication | Yes |
| `0004_runtime_role_and_routines.sql` | The restricted role `abos_app` and the checked routines | Yes |
| `0005_payments_and_stale_leases.sql` | The table `payment_receipts`, guard triggers on `orders` and `bookings`, worker leases, checkout, payment, booking, fact and recovery routines, `agents.spec_revision`, `orders.link_ready_at` | Yes |
| `0006_ownership_material_and_receipts.sql` | Guards on `users`, `businesses` and on what an order or booking proposed, the processed marker for webhooks, delivery receipts, the startup role check, and the removal of `service_role` from the routines | Yes |

There are 22 tables: the PRD's seventeen, plus `catalog_items`, `message_dispatches`, `live_agent` and `fact_conflicts` (SPEC 2.7), plus `payment_receipts` (0005). The migration runner adds `schema_migrations`.

Design points:

- **IDs** are text with a type prefix, for example `ord_` and `apv_` (SPEC 2.1).
- **Three kinds of database user.** A signed-in owner (`authenticated`) can only read rows of a business they own, through row-level security. The server (`abos_app`) reads everything and writes ordinary tables, but can change approvals, executions, dispatches and sync jobs only through routines. The table owner runs migrations, seed and reset.
- **The approval row carries its own proof.** It stores the payload, the canonical JSON text, and the SHA-256 hash of that text. A check constraint ties the hash to the text.
- **Invariants are in the database**, so they hold whatever the server does: one pending approval per subject, one-use approvals, executions only for approved bundles and only in bundle order, immutable idempotency keys, dispatch recipient equal to the approved recipient, no deleting executions, dispatches, sync jobs or approvals, append-only activity events and payment receipts, immutable published agent versions, no overlapping bookings on one calendar, and unique Square and Google references.
- **Orders and bookings are guarded.** The server may still update them, but a trigger checks every server write against the state machine. Paid and booked states, payment IDs and Google event IDs can be written only by a routine. A checkout reference cannot be changed once it is stored. The trigger does not refuse the first write of the checkout references: the server makes that write through `private.save_checkout`. What was proposed (cart, quote, total, contact, pickup, service, slot) cannot be changed by the server after the row is inserted.
- **Ownership is guarded.** The server cannot create a user or a business, change a user, or change a business's owner.
- **A worker holds a lease.** A claim gives 15 minutes. A step whose lease ran out goes to review.
- **The Sheets step has no execution row.** A sync job is created when the subject becomes verified (SPEC 2.9).

The role and routine list is in `SECURITY_NOTES.md` section 5. The typed wrappers are in `packages/db/src/runtime.ts`.

## 4. How an approval becomes executed steps

This is the pizza order. The booking follows the same path with its own steps.

1. **Quote.** The agent calls `quote_order`. `squareQuotePort` in `compose/ports.ts` hands the cart to the Square adapter, which checks availability in `catalog_items` and calls Square CalculateOrder. The quote lives in server memory for 5 minutes and can be used for one proposal.
2. **Propose.** The agent calls `propose_order`. The toolset stores the proposal with channel `qr_only` and no recipient, whatever the model sends. `createOrderProposal` in `policy/engine.ts` then checks the cart hash against the quote and, in one transaction, checks that the call is still in progress and pinned to the agent version, inserts the `orders` row as `AWAITING_OWNER_APPROVAL`, and calls `private.create_approval`. The payload holds exactly the material fields of SPEC 2.9. The expiry is 10 minutes from the database clock. No provider is called.
3. **Decide.** The owner sends `POST /api/approvals/:id/decision` with the payload hash the screen showed. The route guard has already checked the JWT and the business. `decide` calls `private.decide_and_enqueue`, which locks the approval, checks owner, hash and expiry, marks it `APPROVED`, moves the order to `APPROVED`, writes the activity events, and inserts one `action_executions` row per step except the Sheets step. Each row gets its idempotency key there. When the approved channel is `qr_only` the message step is inserted as `SKIPPED`. A repeat of the same decision changes nothing and returns the same approval.
4. **Tell the call and kick.** The route tells the executor to look for work, and publishes the decision to the call if it is still live. The agent then says the order was approved. It never says a message was sent.
5. **Claim.** `private.claim_execution` gives one `QUEUED` step to one worker with a 15 minute lease, only if the earlier steps are finished. When it claims the first step of a bundle it also checks that the subject still matches the approval. Claiming the checkout step moves the order to `CREATING_CHECKOUT`.
6. **Authorize.** `authorizeStep` re-reads the approval, checks its state, its hash, the step's position, the capability's effect in the registry table, the sandbox setting and the idempotency key. A refusal writes `guardrail.refused`.
7. **`square.checkout.create`.** The step authorizes again, then checks in `catalog_items` that every item and variation in the cart is still available. If one is not, the step fails with no request to Square and the order becomes `UNAVAILABLE`. Otherwise the handler calls Square CreatePaymentLink once with the row's key and automatic taxes. The adapter reads the Square order and compares its total with the approved total. On a match `private.save_checkout` stores the references and moves the order to `PAYMENT_LINK_READY`. On a mismatch the step fails and the order becomes `RECOVERY_REQUIRED`. On a timeout the step becomes `NEEDS_REVIEW` and nothing is created again.
8. **`message.checkout.send`.** For an order from a call this step is already `SKIPPED`. When an approval does name a channel, `private.record_dispatch` inserts the one dispatch row with the recipient and channel from the approval, and the adapter sends once. A failed, unknown or unavailable send never stops the bundle.
9. **`local.order.record`.** The order becomes `PAYMENT_PENDING`.
10. **Payment.** A verified Square webhook, or the poll, reads the payment from Square. If it is `COMPLETED`, not refunded, and matches the order ID, amount, currency and location, `private.mark_order_paid` checks the observation again, writes the receipt, sets `PAID_VERIFIED`, and creates the Sheets sync job. `private.fulfill_order` then moves the order to `FULFILLMENT_READY`.
11. **Sheets.** The job runner claims the sync job through `private.claim_sync_job`, checks the record ID column, appends one row, and finishes the job. A failed job is tried up to 5 times in all and never changes the order.

A retryable step failure goes back to `QUEUED` up to 3 attempts with a delay that doubles from 1 second.

**When a step needs review.** The owner can call `POST /api/executions/:id/resolve` with `retry` or `abandon`. The route completes a step only from evidence, and refuses when the evidence is unsure. As wired today the evidence is narrow (`apps/server/src/compose/recovery.ts`). For the checkout step the server reads the link back from Square, and if it exists and its total matches, `retry` completes the step with that same link. For a message step the evidence is the stored dispatch row: a dispatch that is already sent completes the step. The lookup never reports that an effect is absent, and it answers "unknown" for a Calendar step and a price step. So `abandon` is always refused, nothing is requeued, and a Calendar or price step in review cannot be resolved through this route. `POST /api/orders/:id/cancel` cancels an order that has no Square order and is in `RECOVERY_REQUIRED`. An order that already has a Square link is never canceled by this route, because nothing deactivates the link. No web screen calls either route.

**The booking bundle.** `calendar.event.create` looks for an event whose ID is the step's key, re-reads free/busy, and inserts one event with no attendees and no notifications. `private.verify_booking` then stores the event ID, moves the booking to `BOOKED_VERIFIED` and creates the Sheets job, in that same step. `message.booking.confirm` and `local.booking.record` follow. A slot that is busy at this point ends in `SLOT_CONFLICT` with no event. The executed step offers no alternative times: alternatives are offered to the caller when the agent reads availability, before the proposal. If the owner approves a booking whose slot overlaps one already approved, the decision is refused, the booking moves to `SLOT_CONFLICT`, and the approval stays pending until it expires.

**The fact edit.** `decide` runs `local.fact.update` in the same request through `private.apply_fact_update`. It supersedes the old verified fact and inserts the next version, or promotes a new-key draft to verified version 1.

**The price change.** `POST /api/businesses/:id/catalog/prices/propose` reads Square's current price and stores a pending `price_edit` approval. After the owner approves, `square.catalog.price.update` writes the price for the configured location with the row's key, and `local.catalog.sync` refreshes `catalog_items`.

End-to-end tests of these paths, with fakes: `apps/server/test/e2e/main-flow.test.ts`, `apps/server/test/e2e/flows.test.ts` and `apps/server/test/e2e/routines.test.ts`.

## 5. Deviations from the PRD

Each row names the SPEC decision or ruling that covers the change. `docs/SPEC.md` wins over the PRD.

| PRD says | As built | Covered by |
|---|---|---|
| The checkout link goes by Twilio SMS (`sms.checkout.send`, state `SMS_SENT`) | A channel-agnostic message adapter with channels `surge`, `android_gateway`, `whatsapp_sandbox` and `qr_only`. The capability is `message.checkout.send` and the state is `MESSAGE_SENT`. Twilio SMS failed with error 30034. The live setting is `qr_only`, and no message has been delivered through any channel. The contracts package also names a fifth channel, `agentphone`, that the server, the adapter and the database do not accept | D-08, D-11, SPEC 2.2, 2.4 |
| Effects are `read`, `write`, `external_message` | A fourth effect, `propose`, writes only our database and opens an approval | SPEC 2.2 |
| No endpoint named for the pre-approval quote | Square CalculateOrder, through the tool `quote_order` | P-02 |
| "Realtime/live voice endpoint" | OpenAI Realtime API (`gpt-realtime-2.1`) over Twilio Media Streams, relayed by this server | P-03 |
| The live edit demo changes an item price | The live edit changes opening hours. The price change is a SHOULD item. It is built and tested with fakes | P-05 |
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
| Raw transcripts short-lived or redacted | No phone audio and no phone transcript is stored. The owner's builder chat is stored in `builder_sessions`, including speech the browser transcribed | FLOWS section 9 |

Differences from the SPEC and `docs/FLOWS.md` themselves that no ratified decision covers yet. These are open items, not rulings.

| SPEC or FLOWS says | As built on `main` |
|---|---|
| The agent asks for a number and for consent, and the link goes by message (FLOWS B11, B12, B21) | The agent collects no number. Every proposal from a call is `qr_only`, because the server has no trusted evidence of the caller's consent (`apps/server/src/voice/NOTES.md` item 3). The link is shown as a QR code |
| Publish stops when a required integration is unreachable (FLOWS, builder stop condition 4) | Publish runs the read-only health checks itself. A phone agent needs Twilio and OpenAI, the pizza template Square, the booking template Google Calendar, and each capability its provider. A message channel other than `qr_only` has no check at all, so with `surge` or `whatsapp_sandbox` set, an agent with a message capability cannot be published. The same is true when `MESSAGE_CHANNEL` is not set at all |
| A conflict is resolved through `POST /api/conflicts/:id/resolve` (API.md) | For a conflict stored in Postgres, "keep the current value" (`keep_authoritative`) is resolved on the database with no approval (`apps/server/src/api/conflicts.ts`). Any other choice is answered with an error that names the route to use: `facts/propose` with `resolvesConflictId` for a fact, or a price change followed by "keep the current value" for a Square price. The price route refuses a proposal that carries `resolvesConflictId`. Conflicts from an upload are held in server memory and resolved there |
| Uploads save files, draft facts and conflicts (FLOWS A8 to A10) | The extraction stores are in server memory, because `compose/index.ts` passes no `extraction` option |
| The agent ends the call after its goodbye (FLOWS 3.1) | In one case the relay does end the call: if the owner has not decided 90 seconds after a proposal, the agent says goodbye and the relay closes the call. For any other goodbye the relay needs a trusted finish signal that the composition root does not pass, so the call ends when the caller hangs up, on the idle limit, on the session limit, or on a failure |
| Human fallback is a SHOULD item with no stated approval rule | Built and switched off. The rule that it needs no per-call approval is a proposal waiting for the owner. SPEC 2.9 has four more rows marked "proposed, waiting for Arsh to ratify" that the code already follows |
| `webhook.rejected` is written against the integration owner from `integrations` (SPEC 2.9) | Square: the business with the most catalog rows. Twilio: the business that holds the number in `live_agent` |
| The Square signature is checked over `SQUARE_WEBHOOK_URL` (FLOWS B25) | It is checked over `PUBLIC_SERVER_URL` plus `/webhooks/square` |
| The decision replay is kept for 24 hours (API.md) | It is kept for 24 hours in server memory and is lost on restart |
| A fallback of CreateOrder plus CreatePayment if a link cannot be paid (SPEC 4) | Not built |
| `MESSAGE_CHANNEL` may be `android_gateway` (D-08) | It needs `ANDROID_GATEWAY_KIND` (`textbee` or `smsgate`) and that kind's settings. Without them the channel is reported as not configured, nothing is sent, and the server still starts |
| The server runs on Node 24 (SPEC 3.2) | `package.json` allows Node 22 or later. I ran the tests on Node 22.23.4. CI uses Node 24 |
| A call that ends writes `call.ended` (FLOWS B30) | Some calls never get one. A simulated call ends only when the client sends `end: true`, so an abandoned one stays `IN_PROGRESS`. On the phone path, if the audio stream never starts or closes before it is tied to its call row, the relay writes no end and the end depends on Twilio's status callback. No job sweeps calls left `IN_PROGRESS` |
| Neither the SPEC nor FLOWS names a limit on tool calls | There is no cap on tool calls in one phone call. The relay counts them for its log and does not limit them. A simulated call allows 8 per turn |
| Every decision is a row in the SPEC ledger (SPEC 1.1) | The contracts package and `docs/CONTRACTS.md` refer to decision D-12 (AgentPhone as a second phone and message provider). The ledger in `docs/SPEC.md` ends at D-11. On `main` D-12 exists only as contract values: no route, no adapter, no setting. The provider is on a branch behind a provider switch, with no live test |

## 6. Unverified assumptions

Each of these is built on what the vendor documentation or a spike says. For each one this list says what the live runs have shown and what they have not.

**Square**

- A sandbox payment link can be paid on Square's hosted checkout page with the test card. Not verified. What is known from the live run: a Square order created through a payment link stays `DRAFT` until the hosted checkout opens it, and a direct payment on it is refused until it is `OPEN`. The live run opened the order with UpdateOrder and paid it through the API with the sandbox test nonce. That is a SIMULATED payment.
- Square sends `payment.created` or `payment.updated` after a payment. Two Square webhook events were stored and processed by the deployed server around the time of the simulated payment. Whether a payment on the hosted checkout page sends the same events is not verified.
- The Square webhook signature header is base64. The server stores an event only after its signature check passes, so the two stored events are consistent with this.
- Square reports a final failed payment with status `FAILED` or `CANCELED`. Not verified.
- The Square order read returns the payment in `tenders` soon enough for the poll. Otherwise the poll lists recent payments for the location. Not verified: the list of real checks does not say whether the webhook or the poll moved the order to paid.
- A Square catalog price write for one location: its idempotency key limit, whether a read right after the write sees it, and how its errors should be classed. Not verified. `apps/server/src/api/prices/NOTES.md` lists these as not established.

**Twilio**

- Twilio's signature validates against `PUBLIC_SERVER_URL` plus the path when the server is behind Render's proxy. Not verified. Only unsigned requests have been sent to the deployed server, and they were refused.
- The Twilio Media Stream fields the relay reads, barge-in by voice, and that closing the stream ends the call. Not verified: no real phone call has been placed. `apps/server/src/voice/NOTES.md` lists the OpenAI events that the probe did not cover.
- A Twilio call update with inline TwiML can move a live Media Stream call to a person. Not verified. `apps/server/src/voice/fallback/NOTES.md` lists what is unproven.
- Twilio SMS from the unregistered US number fails with error 30034. This one is verified, and it is why the checkout link is shown as a QR code. The Twilio account is a full account, not a trial.

**Google**

- A Google Calendar event can be inserted with our key as its ID. The booking run on a local server created a real event. The second half of the assumption, that a 409 means the event already exists, is not verified.
- A Sheets append to tabs named `Orders` and `Bookings` works with the service account. Verified: one row in each tab.

**Setup and the web app**

- The Square subscription calls in `npm run register-webhooks` match the real API. The webhooks are registered at the Render address, but the list of real checks does not say whether this command or the provider consoles made the registration. `docs/DEPLOY.md` still says the Square calls were not run against a real account.
- The web app works against the deployed server. Not verified. I did not check the value of `WEB_ORIGIN` on Render, which decides whether the browser is allowed to call the server.
- Supabase Realtime delivers `activity_events` inserts to the browser under row-level security. Not verified.
- The variables `SURGE_BASE_URL` and `SURGE_LINK_SHORTENING` appear in adapter code. `apps/server/src/env.ts` does not read them, so setting them has no effect on the server.

## 7. Open items

In the order I would do them.

1. **Place a real phone call** to the voice worker. This is the largest unproven piece. The Twilio webhooks are registered at the Render address.
2. **Pay a sandbox link on Square's hosted checkout page** on a second device with the test card. Until that works, the only verified payment is the SIMULATED one, and the demo must say so.
3. **Run the web app against the deployed server**: sign-in, the Approvals screen, the QR code, and live updates.
4. **Run the booking flow on the deployed server.** It passed on a local server against the same backend.
5. **Publish and pause on the deployed server**, and call a paused agent. Both are stored and tested with fakes.
6. **Run the three rehearsals and the outside owner test** (AC-20), and record the backup video. None has happened.
7. **Decide the message question.** Either ratify "QR code only" for the demo, or build the trusted consent evidence the voice notes describe. A message channel also needs a health check before an agent that uses it can be published.
8. **Rule on human fallback** and on the four SPEC 2.9 rows still marked proposed.
9. **Write decision D-12 into `docs/SPEC.md`.** The contracts package and `docs/CONTRACTS.md` refer to D-12 (AgentPhone), but the decision ledger in the SPEC ends at D-11. Then decide what to do with the AgentPhone branch.
10. **Add a cap on tool calls per phone call**, and make sure every call gets an end event (section 5, second table).
11. **Wire the extraction stores to Postgres**, and pass the call finish signal to the voice plugin.
12. **Close the two defects the adversarial suite records as open**: `GET /api/builder/ping` answers without a token, and a dispatch stays `QUEUED` after crash recovery.
13. **Put the smoke script in the repository.** The list of real checks cites a smoke script that passes 9 of 9 on the deployed server. I found no such script on `main`.
14. **Bring `docs/DEPLOY.md` up to date.** It still says that `GET /api/integrations/health` is not built and that the server has no `SIGTERM` handler. Neither is true of `main`. This pull request changes only the four delivery documents.

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
| `npx tsx scripts/live/run-demo.ts <flows> --base <server address>` | Drive the demo flows against a running server and the real backend. Flows are `pizza`, `pay`, `negative`, `booking`, `hours` and `health`, as a comma list, or `all`. It needs real credentials in `.env.local`. The `pay` flow writes to the Square sandbox directly (see `SECURITY_NOTES.md`, rule 1). I did not run it |
