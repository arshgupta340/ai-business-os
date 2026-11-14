-- 0002: core tables in dependency order, then row level security for all of them.
-- Source: docs/DATA-MODEL.md sections 2 and 4. Names follow docs/SPEC.md 2.1 to 2.9.
-- Status columns use check constraints with the exact SPEC 2.4 strings, not enums.
-- Tables and their RLS are in one file, so one transaction: no committed state has a table without RLS.

-- 2.1 users: public profile of a Supabase Auth user.
create table public.users (
  id           text primary key default public.gen_id('usr_'),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  email        text not null unique,
  display_name text,
  role         text not null default 'owner' check (role in ('owner', 'admin')),
  created_at   timestamptz not null default now()
);

-- 2.2 businesses: owner_id anchors every row level security policy.
create table public.businesses (
  id         text primary key default public.gen_id('biz_'),
  owner_id   text not null references public.users (id),
  name       text not null,
  category   text not null,
  timezone   text not null,
  currency   text not null default 'USD' check (currency = 'USD'),
  contact    jsonb not null default '{}',
  settings   jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2.3 capabilities: the global registry, written only by the seed script.
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
  -- Never-broken rule 1: a write or external_message capability always requires approval.
  constraint capabilities_write_requires_approval
    check ((effect in ('write', 'external_message')) = (approval_mode = 'required')),
  constraint capabilities_propose_creates_approval
    check ((effect = 'propose') = (approval_mode = 'creates_approval'))
);

-- 2.4 integrations: config holds non-secret settings only; config_ref names an environment variable.
create table public.integrations (
  id              text primary key default public.gen_id('int_'),
  business_id     text not null references public.businesses (id) on delete cascade,
  provider        text not null check (provider in ('square', 'twilio', 'openai', 'google_calendar', 'google_sheets', 'message_channel')),
  alias           text not null,
  state           text not null default 'disconnected' check (state in ('connected', 'degraded', 'disconnected')),
  config_ref      text,
  config          jsonb not null default '{}',
  last_checked_at timestamptz,
  last_error      text,
  unique (business_id, provider, alias)
);

-- 2.5 files: uploads in the private Storage bucket business-files. 10 MB cap (SPEC 2.9).
create table public.files (
  id               text primary key default public.gen_id('file_'),
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

-- 2.6 business_facts: versioned facts. Uploads and chat insert drafts only.
create table public.business_facts (
  id            text primary key default public.gen_id('fact_'),
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
  verified_at   timestamptz,
  verified_by   text references public.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((status = 'draft') = (verified_at is null))
);
-- At most one verified fact per business, kind and key (SPEC 2.9). Supersede the old row before verifying the new one.
create unique index business_facts_one_verified
  on public.business_facts (business_id, kind, key) where status = 'verified';
create unique index business_facts_version
  on public.business_facts (business_id, kind, key, version) where status <> 'draft';

-- 2.7 catalog_items: one row per sellable Square variation, written only by the Square sync.
create table public.catalog_items (
  id                       text primary key default public.gen_id('cat_'),
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

-- 2.8 fact_conflicts: a draft fact that disagrees with an authoritative source. Blocks publish while open and required.
create table public.fact_conflicts (
  id               text primary key default public.gen_id('cfl_'),
  business_id      text not null references public.businesses (id) on delete cascade,
  kind             text not null check (kind in ('hours', 'policy', 'service', 'contact', 'faq', 'menu_item')),
  key              text not null,
  candidates       jsonb not null check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) >= 2),
  required         boolean not null default true,
  state            text not null default 'open' check (state in ('open', 'resolved')),
  resolved_fact_id text references public.business_facts (id),
  resolved_by      text references public.users (id),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  check ((state = 'resolved') = (resolved_at is not null and resolved_by is not null))
);
create unique index fact_conflicts_one_open
  on public.fact_conflicts (business_id, kind, key) where state = 'open';

-- 2.9 agents: a live or paused agent always points to a version.
create table public.agents (
  id                text primary key default public.gen_id('agt_'),
  business_id       text not null references public.businesses (id) on delete cascade,
  name              text not null,
  template          text not null check (template in ('restaurant_order_taker', 'appointment_booker', 'custom')),
  channel           text not null default 'phone' check (channel = 'phone'),
  state             text not null default 'draft' check (state in ('draft', 'live', 'paused')),
  draft_spec        jsonb,
  active_version_id text,
  seeded            boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (state = 'draft' or active_version_id is not null),
  unique (id, business_id)
);

