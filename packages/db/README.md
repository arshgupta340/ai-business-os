# @abos/db

Supabase PostgreSQL schema, checksum migration runner and guarded database operations for AI Business OS. Table names and states follow `docs/SPEC.md` and `docs/DATA-MODEL.md`.

## Files

| File | Contents |
|---|---|
| `migrations/0001_extensions_and_helpers.sql` | `extensions` and `private` schemas, `btree_gist`, `pgcrypto`, default privilege lockdown, ID and timestamp helpers |
| `migrations/0002_core_tables.sql` | All 21 application tables, constraints, indexes, RLS, intentional owner reads, invariant functions and ALWAYS triggers, in one transaction |
| `migrations/0003_realtime.sql` | `activity_events` membership in `supabase_realtime` |
| `src/migrate.ts` | Session-pinned, checksum-recorded migration runner |
| `src/guarded-updates.ts` | `decideAndEnqueue`, deprecated `decideApproval`, both claim operations, webhook dedupe and approval expiry |
| `test/` | Offline PGlite tests and test-only Supabase stand-ins |

## Apply migrations

Apply each SQL file as one transaction using the migration administrator. The runner reads `DATABASE_URL` from the environment or the nearest `.env.local`. Use a session connection rather than a transaction pooler:

```sh
npm run migrate -w @abos/db
```

The runner takes one advisory lock on one session, applies each file inside BEGIN and COMMIT, and records its checksum in `public.schema_migrations`. Running it twice skips every recorded file without changing the schema. A changed checksum stops the run. A failed file rolls back and is not recorded. The runner accepts either a pool, from which it checks out one client for the entire run, or a single-session adapter. Never wrap pool.query as a single-session adapter.

This review consolidates the initial migration files. It is a fresh-database baseline, not an upgrade for an installation that recorded the previous file names or checksums. Such an installation needs a separately planned forward migration or an operator-approved rebuild. The runner intentionally refuses to silently reinterpret applied history.

Alternatively, apply files in order through a SQL editor, each in one transaction. This does not populate the runner's history; do not mix the two methods. Never run `test/` SQL against Supabase.

## Safety at each committed file boundary

The matrix assumes the files run as the same migration role, as intended on Supabase. Default privileges apply to objects created by that role. No application table commits without its RLS, privileges, constraints and invariant triggers.

| After file | anon | authenticated | service_role |
|---|---|---|---|
| `0001_extensions_and_helpers.sql` | No application tables exist; no execution of public helpers | Same as anon | Can execute `gen_id`; retains intended Supabase service defaults |
| `0002_core_tables.sql` | No application table access and no execution of application functions | SELECT own user row, owned businesses and business-scoped rows, and global capabilities through RLS. No table writes or TRUNCATE. No access to webhook_events or schema_migrations. Only `private.owns_business` is executable for the policies | Bypasses RLS and retains direct table DML, subject to constraints and ALWAYS triggers. Retains Supabase's TRUNCATE grant |
| `0003_realtime.sql` | Unchanged | Unchanged; activity_events is now in the Realtime publication | Unchanged |

When using the runner, `schema_migrations` has RLS and explicit revokes as soon as it is created, including before `0001`. Neither browser role can access it. Public functions created by the migration role default to no EXECUTE for PUBLIC, anon or authenticated. Existing helpers and trigger functions explicitly revoke these grants. `private.owns_business` is the only SECURITY DEFINER function; it uses an empty search path and qualified names, with schema USAGE and function EXECUTE granted only to authenticated. `execution_claim_allowed` and ID generation are executable by service_role.

### Approval and execution invariants

Approvals start PENDING with no decision. Material columns, including `payload_canonical`, never change. APPROVED and REJECTED require the business's owner as decided_by, decided_at before expires_at, and an unexpired request at decision time. EXPIRED requires now() at or after expires_at, decided_at and no deciding user. Terminal approvals cannot change. DELETE is rejected for every approval, including one without executions.

The proposal writer supplies `payload_canonical`: the exact canonical JSON string of the material fields it hashed. Canonicalization follows SPEC 2.9 and CONTRACTS section 4: recursively sorted keys, no whitespace, UTF-8, arrays in order. The database verifies that this string parses as a JSON object, that payload contains that object's keys and values, and that payload_hash equals `sha256:` plus the lowercase hexadecimal SHA-256 of those exact bytes using `extensions.digest`. The database does not reserialize JSON or enforce the server's choice of material keys or canonical key order. Payload may contain additional display fields. Execution code must use the stored canonical material for approved material fields.

