# @abos/db

PostgreSQL migrations and checked runtime routines for AI Business OS. Names follow `docs/SPEC.md`. No provider call happens inside a database routine.

## Migrations

Apply as the migration administrator, using a session connection:

```sh
npm run migrate -w @abos/db
```

The runner checks out one client, takes an advisory lock, applies each new file in its own transaction and records its checksum in `public.schema_migrations`. A second run skips recorded files without changing data or schema. Changed applied files are refused. A failed file rolls back. Do not mix the runner with unrecorded SQL editor application.

| File | Purpose |
|---|---|
| `0001_extensions_and_helpers.sql` | Extensions, private schema, closed default privileges and helpers |
| `0002_core_tables.sql` | Application tables, RLS, constraints and existing ALWAYS guards |
| `0003_realtime.sql` | Activity publication |
| `0004_runtime_role_and_routines.sql` | Forward migration adding the restricted runtime role, routines and retention guards |

Files 0001 through 0003 remain unchanged and may already be applied. The runtime boundary is available only after 0004 commits. Its SQL is applied once; replay safety comes from the checksum runner, rather than running its CREATE statements twice.

0004 runs as Supabase's `postgres` role, which is not a superuser. It creates `abos_app` only when the role is missing. It never runs `ALTER ROLE ... NOSUPERUSER` or `NOBYPASSRLS`, because a non-superuser cannot. If `abos_app` already exists with SUPERUSER, INHERIT, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS, the migration stops and rolls back; an administrator must fix the role first. Any role memberships `abos_app` holds are revoked. An existing operator-enabled LOGIN is preserved. The migration also stops if `abos_app` could CREATE in `public`, `private`, `extensions` or `graphql_public`. If the Supabase function `public.rls_auto_enable()` exists, 0004 revokes its EXECUTE from PUBLIC, `anon` and `authenticated`; in plain Postgres that statement does nothing.

## Safety boundary

The server connects as `abos_app`, a nonowner role created NOLOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS. It has no role memberships, so it cannot SET ROLE to `postgres`, `service_role` or any other role. Browser roles retain their existing owner-scoped reads and cannot call runtime routines. Never give the server the migration connection.

`abos_app` has SELECT on all 21 application tables. Its RLS policies allow those reads and exactly its granted writes. The backend authenticates the owner, supplies the owner and business arguments, and enforces business scope in code. This role intentionally sees all businesses; the database does not authenticate a human from an asserted user ID.

The database trusts the server for facts it cannot check. `abos_app` can UPDATE `orders`, `bookings` and `businesses` directly. It can therefore set an order to PAID_VERIFIED or a booking to BOOKED_VERIFIED, which is what makes a Sheets job eligible, and it can change `businesses.owner_id`, which the decision routine compares with the asserted owner. Never-broken rules 2 and 5 (verified webhooks, provider-confirmed success) are enforced by the server, not by these grants.

| Tables | Ordinary writes allowed to abos_app |
|---|---|
| businesses, users, business_facts, files, catalog_items, fact_conflicts, agents, agent_versions, live_agent, builder_sessions, calls, orders, bookings, integrations | INSERT, UPDATE, subject to existing constraints and triggers |
| activity_events, webhook_events | INSERT only |
| builder_sessions, files, fact_conflicts, catalog_items, live_agent | DELETE also allowed |
| capabilities | None |
| approval_requests, action_executions, message_dispatches, sync_jobs | None. SELECT only. INSERT, UPDATE, DELETE and TRUNCATE fail with permission errors |

No table grants TRUNCATE to `abos_app`. The migration grants USAGE on `public` and `private` and EXECUTE on `public.gen_id` for ordinary inserts. It grants no USAGE on `extensions`, no schema CREATE and no access to migration bookkeeping. Because no table privilege reaches the four protected tables, every statement form fails there with a permission error, including MERGE, INSERT ... ON CONFLICT, COPY FROM, data-modifying CTEs, SELECT ... FOR UPDATE or FOR KEY SHARE, and LOCK TABLE. Published versions and audit events keep their existing ALWAYS guards.

### Checked routines