-- 2.10 agent_versions: published versions are immutable (trigger in 0004).
create table public.agent_versions (
  id                     text primary key default public.gen_id('agv_'),
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
-- An agent can point only at one of its own versions.
alter table public.agents add constraint agents_active_version_fk
  foreign key (active_version_id, id) references public.agent_versions (id, agent_id);

-- 2.11 live_agent: which pinned agent version answers each phone number (P-06).
create table public.live_agent (
  phone_number     text primary key check (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  business_id      text not null references public.businesses (id),
  agent_id         text not null,
  agent_version_id text not null,
  updated_at       timestamptz not null default now(),
  foreign key (agent_version_id, agent_id) references public.agent_versions (id, agent_id) on delete restrict,
  foreign key (agent_id, business_id) references public.agents (id, business_id)
);

-- 2.12 builder_sessions: messages are kept inline. Only text is stored, never audio.
create table public.builder_sessions (
  id             text primary key default public.gen_id('bld_'),
  business_id    text not null references public.businesses (id) on delete cascade,
  owner_id       text not null references public.users (id),
  agent_id       text references public.agents (id) on delete set null,
  status         text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  messages       jsonb not null default '[]',
  draft_spec     jsonb,
  missing_fields jsonb not null default '[]',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 2.13 calls: stage holds the conversation states before a proposal exists (SPEC 2.4 rulings).
create table public.calls (
  id                text primary key default public.gen_id('call_'),
  business_id       text not null references public.businesses (id) on delete cascade,
  agent_id          text not null,
  agent_version_id  text not null,
  channel           text not null default 'phone' check (channel in ('phone', 'test_console')),
  -- Twilio CallSid. Unique so a repeated Twilio webhook cannot open a second call row.
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

-- 2.14 approval_requests: one approval covers one bundle. Expiry is 10 minutes (SPEC 2.9).
create table public.approval_requests (
  id              text primary key default public.gen_id('apv_'),
  business_id     text not null references public.businesses (id) on delete cascade,
  actor_type      text not null check (actor_type in ('deployed_agent', 'owner')),
  actor_id        text,
  bundle_type     text not null check (bundle_type in ('order_bundle', 'booking_bundle', 'fact_edit', 'price_edit')),
  action_bundle   text[] not null,
  subject_id      text not null,
  payload         jsonb not null,
  payload_hash    text not null check (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  state           text not null default 'PENDING' check (state in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  expires_at      timestamptz not null default now() + interval '10 minutes',
  decided_by      text references public.users (id),
  decided_at      timestamptz,
  decision_reason text,
  created_at      timestamptz not null default now(),
  -- Never-broken rule 1: each bundle type carries exactly the SPEC 2.3 step list, so no step can be added or dropped.
  constraint approval_requests_bundle_matches_type check (
    (bundle_type = 'order_bundle'   and action_bundle = array['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append']) or
    (bundle_type = 'booking_bundle' and action_bundle = array['calendar.event.create', 'message.booking.confirm', 'local.booking.record', 'sheets.booking.append']) or
    (bundle_type = 'fact_edit'      and action_bundle = array['local.fact.update']) or
    (bundle_type = 'price_edit'     and action_bundle = array['square.catalog.price.update', 'local.catalog.sync'])),
  -- One-use approvals: a decided row always has decided_at, and a PENDING row never does.
  constraint approval_requests_decided_at check ((state = 'PENDING') = (decided_at is null)),
  constraint approval_requests_decided_by check ((state in ('APPROVED', 'REJECTED')) = (decided_by is not null))
);
-- One-use approvals: at most one PENDING approval per order, booking, fact or catalog item.
create unique index approval_requests_one_pending_per_subject
  on public.approval_requests (subject_id) where state = 'PENDING';

-- 2.15 orders: created by propose_order already in AWAITING_OWNER_APPROVAL.
create table public.orders (
  id          text primary key default public.gen_id('ord_'),
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
  square_order_id        text,
  square_payment_link_id text,
  checkout_url           text,
  square_payment_id      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A repeated propose_order for the same cart on the same call finds the existing row.
  unique (business_id, cart_hash, call_id),
  -- Never-broken rule 5: no link-ready or later state without the Square order, link and URL.
  constraint orders_link_states_need_square_refs check (
    status not in ('PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY')
    or (square_order_id is not null and square_payment_link_id is not null and checkout_url is not null)),
  -- Never-broken rule 5: no paid state without a Square payment ID.
  constraint orders_paid_states_need_payment check (
    status not in ('PAID_VERIFIED', 'FULFILLMENT_READY') or square_payment_id is not null)
);

-- 2.16 bookings: created by propose_booking already in AWAITING_OWNER_APPROVAL.
create table public.bookings (
  id              text primary key default public.gen_id('bkg_'),
  business_id     text not null references public.businesses (id) on delete cascade,
  call_id         text references public.calls (id),
  status          text not null default 'AWAITING_OWNER_APPROVAL' check (status in (
    'AWAITING_OWNER_APPROVAL', 'RECHECKING_SLOT',
    'BOOKED_VERIFIED', 'SLOT_CONFLICT', 'REJECTED', 'EXPIRED', 'RETRY_REQUIRED')),
  service_id      text not null,
  service_name    text not null,
  calendar_id     text not null,
  start_utc       timestamptz not null,
  end_utc         timestamptz not null,
  timezone        text not null,
  customer        jsonb not null,
  approval_id     text references public.approval_requests (id),
  google_event_id text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_utc > start_utc),
  -- Never-broken rule 5: no verified booking without the Google event ID.
  constraint bookings_verified_needs_event check (status <> 'BOOKED_VERIFIED' or google_event_id is not null),
  -- No overlapping bookings: per calendar, two RECHECKING_SLOT or BOOKED_VERIFIED rows can never overlap.
  -- Moving a booking into RECHECKING_SLOT is the local slot lock. '[)' lets back to back slots touch.
  constraint bookings_no_overlap exclude using gist (
    business_id with =, calendar_id with =, tstzrange(start_utc, end_utc, '[)') with &&
  ) where (status in ('RECHECKING_SLOT', 'BOOKED_VERIFIED'))
);

-- 2.17 action_executions: one row per approved step, except the Sheets step (SPEC 2.9).
create table public.action_executions (
  id              text primary key default public.gen_id('exe_'),
  business_id     text not null references public.businesses (id) on delete cascade,
  approval_id     text not null references public.approval_requests (id),
  action_type     text not null check (action_type in (
    'square.checkout.create', 'message.checkout.send', 'local.order.record',
    'calendar.event.create', 'message.booking.confirm', 'local.booking.record',
    'local.fact.update', 'square.catalog.price.update', 'local.catalog.sync')),
  capability_id   text references public.capabilities (id),
  step_index      smallint not null check (step_index >= 0),
  -- Never-broken rule 3: one stable idempotency key per external write, sha256(businessId:subjectId:actionType:approvalId) in hex.
  idempotency_key text not null unique check (idempotency_key ~ '^[0-9a-f]{64}$'),
  status          text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'NEEDS_REVIEW')),
  external_ref    text,
  -- Retry limit: 3 attempts per execution step (SPEC 2.9).
  attempts        integer not null default 0 check (attempts between 0 and 3),
  next_attempt_at timestamptz not null default now(),
  locked_by       text,
  locked_at       timestamptz,
  error_code      text,
  last_error      text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A double click on Approve cannot queue the same bundle twice.
  unique (approval_id, action_type),
  unique (approval_id, step_index),
  -- Target of the message_dispatches composite key below.
  unique (id, approval_id, business_id),
  check (status <> 'SUCCEEDED' or finished_at is not null)
);

-- 2.18 message_dispatches: one row per outbound message, inserted before the provider call.
create table public.message_dispatches (
  id                  text primary key default public.gen_id('msg_'),
  business_id         text not null references public.businesses (id) on delete cascade,
  approval_id         text not null references public.approval_requests (id),
  execution_id        text not null references public.action_executions (id),
  order_id            text references public.orders (id),
  booking_id          text references public.bookings (id),
  subject_id          text generated always as (coalesce(order_id, booking_id)) stored,
  -- qr_only sends nothing, so it never has a dispatch row (SPEC 2.9).
  channel             text not null check (channel in ('surge', 'android_gateway', 'whatsapp_sandbox')),
  recipient           text not null check (recipient ~ '^\+[1-9][0-9]{6,14}$'),
  template            text not null check (template in ('checkout_link', 'booking_confirmed')),
  body_hash           text not null check (body_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- Never-broken rule 3: a retry finds this row by its key and does not send twice.
  idempotency_key     text not null unique,
  status              text not null default 'QUEUED' check (status in ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNKNOWN')),
  provider_message_id text,
  attempts            integer not null default 0 check (attempts between 0 and 3),
  error_code          text,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (num_nonnulls(order_id, booking_id) = 1),
  -- Never-broken rule 1: a dispatch belongs to the same approval and business as the execution that sends it.
  constraint message_dispatches_execution_approval_fk
    foreign key (execution_id, approval_id, business_id)
    references public.action_executions (id, approval_id, business_id),
  -- Never-broken rule 5: nothing is marked sent without the provider's message ID.
  constraint message_dispatches_sent_needs_provider_id check (status not in ('SENT', 'DELIVERED') or provider_message_id is not null)
);
create unique index message_dispatches_provider_id_key
  on public.message_dispatches (channel, provider_message_id) where provider_message_id is not null;

-- 2.19 webhook_events: only signature-verified events are stored (SPEC 2.9).
create table public.webhook_events (
  id                text primary key default public.gen_id('whk_'),
  source            text not null check (source in ('square', 'twilio_voice', 'twilio_status')),
  provider_event_id text not null,
  event_type        text not null,
  business_id       text references public.businesses (id) on delete cascade,
  payload           jsonb not null default '{}',
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  process_error     text,
  -- Never-broken rule 2, webhook dedupe: the same provider event is stored once.
  -- The handler inserts with "on conflict do nothing" and processes only when a row was inserted.
  constraint webhook_events_source_provider_event_id_key unique (source, provider_event_id)
);

-- 2.20 sync_jobs: Sheets export, created when an order is PAID_VERIFIED or a booking is BOOKED_VERIFIED.
create table public.sync_jobs (
  id            text primary key default public.gen_id('syn_'),
  business_id   text not null references public.businesses (id) on delete cascade,
  target        text not null check (target in ('google_sheets')),
  record_type   text not null check (record_type in ('order', 'booking')),
  record_id     text not null,
  state         text not null default 'PENDING' check (state in ('PENDING', 'RUNNING', 'DONE', 'RETRYING', 'FAILED')),
  -- Retry limit: 5 attempts per sync job (SPEC 2.9).
  attempts      integer not null default 0 check (attempts between 0 and 5),
  next_retry_at timestamptz not null default now(),
  external_ref  text,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One Sheets row per order or booking, however often the step runs.
  unique (target, record_type, record_id)
);

-- 2.21 activity_events: the audit log. Append only (trigger in 0004, no write policy in 0005).
create table public.activity_events (
  id             text primary key default public.gen_id('evt_'),
  business_id    text not null references public.businesses (id) on delete cascade,
  type           text not null check (type in (
    'call.started', 'call.ended', 'proposal.created', 'approval.requested', 'approval.decided', 'approval.expired',
    'execution.started', 'execution.succeeded', 'execution.failed', 'checkout.created', 'message.sent', 'message.failed',
    'payment.verified', 'payment.failed', 'booking.verified', 'booking.slot_conflict', 'order.status_changed',
    'booking.status_changed', 'sync.queued', 'sync.succeeded', 'sync.failed', 'fact.changed', 'extraction.completed',
    'agent.published', 'agent.paused', 'live_agent.changed', 'guardrail.refused', 'webhook.rejected')),
  -- Restrict, not set null: set null would rewrite audit rows. An agent with events is not deletable.
  agent_id       text references public.agents (id) on delete restrict,
  correlation_id text not null,
  actor_type     text not null check (actor_type in ('owner', 'deployed_agent', 'system', 'provider')),
  occurred_at    timestamptz not null default now(),
  payload        jsonb not null default '{}'
);

-- ---------------------------------------------------------------------------------------------
-- Row level security (DATA-MODEL section 4).
-- The server uses the service role, which bypasses RLS. RLS is the second wall: with an owner JWT
-- an owner reads only their own businesses (AC-17), and anon and authenticated can write nothing.

-- True when the signed-in Supabase user owns business b. Lives in the unexposed private schema.
create or replace function private.owns_business(b text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.businesses biz join public.users u on u.id = biz.owner_id
    where biz.id = b and u.auth_user_id = (select auth.uid()));
$$;
revoke all on function private.owns_business(text) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.owns_business(text) to authenticated;

alter table public.users enable row level security;
create policy users_self_read on public.users
  for select to authenticated using (auth_user_id = (select auth.uid()));

alter table public.businesses enable row level security;
create policy businesses_owner_read on public.businesses
  for select to authenticated using (private.owns_business(id));

alter table public.capabilities enable row level security;
create policy capabilities_read on public.capabilities
  for select to authenticated using (true);

-- Every business-scoped table: an owner may read only rows of a business they own.
do $$
declare t text;
begin
  foreach t in array array[
    'integrations', 'files', 'business_facts', 'catalog_items', 'fact_conflicts', 'agents', 'agent_versions',
    'live_agent', 'builder_sessions', 'calls', 'approval_requests', 'orders', 'bookings', 'action_executions',
    'message_dispatches', 'sync_jobs', 'activity_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.owns_business(business_id))',
                   t || '_owner_read', t);
  end loop;
end $$;

-- No policy at all: service role only.
alter table public.webhook_events enable row level security;

-- Privileges. Clear anything anon or authenticated holds on any table in public (including grants
-- made before 0001 changed the defaults), then grant back only select, and only where a policy exists.
revoke all on all tables in schema public from anon, authenticated;
grant select on
  public.users, public.businesses, public.capabilities,
  public.integrations, public.files, public.business_facts, public.catalog_items, public.fact_conflicts,
  public.agents, public.agent_versions, public.live_agent, public.builder_sessions, public.calls,
  public.approval_requests, public.orders, public.bookings, public.action_executions,
  public.message_dispatches, public.sync_jobs, public.activity_events
to authenticated;
