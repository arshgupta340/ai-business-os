# AI Business OS: Data Model

**Version:** 1.1 | **Date:** 2026-11-13 | **Follows:** `docs/SPEC.md` v1.1 | **Used by:** task B-06 (migrations in `packages/db`), task B-10 (seed and reset)

This document defines every table, constraint, index and row level security policy in the Supabase Postgres database. Names follow `docs/SPEC.md` sections 2.1 to 2.9. Under the SPEC 2.9 tie-breaker this file wins for table and column names. Every name this file had to invent is listed in section 8.

Migrations and seeds in `packages/db` and `scripts/` are owned by Arsh (SPEC 3.1). The builder service, which Saina owns (D-07), writes `builder_sessions`, `agents`, `agent_versions`, `files`, draft `business_facts` and `fact_conflicts` through the server; it does not change the schema.

## 0. Read this first: the migrations are the source of truth

The SQL in this document was the starting point for task B-06. An independent review of the migrations then found defects, and the fixes changed the SQL. Where this document and `packages/db/migrations` differ, **the migrations win**. Table names, column names and state lists did not change. These rules did:

| Rule | What the migrations do | What this document's SQL still shows |
|---|---|---|
| Running a step | An execution can be inserted and claimed only for an approval that is `APPROVED`, in the same business, decided before it expired, and only as the step its bundle lists at that position. A missing earlier step blocks a later one. | Claim queries with no approval check |
| Approval rows | Frozen after creation. Only the decision columns change, and only once. | No such trigger |
| Who decides | The decision query joins `businesses` and requires the business owner. | Any user ID accepted |
| Row-level security | Enabled, with policies and revokes, in the same file that creates the tables. Default privileges are revoked before any table exists. No migration step leaves a table exposed. | A separate, later security step |
| Published agent versions | Immutable for every role. There is no reset bypass. | A bypass through the setting `app.allow_reset` |
| Reset script (section 6.2) | Truncates agents and versions, then reseeds the seeded ones. `TRUNCATE` fires no row trigger. | Keeps seeded agents and uses the bypass |
| `activity_events.agent_id` | `ON DELETE RESTRICT`. An agent with audit events cannot be deleted. | `ON DELETE SET NULL` |
| Helper functions | Every function pins an empty `search_path`. `owns_business` lives in a `private` schema and only `authenticated` may run it. | `public.owns_business` with `search_path = public` |
| Message dispatches | A dispatch is tied to the approval of the execution it belongs to. | No such tie |
| Payment outcomes (0005) | `private.mark_order_paid` and `private.mark_order_payment_failed` are the only checked paths for a Square result; `orders.square_payment_id` is unique. | Plain order updates |
| Stale leases (0005) | `private.recover_stale_executions` moves a step RUNNING past its lease to `NEEDS_REVIEW`, never back to `QUEUED`. | A sweeper that requeues |
| Seed facts (section 6.1) | The seed takes its data from the fixtures in `@abos/contracts/fixtures`. The policy keys are `message_consent`, `min_notice` and `no_refunds_by_phone`. Some seeded facts carry the fixture source types `owner_chat` or `owner_ui`. Both agents are seeded with their fixture versions. | Different policy keys, every fact with source type `seed`, version 1 for both agents |
| Server database role | The server connects as `abos_app` and changes approvals, steps, dispatches and sync jobs only through the checked routines in the `private` schema (migration 0004). | The server writing those tables directly |

## 1. Conventions

- Columns are snake_case. JSON fields in `packages/contracts` are camelCase and map one to one (`business_id` is `businessId`).
- Primary keys are text with the SPEC 2.1 type prefix, made by `gen_id(prefix)`. The server may pass its own ID when it needs the ID before the insert (for example to hash it into a payload).
- Money is an integer in minor units (`price_minor`, `total_minor`) next to a `currency` column. Only `USD` is allowed.
- Timestamps are `timestamptz`. Business local time comes from `businesses.timezone`, an IANA name (`America/Los_Angeles` for both seeded businesses).
- Phone numbers are E.164 text, checked with `^\+[1-9][0-9]{6,14}$`.
- Hashes are `sha256:` followed by 64 hex characters. The payload hash is SHA-256 of canonical JSON with sorted keys (SPEC 2.9).
- Status columns hold the exact strings from SPEC 2.4, enforced by check constraints rather than Postgres enums, so adding a state is one `ALTER TABLE`.
- Never stored: card data of any kind (number, CVV, expiry, last four digits, brand), call audio and call transcripts (SPEC 5, OUT). Payment happens on the Square hosted page.
- Secrets never live in tables. `integrations.config_ref` names an environment variable; it never holds a key.

```sql
create extension if not exists btree_gist with schema extensions;  -- for bookings_no_overlap

create or replace function public.gen_id(prefix text) returns text
language sql volatile as $$ select prefix || replace(gen_random_uuid()::text, '-', '') $$;

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
```

The migration attaches `set_updated_at` as a `before update` trigger to every table with an `updated_at` column.

## 2. Tables in dependency order

### 2.1 `users`

```sql
create table public.users (
  id           text primary key default gen_id('usr_'),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  email        text not null unique,
  display_name text,
  role         text not null default 'owner' check (role in ('owner', 'admin')),
  created_at   timestamptz not null default now()
);
```

Supabase Auth owns `auth.users`. This is the public profile. Its ID uses the SPEC 2.1 prefix `usr_`, and `auth_user_id` links it to the auth user so RLS can map `auth.uid()` to the profile. The server reads `role` for its role checks.

### 2.2 `businesses`

```sql
create table public.businesses (
  id       text primary key default gen_id('biz_'),
  owner_id text not null references public.users (id),
  name     text not null,
  category text not null,
  timezone text not null,
  currency text not null default 'USD' check (currency = 'USD'),
  contact  jsonb not null default '{}',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
```

`owner_id` anchors every RLS policy. `timezone` is not null because a missing timezone is a builder stop condition (PRD section 6).

### 2.3 `capabilities`

```sql
create table public.capabilities (
  id              text primary key check (id ~ '^[a-z]+(\.[a-z]+)+$'),
  description     text not null,
  effect          text not null check (effect in ('read', 'propose', 'write', 'external_message')),
  approval_mode   text not null check (approval_mode in ('none', 'creates_approval', 'required')),
  handler_id      text not null,
  input_schema    jsonb not null,
  output_schema   jsonb not null,
  required_scopes text[] not null default '{}',
  timeout_ms      integer not null default 8000 check (timeout_ms between 100 and 60000),
  tier            text not null check (tier in ('MUST', 'SHOULD')),
  check ((effect in ('write', 'external_message')) = (approval_mode = 'required')),
  check ((effect = 'propose') = (approval_mode = 'creates_approval'))
);
```

