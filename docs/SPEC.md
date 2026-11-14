# AI Business OS: Build Spec

**Version:** 1.1 | **Date:** 2026-11-13 | **Build window:** 24 to 48 hours | **Team:** Arsh Gupta and Saina Kakkar, each leading a Claude Code session with parallel worker agents

This is the master spec. It amends the PRD (`docs/PRD.md`). Where this file and the PRD disagree, this file wins. Every other doc in `docs/` must use the names defined here.

| Doc | What it holds |
|---|---|
| `docs/PRD.md` | The original product requirements, unchanged |
| `docs/SPEC.md` | This file: decisions, names, architecture, scope, risks |
| `docs/GAPS.md` | Every gap found in the PRD and how it is resolved |
| `docs/CONTRACTS.md` | Capability registry, schemas, state machines, activity events |
| `docs/API.md` | REST endpoints and webhooks |
| `docs/DATA-MODEL.md` | Database tables, constraints, row-level security |
| `docs/FLOWS.md` | Build, pizza, barbershop and edit flows step by step, with vendor calls |
| `docs/WORKPLAN.md` | Tasks, owners, timeline, checkpoints, collaboration rules |
| `docs/SETUP-ACCOUNTS.md` | Hour-zero account checklist |

## 1. Decision ledger

### 1.1 Decided by Arsh (2026-11-13)

| ID | Decision |
|---|---|
| D-01 | Build window is 24 to 48 hours. |
| D-02 | Arsh owns backend. Saina owns UI. |
| D-03 | The second agent is a barbershop appointment-booking agent on Google Calendar. |
| D-04 | The task board is GitHub Issues plus a GitHub Project board. |
| D-05 | The repo is private: `arshgupta340/ai-business-os`. |
| D-06 | No provider accounts existed at the start. Creating them is task B-01. |
| D-07 | Saina also owns the builder on the server (`apps/server/src/builder`): the builder service, publish and versions, document extraction and the owner voice session. Arsh keeps payments, voice calls, approvals, webhooks and Google. |
| D-08 | The checkout link goes out through a channel-agnostic `MessageAdapter`. Spike B-04 tests channels in this order and uses the first that delivers a Square link to a team phone: (1) Surge shared demo number, real SMS, 25-message cap; (2) an Android phone the team has, sending SMS from its own SIM through textbee or SMSGate; (3) Twilio WhatsApp sandbox. The dashboard always shows the link as a QR code as the backup. |
| D-09 | Scope is the full PRD P0 list and all twenty acceptance criteria. Build time is not the constraint: both leads run parallel worker agents (Claude, Codex, OpenCode). Everything that ships must work. |

| D-10 | The server connects to Postgres as a restricted login, `abos_app`, not as the table owner. It can read and write the application tables but cannot disable guards, truncate, or delete approvals, executions, audit events or published versions. Migrations and the operator reset use the owner connection, `DATABASE_ADMIN_URL`. The server uses `DATABASE_URL`. |

Everything the PRD lists under "Confirmed by the founding team" still holds unless a row here changes it.

### 1.2 Proposed, waiting for Arsh to ratify

These are written into the spec so work can start. Each stays a proposal until Arsh says yes. If he changes one, update this table first and then the affected doc.

