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

Fifteen contradictions between the docs and SPEC section 2.9 or migration `0004_runtime_role_and_routines.sql` were listed here on 2026-11-14. This table says what happened to each one. Every changed sentence was checked against migrations 0001 to 0004, `packages/db/src/runtime.ts` or SPEC 2.9.

| # | Item | File and section changed | Result |
|---|---|---|---|
| 1 | Direct database writes | DATA-MODEL 2.14, 2.17, 2.18 and 2.20. FLOWS section 1 (new paragraph "Database routines"), B14, B17, B21, B28, B29, C5, C9, C11, D3, E2, section 3.3 rule 2 and the section 4 branches. | Fixed. Each place names the `private` routine instead of an insert or update. |
| 2 | Runtime role and policies | DATA-MODEL section 4 | Fixed. The server is `abos_app`, with the `runtime_*` policies listed table by table. |
| 3 | Sync job columns | DATA-MODEL 2.20 and section 8 | Fixed. The SQL shows `approval_id`, `idempotency_key`, `locked_by` and `locked_at`, and the text describes the `retain_sync` trigger. |
| 4 | Approval replay | API 3.7 steps 3 and 4 and the events line. FLOWS B17 and section 4 "Owner double-clicks Approve". CONTRACTS section 6, Approval. | Fixed. One thing is left unstated: the API error code for a repeat that differs only in `reason`. The routine raises `DECIDED: conflicting repeat`, and the decision route that maps it to a code is not in this checkout. |
| 5 | Expiry boundary and effects | API section 2 (`APPROVAL_EXPIRED`), 3.7 step 4 and the background job sentence. CONTRACTS section 4 rules and section 6, Approval. FLOWS B17 and section 4 "Approval expires". | Fixed. |
| 6 | Initial execution status | FLOWS B17, B21 and C9. DATA-MODEL 2.14 and 2.17. CONTRACTS section 6, Execution table. API 3.7 step 5. | Fixed. |
| 7 | Attempt counting | FLOWS section 1 "Retries" and section 3.3 rule 2. CONTRACTS section 6, Execution table and Sync job. DATA-MODEL 2.17. | Fixed in those files. SPEC 2.9 "Execution retry" was not edited; see the list below. |
| 8 | Execution recovery | CONTRACTS section 6 (paragraph under the Execution table). API 3.12. FLOWS section 1 "Retries". DATA-MODEL 2.17. | Fixed by saying what migration 0004 allows today and that migration 0005, not yet applied, changes it. The three rows out of `NEEDS_REVIEW` stay in the table, because `packages/contracts/src/state-machines.ts` still defines them. |
| 9 | Dispatch recovery | CONTRACTS section 6 (paragraph under the Message dispatch table). DATA-MODEL 2.18. API 3.12. | Fixed the same way. The rows stay in the table for the same reason. |
| 10 | Correlation IDs | FLOWS section 1 "Correlation". CONTRACTS section 7. DATA-MODEL 2.21. | Fixed. |
| 11 | Message wording | FLOWS B21 | Fixed. The template now ends with the link on its own line. |
| 12 | Empty live agent | CONTRACTS section 3, `LiveAgent` | Fixed. It now matches `LiveAgentSchema` in `packages/contracts`. |
| 13 | Builder response example | API 3.3 | Fixed. |
| 14 | Original PRD payload and key | None | Left as written. The PRD is kept verbatim. SPEC 2.9 already states both rulings in the rows "Idempotency key" and "Order approval payload", so no row was added. |
| 15 | Original PRD table names and webhook storage | None | Left as written. The PRD is kept verbatim. SPEC 2.9 already states the rulings in the rows "Order totals", "Webhook storage", "Fields that are also columns" and "Tie-breakers", and SPEC 2.3 names `bundleType`. No row was added. |

### Found in a second search on 2026-11-14, not fixed

These statements under `docs/` also disagree with migration 0004 or SPEC 2.9. They are listed only.