The registry is global, not business scoped, and only the seed script writes it. The two table checks make it impossible to store a write or message capability that skips approval (SPEC rule 1.3.1).

### 2.4 `integrations`

```sql
create table public.integrations (
  id          text primary key default gen_id('int_'),
  business_id text not null references public.businesses (id) on delete cascade,
  provider    text not null check (provider in ('square', 'twilio', 'openai', 'google_calendar', 'google_sheets', 'message_channel')),
  alias       text not null,
  state       text not null default 'disconnected' check (state in ('connected', 'degraded', 'disconnected')),
  config_ref  text,
  config      jsonb not null default '{}',
  last_checked_at timestamptz, last_error text,
  unique (business_id, provider, alias)
);
```

`config` holds non-secret settings only (Square location ID, calendar ID, sheet ID). `GET /api/integrations/health` writes `state`, `last_checked_at` and `last_error`. The `provider` keys are the SPEC 2.9 "Integration health" list and the `state` values follow `IntegrationHealth` in CONTRACTS.md. A webhook URL maps to one integration row, which is how a rejected webhook finds its business (section 2.19).

### 2.5 `files`

```sql
create table public.files (
  id               text primary key default gen_id('file_'),
  business_id      text not null references public.businesses (id) on delete cascade,
  storage_path     text not null unique,
  name             text not null,
  mime             text not null check (mime in (
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  sha256           text not null check (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes       integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  extraction_state text not null default 'PENDING' check (extraction_state in ('PENDING', 'EXTRACTING', 'EXTRACTED', 'FAILED')),
  uploaded_by      text not null references public.users (id),
  created_at       timestamptz not null default now(),
  unique (business_id, sha256)
);
```

Files live in the private Supabase Storage bucket `business-files`, with no public URL. The mime check covers PDF, image, CSV and spreadsheet (P-12, D-09). The size check is the 10 MB cap (SPEC 2.9). Audio is not an accepted type. `unique (business_id, sha256)` stops the same file being extracted twice. `FileRecord.draftFactIds` and `conflictIds` are not columns; the API reads them from `business_facts.file_id` and `fact_conflicts`.

### 2.6 `business_facts`

```sql
create table public.business_facts (
  id            text primary key default gen_id('fact_'),
  business_id   text not null references public.businesses (id) on delete cascade,
  kind          text not null check (kind in ('hours', 'policy', 'service', 'contact', 'faq', 'menu_item')),
  key           text not null,
  value         jsonb not null,
  source_type   text not null check (source_type in ('square', 'google_calendar', 'owner_chat', 'owner_ui', 'upload', 'seed')),
  source_ref    text,
  file_id       text references public.files (id) on delete set null,
  status        text not null default 'draft' check (status in ('draft', 'verified', 'superseded')),
  confidence    numeric(3,2) not null default 1 check (confidence between 0 and 1),
  version       integer not null default 1 check (version >= 1),
  supersedes_id text references public.business_facts (id),
  verified_at   timestamptz, verified_by text references public.users (id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((status = 'draft') = (verified_at is null))
);
create unique index business_facts_one_verified
  on public.business_facts (business_id, kind, key) where status = 'verified';
create unique index business_facts_version
  on public.business_facts (business_id, kind, key, version) where status <> 'draft';
```

`source_type` is the SPEC 2.9 list. Every uploaded file uses `upload`, with `file_id` set; the file type is `files.mime`. `business_facts_one_verified` enforces at most one `verified` row per business, kind and key (SPEC 2.9). An earlier verified row becomes `superseded` and stays, which is the versioned change log (AC-16). Uploads and chat only insert drafts. An approved `local.fact.update` then, in one transaction, sets the current verified row to `superseded` and turns the draft into the new verified row with the next `version` and `supersedes_id` pointing at the old row. The order of those two updates matters: supersede first, then verify, or the partial index rejects the second row.

Keys: hours are one fact per weekday, keys `mon` to `sun`, value `{ open, close }` in local time or `{ closed: true }` (SPEC 2.7). Services are `kind = 'service'` with the `svc_` ID as key and a `ServiceOffering` as value. Draft menu items from an upload are `kind = 'menu_item'`; they come only from an upload, stay `draft`, exist only to be compared with `catalog_items` (section 5) and are never a price source (SPEC 2.9). `faq` facts serve the FAQ-only custom agent (P-13).

### 2.7 `catalog_items`

```sql
create table public.catalog_items (
  id                       text primary key default gen_id('cat_'),
  business_id              text not null references public.businesses (id) on delete cascade,
  square_item_id           text not null,
  square_variation_id      text not null,
  square_item_version      bigint not null,
  square_variation_version bigint not null,
  item_name                text not null,
  description              text,
  variation_name           text not null,
  price_minor              integer not null check (price_minor >= 0),
  currency                 text not null default 'USD' check (currency = 'USD'),
  modifier_lists           jsonb not null default '[]',
  is_available             boolean not null default true,
  synced_at                timestamptz not null,
  unique (business_id, square_variation_id)
);
```

One row per sellable Square variation (P-10). Sync upserts on `(business_id, square_variation_id)` and deletes rows whose variation is gone from Square. Variable-price variations are skipped, so `price_minor` can be not null. `modifier_lists` holds each list's Square ID, name, selection type, and modifiers with their Square IDs and `price_minor`. The `square_*_version` columns are what `catalog.price.update` needs, since Square requires the current object version for a price change (SPEC 4).

The API and the tools group rows into items (SPEC 2.9). One `CatalogItem` (CONTRACTS.md) is all rows with the same `square_item_id`: `square_item_id` is `squareItemId`, `item_name` is `name`, `description` is `description`, `modifier_lists` is `modifierLists`, `available` is true if any row has `is_available`, and each row is one entry of `variations` (`square_variation_id` is `id`, `variation_name` is `name`, plus `price_minor` and `currency`).

### 2.8 `fact_conflicts`

```sql
create table public.fact_conflicts (
  id                 text primary key default gen_id('cfl_'),
  business_id        text not null references public.businesses (id) on delete cascade,
  kind               text not null check (kind in ('hours', 'policy', 'service', 'contact', 'faq', 'menu_item')),
  key                text not null,
  candidates         jsonb not null check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) >= 2),
  required           boolean not null default true,
  state              text not null default 'open' check (state in ('open', 'resolved')),
  resolved_fact_id   text references public.business_facts (id),
  resolved_by        text references public.users (id),
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  check ((state = 'resolved') = (resolved_at is not null and resolved_by is not null))
);
create unique index fact_conflicts_one_open
  on public.fact_conflicts (business_id, kind, key) where state = 'open';
```

