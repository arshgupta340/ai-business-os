# B-14 integration notes

The executor must call sendOnce only after checking approval of the exact recipient and body. No approval engine, environment wiring or database implementation was changed in this task.

Inject fetch and the channel configuration into createMessageAdapter. Missing-setting errors use the corresponding environment variable names. No provider or network was contacted during verification.

MessageStore.recordAttempt must commit an atomic insert under a unique idempotency key before returning true. It must never replace an existing row. The store supplies business, execution, subject and template metadata from the approved execution. A QUEUED or UNKNOWN replay needs review. A FAILED key is also consumed, as required by CONTRACTS section 5.

QR-only returns SKIPPED without validating an absent recipient or creating a dispatch row. The caller must persist SKIPPED on the execution, not on message_dispatches.

Live provider delivery remains unverified. The provider constants blocks retain the spike assumptions, including the disputed SMSGate local path and its 36-character id limit. SMSGate receives the first 36 characters of the stable key; local dedupe uses the full key. Surge metadata is tracing only. WhatsApp requires the recipient to join the sandbox and have an active messaging window.

SENT means provider acceptance with a message id, not confirmed delivery. Only a separate verified provider callback may mark DELIVERED. Timeouts, 5xx, HTTP 408 and HTTP 409 return UNKNOWN and are never retried here. Provider errors map to contract error codes, with raw errors omitted to protect recipients and credentials.

Checkout wording follows SPEC 2.9 over the older FLOWS example: the sandbox test payment notice precedes the final URL on its own line. Booking confirmations have no link input and include only business, service, local start and timezone. They also end without punctuation, so every template follows one rule. Templates refuse an empty field, a field with a line break, a non-http link and a link that ends in punctuation.

Surge's demo cap (403 with error type demo_message_limit) maps to FAILED with RATE_LIMITED. The error body is read only to pick the code and is never returned. Whether the demo number accepts settings and metadata is still unconfirmed.

The WhatsApp sender defaults to the Twilio sandbox number +14155238886 when TWILIO_WHATSAPP_FROM is not set.

maskRecipient(to) returns the last four digits for any caller that logs a recipient. This adapter itself writes no log lines.
