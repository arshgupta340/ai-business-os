# Sheets adapter: integration notes

* Wiring. Build the client with `sheets({ version: 'v4', auth })` from `@googleapis/sheets`, scope `spreadsheets`. A test checks at compile time that the real SDK client satisfies `GoogleSheetsClient`.
* The reporting job runner enqueues only on the transition into `PAID_VERIFIED` or `BOOKED_VERIFIED` (SPEC 2.9). An unpaid order never gets a Sheets job. The adapter does not change order or booking state.
* `orderRow` and `bookingRow` return the complete row with the record id in column A. Pass the row unchanged to `appendOnce` with the matching `recordId`. The record id defaults to the order or booking id (FLOWS B29). CONTRACTS 5 says the column holds the sync job's idempotency key instead; pass that key as the second argument if the job runner follows CONTRACTS. The two docs disagree; the lead should pick one.
* Read-then-append is not atomic. It is safe because one sync job exists per record (unique on target, record type, record id, enforced by the job runner). The same read reconciles a retry after an append whose response was lost. Within one instance the adapter also serializes calls per tab.
* Tabs must already exist. The adapter writes the header row into an empty tab. Values use RAW so no value becomes a formula.
* Every provider error or timeout (default 8000 ms) maps to `INTEGRATION_UNAVAILABLE`, retryable. An append that Google does not confirm as one updated row is not reported as success.
* No real Google API was called. All verification uses injected fakes.