The columns are the `FactConflict` fields of CONTRACTS.md. A row is written when a draft fact disagrees with the authoritative source. `candidates` holds the draft (`factId`, `sourceType: 'upload'` or `'owner_chat'`, `value`) and the authority: the Square value from `catalog_items` (`sourceType: 'square'`, `sourceRef` the `cat_` ID) or the current verified fact (its `factId` and `sourceType`). Publish refuses with `CONFLICT_UNRESOLVED` while any row for the business has `state = 'open' and required` (application rule in the publish handler, AC-02). A conflict is resolved through `POST /api/businesses/:id/facts/propose`; the approved `local.fact.update` sets `state`, `resolved_fact_id`, `resolved_by` and `resolved_at`. `resolved_fact_id` is empty when the owner keeps the Square value. Choosing the draft value for a Square price does not change Square; that is the `price_edit` bundle.

### 2.9 `agents`

```sql
create table public.agents (
  id                text primary key default gen_id('agt_'),
  business_id       text not null references public.businesses (id) on delete cascade,
  name              text not null,
  template          text not null check (template in ('restaurant_order_taker', 'appointment_booker', 'custom')),
  channel           text not null default 'phone' check (channel = 'phone'),
  state             text not null default 'draft' check (state in ('draft', 'live', 'paused')),
  draft_spec        jsonb,
  active_version_id text,
  seeded            boolean not null default false,
  spec_revision     integer not null default 1 check (spec_revision >= 1),  -- migration 0005
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (state = 'draft' or active_version_id is not null),
  unique (id, business_id)
);
```

A live or paused agent always points to a version. `draft_spec` is the editable spec before the next publish (API agent summary). The foreign key on `active_version_id` is added after `agent_versions`. `seeded` marks the agents the reset script keeps. `spec_revision` is the builder's durable draft revision (API 3.4 `specRevision`); the builder increments it on each draft change.

### 2.10 `agent_versions`

```sql
create table public.agent_versions (
  id                     text primary key default gen_id('agv_'),
  business_id            text not null references public.businesses (id) on delete cascade,
  agent_id               text not null references public.agents (id) on delete cascade,
  version                integer not null check (version >= 1),
  spec                   jsonb not null,
  knowledge_snapshot_ref jsonb not null default '{}',
  guardrail_version      text not null default 'v1',
  created_by             text references public.users (id),
  created_at             timestamptz not null default now(),
  published_at           timestamptz,
  unique (agent_id, version),
  unique (id, agent_id)
);
alter table public.agents add constraint agents_active_version_fk
  foreign key (active_version_id, id) references public.agent_versions (id, agent_id);

create or replace function public.agent_versions_immutable() returns trigger
language plpgsql as $$
begin
  if old.published_at is not null and coalesce(current_setting('app.allow_reset', true), '') <> 'on' then
    raise exception 'agent version % is published and immutable', old.id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger agent_versions_immutable before update or delete on public.agent_versions
  for each row execute function public.agent_versions_immutable();
```

Immutability is enforced in the database by this trigger: the publish transaction sets `published_at` once, and every later update or delete fails. Only the reset script, which sets `app.allow_reset = 'on'` in its own transaction, can remove published versions. The composite foreign key stops an agent pointing at another agent's version. `knowledge_snapshot_ref` pins the fact IDs and versions and the catalog `synced_at` the version was tested against (PRD section 6 step 9). Rollback (SHOULD) points `active_version_id` at an older published version; it never edits one. Pointing `active_version_id` only at a published version is an application rule in the publish and rollback handlers.

### 2.11 `live_agent`

```sql
create table public.live_agent (
  phone_number     text primary key check (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  business_id      text not null references public.businesses (id),
  agent_id         text not null,
  agent_version_id text not null,
  updated_at       timestamptz not null default now(),
  foreign key (agent_version_id, agent_id) references public.agent_versions (id, agent_id) on delete restrict,
  foreign key (agent_id, business_id) references public.agents (id, business_id)
);
```

One row per phone number (P-06), with exactly the `LiveAgent` fields of SPEC 2.9. Who made a switch is recorded in the `live_agent.changed` event, not on the row. An inbound call reads this row to find the business and the pinned version. The two composite foreign keys keep the version, agent and business consistent. `PUT /api/live-agent` checks that the agent is `live` before writing (application rule) and writes `live_agent.changed`.

### 2.12 `builder_sessions`

```sql
create table public.builder_sessions (
  id             text primary key default gen_id('bld_'),
  business_id    text not null references public.businesses (id) on delete cascade,
  owner_id       text not null references public.users (id),
  agent_id       text references public.agents (id) on delete set null,
  status         text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  messages       jsonb not null default '[]',
  draft_spec     jsonb,
  missing_fields jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
```

`messages` is an array of `BuilderMessage` objects, each with its own `bmsg_` ID, role, text and optional `specPatch` and `evidenceRefs`. They are kept inline rather than in a separate table because they are read and written only as part of their session. Owner voice in the builder stores only the text of each turn, never audio.

### 2.13 `calls`

```sql
create table public.calls (
  id                text primary key default gen_id('call_'),
  business_id       text not null references public.businesses (id) on delete cascade,
  agent_id          text not null,
  agent_version_id  text not null,
  channel           text not null default 'phone' check (channel in ('phone', 'test_console')),
  provider_call_id  text unique,
  caller_last4      text check (caller_last4 ~ '^[0-9]{4}$'),
  status            text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS', 'COMPLETED', 'DROPPED', 'FAILED')),
  stage             text not null check (stage in (
    'CALL_STARTED', 'COLLECTING', 'VALIDATING', 'UNAVAILABLE', 'CUSTOMER_CONFIRMED',
    'INQUIRY', 'SLOT_SEARCH', 'PROPOSAL')),
  fact_snapshot_ref jsonb not null default '{}',
  end_reason        text check (end_reason in ('completed', 'dropped', 'failed')),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  foreign key (agent_version_id, agent_id) references public.agent_versions (id, agent_id),
  check ((channel = 'phone') = (provider_call_id is not null)),
  check ((status = 'IN_PROGRESS') = (ended_at is null)),
  check (ended_at is null or ended_at >= started_at)
);
```

