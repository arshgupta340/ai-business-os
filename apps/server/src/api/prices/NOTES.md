# B-26 integration notes

The price proposal contract has no optional resolvesConflictId. This implementation does not add it. Uploaded price conflicts need a separate contract change to link a price approval to a conflict.

Register pricesPlugin at the server root with injected owner auth, catalog lookup, Square read, approval persistence, and clock ports. OwnerAuthPort must verify the session and ownership of the requested business. ApprovalPort must persist the PENDING owner price_edit approval and approval.requested event atomically using the supplied payload, hash, and creation time.

The requested arsh/integration api/facts directory does not exist in the inspected branch. Its api/routes.ts and api/ports.ts provide the route, auth, and injection reference instead.

Use createPriceAdapter with the existing createSandboxSquareClient result in production. The existing factory returns a narrow interface without catalog.object even though its real Square SDK instance includes it. The price adapter checks the factory runtime brand before adapting that interface. createPriceAdapterForTest is solely for injected fakes.

The executor must call executePriceEditStep only after its ordinary approval and policy checks and persist its result. The handler also checks APPROVED state and the material payload hash. expectedVersion is additive to the requested adapter input so the executor can enforce the approved Square object version.

The handler performs the required cache refresh after verified success. The existing price_edit bundle also names local.catalog.sync as a separate step. Integration must avoid repeating the external price write if cache refresh fails: resume only the read-only cache sync, or mark the bundle NEEDS_REVIEW. Never blindly retry unknown or updated_unverified writes. Repeated adapter calls retain the supplied key and recheck the original approved price and version; a completed update normally fails that precondition without another write.

No real Square provider call was made. Tests use injected fakes. Wiring in app.ts, the existing approval engine, and executor is outside this task's allowed paths.
