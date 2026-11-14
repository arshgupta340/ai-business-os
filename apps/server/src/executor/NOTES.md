# B-11 integration

All dependencies are injected. Server wiring is left to the lead because this task may edit only the executor and its tests. No real provider or network call was made.

## Queue

`claimNext` fences claims by worker and lease, enforces step order and the three-attempt limit, and respects retry delays. `finish` runs `outcome.apply` with transaction-scoped subjects in the same transaction as the status change, and rolls back both on failure. A worker finishes a step only as SUCCEEDED, FAILED, NEEDS_REVIEW or QUEUED, never SKIPPED. Only terminal message outcomes with `continueBundle: true` may unblock local recording. `outcome.externalRef` goes on the execution row: the Square order ID for checkout, the provider message ID for a message, the Google event ID for calendar.

`recoverStale({ olderThan })` is the only recovery for a crash: leases have no timeout, so the lease row needs a claimed-at time. In one conditional update it moves each step RUNNING under a lease claimed before `olderThan` to NEEDS_REVIEW, never back to QUEUED. It sets continueBundle for message steps, and moves the subject as a failed step would (checkout: `RECOVERY_REQUIRED`, calendar: `RETRY_REQUIRED`). The executor calls it at the start of every tick with `staleAfterMs` (default 15 minutes, well above any provider timeout).

## Subjects

The subjects implementation owns valid server transitions and their domain activity events.
- `saveCheckoutLink(businessId, orderId, executionId, refs)` is called from Square's `onLinkCreated`, before the total is verified. One transaction: Square order ID and payment link ID on the order and the execution row, the URL on the execution row only. No state change, and nothing customer-facing shows the link.
- `completeCheckout(businessId, orderId, refs)` runs inside `finish`: refs and URL on the order, state `PAYMENT_LINK_READY`.
- `saveEvent` runs inside `finish` for the calendar step. Entering `BOOKED_VERIFIED` must create the unique booking Sheets job. Payment reconciliation creates the order Sheets job on `PAID_VERIFIED`.

## Adapters

- Checkout: `createCheckout({ order, idempotencyKey, approvedTotalMinor, currency, onLinkCreated })` and read-only `resumeCheckout`. Errors carry `outcome` (`not_created` requeues; `unknown` and `created_unverified` go to review) or `orderState: 'RECOVERY_REQUIRED'` (stop, no message). A saved Square order ID makes the handler resume by reading, never create. Once `onLinkCreated` ran, nothing retries.
- Messages: `sendOnce({ executionId, workerId, dispatchKey, to, body })` returns the message layer's `SendOnceResult`. The bridge builds the `MessageStore` for that execution and lease. SENT or DELIVERED counts only with a provider message ID; QUEUED, UNKNOWN or malformed results go to review; SKIPPED (channel set to qr_only after approval) fails the step with the bundle continuing.
- Calendar: the adapter's own `createEvent` result shape, with `idempotencyKey` set to the stored step key. A retryable failure requeues, which is safe because the adapter looks the event up by that key before inserting.
- Sheets: the adapter's own `ReportingResult`; the bridge adds `sheetId` and `tab`. A definite refusal fails at once; other failures retry up to five times. The job runner has no subject mutation port.

## Known gaps

- B18's item availability recheck has no port here. If the checkout bridge reports `ITEM_UNAVAILABLE`, the order moves to `UNAVAILABLE`.
- A step refused on its pre-call reauthorization leaves the order in `CREATING_CHECKOUT` with the step FAILED.
- If the sync job's `finish` throws, the job stays RUNNING; the sync queue needs its own lease recovery.
- `square.catalog.price.update` and `local.catalog.sync` fail with CAPABILITY_NOT_ALLOWED and a not-implemented reason.

Validation uses injected fakes only. No database transaction, real adapter, provider account or server wiring was verified.
