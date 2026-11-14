# Gap Analysis of the PRD

**Date:** 2026-11-13. **Source:** `docs/PRD.md`, version 1.0.

The PRD is strong on rules: approval before every write, idempotency, webhook verification, honest sandbox labelling. It is weak on the things two people need in order to build in parallel for 24 to 48 hours. This file lists every gap found, what was checked, and how the spec resolves it.

Status values:
- **DECIDED**: Arsh decided it.
- **PROPOSED**: written into `docs/SPEC.md` so work can start. Waiting for Arsh to ratify. The proposal ID (P-xx) points to SPEC section 1.2.
- **OPEN**: needs a decision or a spike result before it is settled.

## 1. Things that would have stopped the build

### G-01. US SMS cannot be delivered in the build window
**PRD says:** the checkout link goes to the customer by Twilio SMS.

**What was checked (official docs, 2026-11-13):**

| Route | Result |
|---|---|
| Twilio trial account | Sends only Twilio's own templates, only to verified numbers. No custom link. |
| Twilio upgraded, unregistered local number | Blocked with error 30034 until A2P 10DLC brand and campaign registration. A week or more. |
| Twilio toll-free, unverified | Blocked with error 30032. Verification review about 3 business days. |
| Telnyx | Same carrier rule. Unregistered 10DLC blocked since February 2025. Toll-free review 1 to 2 weeks. A sole-proprietor path is "typically auto-approved" on paper, about 22 US dollars, but nobody confirms it clears in 48 hours. |
| Sent.dm, Vonage, SignalWire, AWS | Registration required, or trial reaches one verified number only. |
| Textbelt | Shared sender, no registration, but every link must be whitelisted by them first. Turnaround not published. |
| Carrier email-to-SMS gateways | Shut down or being shut down. |
| Surge (surge.app) | New accounts get a shared demo number with no registration. Custom body. Capped at 25 outbound messages. Whether a Square link passes carrier filtering is not documented. |
| Android phone as sender (textbee, SMSGate) | Real SMS from the phone's own SIM, triggered over HTTP, free. Needs an Android phone that stays on. |
| iPhone without a Mac | No confirmed way for a server to trigger a text without a tap. |
| Twilio WhatsApp sandbox | Works the same day. Each recipient texts a join code once. It is not SMS. |

The block is a US carrier rule (The Campaign Registry), not a Twilio rule, so changing API provider does not remove it.

**Resolution:** D-08. One `MessageAdapter`, with the channel as configuration. Spike B-04 tries Surge, then the team's Android phone as the sender, then WhatsApp sandbox, and uses the first one that delivers a Square link to a team phone. The dashboard always shows the link as a QR code as the backup. **Status: DECIDED.** Which channel wins is recorded when B-04 closes.

### G-02. No way to quote tax before approval without a write
**PRD says:** tax comes from Square order logic, and no Square write happens before approval. It names no endpoint that does both.

**Resolution:** P-02. Square `CalculateOrder` (`POST /v2/orders/calculate`) returns totals and tax without creating an order. Use `auto_apply_taxes` in both the quote and the payment link, and compare the two totals before sending the link. **Status: PROPOSED.**

### G-03. The voice stack is named loosely
**PRD says:** "OpenAI realtime/live voice endpoint", and cites a "GPT-Live" guide.

**What was checked:** both products exist. The Realtime API (`gpt-realtime-2.1`) has an official Twilio Media Streams sample and an Agents SDK transport for Twilio. GPT-Live (`gpt-live-1`) is newer and has no official Twilio sample.

**Resolution:** P-03. Realtime API over Twilio Media Streams for the phone, and the same API over WebRTC for owner voice in the browser. Spike B-03 proves the phone path in the first two hours. **Status: PROPOSED.**

### G-04. Scope against the time available
**PRD says:** twelve P0 items and twenty acceptance criteria, for two to three developers.

**Resolution:** D-09. The full P0 list and all twenty criteria are in scope. Both leads run parallel worker agents, so coding time is not the limit. The limits that remain are the steps that need a person and what the carriers and sandboxes allow. The PRD's own cut order is kept in SPEC section 5.1 and applies only if a checkpoint fails. **Status: DECIDED.**

