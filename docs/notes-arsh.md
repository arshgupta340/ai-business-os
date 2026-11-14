# Notes: Arsh's lane

Running notes for the backend lane: spike results, blockers, and assumptions that are not yet verified. Saina's notes are in `docs/notes-saina.md`.

## Spikes

Each spike is a standalone project with its own README. The README has the steps for a person, a results table to fill in, and a "Not verified without keys" list.

| Task | Folder | State on 2026-11-13 |
|---|---|---|
| B-02 Square | `scripts/spikes/square` | Prepared. Typechecks, 12 tests pass. Not run against Square. |
| B-03 Phone voice | `scripts/spikes/voice` | Prepared. Typechecks, 19 tests pass. Not run on a real call. |
| B-04 Message channel | `scripts/spikes/message` | Prepared. Typechecks, 70 tests pass. Nothing sent. |
| B-05 Google | `scripts/spikes/google` | Prepared. Typechecks, 29 tests pass. Not run against Google. |

Go or no-go for each is still open. Record the result here when the spike has been run.

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