| ID | Proposal | Replaces or fills in the PRD |
|---|---|---|
| P-02 | The pre-approval quote comes from Square `CalculateOrder`, which returns totals and tax without creating an order. | PRD section 8 step 3 names no endpoint. |
| P-03 | Phone voice uses the OpenAI Realtime API (`gpt-realtime-2.1`) over Twilio Media Streams, relayed by our Node server. Owner browser voice uses the same Realtime API over WebRTC with a short-lived client secret minted by our server. GPT-Live is not used. Spike B-03 confirms the phone path in the first two hours. | PRD: "realtime/live voice endpoint". |
| P-05 | The live-edit demo changes opening hours, which is a local fact. Changing a price through Square is the SHOULD-tier capability `catalog.price.update`. | PRD demo says "change this item price", but the registry has no catalog write. |
| P-06 | One phone number. A "live agent" switch in the dashboard decides which published agent answers it. | PRD has one number but two agents that take calls. |
| P-07 | While waiting for approval the phone agent says the shop will confirm the order and a payment link will follow by message. The call may end. An approval request expires 10 minutes after it is created. | PRD leaves both undefined. |
| P-08 | After a booking is created, the customer gets a confirmation through the same `MessageAdapter`. | PRD booking flow never tells the customer. |
| P-09 | An owner editing a fact is a confirmation, not a third-party approval. It reuses the approval table with `actorType = owner` and shows a confirm dialog. | PRD says fact writes "require approval" without saying whose. |
| P-10 | A local `catalog_items` table caches the Square catalog. It syncs at seed, at publish and on demand. The phone agent reads the cache. Quotes always come from Square. | PRD "knowledge snapshot" is undefined. |
| P-11 | One persistent Node server holds the REST API, webhooks, the phone WebSocket and background jobs. The Next.js app has no API routes. | PRD suggests API routes plus a worker; pg-boss cannot run on Vercel. |
| P-12 | Document extraction accepts PDF, image, CSV and spreadsheet files, uses one structured-output call per file, and saves draft facts with a confidence value. | PRD P0 item 3 is unspecified. |
| P-13 | A custom agent is any validated subset of registered capabilities. One example, a FAQ-only agent, is a SHOULD item. | PRD "custom agent" is undefined. |
| P-14 | One owner login and two seeded businesses with a simple selector. | PRD leaves tenancy open. |
| P-15 | Google access uses one service account, with the demo calendar and sheet shared to it. | PRD says "preconnected test credentials". |
| P-16 | The dashboard gets live updates through Supabase Realtime on `activity_events`, which tells the UI to refetch. There is no custom SSE endpoint. | PRD `/api/activity/stream`. |
| P-17 | Upgrade the Twilio account (about 20 US dollars) so callers do not hear the trial announcement. This is Arsh's spending decision. | Not in PRD. |
| P-19 | Owner recovery actions are a SHOULD item (task B-32): `POST /api/orders/:id/cancel`, and `POST /api/executions/:id/resolve` with `retry` or `abandon` for a step in `NEEDS_REVIEW`, a booking in `RETRY_REQUIRED` or a message in `UNKNOWN`. Until they exist, a stuck record is cleared with the reset script. | The PRD defines the stuck states but no way out of them. |
| P-18 | Two text ways to run an agent. `POST /api/agents/:id/test` uses mock tools only and can never cause a write (AC-03). `POST /api/agents/:id/sim-call` runs a published agent in text with the real read and propose tools, creates a `calls` row with channel `test_console`, and is labelled "simulated call" in the UI. Writes still need owner approval. Automated end-to-end tests use it, and it is the fallback if the phone path fails. | PRD has only the mock preview. |

### 1.3 Rules that are never cut

These come from the PRD and hold whatever else changes.

1. No external write happens before the owner approves the exact payload.
2. Every webhook is signature-verified and deduplicated before it changes state.
3. Every external write carries a stable idempotency key.
4. Payment data is always labelled as sandbox.
5. No success state is shown before the provider confirms it.
6. The phone agent cannot change facts, prices, policies or permissions, whatever the caller says.

## 2. Names used everywhere

### 2.1 Seeded data and IDs

| Thing | Value |
|---|---|
| Owner login | one seeded owner user |
| Pizza business | `biz_pizza_01`, display name "Demo Pizza Co." (placeholder, rename freely) |
| Barbershop business | `biz_barber_01`, display name "Demo Barbershop" (placeholder, rename freely) |
| Pizza agent template | `restaurant_order_taker` |
| Barbershop agent template | `appointment_booker` |
| Time zone of both | `America/Los_Angeles` |

IDs are text with a type prefix: `usr_`, `biz_`, `agt_`, `agv_` (agent version), `ord_`, `qte_` (quote), `bkg_`, `svc_` (service), `apv_`, `exe_`, `call_`, `evt_`, `msg_`, `fact_`, `cfl_` (fact conflict), `file_`, `job_`, `bld_` (builder session), `bmsg_` (builder message), `tst_` (test console session), `int_` (integration), `cat_` (catalog item), `whk_` (webhook event), `syn_` (sync job). The mock toolset returns approvals with the prefix `apv_mock_`.

### 2.2 Capabilities

`effect` is one of `read`, `propose`, `write`, `external_message`. `propose` is new: it writes only to our own database and creates an approval request. The phone agent may call `read` and `propose` capabilities. It can never call `write` or `external_message` capabilities. Only the action executor runs those, and only for an approved bundle.

