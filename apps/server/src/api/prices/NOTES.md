# B-26 integration notes

The price proposal contract has no optional resolvesConflictId. This module does not add it. Uploaded price conflicts need a contract change before a price approval can link to a conflict.

Register pricesPlugin at the server root with injected owner authentication, catalog lookup, Square read, checked approval creation, and one clock. OwnerAuthPort must verify the session and ownership of the requested business. The configured Square location must be bound to that business during composition. The route does not call Square upsert.

The requested arsh/integration api/facts directory does not exist in the inspected branch. Its api/routes.ts and api/ports.ts provide the route, auth, and injection reference instead.

ApprovalPort maps to one checked restricted-role database routine, `create_pending_price_edit_approval`. That routine must verify owner and business scope, derive canonical material payload JSON and its hash, insert only a PENDING approval, append approval.requested atomically, and enforce the one-PENDING-per-subject constraint. It must return the existing approval for an identical repeat and `conflict` for a different pending proposal. The database migration and routine implementation belong to the database and approval-engine owner. Do not grant general DML to the application role to work around a missing routine.

The action executor must claim and renew its lease, then call executePriceEditStep with the stored stable key and attempt number. It must persist SUCCEEDED, QUEUED, FAILED, and NEEDS_REVIEW through its checked execution-result routine. It must never write action_executions directly. After the Square step is persisted SUCCEEDED, it must run executeCatalogSyncStep for the existing separate local.catalog.sync execution. A cache-sync failure queues or fails that local step and never changes the confirmed Square step. The executor's recovery routine must use reconcilePriceEditStep for a NEEDS_REVIEW price write: it may mark SUCCEEDED when a read proves the approved price is present, QUEUED only when a read proves the approved write did not happen, or leave NEEDS_REVIEW. It must not retry Square upsert to resolve uncertainty.

Use createPriceAdapter with createSandboxSquareClient in production. createPriceAdapterForTest rejects every non-plain, unmarked fake client, including real Square SDK clients. It exists only for unit tests. The adapter updates only the configured location override and preserves the global price and other location overrides.

Before live integration, extend the approved sandbox spike to establish UpsertCatalogObject idempotency-key limits, read-after-write visibility, valid pricing-type shapes, and response-error classification. The implementation treats only an HTTP 429 as a proven non-write retryable rejection. Other write transport errors and returned error arrays remain uncertain and require review. No provider test was performed here.

Human fallback proposal for owner ratification: it needs no per-call owner approval, but it may run only when the fallback number is a verified business fact, the active published agent version enables fallback, and the call is bound to an active call record for that business. One provider call uses one stable key. The B-26 price module has no fallback path and cannot enforce this outside its injected ports.

No real Square provider or database call was made. Tests use injected fakes. Wiring in app.ts, the existing approval engine, and executor is outside this task's allowed paths.
