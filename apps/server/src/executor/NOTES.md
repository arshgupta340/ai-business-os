# B-11 integration

All dependencies are injected. Server wiring is intentionally left to the lead because this task may edit only the executor and its tests. No real provider or network call was made.

The queue implementation must fence claims by worker and lease, enforce step order and the three-attempt limit, respect retry delays, and run `outcome.apply` using transaction-scoped subjects in the same transaction as `finish`. Roll back both on failure. Only terminal message outcomes with `continueBundle: true` may unblock local recording. Never blindly reclaim a RUNNING step whose external result is uncertain. If both finish attempts fail because storage is unavailable, lease recovery must send the step to review.

The subjects implementation owns valid server transitions and their domain activity events. Entering BOOKED_VERIFIED must create the unique booking Sheets job. Payment reconciliation elsewhere creates the order Sheets job only upon PAID_VERIFIED. This executor does not create order Sheets jobs or run a payment poller.

Provider bridges must implement the exact ports in types.ts. Checkout must verify the provider total and currency and throw TotalMismatchError on mismatch. Message sendOnce must durably deduplicate dispatchKey and retain UNKNOWN without resending. Calendar must recheck availability, use a deterministic event ID bound to the stored execution key, and reconcile existing events. Its requested port has no idempotencyKey argument, so the bridge must resolve that stored key from bookingId. It throws SlotConflictError with shared AvailabilitySlot alternatives.

Provider errors must identify requestSent, retryable and ambiguity where known. A timeout or uncertain result requires review. An error code alone does not prove that no write happened. Exception text is never stored in activity or outcome diagnostics.

Sheets job claims must serialize each record, honor retry delays and stop after five attempts. authorizeSync must verify the original approved reporting payload and the verified subject state before each append. appendOnce must check the stable record ID column before every attempt, including after an uncertain append. The job runner has no subject mutation port.

square.catalog.price.update and local.catalog.sync deliberately fail with CAPABILITY_NOT_ALLOWED and a not-implemented reason. local.fact.update delegates its approved payload to the subjects port.

Validation uses injected fakes only. No database transaction, real adapter, provider account or server startup wiring was verified.