Every runtime entry point lives in `private`, is SECURITY DEFINER owned by the migration role, pins an empty search path and qualifies object names. PUBLIC, anon and authenticated have no EXECUTE grant. Only `abos_app` and the legacy `service_role` can execute these entry points. Internal validation and trigger helpers are not runtime entry points.

| Routine | Runtime wrapper | Enforced checks |
|---|---|---|
| private.create_approval | createApproval | Builds the complete material projection for each bundle. Canonical JSONB must equal it, preserving array order. Business, subject, actions and expiry must match the row. SHA-256 covers the exact supplied canonical bytes. Stored subject material and scope must match; orders and bookings must await approval. Expiry must be in the future and at most 11 minutes away (SPEC's 10 minutes plus one minute for clock skew). `messageRecipient` must be E.164 for every sending channel; only `qr_only` may omit it or sign it as null |
| private.decide_and_enqueue | runtimeDecideAndEnqueue | Locks approval before sampling clock_timestamp. Checks owner, business, hash and expiry; writes decision, subject transition and audit atomically; enqueues exact nondeferred steps. Booking approval moves to RECHECKING_SLOT, since SPEC has no booking APPROVED state |
| private.claim_execution | runtimeClaimExecution | Locks approval then execution. Checks approval, due time, attempt limit and ordered predecessors before acquiring the lease. For step 0, the first step to use the material, it also revalidates the current subject row against the signed material. Later steps are not revalidated, because the completed provider write may legitimately change the subject, as price_edit changes its catalog row |
| private.claim_next_execution | runtimeClaimNextExecution | Selects the next eligible step within the supplied business using the same claim checks and SKIP LOCKED approval locking. A step refused for a SUBJECT or MATERIAL mismatch stays QUEUED and is passed over, so it cannot block the rest of the business; a direct claim of it still raises the error |
| private.finish_execution | finishExecution | Requires RUNNING, matching worker and attempt. Allows SUCCEEDED, FAILED, NEEDS_REVIEW or QUEUED retry within three attempts. A provider step needs a reference to succeed. A message step succeeds only when its dispatch is SENT or DELIVERED and the reference equals that dispatch's provider message ID. Finished rows cannot change; a started successor prevents predecessor regression |
| private.record_dispatch | recordDispatch | Requires the currently leased RUNNING message and completed predecessors. Derives approved subject, recipient, channel, template and key. A repeat returns the original dispatch only if the body hash agrees |
| private.update_dispatch | updateDispatch | Requires the running lease. Changes status metadata only, requires provider ID for sent/delivered, freezes provider identity after send and restricts status transitions |
| private.enqueue_sheets_sync | enqueueSheetsSync | Requires an APPROVED matching Sheets action and subject in PAID_VERIFIED or FULFILLMENT_READY for orders, BOOKED_VERIFIED for bookings. One job per subject, with a derived stable key |
| private.claim_sync_job | claimSyncJob | Revalidates eligibility, due time and five-attempt limit, then acquires the worker lease |
| private.finish_sync_job | finishSyncJob | Requires matching RUNNING worker and attempt. Allows DONE with provider reference, FAILED, or RETRYING within the limit |
| private.expire_approvals | runtimeExpireApprovals | Uses one clock_timestamp cutoff per sweep and supplied business. Updates subjects and audit in the same statement |

Every execution key is the hex SHA-256 of `businessId:subjectId:actionType:approvalId`, derived in the database. Dispatches reuse the message execution key. Sheets jobs derive the equivalent Sheets action key. No routine accepts caller-chosen keys or recipient overrides. All material field sets come from CONTRACTS section 4 because `packages/contracts/src/bundles.ts` and `hash.ts` are absent in this checkout.

A lease has no timeout. If a worker dies while a step is RUNNING, the step stays RUNNING until that worker ID finishes it with the same attempt number, or an operator reviews it. An automatic reclaim could repeat a provider write.

Display-only payload extras are excluded from the material projection. The server must serialize canonical JSON with recursively sorted keys, no whitespace and ordered arrays per CONTRACTS. The database compares parsed material and hashes the supplied bytes; it does not replace that serializer with JSONB text formatting. Executors must consume the stored signed material. Current stored material is revalidated at creation, decision and claim. Message recipient and channel come from that immutable material. The database cannot prove rendered provider message bytes from a body hash, validate actual provider responses from a reference string, verify webhook signatures, or establish human authentication. Those remain backend responsibilities.

Identical decisions return the original rows without updates or duplicate audit. Historical APPROVED decisions missing steps are repaired under the same lock with exactly the missing deterministic keys. Existing rows with conflicting identities cause refusal. A historical subject still awaiting approval is moved and its audit completed. No approved message is skipped except `qr_only`; it has no dispatch.

ALWAYS BEFORE DELETE guards retain executions, dispatches and sync jobs even in replica mode. An ALWAYS sync UPDATE guard freezes ID, business, target, record type, subject, approval and dedupe key. All previous triggers remain attached. The approval guard now checks actual wall clock, including decisions inside long transactions. `service_role` also loses DELETE and TRUNCATE on all four sensitive tables.

### Administrative limits and login

The table owner and migration administrator remain outside this boundary. They can change grants, constraints, ownership and triggers. Operator reset by TRUNCATE remains outside it and bypasses row triggers. `service_role` is a legacy privileged credential that retains direct INSERT and UPDATE subject to the old guards; it is not the restricted runtime credential. Its grants on other tables may permit administrative cascading resets. Do not expose it to the running server. These controls do not turn an administrator into an untrusted application role.

After migration, the operator performs one step on an administrator connection: call `enableRuntimeLogin(adminClient, password)` with a password obtained at runtime. The password must be at least 16 printable ASCII characters. The helper computes the SCRAM-SHA-256 verifier in the Node process and sends only `ALTER ROLE abos_app LOGIN PASSWORD '<verifier>'`, so the plain password never reaches the server, its statement log or `pg_stat_statements`. The verifier is checked to contain only base64 characters, digits, `:` and `$` before it is sent, so the statement cannot carry SQL injection. Driver errors are replaced with a fixed message. Do not store the password in SQL, source, logs or migration files. Provision the server connection securely with that role. Ordinary runtime code must not receive this administrator client.

## TypeScript API

Import runtime wrappers from `@abos/db`. Each accepts a pg-style query executor or transaction client and calls one routine. Each routine is atomic as one SQL statement; a caller may also include it in a larger transaction. Claims return null when no row is eligible. Finish and dispatch calls pass the claim's `attempts` value together with the worker ID, fencing stale retries. Routine refusals use short prefixes such as MATERIAL, SCOPE, OWNER, HASH, EXPIRED, LEASE, RETRY and IDENTITY.

The old direct SQL decision, enqueue, claim and sweep exports remain deprecated for compatibility with existing branches. They cannot write sensitive tables as `abos_app`; migrate callers to the runtime wrappers. `recordWebhookEvent` still performs ordinary INSERT dedupe, only after the server verifies the signature and redacts sensitive payload data.

## Verification

```sh
npm test -- packages/db/test --pool=threads --maxWorkers=1
npm run typecheck
```

Offline tests apply all migrations to PGlite with real pgcrypto and btree_gist extensions and Supabase test stand-ins. The migrations run as `supabase_postgres` (`test/supabase-owner.sql`), a non-superuser with the attributes of Supabase's `postgres` role, so a statement that needs a superuser fails in the tests as it would on Supabase. The session user is still a superuser, and PostgreSQL checks SET ROLE against the session user, so the tests prove that `abos_app` has no memberships rather than attempting SET ROLE as it. They cover checksum replay, the four-table DML permission matrix after SET ROLE abos_app, all four bundles, ordered execution, leases, retries, dispatch, verified Sheets eligibility, old-transaction expiry, exact material binding, deterministic keys, historical repair and replica-mode retention. Existing tests still exercise legacy guards separately.

This does not verify a real PostgreSQL 17 or Supabase server, Supabase's own grants to PUBLIC on its schemas, multi-session lock contention, live provider writes, login over a network connection or the Supabase pooler, JWT/PostgREST or Realtime delivery. PGlite executes the SQL but cannot replace that deployment verification.
