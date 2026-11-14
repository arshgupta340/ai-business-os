# B-32 recovery wiring

Register `createRecoveryPlugin(ports)` after the existing owner auth guard. It reads `request.ownerUserId` and independently verifies business ownership. No app.ts or compose changes were made.

Supply the interfaces in types.ts. `withRecovery` must serialize the subject and execution across processes and atomically commit checked routines, durable replay receipts and `tx.activity.write`. Roll back all three on failure. Keep provider lookups bounded. Fence running or uncertain work before local cancellation. Cancellation never cancels a Square link, refunds money or messages a customer.

Bridge `lookup` to read-only provider lookups that verify the exact approved material. Return `unknown` when absence cannot be proven. `resolve` must atomically save verified references, apply valid subject transitions and resume approved downstream work through the executor. A recovered calendar event also needs the booking and unique Sheets job handled by checked routines. Never report success from an ID alone.

Bridge `authorizeRetry` to current-material policy checks. Preserve attempts and every stored key. `retryMessage` queues the existing dispatch through the message worker with the same dispatch key. Never resend SENT or DELIVERED dispatches. Replay receipts must survive restart and return current state without another event or enqueue. A later failed worker attempt is a new recovery generation, still using the original provider key.

Bridge `reconcilePayment` to B-13 verification and checked payment routines. It runs outside the recovery lock and commits independently, so refusal to cancel cannot undo a verified payment. Re-read under the cancellation lock afterward.

Only the two API 3.12 SHOULD routes are registered. No new payment, resend, approval or mark-ready route exists. Protected tables require routines, never direct DML. Routine and production port implementations belong to the integration worker. The shared execution machine currently has no FAILED recovery transitions; booking and definite message retries need additive recovery transitions in contracts and checked routines. Checkout recovery also needs its RECOVERY_REQUIRED retry transition wired. These changes are outside this task. Downstream work must pass original-approval policy before being queued.

Validation uses injected fakes only. No provider, live database, process restart or production wiring was integration-tested.