### G-05. No accounts exist
None of Twilio, Square, OpenAI, Google Cloud, Supabase or hosting existed at the start. Signups, verification emails and card entry are human steps that no agent can do. **Resolution:** task B-01 and `docs/SETUP-ACCOUNTS.md`. **Status: DECIDED** (D-06).

### G-06. The backend lane is much larger than the UI lane
Sizing the first task list gave roughly 70 hours of backend work and 30 hours of UI work at human speed, with every risky spike on the backend side. **Resolution:** D-07. Saina owns the builder end to end, including its server code in `apps/server/src/builder`. See `docs/WORKPLAN.md` section 1. **Status: DECIDED.**

## 2. Product behavior the PRD leaves undefined

| ID | Gap | Resolution | Status |
|---|---|---|---|
| G-07 | The demo says "change this item price", but Square is the source of truth for prices and the registry has no catalog-write capability. | P-05. The live-edit demo changes opening hours, a local fact. Price change is the SHOULD-tier capability `catalog.price.update`, with its own `price_edit` bundle. | PROPOSED |
| G-08 | One phone number, but two agents that both take calls. | P-06. One number, with a "live agent" switch in the dashboard. | PROPOSED |
| G-09 | What the agent says while the owner has not yet approved, and how long an approval lasts. | P-07. The agent says the shop will confirm and a payment link will follow. The call may end. Approval expires after 10 minutes. | PROPOSED |
| G-10 | The booking flow never tells the customer the booking was confirmed. | P-08. A confirmation message through the same `MessageAdapter`. | PROPOSED |
| G-11 | "All fact writes require owner approval", but the owner is the one making the edit. | P-09. It is a confirmation. It reuses the approval table with `actor_type = owner`. | PROPOSED |
| G-12 | "Knowledge snapshot" and how it relates to the live Square catalog. | P-10. A local `catalog_items` cache, synced at seed, publish and on demand. Quotes always come from Square. | PROPOSED |
| G-13 | The document extraction pipeline. | P-12. PDF, image, CSV and spreadsheet. One structured-output call per file. Draft facts with a confidence value. A draft that disagrees with Square becomes a conflict that blocks publish. | PROPOSED |
| G-14 | What a "custom agent" is. | P-13. Any validated subset of registered capabilities. One FAQ-only example, as a SHOULD item. | PROPOSED |
| G-15 | One tenant or two. | P-14. One owner, two seeded businesses, a simple selector. | PROPOSED |
| G-16 | The second agent was an unconfirmed assumption (salon). | D-03. Barbershop booking agent. | DECIDED |
| G-17 | What happens to the customer when the owner rejects or the approval expires. Any message to the customer is itself a write. | Not messaged in this build. The order shows as `REJECTED` or `APPROVAL_EXPIRED` on the dashboard. The agent's wait script already tells the caller that the shop must confirm. | PROPOSED |
| G-18 | The story says the owner is too busy to answer the phone, yet the owner must approve every order. | No change to the rule. The pitch presents approval as one tap, and standing approval policies as the roadmap. | Noted |

## 3. Engineering the PRD does not specify

