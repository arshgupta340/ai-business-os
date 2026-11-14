-- DEMO MODE ONLY (SPEC D-13, DEMO_PAY_FIRST). Two demo tables for the pay-first hackathon demo: which
-- orders got a demo pay link and a demo "payment", and an audit row for every demo message sent. Additive
-- only: two new tables with their keys, checks, policies and grants. No existing table, column, constraint,
-- trigger, policy or routine changes, and the migration writes no row. Apply as the non-superuser migration
-- owner; the runner wraps this file in one transaction. 0001 to 0008 are unchanged.
--
-- These are not protected tables. Nothing in them moves an order: the real status still changes only
-- through the approval engine, the executor and the signed Square webhook and reconcile path. A demo
-- "payment" here (demo_paid_at) is a click on a demo page, never a provider-confirmed state.
-- The caller's full number is kept only in these two tables (recipient), and only for numbers the
-- owner listed in DEMO_TEXT_NUMBERS.

-- 1. One row per order proposed on a demo call.
create table public.demo_orders (
  order_id             text primary key,
  business_id          text not null references public.businesses (id),
  recipient            text not null check (recipient ~ '^\+[1-9][0-9]{6,14}$'),
  -- The demo pay link message went out (stamped after the send was accepted).
  link_sent_at         timestamptz,
  -- The customer pressed Pay on the demo page. Not a payment: no money moves.
  demo_paid_at         timestamptz,
  -- The Square SANDBOX payment the demo worker created after the owner approved. Square's own webhook and
  -- the reconcile poll, not this column, decide whether the order is paid.
  sandbox_payment_id   text,
  -- The demo confirmation message with the track link went out.
  confirmation_sent_at timestamptz,
  created_at           timestamptz not null default now(),
  -- The order and the business must match (orders has unique (id, business_id)).
  foreign key (order_id, business_id) references public.orders (id, business_id)
);

-- 2. Every demo message, at most one per (call or order, kind): the deterministic id is the gate, written
-- before the send. A row whose sent_at is null was claimed but not confirmed sent, and is never resent.
create table public.demo_messages (
  id           text primary key check (id ~ '^dmsg_[0-9a-f]{40}$'),
  business_id  text not null references public.businesses (id),
  call_id      text references public.calls (id),
  kind         text not null check (kind in ('menu', 'pay_link', 'confirmation')),
  recipient    text not null check (recipient ~ '^\+[1-9][0-9]{6,14}$'),
  sent_at      timestamptz,
  provider_ref text,
  created_at   timestamptz not null default now()
);

-- 3. The runtime role may read, insert and update the demo tables, and nothing else. No delete, no
-- truncate. anon, authenticated and service_role get nothing: no owner screen reads these rows.
alter table public.demo_orders enable row level security;
alter table public.demo_messages enable row level security;
revoke all on public.demo_orders, public.demo_messages from public, anon, authenticated, service_role, abos_app;
grant select, insert, update on public.demo_orders, public.demo_messages to abos_app;
create policy runtime_read on public.demo_orders for select to abos_app using (true);
create policy runtime_insert on public.demo_orders for insert to abos_app with check (true);
create policy runtime_update on public.demo_orders for update to abos_app using (true) with check (true);
create policy runtime_read on public.demo_messages for select to abos_app using (true);
create policy runtime_insert on public.demo_messages for insert to abos_app with check (true);
create policy runtime_update on public.demo_messages for update to abos_app using (true) with check (true);