| Capability ID | Effect | Approval | What it does | Tier |
|---|---|---|---|---|
| `catalog.read` | read | none | Search the cached catalog for items, variations and modifiers | MUST |
| `business.facts.read` | read | none | Read verified hours, policies and services | MUST |
| `order.quote` | read | none | Authoritative totals and tax from Square CalculateOrder | MUST |
| `order.propose` | propose | creates one | Store an immutable order proposal and open an approval request | MUST |
| `order.status.read` | read | none | Read the verified status of an order | MUST |
| `order.checkout.prepare` | write | required | Create the Square payment link (which creates the Square order) | MUST |
| `message.checkout.send` | external_message | required | Send the checkout link to the confirmed recipient | MUST |
| `calendar.availability.read` | read | none | Free slots from Google Calendar free/busy | MUST |
| `booking.propose` | propose | creates one | Store a booking proposal and open an approval request | MUST |
| `calendar.event.create` | write | required | Create one Calendar event after a fresh availability check | MUST |
| `message.booking.confirm` | external_message | required | Tell the customer the booking is confirmed | MUST |
| `sheets.rows.append` | write | required | Append one reporting row, deduplicated | MUST |
| `catalog.price.update` | write | required | Change a price in Square | SHOULD |

`message.checkout.send` replaces the PRD's `sms.checkout.send`. `business.facts.read`, `order.quote`, `message.booking.confirm` and `catalog.price.update` are additions.

### 2.3 Bundles and action types

An approval covers one bundle. The approval field that names the kind of bundle is `bundleType`. A bundle is an ordered list of action types that the executor runs. The words are kept apart on purpose: `bundleType` is the kind of bundle, `actionType` is one step.

| `bundleType` | Action types, in order |
|---|---|
| `order_bundle` | `square.checkout.create`, `message.checkout.send`, `local.order.record`, `sheets.order.append` |
| `booking_bundle` | `calendar.event.create`, `message.booking.confirm`, `local.booking.record`, `sheets.booking.append` |
| `fact_edit` | `local.fact.update` |
| `price_edit` (SHOULD) | `square.catalog.price.update`, `local.catalog.sync` |

How action types map to capabilities:

| Action type | Capability it exercises |
|---|---|
| `square.checkout.create` | `order.checkout.prepare` |
| `message.checkout.send` | `message.checkout.send` |
| `calendar.event.create` | `calendar.event.create` |
| `message.booking.confirm` | `message.booking.confirm` |
| `sheets.order.append`, `sheets.booking.append` | `sheets.rows.append` |
| `square.catalog.price.update` | `catalog.price.update` |
| `local.order.record`, `local.booking.record`, `local.fact.update`, `local.catalog.sync` | none. These are internal steps that write only our own database. They run only inside an approved bundle. |

Rules for the steps:
- `local.order.record` writes the external references and the state transition for the order after the external steps. `local.booking.record` does the same for a booking.
- The Sheets step is authorized by the approval but runs later: `sheets.order.append` runs when the order reaches `PAID_VERIFIED`, and `sheets.booking.append` runs when the booking reaches `BOOKED_VERIFIED`. It never blocks or reverses any other step.
- A message step that fails or has an unknown result does not fail the order or the booking. The dashboard QR code still gives the customer the link.

### 2.4 States

| Machine | States |
|---|---|
| Order | `CALL_STARTED`, `COLLECTING`, `VALIDATING`, `CUSTOMER_CONFIRMED`, `AWAITING_OWNER_APPROVAL`, `APPROVED`, `CREATING_CHECKOUT`, `PAYMENT_LINK_READY`, `MESSAGE_SENT`, `PAYMENT_PENDING`, `PAID_VERIFIED`, `FULFILLMENT_READY`. Branches: `REJECTED`, `APPROVAL_EXPIRED`, `UNAVAILABLE`, `PAYMENT_FAILED`, `CANCELLED`, `RECOVERY_REQUIRED` |
| Booking | `INQUIRY`, `SLOT_SEARCH`, `PROPOSAL`, `CUSTOMER_CONFIRMED`, `AWAITING_OWNER_APPROVAL`, `RECHECKING_SLOT`, `BOOKED_VERIFIED`. Branches: `SLOT_CONFLICT`, `REJECTED`, `EXPIRED`, `RETRY_REQUIRED` |
| Approval | `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED` |
| Execution | `QUEUED`, `RUNNING`, `SUCCEEDED`, `SKIPPED`, `FAILED`, `NEEDS_REVIEW` |
| Sync job | `PENDING`, `RUNNING`, `DONE`, `RETRYING`, `FAILED` |
| Agent | `draft`, `live`, `paused` |
| Call | `IN_PROGRESS`, `COMPLETED`, `DROPPED`, `FAILED` |
| Message dispatch | `QUEUED`, `SENT`, `DELIVERED`, `FAILED`, `UNKNOWN` |
| Fact | `draft`, `verified`, `superseded` |
| Fact conflict | `open`, `resolved` |

