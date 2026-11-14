# Notes: Arsh's lane

Running notes for the backend lane: spike results, blockers, and assumptions that are not yet verified. Saina's notes are in `docs/notes-saina.md`.

## Spikes

Each spike is a standalone project with its own README. The README has the steps for a person, a results table to fill in, and a "Not verified without keys" list.

| Task | Folder | State on 2026-11-13 |
|---|---|---|
| B-02 Square | `scripts/spikes/square` | Prepared. Typechecks, 12 tests pass. Not run against Square. |
| B-03 Phone voice | `scripts/spikes/voice` | OpenAI leg proven on 2026-11-13 with `npm run probe`: 11 of 11 checks pass on `gpt-realtime-2.1`. The Twilio leg and a real call are still to run. |
| B-04 Message channel | `scripts/spikes/message` | Prepared. Typechecks, 70 tests pass. Nothing sent. |
| B-05 Google | `scripts/spikes/google` | Prepared. Typechecks, 29 tests pass. Not run against Google. |

Go or no-go for each is still open. Record the result here when the spike has been run.

## Results

### B-03, OpenAI leg (2026-11-13, `npm run probe` in `scripts/spikes/voice`)

Run against `gpt-realtime-2.1` with the same session setup the phone relay uses, with no Twilio.

| Check | Result |
|---|---|
| Session shape accepted: G.711 u-law both ways, voice `alloy`, `server_vad`, one tool | Pass |
| Model speaks first with no caller input | Pass, first audio after 698 ms |
| Audio deltas carry `item_id` | Pass |
| A question triggers the tool (`function_call` in `response.done`) | Pass, 1,121 ms |
| The tool result comes back as speech | Pass, first audio after 812 ms |

Still unverified, needs Twilio and a phone: the Media Stream leg, barge-in by voice and its truncate offset, the Twilio signature through a tunnel, trial account behavior, end-to-end time to first audio on a call.

Builder model: one strict structured-output call on `gpt-6-astra` through the Responses API returned valid JSON. `OPENAI_BUILDER_MODEL` is set to it.

### Twilio account check (2026-11-13, Twilio console)

| Check | Result |
|---|---|
| Account type | Upgraded, pay-as-you-go, auto-recharge on. P-17 is done: callers hear no trial announcement. |
| Number +1 805 215 1344 | Voice, SMS and MMS capable. Inbound voice URL is empty until `PUBLIC_SERVER_URL` exists. Attached to a Messaging Service. |
| Test SMS to a team phone | Failed, error 30034 (US A2P 10DLC, unregistered number). Confirms SPEC 4: Twilio SMS is not a channel for this build. |
| Test outbound call | Pass. API call with inline TwiML `<Say>` to a team phone: status Completed, 6 seconds, STIR/SHAKEN attestation B. Proves the account SID, auth token and number work for voice. |
| Emergency address | Not set. Twilio warns of a 75 dollar charge per emergency call without one. |

## Found while preparing the spikes

- Square: `CreatePayment` caps the idempotency key at 45 characters, `CreatePaymentLink` at 192 (official reference). Recorded in SPEC 2.9.
- Square: the SDK's `WebhooksHelper` does not compare signatures in constant time. Use our own check.
- Square: `ListPayments` has no order filter. Read the order's tenders first.
- Square: on `CalculateOrder`, `pricingOptions` sits on the order object, not on the request.
- Voice: OpenAI's error text can echo part of the API key. Redact before logging.
- Voice: the spike uses a raw WebSocket relay, following Twilio's sample. The Agents SDK Twilio transport was not confirmed for `gpt-realtime-2.1`.
- Message: no provider documents an idempotency key. Our `message_dispatches` row is the only guard against a resend.
- Message: for the Android gateways, `SENT` means the gateway accepted the message, not that the phone sent it.
- Message: end the message with the link on its own. Recorded in SPEC 2.9.
- Google: a booking ID over 44 characters is silently dropped from private extended properties.
- Google: wrap the service account JSON in single quotes in `.env.local`, or give a file path. Double quotes cut the value.
- Google: a school Google account may block service account keys. Use a personal account.