`provider_call_id` is the Twilio CallSid; it is unique so a repeated Twilio webhook cannot open a second call row. A simulated call (P-18) has `channel = 'test_console'` and no CallSid, but it is still a `calls` row, so every order has a `call_id` and `agent_version_id` always comes from the call (SPEC 2.9). `stage` holds the conversation states before a proposal exists (SPEC 2.4 rulings): an order call starts at `CALL_STARTED`, a booking call at `INQUIRY`, and both end at `CUSTOMER_CONFIRMED` when the propose tool runs. `UNAVAILABLE` is the stage while the caller picks another item (CONTRACTS.md `CallStage`). `fact_snapshot_ref` holds the verified fact IDs and versions read at call start, so a call in progress keeps the hours it started with (AC-16). Only the last four digits of the caller number are kept; the confirmed message number lives in `orders.contact` after consent. `end_reason` is what `call.ended` carries.

### 2.14 `approval_requests`

```sql
create table public.approval_requests (
  id            text primary key default gen_id('apv_'),
  business_id   text not null references public.businesses (id) on delete cascade,
  actor_type    text not null check (actor_type in ('deployed_agent', 'owner')),
  actor_id      text,
  bundle_type   text not null check (bundle_type in ('order_bundle', 'booking_bundle', 'fact_edit', 'price_edit')),
  action_bundle text[] not null,
  subject_id    text not null,
  payload       jsonb not null,
  payload_hash  text not null check (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  state         text not null default 'PENDING' check (state in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  expires_at    timestamptz not null default now() + interval '10 minutes',
  decided_by    text references public.users (id),
  decided_at    timestamptz,
  decision_reason text,
  created_at    timestamptz not null default now(),
  check (
    (bundle_type = 'order_bundle'   and action_bundle = array['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append']) or
    (bundle_type = 'booking_bundle' and action_bundle = array['calendar.event.create', 'message.booking.confirm', 'local.booking.record', 'sheets.booking.append']) or
    (bundle_type = 'fact_edit'      and action_bundle = array['local.fact.update']) or
    (bundle_type = 'price_edit'     and action_bundle = array['square.catalog.price.update', 'local.catalog.sync'])),
  check ((state = 'PENDING') = (decided_at is null)),
  check ((state in ('APPROVED', 'REJECTED')) = (decided_by is not null))
);
create unique index approval_requests_one_pending_per_subject
  on public.approval_requests (subject_id) where state = 'PENDING';
```

`bundle_type` is the kind of bundle; the single step is `action_executions.action_type` (SPEC 2.3). `subject_id` is the `ord_`, `bkg_`, draft `fact_` or `cat_` ID; it has no foreign key because it points at four tables. `actor_id` is the `agv_` ID for a deployed agent and the `usr_` ID for an owner (P-09). The bundle check pins each bundle type to the exact SPEC 2.3 list. Expiry is 10 minutes (P-07, SPEC 2.9). `payload` is never updated after insert (application rule; the guarded update below does not touch it).

The one-use rule is this guarded update. Zero rows returned means the request was already decided, has expired, or the hash the owner saw no longer matches. The server then reads the row to return the right error.

```sql
-- $1 approval id, $2 business id, $3 'APPROVED' or 'REJECTED', $4 owner usr_ id, $5 payload hash shown to the owner
update public.approval_requests
set    state = $3, decided_by = $4, decided_at = now()
where  id = $1 and business_id = $2 and payload_hash = $5
  and  state = 'PENDING' and expires_at > now()
returning *;
```

On approval the same transaction moves the order or booking to its next state, inserts one `action_executions` row as `QUEUED` for each step except the Sheets step (section 2.17), and inserts the `approval.decided` event. Every 30 seconds the expiry sweeper runs `update approval_requests set state = 'EXPIRED', decided_at = now() where state = 'PENDING' and expires_at <= now() returning id, subject_id`, then moves each order to `APPROVAL_EXPIRED` and each booking to `EXPIRED` and writes `approval.expired`.

### 2.15 `orders`

```sql
create table public.orders (
  id          text primary key default gen_id('ord_'),
  business_id text not null references public.businesses (id) on delete cascade,
  call_id     text not null references public.calls (id),
  status      text not null default 'AWAITING_OWNER_APPROVAL' check (status in (
    'AWAITING_OWNER_APPROVAL', 'APPROVED',
    'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY',
    'REJECTED', 'APPROVAL_EXPIRED', 'UNAVAILABLE', 'PAYMENT_FAILED', 'CANCELLED', 'RECOVERY_REQUIRED')),
  cart        jsonb not null,
  cart_hash   text not null check (cart_hash ~ '^sha256:[0-9a-f]{64}$'),
  quote       jsonb not null,
  total_minor integer not null check (total_minor >= 0),
  currency    text not null default 'USD' check (currency = 'USD'),
  contact     jsonb not null,
  fulfillment jsonb not null,
  approval_id text references public.approval_requests (id),
  square_order_id text, square_payment_link_id text, checkout_url text, square_payment_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (business_id, cart_hash, call_id),
  check (status not in ('PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY')
         or (square_order_id is not null and square_payment_link_id is not null and checkout_url is not null)),
  check (status not in ('PAID_VERIFIED', 'FULFILLMENT_READY') or square_payment_id is not null)
);
create unique index orders_square_order_id_key on public.orders (square_order_id) where square_order_id is not null;
create unique index orders_square_payment_link_id_key on public.orders (square_payment_link_id) where square_payment_link_id is not null;
create unique index orders_square_payment_id_key on public.orders (square_payment_id) where square_payment_id is not null;  -- 0005
```

**Payment routines (migration 0005).** The server reads Square first, then calls one of these as `abos_app`. Both lock the order, check `business_id` and the order's `APPROVED` `order_bundle` approval, and are all or nothing.

| Routine | Wrapper | Does |
|---|---|---|
| `private.mark_order_paid(business, order, paymentId, amountMinor, currency)` returns `{order, syncJob}` | `markOrderPaid` | Accepts `PAYMENT_PENDING` or `PAYMENT_FAILED`. Amount and currency must equal both the signed `totalMinor`/`currency` and the order row. Records `square_payment_id`, moves to `PAID_VERIFIED`, enqueues the Sheets job through `enqueue_sheets_sync`, and writes `order.status_changed`, `payment.verified` and `sync.queued`. A repeat with the same payment ID (also after `FULFILLMENT_READY`) changes nothing and returns the same result. A different payment ID on a paid order, or a payment ID on another order, is refused. It does not set `FULFILLMENT_READY`. |
| `private.mark_order_payment_failed(business, order, paymentId, reason)` returns the order | `markOrderPaymentFailed` | `PAYMENT_PENDING` to `PAYMENT_FAILED` with `order.status_changed` and `payment.failed`. A repeat on `PAYMENT_FAILED` is a no-op. Any other state, including paid, is refused. |