Rulings:
- `MESSAGE_SENT` replaces the PRD's `SMS_SENT`.
- The states before `AWAITING_OWNER_APPROVAL` (for orders: `CALL_STARTED` to `CUSTOMER_CONFIRMED`; for bookings: `INQUIRY` to `CUSTOMER_CONFIRMED`) describe the conversation. They live on the call, in the field `stage` of the `calls` row. The `orders` or `bookings` row is created by the propose tool, already in `AWAITING_OWNER_APPROVAL`.
- From `PAYMENT_LINK_READY` the order goes to `MESSAGE_SENT` when a message is sent, and then to `PAYMENT_PENDING`. When the channel is `qr_only`, or the send fails or is unknown, it goes straight from `PAYMENT_LINK_READY` to `PAYMENT_PENDING`.
- The expired branch is named `APPROVAL_EXPIRED` on orders and `EXPIRED` on bookings and approvals. This follows the PRD. Do not unify it.

### 2.5 Activity event types

`call.started`, `call.ended`, `proposal.created`, `approval.requested`, `approval.decided`, `approval.expired`, `execution.started`, `execution.succeeded`, `execution.failed`, `checkout.created`, `message.sent`, `message.failed`, `payment.verified`, `payment.failed`, `booking.verified`, `booking.slot_conflict`, `order.status_changed`, `booking.status_changed`, `sync.queued`, `sync.succeeded`, `sync.failed`, `fact.changed`, `extraction.completed`, `agent.published`, `agent.paused`, `live_agent.changed`, `guardrail.refused`, `webhook.rejected`.

`order.status_changed` and `booking.status_changed` are written on every state transition, so the PRD rule "an event for every transition" holds. The more specific events are written in addition, where one exists. `call.ended` carries a `reason` (`completed`, `dropped`, `failed`).

Every event carries `id`, `businessId`, `type`, `correlationId`, `actorType` (`owner`, `deployed_agent`, `system`, `provider`), `occurredAt` and a redacted `payload`.

### 2.6 Agent tools

The names the voice or text model sees. Each maps to one capability.

| Tool | Capability |
|---|---|
| `read_catalog` | `catalog.read` |
| `read_business_facts` | `business.facts.read` |
| `quote_order` | `order.quote` |
| `propose_order` | `order.propose` |
| `get_order_status` | `order.status.read` |
| `read_calendar_availability` | `calendar.availability.read` |
| `propose_booking` | `booking.propose` |

There is no tool for any `write` or `external_message` capability. Every tool returns `{ ok: true, ... }` or `{ ok: false, reason }`. Tools sit behind one `ToolHandler` interface with two implementations: the real toolset and the mock toolset.

### 2.7 Tables

The PRD's seventeen tables keep their names: `users`, `businesses`, `business_facts`, `files`, `integrations`, `capabilities`, `agents`, `agent_versions`, `builder_sessions`, `calls`, `orders`, `bookings`, `approval_requests`, `action_executions`, `webhook_events`, `activity_events`, `sync_jobs`.

Four are added: `catalog_items` (P-10), `message_dispatches` (one row per outbound message, for idempotent sending), `live_agent` (which agent answers the phone number, P-06), and `fact_conflicts` (a draft fact that disagrees with an authoritative source; blocks publish while `open`).

Opening hours are stored as one fact per weekday. Barbershop services are stored as facts of kind `service`.

### 2.8 Endpoints

The PRD's endpoint list stands, with these changes. `docs/API.md` is the full list.

| Change | Endpoint |
|---|---|
| Added | `POST /api/agents/:id/test` (mock tools only, P-18) |
| Added | `POST /api/agents/:id/sim-call` (real read and propose tools, published agents only, P-18) |
| Added | `GET` and `PUT /api/live-agent` |
| Added | `GET /api/integrations/health` |
| Added | `GET /api/orders/:id/checkout` (link and QR data for the dashboard) |
| Added | `GET /api/activity` (paged list; live updates come from Supabase Realtime) |
| Added | `POST /api/businesses/:id/catalog/sync` |
| Added | `POST /api/realtime/client-secret` (short-lived key for owner browser voice) |
| Added | `POST /api/agents/:id/rollback` (SHOULD) |
| Added | `POST /api/businesses/:id/catalog/prices/propose` (SHOULD; creates a `price_edit` approval) |
| Added | Single-resource reads: `GET /api/businesses`, `/api/files/:id`, `/api/builder/sessions/:id`, `/api/agents/:id`, `/api/approvals/:id`, `/api/orders/:id`, `/api/bookings/:id` |
| Added at the contract freeze | `GET /api/businesses/:id/catalog`, `GET /api/calls`, `GET /api/calls/:id`, `POST /api/conflicts/:id/resolve` |
| Added at the contract freeze, SHOULD | `GET /api/telemetry`, `POST /api/orders/:id/cancel`, `POST /api/executions/:id/resolve` (P-19) |
| Removed | `GET /api/activity/stream` (P-16) |
| Narrowed | `PATCH /api/businesses/:id` changes name, contact and settings only. Facts change through `POST /api/businesses/:id/facts/propose`. |
| Narrowed | `/webhooks/twilio/status` handles call status, and message status only when the channel is `whatsapp_sandbox`. |

