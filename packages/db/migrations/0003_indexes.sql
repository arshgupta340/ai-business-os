-- 0003: unique indexes on provider IDs and indexes for dashboard queries.
-- Source: docs/DATA-MODEL.md sections 2.15, 2.16 and 3.

-- One Square order or payment link can never attach to two local orders (AC-10).
create unique index orders_square_order_id_key
  on public.orders (square_order_id) where square_order_id is not null;
create unique index orders_square_payment_link_id_key
  on public.orders (square_payment_link_id) where square_payment_link_id is not null;

-- One Google event can never verify two bookings.
create unique index bookings_google_event_id_key
  on public.bookings (google_event_id) where google_event_id is not null;
-- A repeated propose_booking for the same slot on the same call finds the existing row.
create unique index bookings_one_proposal_per_call_slot
  on public.bookings (business_id, call_id, service_id, start_utc) where call_id is not null;

-- Dashboard and worker queries.
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