Events use the approval ID as `correlation_id`, as the 0004 routines do.

The propose tool creates the row already in `AWAITING_OWNER_APPROVAL` (SPEC 2.4 rulings). The earlier states live in `calls.stage`, so the check holds exactly the fourteen values of the `OrderStatus` type (CONTRACTS.md). `UNAVAILABLE` here means the checkout step's re-check found an item gone. `unique (business_id, cart_hash, call_id)` makes a repeated `propose_order` return the existing row instead of making a second proposal. The two partial unique indexes stop one Square order or link attaching to two local orders (AC-10). The last two checks make the database refuse a paid state without a Square payment ID (SPEC rule 1.3.5). `PAYMENT_LINK_READY` may go straight to `PAYMENT_PENDING` when the channel is `qr_only` or the send fails. `quote` is the `Quote` (`qte_` ID, `expiresAt`) the proposal used; quotes before a proposal live only in the call session and are not stored. `total_minor` and `currency` are copied from the quote when the proposal is stored (SPEC 2.9).

### 2.16 `bookings`

```sql
create table public.bookings (
  id           text primary key default gen_id('bkg_'),
  business_id  text not null references public.businesses (id) on delete cascade,
  call_id      text references public.calls (id),
  status       text not null default 'AWAITING_OWNER_APPROVAL' check (status in (
    'AWAITING_OWNER_APPROVAL', 'RECHECKING_SLOT',
    'BOOKED_VERIFIED', 'SLOT_CONFLICT', 'REJECTED', 'EXPIRED', 'RETRY_REQUIRED')),
  service_id   text not null,
  service_name text not null,
  calendar_id  text not null,
  start_utc    timestamptz not null,
  end_utc      timestamptz not null,
  timezone     text not null,
  customer     jsonb not null,
  approval_id  text references public.approval_requests (id),
  google_event_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (end_utc > start_utc),
  check (status <> 'BOOKED_VERIFIED' or google_event_id is not null),
  constraint bookings_no_overlap exclude using gist (
    business_id with =, calendar_id with =, tstzrange(start_utc, end_utc, '[)') with &&
  ) where (status in ('RECHECKING_SLOT', 'BOOKED_VERIFIED'))
);
create unique index bookings_google_event_id_key on public.bookings (google_event_id) where google_event_id is not null;
create unique index bookings_one_proposal_per_call_slot
  on public.bookings (business_id, call_id, service_id, start_utc) where call_id is not null;
```

Like orders, the propose tool creates the row in `AWAITING_OWNER_APPROVAL`, and the check holds exactly the seven values of the `BookingStatus` type (CONTRACTS.md). `service_id` is the `svc_` key of a `service` fact; it has no foreign key because facts are versioned. `bookings_no_overlap` is per calendar and covers `RECHECKING_SLOT` as well as `BOOKED_VERIFIED` (SPEC 2.9), so moving a booking into `RECHECKING_SLOT` is the local slot lock: a second approval for an overlapping slot fails on that update, before Google Calendar is called. The `[)` range lets back to back slots touch. It needs `btree_gist`; if the migration cannot find the gist operator class for text, install the extension into `public`. The simpler fallback, if the exclusion constraint fights us, is `create unique index on bookings (business_id, calendar_id, start_utc) where status in ('RECHECKING_SLOT', 'BOOKED_VERIFIED')`, which is safe only while every service uses one fixed slot grid. `call_id` is nullable because the `Booking` shape allows it, though both live and simulated calls set it.

### 2.17 `action_executions`

```sql
create table public.action_executions (
  id              text primary key default gen_id('exe_'),
  business_id     text not null references public.businesses (id) on delete cascade,
  approval_id     text not null references public.approval_requests (id),
  action_type     text not null check (action_type in (
    'square.checkout.create', 'message.checkout.send', 'local.order.record',
    'calendar.event.create', 'message.booking.confirm', 'local.booking.record',
    'local.fact.update', 'square.catalog.price.update', 'local.catalog.sync')),
  capability_id   text references public.capabilities (id),
  step_index      smallint not null check (step_index >= 0),
  idempotency_key text not null unique check (idempotency_key ~ '^[0-9a-f]{64}$'),
  status          text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'NEEDS_REVIEW')),
  external_ref    text,
  attempts        integer not null default 0 check (attempts between 0 and 3),
  next_attempt_at timestamptz not null default now(),
  locked_by text, locked_at timestamptz, error_code text, last_error text,
  started_at timestamptz, finished_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (approval_id, action_type),
  unique (approval_id, step_index),
  check (status <> 'SUCCEEDED' or finished_at is not null)
);
```

`idempotency_key` is `sha256(businessId:subjectId:actionType:approvalId)` in hex (SPEC 2.9). It is computed once at insert and sent unchanged to Square, Google and the message channel on every retry; where a provider caps key length, the adapter shortens it the same way every time. `unique (approval_id, action_type)` means a double click on Approve cannot queue a bundle twice. A worker claims a row with `update ... set status = 'RUNNING', attempts = attempts + 1, locked_by = $1, locked_at = now() where id = $2 and status = 'QUEUED' and next_attempt_at <= now() returning *`, so only one worker owns an intent. A retryable failure returns to `QUEUED` with a later `next_attempt_at`; after 3 attempts it is `FAILED`; an unknown result is `NEEDS_REVIEW`, never a blind retry (SPEC 2.9). When `MESSAGE_CHANNEL` is `qr_only`, a message step goes straight to `SKIPPED` and no `message_dispatches` row is created (SPEC 2.9). `last_error` is `ActionExecution.lastError`. `capability_id` follows the SPEC 2.3 mapping and is null for `local.*` steps.

**Stale lease recovery (migration 0005).** `private.recover_stale_executions(business, staleAfter interval)` (wrapper `recoverStaleExecutions`, `staleAfterMs` at least 60000) moves every step in the business that is `RUNNING` with `locked_at` older than the interval to `NEEDS_REVIEW`, clears the lease and keeps the idempotency key. The provider outcome is unknown, so it never requeues. A stale checkout moves its order from `APPROVED` or `CREATING_CHECKOUT` to `RECOVERY_REQUIRED`; a stale calendar step moves its booking from `RECHECKING_SLOT` to `RETRY_REQUIRED`; each with a status event. A message step in `NEEDS_REVIEW` still lets local recording run. It returns the moved rows; the executor writes `execution.failed`. Sync job leases have no recovery yet.

