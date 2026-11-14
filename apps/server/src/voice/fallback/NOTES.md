# B-28 integration notes

Only the assigned fallback source and test directories changed. No provider was called.

## Owner-ratification proposal

Human fallback is not one of the four approval-gated external writes: Square, customer messaging, Calendar, and Sheets. It needs no per-call owner approval. It is allowed only when all three conditions hold: the fallback number is a verified business fact, the published agent version pinned to the call enables human fallback, and the call is bound to an active phone call record for that business. The checked routine below must enforce all three conditions and fail closed. The owner must ratify this exception and its one-provider-call-one-stable-key policy in SPEC before deployment.

## Required checked routines and ports

The fallback module does not permit direct table writes. The migration owner must add the two checked routines below for the restricted application role. Each port maps to exactly one routine call.

1. `fallback.reserve` locks the stored phone call by business ID, call ID, and provider call SID. It requires matching business, `IN_PROGRESS` status, phone channel, a published pinned version with human fallback enabled, and one verified `contact/fallback_phone_number` fact with `verified_at`. It creates or returns one immutable operation keyed by the provider call SID. A different local call ID for the same provider SID returns no reservation. It stores the fallback reason, fact ID/version, destination last four digits only, and a stable operation key. It must not log a full number, TwiML, token, or provider error body.
2. `fallback.begin_dispatch` receives the reserved operation key and exact TwiML material. In the same transaction it rechecks `IN_PROGRESS`, verifies the reservation binding, records an exact-payload hash, and marks dispatch started. It returns false when a terminal transition or prior dispatch won. The port receives an AbortSignal and must not begin work after it is aborted.
3. `outcomes.record` is one checked routine that resolves the reserved operation, conditionally changes the matching active call to its verified terminal state, and inserts exactly one `call.ended` event. It must deduplicate replays and competing stream, status-webhook, and fallback writers. The module only builds the contract event. It cannot demonstrate durable state without this routine and restricted-role database tests.

These are distinct from the execution recovery routines in the current migration work. They must be added by the database and backend owner, not simulated in this module. Until then, any production adapter must return null or false and fallback remains blocked.

## Voice wiring

1. Inject one long-lived router after Twilio signature verification and existing provider-call deduplication. IDs must come from the verified integration or stored call context, never request text.
2. Create and bind the call before a fallback attempt. The existing missing-live-agent branch lacks a persisted agent/version for a never-published number. The voice and data owners must provide a reviewed additive schema path for that case. Do not fabricate IDs.
3. Invoke `route` for the trusted fallback signals described in the task. Pass `callerRequestedPerson` only from a trusted tool or refusal outcome. Never parse caller text. In the relay, invoke it before shutdown for pre-ready model setup failures and phone back-pressure, and maintain validated per-call guardrail and tool-failure counts.
4. `webhook` results return TwiML. `stream` `redirect` results are submitted once with `client.calls(providerCallId).update({ twiml })`. The adapter must honor AbortSignal before initiating that request and never log its instruction. `redirect_unknown` means no retry: reconcile through the stored operation and provider evidence. `blocked` means close the local relay without changing the provider call.
5. The router has an 800 ms total deadline. Required port operations receive AbortSignal. On a timeout before provider update, it fails closed. On a timed-out call update, it returns `redirect_unknown`, retains the dispatch record, and does not retry.
6. On a verified, deduplicated terminal provider callback, call `complete`. `COMPLETED` means the call ended, not that a person answered. Do not write normal stream terminal state after a fallback dispatch begins. The database routine decides the one winner.

## Unverified Twilio behavior

SPEC section 4 and the voice spike do not prove Dial bridging, the 20-second ring timeout, caller ID restrictions, Hangup after Dial, inline Calls.update interrupting a bidirectional Connect/Stream, stream stop and close ordering, or terminal status delivery after forwarding. Local SDK types support Dial callerId and timeout and inline TwiML updates, but this is not a live test. A person must test answer, busy, no-answer, failed and ambiguous update, and stream redirection with the actual account before release.