| ID | Gap | Resolution | Status |
|---|---|---|---|
| G-19 | Repo layout and who owns which directory. | SPEC section 3.1 and `.github/CODEOWNERS`. | PROPOSED |
| G-20 | pg-boss needs a process that stays up. Vercel cannot host one. | P-11. One persistent Node server for API, webhooks, phone WebSocket and jobs. | PROPOSED |
| G-21 | How the dashboard gets live updates. | P-16. Supabase Realtime on `activity_events`. No custom SSE endpoint. | PROPOSED |
| G-22 | Environment variables. | SPEC section 3.3 and `.env.example`. | PROPOSED |
| G-23 | Webhook URLs must not change, because Square signs over the exact registered URL. | Server deployed to a host by hour 6. A reserved tunnel domain for local voice debugging only. | PROPOSED |
| G-24 | Google credential type. | P-15. One service account, with the calendar and the sheet shared to it. | PROPOSED |
| G-25 | A frozen contract so the UI can be built before the backend exists. | `docs/CONTRACTS.md`, `docs/API.md`, fixtures and a mock layer (tasks S-02, S-03, U-02). | PROPOSED |
| G-26 | Rules for two Claude Code sessions in one repo. | `CLAUDE.md` and `docs/WORKPLAN.md`: branch names, directory ownership, how to claim a task, contract-change rule. | PROPOSED |
| G-27 | Square marks payment on the payment object. The order can stay `OPEN`. The PRD's wording could lead to waiting on the order state. | Reconcile on the payment reaching `COMPLETED` with matching order ID, amount, currency and location. | PROPOSED |
| G-28 | Square payment links may not be fully supported in sandbox (forum staff reply). | Spike B-02 in the first hours. Fallback: `CreateOrder` plus `CreatePayment` with the sandbox test nonce, labelled simulated. | OPEN until B-02 |
| G-29 | A trial Twilio account probably plays an announcement and only accepts verified callers. | P-17. Upgrade the account, about 20 US dollars. Arsh's spending decision. | PROPOSED |
| G-30 | Demo logistics: a second device to pay on, venue network, rehearsal resets. | Second phone for checkout, a hotspot, the reset script (B-10), three rehearsals (S-06). | PROPOSED |
| G-31 | Model IDs in the PRD are not pinned. | `OPENAI_BUILDER_MODEL` and `OPENAI_REALTIME_MODEL` are environment variables. Confirm both IDs during B-01. | PROPOSED |

## 4. Gaps found while writing the contracts

Writing the schemas, endpoints, tables and flows side by side exposed contradictions that reading the PRD alone did not. Each is settled in `docs/SPEC.md` section 2.

| ID | Gap | Resolution | Status |
|---|---|---|---|
| G-32 | AC-03 says a preview makes no real writes, but there was no way to exercise a published agent in text against real tools. | P-18. Two endpoints: `test` (mock tools only) and `sim-call` (real read and propose tools, writes still need approval). End-to-end tests use `sim-call`. | PROPOSED |
| G-33 | The PRD's order bundle includes the Sheets row, which would run at approval, before any payment exists. | The approval authorizes the row, but it is written when the order reaches `PAID_VERIFIED` or the booking reaches `BOOKED_VERIFIED`. | PROPOSED |
| G-34 | "Action type" meant both the kind of bundle and a single step. | The approval field is `bundleType`. `actionType` is one step. SPEC 2.3 maps each step to its capability. | PROPOSED |
| G-35 | The order states before approval describe a conversation, but no order row exists yet. | Those states live on the call, in `calls.stage`. The order or booking row is created by the propose tool. | PROPOSED |
| G-36 | No order state covered a message that fails, or a QR-only channel. | The order goes from `PAYMENT_LINK_READY` straight to `PAYMENT_PENDING`. A failed message never fails the order. | PROPOSED |
| G-37 | The PRD wants an event for every transition, but the event list had none for plain status changes. | `order.status_changed` and `booking.status_changed` are written on every transition. | PROPOSED |
| G-38 | The PRD's `signature_valid` column implies forged webhook events are stored, which lets a forgery claim a real event ID first. | Only verified events are stored. A rejected webhook writes a `webhook.rejected` event. | PROPOSED |
| G-39 | The execution state machine had no retry path. | A retryable failure returns to `QUEUED`. Limits: 3 attempts per step, 5 per sync job. | PROPOSED |
| G-40 | A booking had no calendar field, so "no double-booking" could not be a database rule. | `Booking.calendarId`, with a no-overlap rule per calendar that also covers `RECHECKING_SLOT`. | PROPOSED |
| G-41 | Quotes had no lifetime, so a caller could confirm a stale total. | A quote expires after 5 minutes and is re-quoted. | PROPOSED |

## 5. PRD items confirmed as sound

These were checked and need no change.

- Capabilities are a server-owned registry, and the model cannot add one or change its effect.
- The deployed agent and the builder agent have disjoint tools.
- Approval binds to a hash of the exact payload, is one-use and expires.
- `CreatePaymentLink` with an `order` object creates the Square order, so there is one order creation path.
- Square webhook verification as described matches the official method.
- Sheets is a reporting mirror and never the source of truth.
- The cut order in PRD section 18 matches the tiers here.