- **Slot conflict at approval:** CONTRACTS section 6 (Booking table) and FLOWS X1 say an overlap found when the owner approves leaves the approval `APPROVED`, the booking `SLOT_CONFLICT` and the calendar step `FAILED`. In `decide_and_enqueue` the booking moves to `RECHECKING_SLOT` inside the same call as the decision, so a `bookings_no_overlap` violation aborts the whole call. The approval stays `PENDING` and no execution row exists. What the server does after that error was not checked, because the decision route is not in this checkout.
- **Checkout references on the execution row:** FLOWS B18 and section 3.3 rule 6 say the payment link ID, URL and Square order ID are saved on the `square.checkout.create` execution row. In migration 0004 that row has one `external_ref` column, `abos_app` cannot update the table directly, and only `finish_execution` writes `external_ref`.
- **Delivery callbacks:** API section 4 says the Twilio status webhook updates `message_dispatches`, and CONTRACTS section 6 has a delivery callback move `SENT` to `DELIVERED` or `FAILED`. `update_dispatch` works only while the message step is `RUNNING` under the calling worker and attempt, and it refuses `SENT` to `FAILED`, so a callback that arrives after the step has finished cannot change the row.
- **Hash check before every step:** CONTRACTS section 4 says the executor recomputes the hash from current rows before every step. `claim_execution` checks the subject against the payload only for the first step, and `record_dispatch` checks it for a message step. Whether the executor does more itself was not checked.
- **SPEC wording on attempts:** SPEC 2.9 "Execution retry" says a retryable failure goes back to `QUEUED` with `attempts` increased, which reads as if the failure adds the attempt. Migration 0004 adds it on the claim. The ruling was not edited.
- **Empty live agent in API:** API 3.6 and 3.12 say `agentId` and `agentVersionId` are absent when no agent answers. SPEC 2.9 says the empty case has `phoneNumber` and `businessId` only, so `updatedAt` is absent too.
- **Webhook processing columns:** DATA-MODEL 2.19 lists `processed_at` and `process_error`. Migration 0004 gives `abos_app` select and insert on `webhook_events` but no update, so the server cannot set them.
- **Fallback jobs table:** DATA-MODEL section 7 defines a `jobs` table with the comment "service role only". No migration creates it and `abos_app` has no grant on it.
- **SQL blocks in DATA-MODEL section 2:** the block in 2.14 leaves out `payload_canonical` and its three constraints, 2.15 and 2.16 leave out `unique (id, business_id)`, 2.17 leaves out `unique (id, approval_id, business_id)`, and 2.18 leaves out the unique `execution_id` and the composite foreign keys. Section 0 already says the migrations win, but it does not name these.

## Database stores for uploads (2026-11-14, branch `arsh/uploads-db-stores`)

`apps/server/src/compose/builder-extraction.ts` gives the builder's document extraction database stores. Not verified, or decided without a ruling:

- **Tested on the in-process Postgres only.** Every query ran as `abos_app` on PGlite. None ran against the Supabase database or through the `pg` driver. The statements use the same forms the other compose stores use (`$n::jsonb`, `= any($n::text[])`, `clock_timestamp()`).
- **File contents are not stored anywhere.** `files` has no column for them and no bucket is wired. The bytes stay in the server process from the upload until that file's extraction ends, then they are dropped. A restart during an extraction loses them: the row stays `PENDING` or `EXTRACTING`, and nothing moves it to `FAILED`.
- **A failed file is replaced, not re-run (my decision, not in SPEC).** The builder re-runs a `FAILED` file from its stored bytes when the same file is uploaded again. With no stored bytes, the new upload replaces the failed row instead: the old `files` row is deleted, a new one is inserted with a new `file_` ID, and draft facts of the old row move to the new one. The same happens to a row left `PENDING` or `EXTRACTING` for more than 15 minutes whose bytes this process does not hold. The 15 minutes is a guess from the extractor's 60 second timeout with one retry. With several server processes, a row another process has been extracting for more than 15 minutes would be replaced under it.
- **An uploaded draft is never marked `superseded`.** The check `(status = 'draft') = (verified_at is null)` and the index `business_facts_version` refuse it for a fact that was never verified. After "keep the current value" the conflict row is `resolved` and the draft stays `draft`. Deleting it is not possible either: `abos_app` has no delete on `business_facts`.
- **A draft and its conflict are two statements.** DATA-MODEL section 5 says "in the same transaction". The builder's service calls the fact store and then the conflict store, so a crash between the two leaves a draft with no conflict row.
- **`StoredFile.failureReason` is not stored.** `files` has no column for it. It is kept in the process and nothing but a builder test reads it.
