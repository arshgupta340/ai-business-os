# B-13 integration notes

Register webhooksPlugin with WebhookDependencies in app.ts. Configure the exact registered Square and Twilio URLs. Environment loading must enforce Square sandbox. App registration and environment files were outside this task.

Implement the injected ports with the database and adapters. OrdersPort.withLockedOrder must lock and re-read across processes and atomically commit or roll back the payment ID, state changes, activity and unique local Sheets job. Its activity and sync ports must share that transaction. SyncPort.queueOrder must check the original order approval, preserve the Sheets idempotency key, insert one unique job and emit sync.queued. It must not call Sheets directly.

Supply PaymentOrder.locationId from the stored approved integration and linkReadyAt from checkout creation, never updatedAt. Resolve early Square references from checkout execution rows too. SquarePort.verifyPayment must read Square afresh. verified:true means COMPLETED with all four expected fields matching. Prefer a mismatch field over status when both fail. A later verified success can recover PAYMENT_FAILED. Paid and terminal orders cannot regress.

WebhookStore.recordOnce must enforce unique source/event ID and retain pending rows until job completion. JobsPort.enqueue runs after the HTTP response and must persist the webhook row ID, retry failures and recover pending rows after crashes or enqueue failures. Rebuild jobs through processSquareEvent or processTwilioStatus. Injected closures alone are not durable storage. Log sanitized fixed messages only.

CallsPort.endOnce must share its conditional terminal update with stream stop. DispatchPort.updateStatus must prevent terminal regression. Use a transaction or outbox for crash-safe Twilio activity delivery. Only whatsapp_sandbox dispatches are updated.

Schedule pollPendingPayments every PAYMENT_POLL_INTERVAL_MS. Polling stops at PAYMENT_POLL_DURATION_MS after link creation and leaves unpaid orders unpaid. Scheduler wiring was outside this task.

The task explicitly requires mismatches to leave the order unpaid, so they emit guardrail.refused without changing PAYMENT_PENDING, overriding the CONTRACTS recovery-state row. Local transport port types have no equivalent exported contract; domain types, events, errors, routes and timing use @abos/contracts.

All tests use injected fakes and Fastify inject. Live providers, database locking and durable queue recovery were not integration-tested. No provider was called, and no voice route or WebSocket was created.