The Sheets step is authorized at approval but runs later (SPEC 2.3), and it never gets an `action_executions` row (SPEC 2.9). That is why the `action_type` check leaves out `sheets.order.append` and `sheets.booking.append`. The transaction that moves an order into `PAID_VERIFIED`, or a booking into `BOOKED_VERIFIED`, inserts the `sync_jobs` row; the approval in `action_bundle` is its authority. An order that is never paid has no Sheets row and no pending job.

### 2.18 `message_dispatches`

```sql
create table public.message_dispatches (
  id                  text primary key default gen_id('msg_'),
  business_id         text not null references public.businesses (id) on delete cascade,
  approval_id         text not null references public.approval_requests (id),
  execution_id        text not null references public.action_executions (id),
  order_id            text references public.orders (id),
  booking_id          text references public.bookings (id),
  subject_id          text generated always as (coalesce(order_id, booking_id)) stored,
  channel             text not null check (channel in ('surge', 'android_gateway', 'whatsapp_sandbox')),
  recipient           text not null check (recipient ~ '^\+[1-9][0-9]{6,14}$'),
  template            text not null check (template in ('checkout_link', 'booking_confirmed')),
  body_hash           text not null check (body_hash ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key     text not null unique,
  status              text not null default 'QUEUED' check (status in ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNKNOWN')),
  provider_message_id text,
  attempts            integer not null default 0 check (attempts between 0 and 3),
  error_code text, sent_at timestamptz, delivered_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (num_nonnulls(order_id, booking_id) = 1),
  check (status not in ('SENT', 'DELIVERED') or provider_message_id is not null)
);
create unique index message_dispatches_provider_id_key
  on public.message_dispatches (channel, provider_message_id) where provider_message_id is not null;
```

The adapter inserts this row with the execution's idempotency key before it calls the provider, so a retry finds the row and does not send twice. Under `qr_only` nothing is sent, so no row exists and nothing is ever marked sent (SPEC 2.9). A timeout with no provider answer sets `UNKNOWN`, which needs review; a failed or unknown message does not fail the order or booking (SPEC 2.3). `order_id` and `booking_id` keep real foreign keys; `subject_id` is a generated column that gives the `MessageDispatch.subjectId` field. Only the body hash is stored; the checkout URL lives on the order. `recipient` is stored in full and must equal the number in the approved payload (application rule, checked against `payload_hash`); events show only its last four digits. The adapter adds WhatsApp's `whatsapp:` prefix; it is not stored.

### 2.19 `webhook_events`

```sql
create table public.webhook_events (
  id                text primary key default gen_id('whk_'),
  source            text not null check (source in ('square', 'twilio_voice', 'twilio_status')),
  provider_event_id text not null,
  event_type        text not null,
  business_id       text references public.businesses (id) on delete cascade,
  payload           jsonb not null default '{}',
  received_at       timestamptz not null default now(),
  processed_at timestamptz, process_error text,
  unique (source, provider_event_id)
);
```

Only signature-verified events are inserted (SPEC 2.9), so the table has no `signature_valid` column. A rejected webhook writes one `webhook.rejected` activity event and nothing else. That event belongs to the business that owns the integration the webhook URL serves, read from `integrations`, so `activity_events.business_id` stays not null. Nothing from the unverified request body is trusted or stored, in this table or in the event payload (SPEC 2.9). `unique (source, provider_event_id)` is the replay guard: the handler inserts with `on conflict do nothing` and processes only when a row was inserted. Square uses `event_id`; Twilio callbacks use `CallSid:CallStatus`. WhatsApp message status arrives on `/webhooks/twilio/status` and uses source `twilio_status` (SPEC 2.8). `payload` keeps only object IDs, statuses, amount and currency; `card_details` is stripped before insert.

### 2.20 `sync_jobs`

```sql
create table public.sync_jobs (
  id            text primary key default gen_id('syn_'),
  business_id   text not null references public.businesses (id) on delete cascade,
  target        text not null check (target in ('google_sheets')),
  record_type   text not null check (record_type in ('order', 'booking')),
  record_id     text not null,
  state         text not null default 'PENDING' check (state in ('PENDING', 'RUNNING', 'DONE', 'RETRYING', 'FAILED')),
  attempts      integer not null default 0 check (attempts between 0 and 5),
  next_retry_at timestamptz not null default now(),
  external_ref text, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (target, record_type, record_id)
);
```

A row is created only when the order reaches `PAID_VERIFIED` or the booking reaches `BOOKED_VERIFIED` (section 2.17). `unique (target, record_type, record_id)` is the local export key: one Sheets row per order or booking however often the step runs. The Sheets row carries `record_id` in its first column so a retry can check the sheet before it appends (PRD section 14). After 5 attempts the job is `FAILED`. A failed sync never changes the order or booking status (AC-13). Catalog sync is not a `sync_jobs` row; it is a background job (section 7).

### 2.21 `activity_events`

```sql
create table public.activity_events (
  id             text primary key default gen_id('evt_'),
  business_id    text not null references public.businesses (id) on delete cascade,
  type           text not null check (type in (
    'call.started', 'call.ended', 'proposal.created', 'approval.requested', 'approval.decided', 'approval.expired',
    'execution.started', 'execution.succeeded', 'execution.failed', 'checkout.created', 'message.sent', 'message.failed',
    'payment.verified', 'payment.failed', 'booking.verified', 'booking.slot_conflict', 'order.status_changed',
    'booking.status_changed', 'sync.queued', 'sync.succeeded', 'sync.failed', 'fact.changed', 'extraction.completed',
    'agent.published', 'agent.paused', 'live_agent.changed', 'guardrail.refused', 'webhook.rejected')),
  agent_id       text references public.agents (id) on delete set null,
  correlation_id text not null,
  actor_type     text not null check (actor_type in ('owner', 'deployed_agent', 'system', 'provider')),
  occurred_at    timestamptz not null default now(),
  payload        jsonb not null default '{}'
);

create or replace function public.activity_events_append_only() returns trigger
language plpgsql as $$ begin raise exception 'activity_events is append only'; end $$;
create trigger activity_events_append_only before update or delete on public.activity_events
  for each row execute function public.activity_events_append_only();
```

`type` has a check constraint with the full SPEC 2.5 list, so a misspelled event fails at insert. Adding a type is one `ALTER TABLE`. Append only is enforced twice: RLS gives no update or delete policy, and the trigger blocks the service role too. `TRUNCATE` fires no row triggers, so the reset script still works. The server redacts `payload` before insert: phone numbers as last four digits only, first names only, no checkout URLs, no secrets. `correlation_id` is the `call_` ID for phone journeys, the `bld_` ID for builder journeys and the `apv_` ID for fact edits (CONTRACTS.md).