### 2.9 Rulings on shared details

These settle names and numbers that more than one doc uses.

| Topic | Ruling |
|---|---|
| Idempotency key | `sha256(businessId:subjectId:actionType:approvalId)`, the four values joined by colons, hex output. Shorten it only where a provider caps key length, and confirm any cap in spike B-02. |
| Payload hash | Canonical JSON with sorted keys, SHA-256, prefixed `sha256:`. |
| Approval expiry | 10 minutes after creation. |
| Quote expiry | 5 minutes. `Quote` carries `expiresAt`. A proposal made on an expired quote is refused and re-quoted. |
| Retry limits | 3 attempts per execution step, 5 per sync job. |
| Payment poller | Every 30 seconds for 15 minutes after the link is ready. |
| Error codes | The table in `docs/API.md` is the one list. `docs/CONTRACTS.md` exports the same list as `ErrorCode`. |
| Headers | `X-Correlation-Id` on every response. `Idempotency-Key` accepted on the approval decision. |
| Business scope | `businessId` is in the path for `/api/businesses/...` and a query parameter on every other business-scoped route. |
| Upload cap | 10 MB per file. |
| Phone stream | A `streamToken` minted by `/webhooks/twilio/voice` ties the Media Stream to its call. |
| Call channel | `calls.channel` is `phone` or `test_console`. A simulated call creates a `calls` row, so `agentVersionId` always comes from the call. |
| Sidebar | The sidebar item "Activity" opens the Live operations screen. |
| Square signature | Confirm in spike B-02 whether the header value is base64. |
| Order totals | `Order` carries top-level `totalMinor` and `currency`, copied from its quote when the proposal is stored. |
| Booking calendar | `Booking` carries `calendarId`. The no-overlap rule is per calendar and covers `RECHECKING_SLOT` as well as `BOOKED_VERIFIED`, which makes it the local slot lock. |
| Webhook storage | Only signature-verified events are stored in `webhook_events`, so a forged event can never claim a real event ID. A rejected webhook writes a `webhook.rejected` activity event and nothing else. |
| Execution retry | There is no retry state. A retryable failure goes back to `QUEUED` with `attempts` increased. After the limit it becomes `FAILED`. An unknown result becomes `NEEDS_REVIEW`. |
| Fact status | `business_facts.status` is `draft`, `verified` or `superseded`. At most one `verified` row per business, kind and key. |
| Sheets step when never paid | No `action_executions` row and no `sync_jobs` row is created for the Sheets step at approval. The transition into `PAID_VERIFIED` or `BOOKED_VERIFIED` creates the sync job. An order that is never paid has no Sheets row and no pending job. |
| Rejected webhook event | `webhook.rejected` is written against the business that owns the integration the webhook URL belongs to, read from `integrations`. Nothing from the unverified request body is trusted or stored. |
| Fact source type | `sourceType` is one of `square`, `google_calendar`, `owner_chat`, `owner_ui`, `upload`, `seed`. Every uploaded file uses `upload`. The file type lives on the `files` row. |
| Integration health | Provider keys are `square`, `twilio`, `openai`, `google_calendar`, `google_sheets`, `message_channel`. Each entry has `state` and `lastCheckedAt`. |
| Live agent shape | `LiveAgent` is `{ phoneNumber, businessId, agentId, agentVersionId, updatedAt }`. |
| Refusal event | The `guardrail.refused` payload names the rule that fired in the field `rule`. |
| QR-only channel | When `MESSAGE_CHANNEL` is `qr_only`, the message step's execution is `SKIPPED` and no `message_dispatches` row is created. `message_dispatches.channel` is `surge`, `android_gateway` or `whatsapp_sandbox` only. Nothing is ever marked sent that was not sent. |
| Order approval payload | The hashed material fields are `businessId`, `subjectId`, `agentVersionId`, `cartHash`, `totalMinor`, `currency`, `pickupAt`, `messageRecipient`, `messageChannel`, `actionBundle`, `expiresAt`. The full quote and contact are shown to the owner but are not separately hashed. `callId` is not a material field. |
| Catalog shape | The table `catalog_items` has one row per sellable variation. The API and the tools group rows into items, each with a `variations` array. |
| Fact kinds | `hours`, `policy`, `service`, `contact`, `faq`, `menu_item`. A `menu_item` fact comes only from an upload, stays `draft`, and exists to be compared with `catalog_items`. It is never a price source. |
| Hours keys | One `hours` fact per weekday, with keys `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`. |
| Sync target | The Sheets sync target is named `google_sheets`. |
| Not persisted | Quotes made before a proposal and test console sessions live in server memory. A quote is saved inside the order when the proposal is stored. |
| User IDs | `users.id` is a `usr_` text ID. `users.auth_user_id` links to Supabase Auth. |
| Unavailable items | `UNAVAILABLE` is both a call stage (an item is found unavailable while collecting) and an order status (the re-check at checkout finds an item gone). |
| Fulfillment | The server sets `FULFILLMENT_READY` itself once the order is `PAID_VERIFIED` and recorded. There is no "mark ready" endpoint. |
| Catalog sync events | A catalog sync writes `sync.*` events with `target: "catalog"`. It is not a `sync_jobs` row. Only Sheets uses `sync_jobs`. |
| Live agent route | `GET` and `PUT /api/live-agent` are Arsh's, because the phone worker reads that table. Publish (Saina's) can make an agent live by calling the function that route exports. |
| Fields that are also columns | Where a JSON field is stored in a column, the column's name decides the field's name. Enum values and object shapes follow `docs/CONTRACTS.md`. |
| Business location | `Business.contact` is `{ phone?, email?, address? }`. The location is `contact.address`. |
| Resolving a conflict | Keeping the authoritative value (for a price, Square's) marks the conflict `resolved` and the draft fact `superseded`, with no approval, because nothing external is written. Preferring the uploaded price is a price change (`price_edit`, SHOULD). |
| Builder turn response | It always carries `unsupportedRequests: string[]`, and carries `proposedChange: { approvalId, bundleType }` when the turn created an approval. |
| Live agent, empty case | When no agent answers the number, `LiveAgent` has `phoneNumber` and `businessId` only. |
| Square key length | Square's reference caps the idempotency key at 45 characters for `CreatePayment` and 192 for `CreatePaymentLink`. Use the full key for the payment link and its first 45 characters for `CreatePayment` (the fallback path only). |
| Message wording | A customer message ends with the link on its own, with no punctuation after it, so a phone cannot fold a full stop into the link. |
| Comparing timestamps | Schemas compare timestamps as instants with `Date.parse` and allow 2 seconds of slack, never as strings. The server sets an approval's `created_at` and `expires_at` explicitly from one clock reading, so they are exactly 10 minutes apart. |
| Fact verified time | A draft has no `verifiedAt`. A verified fact has one. A superseded fact may or may not, because a draft can be superseded when a conflict keeps the authoritative value. |
| Quote totals | A quote's total is not required to equal subtotal plus tax, because Square can add a discount or a service charge. The total Square returns is the authority. |
| Builder messages | `sessionId` and `inputMode` are required on every builder message. The server fills them on assistant messages. |
| File read | `GET /api/files/:id` returns a bare `FileRecord`. The upload returns `{ file }`. |
| Timestamps sent to the UI | The server sends every timestamp through `toISOString()`. Schemas accept `Z` or a numeric offset. |
| Customer who declines messages | `messageConsent` is a boolean. Without consent there is no recipient and the channel is `qr_only`. |
| Tie-breakers | For a field name no ruling covers, `docs/CONTRACTS.md` wins. For a path or an error code, `docs/API.md` wins. For a table or column name, `docs/DATA-MODEL.md` wins. |

## 3. Architecture

```text
apps/web (Next.js, Saina)  ---- REST + Supabase JWT ---->  apps/server (Fastify)
      ^   \                                                       |
      |    \-- WebRTC voice (owner) --> OpenAI Realtime           |-- REST API, auth check          (Arsh)
      |                                                           |-- builder service               (Saina)
      | Supabase Realtime: activity_events                        |-- policy and approval engine    (Arsh)
Supabase (Postgres, Auth, Realtime) <-----------------------------|-- action executor + job runner  (Arsh)
                                                                  |-- webhooks: square, twilio      (Arsh)
Caller phone -> Twilio number -> Media Stream -> /ws/phone -------|-- phone worker <-> OpenAI Realtime (Arsh)
                                                                  |
                                        Square sandbox, MessageAdapter channel, Google Calendar, Sheets
```

### 3.1 Repo layout and ownership

```text
ai-business-os/
  apps/
    web/              Next.js App Router, Tailwind, shadcn/ui. No API routes.   Saina
      mocks/          MSW handlers and the mock activity feed                   Saina
    server/           Fastify
      src/builder/    builder service, text runner, publish, versions,
                      extraction, owner voice session                           Saina
      src/api/        every other REST route                                    Arsh
      src/policy/     approval engine and policy checks                         Arsh
      src/executor/   action executor and jobs                                  Arsh
      src/adapters/   square, message, calendar, sheets                         Arsh
      src/tools/      real and mock toolsets behind ToolHandler                 Arsh
      src/voice/      Twilio Media Stream and OpenAI Realtime relay             Arsh
      src/webhooks/   square and twilio                                         Arsh
  packages/
    contracts/        Zod schemas, state machines, registry, fixtures           Arsh edits, Saina reviews
    db/               migrations and seeds                                      Arsh
  scripts/            seed, reset, board tooling                                Arsh
  docs/               these documents                                           either, by pull request
```

The builder registers its own routes as a Fastify plugin from `apps/server/src/builder`. The server entry file registers that plugin once (task S-01), so Saina never edits files outside her directories.

### 3.2 Stack

| Layer | Choice |
|---|---|
| Language and tooling | TypeScript, npm workspaces, tsx, vitest, Playwright for UI smoke tests |
| Web | Next.js App Router, Tailwind CSS, shadcn/ui |
| Server | Node 24, Fastify, `ws` |
| Database, auth, live updates | Supabase (Postgres, Auth, Realtime) |
| Jobs | pg-boss on the Supabase session connection. If it fights us, a `jobs` table polled with `FOR UPDATE SKIP LOCKED` |
| Builder model | OpenAI Responses API with strict Structured Outputs. Confirm the model ID at build time |
| Voice model | OpenAI Realtime API, `gpt-realtime-2.1`. Phone: `g711_ulaw` over Twilio Media Streams. Browser: WebRTC with a client secret |
| Payments | Square sandbox, Node SDK `square` v46 (`SquareClient`) |
| Messaging | `MessageAdapter`, channel per D-08 |
| Calendar and Sheets | Google APIs with one service account |
| Hosting | Web on Vercel. Server on Railway or Render, live by hour 6 so webhook URLs never change |

### 3.3 Environment variables

Names only. Values live in `.env.local` and in the host's secret store. They are never committed.

| Variable | Used by |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | web, server |
| `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (the restricted `abos_app` login, D-10) | server |
| `DATABASE_ADMIN_URL` (the owner connection) | migrations and the reset script only |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_MOCK` | web |
| `OPENAI_API_KEY`, `OPENAI_BUILDER_MODEL`, `OPENAI_REALTIME_MODEL` | server |
| `SQUARE_ENVIRONMENT` (must be `sandbox`), `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` | server |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | server |
| `MESSAGE_CHANNEL` (`surge`, `android_gateway`, `whatsapp_sandbox`, `qr_only`), plus that channel's own keys | server |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID`, `GOOGLE_SHEET_ID` | server |
| `PUBLIC_SERVER_URL`, `PORT` | server |

The server refuses to start if `SQUARE_ENVIRONMENT` is not `sandbox` (AC-19).

## 4. Verified vendor facts

Checked against official documentation on 2026-11-13. Anything marked "spike" must be proven by a first-hour spike before code depends on it.

**Square**
- `POST /v2/orders/calculate` returns totals and tax and does not persist an order. It is labelled beta.
- Use `pricing_options.auto_apply_taxes = true`. Never also send `order.taxes`, or tax is applied twice. Use the same choice in the quote and in the payment link so the totals match.
- `CreatePaymentLink` with an `order` object creates the Square order itself. Never also call `CreateOrder`. The response carries `payment_link.id`, `url` and `order_id`.
- Webhook signature: header `x-square-hmacsha256-signature`, HMAC-SHA256 over the exact registered notification URL plus the raw request body, using the subscription signature key. Deduplicate on `event_id`. Respond within 10 seconds. Delivery order is not guaranteed.
- Mark an order paid when the payment is `COMPLETED` and its `order_id`, amount, currency and location match. Do not wait for the order to change state, because it can stay `OPEN`.
- Sandbox takes cards only. Test card `4111 1111 1111 1111`, CVV `111`, any future expiry. Declined card `4000 0000 0000 0002`.
- Changing a catalog price needs the full current object and its current `version`.
- Spike: a forum staff reply says payment links are not fully supported in sandbox. If the link cannot be paid, the fallback is `CreateOrder` plus `CreatePayment` with the sandbox test nonce, labelled as simulated.

**Twilio and messaging**
- US SMS from a new Twilio account does not deliver in this window (errors 30034 and 30032). Telnyx and other API providers have the same carrier rule.
- Surge gives a new account a shared demo number with no registration, capped at 25 outbound messages. Spike: whether a Square link passes the carrier filter is not documented.
- An Android phone running textbee or SMSGate sends real SMS from its own SIM and can be triggered over HTTP.
- Twilio WhatsApp sandbox works the same day. Each recipient texts a join code once.
- Spike: a trial Twilio account probably plays an announcement to callers and accepts calls only from verified numbers.

**OpenAI**
- Realtime API model `gpt-realtime-2.1`. Twilio publishes a Media Streams sample (`twilio-samples/speech-assistant-openai-realtime-api-node`), and the Agents SDK has a Twilio transport in `@openai/agents-extensions`.
- Barge-in: on `input_audio_buffer.speech_started`, clear Twilio's audio buffer and send `conversation.item.truncate`.
- Browser voice on the Realtime API: the server calls `POST /v1/realtime/client_secrets` to mint a short-lived key, and the browser posts its SDP offer to `/v1/realtime/calls` with that key.
- Builder: Responses API, `text.format` of type `json_schema` with `strict: true`, and the `zodTextFormat` helper.

**Google**
- Calendar free/busy and event insert, and Sheets append, work with a service account once the calendar and the sheet are shared to its email address.

## 5. Scope

Decision D-09 sets the scope: the full PRD P0 list, all twenty acceptance criteria, built by two leads with parallel worker agents.

| Tier | What is in it | Acceptance criteria |
|---|---|---|
| MUST | All twelve PRD P0 items. Seeded login and business selector. Builder by text and by browser voice. Upload and extraction for PDF, image, CSV and spreadsheet, with conflict review. Capability registry. Draft spec, preview, test, publish, pause. Pizza phone agent. Approval inbox and action executor. Checkout link, message, verified payment. Barbershop agent on a live call with Calendar. Sheets mirror. Operations dashboard. Live fact edits with a change log. Webhook verification, audit log, business isolation. Automated end-to-end tests. | AC-01 to AC-20 |
| SHOULD | Price change through Square. FAQ-only custom agent. Version compare and rollback. Human fallback call routing. Latency and cost telemetry panel. | none |
| OUT | The PRD's non-goals and its P2 list. Storing audio or transcripts. Real multi-tenant onboarding. | none |

### 5.1 Cut order, used only if a checkpoint fails

Worker agents shorten coding. They do not shorten the steps that need a person (signups, phone calls, paying on a second device, rehearsals) or change what a carrier or a sandbox allows. If a checkpoint in `docs/WORKPLAN.md` fails, cut in this order, which is the PRD's own:

1. Owner browser voice, before phone voice.
2. The Sheets screen details, before the payment flow.
3. Custom agent richness, before the builder interview.
4. The barbershop agent on a live call, replaced by a simulated call and labelled as reduced scope.

The rules in section 1.3 are never cut.

## 6. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Voice path fails or is too slow | Upgrade Twilio and verify the team's numbers. If it still fails, demo the order through a simulated call (P-18) and label it as simulated. |
| Square payment link cannot be paid in sandbox | `CreateOrder` plus `CreatePayment` with the sandbox test nonce, labelled simulated, verified through the same webhook and API reads. |
| No message channel delivers the link | QR code on the Live operations screen. The pitch says the message channel is one adapter. |
| Parallel workers collide or drift | Contract freeze at hour 2, one task per worker in its own worktree, each task names the directories it owns, typecheck in CI, Integration 1 at hour 16. |
| Webhooks do not arrive at the venue | Stable hosted server URL, a phone hotspot, and a reconciliation poller that resolves a missed webhook. |
| Human-gated steps become the bottleneck | The leads do signups, calls and rehearsals themselves and hand everything else to workers. Tasks that need a person are labelled `human`. |

## 7. Honest demo claim

"A business owner can build, publish and monitor agents by conversation. A real phone call ends in a Square sandbox checkout that completes after the owner approves it." Do not say the payment is real money. Do not say the link went by SMS unless it did.
