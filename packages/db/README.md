# @abos/db

The Supabase (Postgres) schema for AI Business OS, the runner that applies it, and the few queries whose exact form is a rule. Owner: Arsh. The source for every table, constraint and policy is `docs/DATA-MODEL.md`.

Nothing here holds a secret. The connection string lives in `.env.local` as `DATABASE_URL`.

## What is in this folder

| Path | What it holds |
|---|---|
| `migrations/0001_extensions_and_helpers.sql` | The `extensions` and `private` schemas, `btree_gist`, default privileges that keep new tables and functions closed to `anon` and `authenticated`, `gen_id()` and `set_updated_at()` |
| `migrations/0002_core_tables.sql` | All 21 tables of SPEC 2.7 in dependency order with their checks and unique keys, then in the same file `private.owns_business()`, row level security, the read-only owner policies and the table privileges |
| `migrations/0003_indexes.sql` | Unique indexes on Square and Google IDs, and the dashboard indexes |
| `migrations/0004_triggers.sql` | `updated_at`; immutable published agent versions; append-only `activity_events`; approvals born `PENDING` and frozen except for the one decision; executions only for an `APPROVED` bundle and only as the step the bundle lists |
| `migrations/0005_realtime.sql` | Adds `activity_events` to the `supabase_realtime` publication |
| `src/migrate.ts` | The migration runner |
| `src/guarded-updates.ts` | `decideApproval`, `claimExecution`, `claimNextExecution`, `recordWebhookEvent`, `expireApprovals` |
| `test/` | Tests that run every migration on PGlite, plus the test-only Supabase prelude |

The seed and reset scripts are task B-10 and are not here yet.

## Apply the migrations to Supabase

Option 1, the runner. In the Supabase dashboard open Connect and copy the **session** connection string (port 5432, not the transaction pooler on 6543). Put it in `.env.local` at the repo root:

```
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres
```

Then, from the repo root:

```bash
npm run migrate -w @abos/db
```

The runner finds `.env.local` by walking up from the current directory. It applies each file in name order inside its own transaction and records it in `public.schema_migrations`. Running it again applies nothing. If a file that was already applied has been edited, the runner stops: add a new numbered file instead of changing an old one.

Each file is safe on its own: tables and their row level security are in the same file, so a run that stops after any file leaves no table readable or writable by `anon` or `authenticated`.

Option 2, the SQL editor or any tool that runs one file as one transaction. Run each file from `migrations/` in name order, `0001` first. This does not fill `schema_migrations`, so do not mix the two methods on one database. If you used the editor and later want the runner, start from a fresh project.

Do not run anything from `test/` against Supabase.

## Use the guarded queries

```ts
import { decideApproval, recordWebhookEvent } from '@abos/db';

const decided = await decideApproval(pool, { approvalId, businessId, decision: 'APPROVED', ownerUserId, payloadHash });
if (!decided) {
  // Already decided, expired, or the hash no longer matches. Read the row to choose the error code.
}
```

Each function takes anything with a pg-style `query(text, params)` method: a `pg` Pool, a client inside a transaction, or PGlite. Do not rewrite these queries in the server; the `where` clauses are the rules.

- `decideApproval` succeeds only for a `PENDING`, unexpired request whose hash matches, in the given business, decided by that business's owner. `decided_by` is copied from `businesses.owner_id`.
- `claimExecution` and `claimNextExecution` claim a step only when its approval is `APPROVED` (decided before it expired, same business), the row is the step the bundle lists at that position, and every earlier listed step has a finished row. A missing earlier row blocks the claim.
- The database backs this up: an `action_executions` insert fails unless its approval is `APPROVED`, in the same business, and lists that action at that step (Sheets steps are left out, SPEC 2.9). Insert the executions in the same transaction as the decision.

`applyMigrations` accepts a pool (it checks out one client for the whole run and releases it at the end) or a single-session adapter with `exec` and `query`. Never wrap a pool in the adapter.

## Run the tests

```bash
npm test
```

The tests use PGlite (`@electric-sql/pglite`), which is Postgres compiled to WebAssembly and runs inside the test process. No database server, Docker or network is needed. Each test file creates a fresh database, runs `test/supabase-prelude.sql`, then applies every migration through the same runner the real command uses.

## The test prelude

Supabase creates some objects that plain Postgres does not have. `test/supabase-prelude.sql` makes stand-ins for them before the migrations run:

- the roles `anon`, `authenticated` and `service_role` (with `bypassrls`)
- the `auth` schema with `auth.users` and an `auth.uid()` that reads the session setting `request.jwt.claim.sub`
- Supabase's default table grants to those roles in `public`
- the `supabase_realtime` publication

It is not a migration because Supabase already has all of these. Running it on Supabase would fail or, worse, replace Supabase's own `auth.uid()`.

PGlite ships `btree_gist`, so the `bookings_no_overlap` exclusion constraint runs in the tests exactly as written. No migration statement is skipped in the tests.

## Not verified until the migrations run on a real Supabase project

- `create extension btree_gist with schema extensions` on Supabase, and that the gist operator class is found from `extensions`. If it is not, DATA-MODEL 2.16 says to install the extension into `public`.
- The foreign key from `public.users.auth_user_id` to Supabase's real `auth.users`, and the real `auth.uid()` reading an owner JWT through PostgREST.
- Realtime: that a dashboard subscribed with an owner JWT receives only that owner's `activity_events`. The tests check only that the table is in the publication and that the select policy filters rows.
- Supabase's own default grants. The tests mirror them in the prelude; the real ones may differ by version.
- The Postgres version. PGlite is Postgres 18; the project runs Postgres 17.11. Nothing here uses a feature newer than Postgres 15.
- That Supabase's own default grants are the per-schema kind that `0001` can revoke. If a grant to `anon` or `authenticated` is global, `0002` still revokes it table by table, but a later table would need its own revoke.
- `alter default privileges revoke execute on functions from public` in `0001` applies to every function the migration role creates later, in any schema. Grant execute explicitly where a role needs it.
- A connection over TLS through the Supabase pooler. The runner was run with the `pg` driver against a local PGlite socket server only.

## Reset and immutable versions

Published agent versions cannot be updated or deleted by any role, the service role included; there is no session setting that unlocks them. The demo reset (task B-10) must therefore remove agents and versions with `TRUNCATE ... CASCADE`, which fires no row trigger, and then reseed. This changes DATA-MODEL 6.2, which deletes non-seeded agents and keeps the seeded ones: with this schema the reset truncates and reseeds them instead. An agent that any `activity_events` row references cannot be deleted either (`on delete restrict`), so the reset truncates `activity_events` first.

## Rules for later migrations

- Add a new numbered file. Never edit an applied one.
- A new table is closed to `anon` and `authenticated` by default (0001). In the same file that creates it: `enable row level security`, add a select policy if owners should read it, and `grant select` to `authenticated` only where that policy exists.
- A new function is not executable by `PUBLIC` or `anon` by default. Pin `set search_path = ''` and schema-qualify every name. Put any `security definer` function in `private`, never in `public`.