## 3. Indexes for dashboard queries

```sql
create index approval_requests_pending_idx on public.approval_requests (business_id, expires_at) where state = 'PENDING';
create index orders_business_created_idx   on public.orders (business_id, created_at desc);
create index bookings_business_start_idx   on public.bookings (business_id, start_utc);
create index calls_business_started_idx    on public.calls (business_id, started_at desc);
create index activity_business_time_idx    on public.activity_events (business_id, occurred_at desc);
create index activity_correlation_idx      on public.activity_events (correlation_id, occurred_at);
create index business_facts_kind_idx       on public.business_facts (business_id, kind, status);
create index fact_conflicts_open_idx       on public.fact_conflicts (business_id) where state = 'open';
create index executions_queue_idx          on public.action_executions (next_attempt_at) where status = 'QUEUED';
create index sync_jobs_due_idx             on public.sync_jobs (next_retry_at) where state in ('PENDING', 'RETRYING');
```

"Today's orders" uses the business time zone, so the day boundary is the shop's and not UTC:

```sql
select o.* from public.orders o join public.businesses b on b.id = o.business_id
where o.business_id = $1
  and o.created_at >= (date_trunc('day', now() at time zone b.timezone) at time zone b.timezone)
order by o.created_at desc;
```

## 4. Row level security and Realtime

The Fastify server connects with the service role key, which bypasses RLS. Every server query still filters on the `business_id` of the owner's selected business, through one repository helper that refuses a query without it. RLS is the second wall: if the anon key or an owner JWT ever reaches a table, the owner sees only their own businesses and nobody can write. The browser reads only `activity_events` directly, for Realtime.

```sql
create or replace function public.owns_business(b text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.businesses biz join public.users u on u.id = biz.owner_id
    where biz.id = b and u.auth_user_id = (select auth.uid()));
$$;

alter table public.users enable row level security;
create policy users_self_read on public.users for select to authenticated using (auth_user_id = (select auth.uid()));
alter table public.businesses enable row level security;
create policy businesses_owner_read on public.businesses for select to authenticated using (public.owns_business(id));
alter table public.capabilities enable row level security;
create policy capabilities_read on public.capabilities for select to authenticated using (true);

do $$
declare t text;
begin
  foreach t in array array[
    'integrations', 'files', 'business_facts', 'catalog_items', 'fact_conflicts', 'agents', 'agent_versions',
    'live_agent', 'builder_sessions', 'calls', 'approval_requests', 'orders', 'bookings', 'action_executions',
    'message_dispatches', 'sync_jobs', 'activity_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.owns_business(business_id))',
                   t || '_owner_read', t);
  end loop;
end $$;

alter table public.webhook_events enable row level security;  -- no policy: service role only

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;

alter publication supabase_realtime add table public.activity_events;
```

No table has an insert, update or delete policy, so `authenticated` and `anon` cannot write anything. Supabase Realtime applies `activity_events_owner_read` to each subscriber, so a dashboard subscribed with the owner's JWT receives only that owner's events (P-16). The UI treats each event as a signal to refetch through the API. The isolation test (AC-17) queries each table with a second owner's JWT and expects zero rows.

## 5. Source precedence

PRD section 10 sets which source wins. The tables implement it like this:

| Data | Authority | How the model enforces it |
|---|---|---|
| Items, variations, prices, modifiers | Square catalog | `catalog.read` reads only `catalog_items`, which only the Square sync writes. Quotes always come from Square `CalculateOrder` (P-02), never from `catalog_items.price_minor`. |
| Opening hours, policies, services, FAQ | Owner-verified facts | `business.facts.read` reads only rows with `status = 'verified'`, through the call's `fact_snapshot_ref`. |
| Appointment availability | Google Calendar | `calendar.availability.read` calls free/busy live. `bookings` holds proposals and verified results, not availability. |
| Uploads and owner chat | Proposals only | They insert `business_facts` drafts with `confidence` and `source_type`. A draft becomes verified only through an approved `fact_edit`. |

When extraction saves a draft that disagrees with an authority, it writes a `fact_conflicts` row in the same transaction. A draft `menu_item` fact is compared with `catalog_items` on normalized item and variation names, and a price difference opens a required conflict (AC-02). A draft hours, policy or service fact is compared with the current verified fact for the same kind and key. The deployed agent never reads `menu_item` facts, so it always uses the Square price. Publishing is blocked while a required conflict is `open`.

## 6. Seed and reset

### 6.1 Seed script (task B-10)

The seed is idempotent: every insert uses `on conflict do nothing` or an upsert on the natural key.

1. **Owner.** Create the auth user with the Supabase admin API from `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` in `.env.local`, then insert the `users` row `usr_owner_01` with `role = 'owner'`.
2. **Businesses.** `biz_pizza_01` ("Demo Pizza Co.", category `restaurant`) and `biz_barber_01` ("Demo Barbershop", category `barbershop`), both owned by `usr_owner_01`, time zone `America/Los_Angeles`.
3. **Capabilities.** The thirteen rows of SPEC 2.2, shown below. `input_schema` and `output_schema` are generated from the Zod schemas in `packages/contracts`, so the registry cannot drift from the code. `handler_id`, `required_scopes` and `timeout_ms` come from the registry table in CONTRACTS.md section 2.
4. **Integrations.** Square for the pizza shop (`config.locationId` from `SQUARE_LOCATION_ID`), Google Calendar for the barbershop (`config.calendarId` from `GOOGLE_CALENDAR_ID`), and `twilio`, `openai`, `google_sheets` and `message_channel` for both.
5. **Facts.** All with `source_type = 'seed'`, `status = 'verified'`, `confidence = 1`, `version = 1`. Each business gets seven `hours` facts, keys `mon` to `sun`. The pizza shop gets `policy` facts `pickup_only`, `message_consent_required`, `special_requests` and `pickup_window`. The barbershop gets `policy` facts `booking_min_notice_minutes`, `booking_buffer_minutes` and `cancellation`, plus one `service` fact per service, keyed by its `svc_` ID, with a `ServiceOffering` value. The values come from the fixtures in `packages/contracts`.
6. **Pizza catalog.** The seed writes the pizza menu to the Square sandbox first with `BatchUpsertCatalogObjects` and a fixed idempotency key, then runs the normal catalog sync, which fills `catalog_items`. `catalog_items` is never seeded directly, because the Square object IDs and versions exist only after the upsert.
7. **Agents.** One published `restaurant_order_taker` agent and one published `appointment_booker` agent, each `seeded = true` at version 1. These are the known-good backups the PRD demo contingency asks for.
8. **Live agent.** One `live_agent` row for `TWILIO_PHONE_NUMBER`, pointing at the seeded pizza version.