## Blockers

- Every spike waits on keys in `.env.local` (task B-01).

## Doc contradictions found on 2026-11-14

These are additional contradictions found by searching all files under `docs/` against SPEC section 2.9 and migration `0004_runtime_role_and_routines.sql`. They are listed here without fixing the cited statements.

- **Direct database writes:** DATA-MODEL sections 2.14 and 2.17 and FLOWS B17 describe direct approval updates, execution inserts and claims. Migration 0004 gives `abos_app` read access to approvals, executions, dispatches and sync jobs, with mutations through checked `private` routines. DATA-MODEL section 0 acknowledges this, but the later instructions still contradict it.
- **Runtime role and policies:** DATA-MODEL section 4 says the server connects with the service role key and that no table has insert, update or delete policies. Migration 0004 uses `abos_app` and creates runtime policies for its allowed operations. Its grants also allow `abos_app` to read verified webhook records, contrary to the section's "service role only" comment.
- **Sync job columns:** DATA-MODEL section 2.20 omits `approval_id`, `idempotency_key`, `locked_by` and `locked_at` from its SQL. Migration 0004 adds those columns and freezes the sync identity with `retain_identity`.
- **Approval replay:** API section 3.7 says an identical decision does nothing and always emits `approval.decided`. Migration 0004's `decide_and_enqueue` emits no duplicate event on an ordinary replay, but it can repair missing execution rows on a historical partial decision. It also checks the owner and decision reason before accepting a repeat.
- **Expiry boundary and effects:** API section 3.7 uses `now > expiresAt`, and CONTRACTS section 6 says a late decision can expire an approval. Migration 0004 refuses a pending decision at `cutoff >= expires_at` without expiring the row. `expire_approvals` performs the expiry. API section 3.7 also promises a subject status event on every expiry, while the routine writes one only if an awaiting order or booking actually moves.
- **Initial execution status:** FLOWS B17 and DATA-MODEL section 2.14 say every non-Sheets execution is created `QUEUED`. CONTRACTS section 6 says a QR-only message becomes `SKIPPED` when claimed. Migration 0004's `decide_and_enqueue` creates a QR-only message execution already `SKIPPED`.
- **Attempt counting:** FLOWS section 1 and CONTRACTS section 6 describe increasing attempts on a retryable failure. Migration 0004 increments attempts when `claim_execution` or `claim_sync_job` claims a row, not when a failure returns it to the queue.
- **Execution recovery:** CONTRACTS section 6 permits `NEEDS_REVIEW` to move to `SUCCEEDED`, `QUEUED` or `FAILED`, and API section 3.12 describes retry and abandon recovery routes. Migration 0004's `finish_execution` requires a currently `RUNNING` execution with the matching worker and attempt, and its claim routines accept only `QUEUED` rows. It provides no routine for those recovery transitions.
- **Dispatch recovery:** CONTRACTS section 6 permits `UNKNOWN` to move to `SENT` or `FAILED`, and `SENT` to move to `FAILED`. Migration 0004's `update_dispatch` refuses any update from `UNKNOWN` and permits only `DELIVERED` after `SENT`. It also requires a running execution with the matching worker and attempt.
- **Correlation IDs:** FLOWS section 1, CONTRACTS section 7 and DATA-MODEL section 2.21 say call journeys use the call ID as their correlation ID. Migration 0004's `decide_and_enqueue` and `expire_approvals` use the approval ID for their decision, expiry and subject status events, including call journeys.
- **Message wording:** FLOWS B21 puts punctuation and "Sandbox test payment" after the checkout URL. SPEC section 2.9 requires a customer message to end with the link on its own, with no punctuation after it.
- **Empty live agent:** CONTRACTS section 3 requires `agentId`, `agentVersionId` and `updatedAt` on every `LiveAgent`. SPEC section 2.9 says the empty case has only `phoneNumber` and `businessId`. The earlier note in notes-saina under U-02 already flags the required IDs.
- **Builder response example:** API section 3.3 omits `sessionId` and `inputMode` on the assistant message and omits `unsupportedRequests` on the turn response. SPEC section 2.9 requires those fields.
- **Original PRD payload and key:** PRD section 12's approval example uses fields such as `proposalId`, `amountMinor` and `smsRecipient`, omits required material fields and mixes approval metadata into the payload. SPEC section 2.9 defines the exact order payload fields. PRD section 14's example hashes `businessId + proposalId + capabilityId + approvalRevision`; SPEC section 2.9 and migration 0004 use colon-separated `businessId:subjectId:actionType:approvalId`.
- **Original PRD table names and webhook storage:** PRD section 10 lists `orders.amount_minor`, `approval_requests.action_type`, `payload_json`, `activity_events.redacted_payload` and `webhook_events.signature_valid`. SPEC section 2.9's order-total, column-name and webhook-storage rulings require the current DATA-MODEL names and permit only verified webhook rows, with no `signature_valid` column.