Execution inserts require an APPROVED request decided before expiry, the same business, and the exact non-deferred bundle position. Initial status must be QUEUED, or SKIPPED for `message.checkout.send` or `message.booking.confirm`. Execution identity and its idempotency key are immutable. Both claim queries and every direct transition into RUNNING call the same SQL function, `public.execution_claim_allowed`. It requires valid approval, business and bundle position and a finished row for every earlier expected step. A missing predecessor blocks a claim. SUCCEEDED counts as finished; only message steps may instead end SKIPPED, FAILED or NEEDS_REVIEW. The guarded claims additionally require QUEUED and a due retry time. ALWAYS triggers also run in replica mode.

Dispatches are unique per execution. They require a message execution, the approval's order or booking subject in the same business, the matching bundle and template, and recipient and channel equal to the approved payload and canonical material. No dispatch exists for qr_only. After insert, business, approval, execution, subject source columns, channel, recipient, template, body hash, ID and idempotency key cannot change. Only status, attempts, provider reference, timestamps and error fields can change. Body hash is frozen on insert; the database does not prove a rendered provider message's bytes or a provider result. The sent-state constraint requires a provider message ID.

Published agent versions reject row updates and deletes after publication. Activity events reject row updates and deletes. These invariant triggers are also ALWAYS enabled.

### Remaining bypasses

The table owner can disable triggers, change constraints or grants, and rewrite data. ALWAYS does not prevent an owner disabling a trigger. TRUNCATE bypasses row triggers and remains the operator reset path, including for approvals, versions and audit events. Supabase's service_role retains its default TRUNCATE privilege. Row guards do not constrain that administrative reset path. The application should not connect as the table owner or use the migration administrator connection.

## Open decision

A dedicated non-owner runtime role and an operator-only reset privilege boundary remain a project-owner decision. This task creates no new database login role and does not change which role the application uses. service_role retains direct DML and TRUNCATE. The row-level bypasses tested here are closed, but isolating reset from runtime requires a separately approved privilege change. No claim is made that a malicious holder of the service credential cannot reset data or that database fields authenticate the human owner; the server must authenticate the owner before deciding.

## Decide and enqueue atomically

Use `decideAndEnqueue(tx, args)` to decide. Its transaction client type requires a checked-out client's release method, so a pg.Pool cannot be passed. The caller owns BEGIN, COMMIT, ROLLBACK and client release:

```ts
const tx = await pool.connect();
try {
  await tx.query('BEGIN');
  const result = await decideAndEnqueue(tx, {
    approvalId, businessId, ownerUserId, payloadHash,
    decision: 'APPROVED',
    stepIdempotencyKeys, // one caller-supplied stable key per non-deferred step, in order
  });
  // Add any subject transitions and activity events on tx in this transaction.
  await tx.query('COMMIT');
  return result;
} catch (error) {
  await tx.query('ROLLBACK');
  throw error;
} finally {
  tx.release();
}
```

The operation locks the approval, checks business, owner, hash and expiry, makes the guarded decision, and inserts each non-deferred step in order. Steps start QUEUED except the message step for qr_only, which starts SKIPPED. Sheets is deferred until verified payment or booking. Reject with an empty stepIdempotencyKeys array. A repeated identical decision, reason and keys returns the existing approval and executions without insertion; mismatches return null. Incorrect key counts throw. A savepoint rolls back both decision and inserts on failure even when the caller catches the error and commits. It does not BEGIN or COMMIT independently or make provider calls. Subject state and activity event updates remain the caller's responsibility in that same transaction.

`decideApproval` remains exported for the other branch's compatibility and is deprecated. It performs only a guarded decision and is not the atomic decision API. `claimExecution`, `claimNextExecution`, `recordWebhookEvent` and `expireApprovals` accept pg-style query executors. Record webhook events only after signature verification; the database enforces replay uniqueness, not cryptographic verification of provider signatures.

## Verification

```sh
npm test -- packages/db/test --pool=threads --maxWorkers=1
npm run typecheck
```

Tests run offline against PGlite with both real `btree_gist` and `pgcrypto` extensions. No migration SQL is skipped. The test-only prelude mirrors Supabase roles, default grants, auth.uid and Realtime publication. Direct service_role INSERT and UPDATE tests exercise the guards without guarded decision or claim helpers. Tests cover migration replay, rollback and the table-file boundary.

A real Supabase project, PostgreSQL 17, real JWT/PostgREST sessions, deployed default grants, TLS pooler connections and end-to-end Realtime delivery are not verified by this offline suite. Before deployment, confirm extensions are installed in `extensions` and apply with the intended migration administrator. No provider operations are tested here.