| Capability IDs | effect | approval_mode | tier |
|---|---|---|---|
| `catalog.read`, `business.facts.read`, `order.quote`, `order.status.read`, `calendar.availability.read` | read | none | MUST |
| `order.propose`, `booking.propose` | propose | creates_approval | MUST |
| `order.checkout.prepare`, `calendar.event.create`, `sheets.rows.append` | write | required | MUST |
| `message.checkout.send`, `message.booking.confirm` | external_message | required | MUST |
| `catalog.price.update` | write | required | SHOULD |

### 6.2 Reset script

The reset runs in one transaction with `set local app.allow_reset = 'on'` and returns the database to its state right after seeding.

- **Truncated:** `message_dispatches`, `action_executions`, `sync_jobs`, `orders`, `bookings`, `approval_requests`, `calls`, `webhook_events`, `activity_events`, `fact_conflicts`, `builder_sessions`, and the `jobs` table or the pg-boss job tables.
- **Restored:** `live_agent` is pointed back at the seeded pizza version, then non-seeded agents are deleted with their versions. `business_facts` rows with `source_type <> 'seed'` are deleted first, then the seed rows are set back to `status = 'verified'`, which reverts the opening-hours edit. Non-seed `files` rows are deleted with their Storage objects.
- **Kept:** `users`, `businesses`, `capabilities`, `integrations`, `catalog_items` (re-synced from Square at the end), and the seeded agents and versions. Square sandbox orders, Calendar events and Sheets rows are not touched; the runbook says how to clear them. If a demo price change ran, the reset re-applies the seed price in Square before the re-sync.

## 7. Background jobs

pg-boss is the first choice (SPEC 3.2). It creates and migrates its own `pgboss` schema on start and must use the Supabase session connection (port 5432), not the transaction pooler. That schema is not exposed through the Supabase API, and `anon` and `authenticated` get no grants on it.

If pg-boss fights us, the server polls this table every second instead:

```sql
create table public.jobs (
  id            text primary key default gen_id('job_'),
  queue         text not null check (queue in ('execute_action', 'process_webhook', 'reconcile_payment',
                                               'sync_sheets', 'expire_approvals', 'sync_catalog', 'extract_file')),
  payload       jsonb not null default '{}',
  singleton_key text,
  state         text not null default 'QUEUED' check (state in ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
  attempts      integer not null default 0,
  max_attempts  integer not null default 5 check (max_attempts between 1 and 20),
  run_after     timestamptz not null default now(),
  locked_by text, locked_at timestamptz, last_error text,
  created_at    timestamptz not null default now(),
  unique (queue, singleton_key)
);
create index jobs_due_idx on public.jobs (run_after) where state = 'QUEUED';
alter table public.jobs enable row level security;  -- no policy: service role only
```

`unique (queue, singleton_key)` stops the same work being queued twice, for example `reconcile_payment` keyed by order ID. Rows with a null `singleton_key` are not deduplicated. The payment poller (every 30 seconds for 15 minutes after the link is ready, SPEC 2.9) is a `reconcile_payment` job that re-queues itself with a later `run_after`. The claim query takes one due job without blocking other workers:

```sql
with next as (
  select id from public.jobs
  where state = 'QUEUED' and run_after <= now()
  order by run_after
  limit 1
  for update skip locked
)
update public.jobs j
set state = 'RUNNING', attempts = j.attempts + 1, locked_by = $1, locked_at = now()
from next where j.id = next.id
returning j.*;
```

On failure the worker sets `state = 'QUEUED'` and `run_after = now() + backoff` while `attempts < max_attempts`, otherwise `FAILED`. A sweeper returns `RUNNING` rows with `locked_at < now() - interval '5 minutes'` to `QUEUED`.

## 8. Names added by this doc

**Functions, triggers, settings, storage:** `gen_id`, `set_updated_at`, `agent_versions_immutable`, `activity_events_append_only`, `owns_business`, the session setting `app.allow_reset`, the Storage bucket `business-files`, and the seed variables `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD`.

**Columns not defined in SPEC or the PRD:** `users.display_name`; `businesses.currency`; `capabilities.approval_mode`, `tier`; `integrations.config`, `last_error`; `files.name`, `size_bytes` (PRD `size`), `uploaded_by`; `business_facts.confidence`, `file_id`, `supersedes_id`, `verified_by`, `updated_at`; all `catalog_items` and `fact_conflicts` column names; `agents.channel`, `draft_spec`, `seeded`, `spec_revision`; `agent_versions.business_id`, `guardrail_version`; all `live_agent` column names; `builder_sessions.owner_id`, `agent_id`, `status`, `messages` (PRD `messages_json_ref`); `calls.agent_id`, `caller_last4` (PRD `caller_ref`), `fact_snapshot_ref`, `end_reason`, `started_at` (PRD `began_at`); `approval_requests.actor_id`, `decision_reason`; `action_executions.step_index`, `next_attempt_at`, `locked_by`, `locked_at`, `last_error`, `started_at`, `finished_at`; `message_dispatches.approval_id`, `order_id`, `booking_id`, `subject_id` (generated), `body_hash`, `sent_at`, `delivered_at`; `webhook_events.event_type`, `business_id`, `payload`, `process_error`; `sync_jobs.external_ref`, `last_error`; `activity_events.payload` (PRD `redacted_payload`).

**Enumerated values:** `users.role`; `builder_sessions.status`; `calls.end_reason`; `webhook_events.source`; `sync_jobs.record_type`; `jobs.queue` and `state`. The values of `files.extraction_state`, `integrations.state`, `capabilities.approval_mode` and `business_facts.kind` come from CONTRACTS.md and SPEC 2.9.

**Constraint and index names:** all names in sections 2, 3 and 7, including `business_facts_one_verified`, `approval_requests_one_pending_per_subject`, `fact_conflicts_one_open`, `bookings_no_overlap`, `bookings_one_proposal_per_call_slot` and `agents_active_version_fk`.

**Open items:** none. Quotes and test console sessions have no table (SPEC 2.9 "Not persisted"). Catalog sync is a background job, not a `sync_jobs` row; its `sync.*` events carry `target: "catalog"` (CONTRACTS.md section 7).