## AgentPhone (D-12), 2026-11-14: unverified assumptions and fail-closed choices

Vendor facts are in `docs/notes-agentphone.md`, each with its URL. None was tested: no AgentPhone account exists yet.

- **Voice mode.** The build assumes the AgentPhone agent is set to `webhook` voice mode. In `hosted` mode AgentPhone's own model would answer and no turn would reach us.
- **Turn timing.** A turn is bounded at 20 seconds (AgentPhone's default webhook timeout is 30). If the model is slower, the caller hears a fixed apology and the late answer is dropped; the runner is not cancelled, so a propose tool already running can still store its PENDING proposal. After 1.5 seconds without an answer the caller hears an interim "One moment."
- **No hang-up from our side.** The server never ends an AgentPhone call on its own, matching voice NOTES item 4 (no goodbye is inferred from the transcript). The call ends when the caller hangs up, or by AgentPhone's own silence limit, and `agent.call_ended` closes the call row.
- **Owner decision mid-call.** No documented API pushes speech into a live webhook-mode call, so the decision is spoken at the caller's next turn, in fixed wording that never says paid or booked.
- **Restart.** Call history and the per-call toolset live in process memory, as for sim-call. After a restart the call continues on its pinned version with a fresh history and a fresh fact read.
- **`agent.call_ended` recovery.** AgentPhone sends it once. If processing fails, the stored row is retried every minute by the AgentPhone job and closed as `completed`, since the stored row keeps only the provider call ID.
- **Inbound texts.** Verified, deduplicated and stored with the provider message ID only. There is no inbound-text feature, so nothing else happens and the body is never stored.
- **Delivery status.** There is no receipt webhook. Dispatches on `agentphone` that are SENT within the last 24 hours are matched against up to 300 messages of the number's history every minute. Older messages are not checked. How long AgentPhone keeps history is not documented.
- **Send outcomes.** Only the documented `sent` (and `delivered`) status counts as SENT. Any other status, a timeout, a 5xx or a 409 is UNKNOWN and is never resent; 4xx is FAILED.
- **Health entry.** With `TELEPHONY_PROVIDER=agentphone`, AgentPhone is reported on the existing `twilio` health key ("the phone line your agent answers"), with the detail naming AgentPhone. A separate key would be a contract and web change.
- **Publish binding.** Publish binds `live_agent` to the selected provider's number. The seed still uses `TWILIO_PHONE_NUMBER`, so after switching, publish again.
- **Web app.** `apps/web` has exhaustive `Record` maps of message channels and webhook providers (`integrations-view.ts`, `HealthSection.tsx`) that need an `agentphone` label after the contract change. That is a needs:saina change; until it lands, `npm run typecheck` fails in `apps/web` only.
