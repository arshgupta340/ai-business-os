-- Ownership and order material guards, checkout references, webhook and delivery receipt routines,
-- and a runtime role self-check. Apply as the non-superuser migration owner. 0001 to 0005 are unchanged.
-- The guards use the 0005 mechanism: an ALWAYS invoker trigger that tests current_user. A checked
-- SECURITY DEFINER routine runs as the owner, so only direct abos_app DML is constrained.

-- 1. Ownership. The decision routine trusts businesses.owner_id and the auth guard trusts users.auth_user_id.
-- The server never creates users or businesses (the seed runs as the owner) and never writes users.
revoke insert on public.users, public.businesses from abos_app;
revoke update on public.users from abos_app;
drop policy runtime_insert on public.users;
drop policy runtime_insert on public.businesses;
drop policy runtime_update on public.users;

create function private.businesses_runtime_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'abos_app' then return new; end if;
  if tg_op = 'INSERT' then raise exception 'protected ownership: the runtime role cannot create a business'; end if;
  if (new.id, new.owner_id, new.created_at) is distinct from (old.id, old.owner_id, old.created_at) then
    raise exception 'protected ownership: business ID and owner cannot change'; end if;
  return new;
end $$;
create trigger businesses_runtime_guard before insert or update on public.businesses
  for each row execute function private.businesses_runtime_guard();
alter table public.businesses enable always trigger businesses_runtime_guard;

-- Second wall behind the revokes: identity columns stay frozen even if a grant is ever restored.
create function private.users_runtime_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'abos_app' then return new; end if;
  if tg_op = 'INSERT' then raise exception 'protected identity: the runtime role cannot create a user'; end if;
  if (pg_catalog.to_jsonb(new) - 'display_name') is distinct from (pg_catalog.to_jsonb(old) - 'display_name') then
    raise exception 'protected identity: user identity columns cannot change'; end if;
  return new;
end $$;
create trigger users_runtime_guard before insert or update on public.users
  for each row execute function private.users_runtime_guard();
alter table public.users enable always trigger users_runtime_guard;

-- 2. Subject material. The checkout is built from orders.cart, and the calendar event from the booking
-- row, so every material column is frozen for the runtime role from insert on. A proposal is born
-- AWAITING_OWNER_APPROVAL with no approval and no provider references, as propose_order and
-- propose_booking insert it. Hashing the cart in SQL was rejected: it would have to reproduce the
-- server's canonical JSON byte for byte.
create function private.orders_material_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'abos_app' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'AWAITING_OWNER_APPROVAL' or new.approval_id is not null or new.square_order_id is not null
      or new.square_payment_link_id is not null or new.checkout_url is not null or new.link_ready_at is not null then
      raise exception 'protected proposal state: an order is inserted AWAITING_OWNER_APPROVAL with no approval or checkout'; end if;
    return new;
  end if;
  if (new.cart, new.cart_hash, new.quote, new.total_minor, new.currency, new.contact, new.fulfillment, new.created_at)
    is distinct from (old.cart, old.cart_hash, old.quote, old.total_minor, old.currency, old.contact, old.fulfillment, old.created_at) then
    raise exception 'protected order material: cart, quote, total, currency, contact and fulfillment cannot change'; end if;
  return new;
end $$;
create trigger orders_material_guard before insert or update on public.orders
  for each row execute function private.orders_material_guard();
alter table public.orders enable always trigger orders_material_guard;

create function private.bookings_material_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'abos_app' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'AWAITING_OWNER_APPROVAL' or new.approval_id is not null then
      raise exception 'protected proposal state: a booking is inserted AWAITING_OWNER_APPROVAL with no approval'; end if;
    return new;
  end if;
  if (new.service_id, new.service_name, new.calendar_id, new.start_utc, new.end_utc, new.timezone, new.customer, new.created_at)
    is distinct from (old.service_id, old.service_name, old.calendar_id, old.start_utc, old.end_utc, old.timezone, old.customer, old.created_at) then
    raise exception 'protected booking material: service, calendar, slot, timezone and customer cannot change'; end if;
  return new;
end $$;
create trigger bookings_material_guard before insert or update on public.bookings
  for each row execute function private.bookings_material_guard();
alter table public.bookings enable always trigger bookings_material_guard;

-- 3a. The server never connects as service_role. The 0005 subject guards test only abos_app, so
-- service_role keeps no direct write on the subjects, and no runtime entry point.
revoke insert, update, delete, truncate on public.orders, public.bookings from service_role;
revoke all on function private.create_approval(text,text,text,text,text,jsonb,text,text,text[],timestamptz) from service_role;
revoke all on function private.claim_next_execution(text,text) from service_role;
revoke all on function private.record_dispatch(text,text,text,integer,text) from service_role;
revoke all on function private.update_dispatch(text,text,text,integer,text,text,text) from service_role;
revoke all on function private.enqueue_sheets_sync(text,text,text) from service_role;

-- 3b. 0005 finish_execution with one change: a checkout step succeeds only with the Square order ID
-- that save_checkout stored. A checkout with no saved references can no longer succeed.
create or replace function private.finish_execution(p_business text,p_id text,p_worker text,p_attempt integer,p_status text,
  p_external_ref text default null,p_error text default null,p_retry_at timestamptz default null)
returns public.action_executions language plpgsql security definer set search_path = '' as $$
declare x public.action_executions;
begin
  perform 1 from public.approval_requests a join public.action_executions e on e.approval_id=a.id
    where e.id=p_id and e.business_id=p_business and a.business_id=p_business for update of a;
  select * into x from public.action_executions where id=p_id and business_id=p_business for update;
  if not found then raise exception 'SCOPE: execution not found'; end if;
  if x.status <> 'RUNNING' or x.locked_by is distinct from p_worker or p_worker is null or x.attempts is distinct from p_attempt then
    raise exception 'LEASE: running execution and current attempt required'; end if;
  if x.lease_deadline is null or x.lease_deadline <= pg_catalog.clock_timestamp() then raise exception 'LEASE: expired deadline'; end if;
  if p_status is null or p_status not in ('SUCCEEDED','FAILED','NEEDS_REVIEW','QUEUED') then raise exception 'TRANSITION: invalid result'; end if;
  if exists(select 1 from public.action_executions where approval_id=x.approval_id and step_index>x.step_index and started_at is not null) then
    raise exception 'PREDECESSOR: successor already started'; end if;
  if p_status='QUEUED' and (x.attempts>=3 or p_retry_at is null) then raise exception 'RETRY: attempt limit or missing retry time'; end if;
  if p_status='SUCCEEDED' and x.action_type not like 'local.%' and nullif(p_external_ref,'') is null then
    raise exception 'RESULT: provider reference required'; end if;
  -- Never-broken rule 5: a message step succeeds only when its dispatch was sent, and the
  -- reference is that dispatch's provider message ID.
  if p_status='SUCCEEDED' and x.action_type like 'message.%' and not exists(
    select 1 from public.message_dispatches m where m.execution_id=x.id and m.status in ('SENT','DELIVERED')
      and m.provider_message_id=p_external_ref) then
    raise exception 'RESULT: message step needs its sent dispatch and provider message ID'; end if;
  -- 0006: a checkout step needs the references saved by save_checkout, and the reference is that
  -- Square order ID. A calendar step succeeds only on its verified booking.
  if p_status='SUCCEEDED' and x.action_type='square.checkout.create'
    and (x.square_order_id is null or x.square_order_id is distinct from p_external_ref) then
    raise exception 'RESULT: checkout step needs its saved Square order ID'; end if;
  if p_status='SUCCEEDED' and x.action_type='calendar.event.create' and not exists(
    select 1 from public.approval_requests a join public.bookings b on b.id=a.subject_id and b.business_id=a.business_id
      where a.id=x.approval_id and b.status='BOOKED_VERIFIED' and b.google_event_id=p_external_ref) then
    raise exception 'RESULT: calendar step needs its verified booking event ID'; end if;
  update public.action_executions set status=p_status,external_ref=p_external_ref,last_error=p_error,
    next_attempt_at=case when p_status='QUEUED' then p_retry_at else next_attempt_at end,
    locked_by=null,locked_at=null,lease_deadline=null,finished_at=case when p_status='QUEUED' then null else pg_catalog.clock_timestamp() end
    where id=x.id returning * into x;
  return x;
end $$;
revoke all on function private.finish_execution(text,text,text,integer,text,text,text,timestamptz) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.finish_execution(text,text,text,integer,text,text,text,timestamptz) to abos_app;

-- 4a. The processed marker on a stored, signature-verified webhook row. Idempotent: a processed row
-- is returned unchanged, so a row is never un-processed and its first error text is kept.
create function private.mark_webhook_processed(p_business text,p_id text,p_error text default null)
returns public.webhook_events language plpgsql security definer set search_path = '' as $$
declare w public.webhook_events;
begin
  select * into w from public.webhook_events where id=p_id for update;
  -- A null business matches only a row stored without one.
  if not found or w.business_id is distinct from p_business then raise exception 'SCOPE: webhook event not found'; end if;
  if w.processed_at is not null then return w; end if;
  update public.webhook_events set processed_at=pg_catalog.clock_timestamp(),
    process_error=pg_catalog.left(nullif(p_error,''),500) where id=w.id returning * into w;
  return w;
end $$;

-- 4b. Provider delivery receipts for a recorded dispatch. No worker lease: a receipt arrives after the
-- step finished. Forward only, SENT to DELIVERED or FAILED; DELIVERED, FAILED and UNKNOWN are terminal
-- here (UNKNOWN is settled by resolve_execution). A repeated, stale or out-of-order receipt returns the
-- row unchanged, since providers deliver receipts out of order. The dispatch routines write no events.
create function private.update_dispatch_status(p_business text,p_id text,p_status text)
returns public.message_dispatches language plpgsql security definer set search_path = '' as $$
declare d public.message_dispatches;
begin
  if p_status is null or p_status not in ('SENT','DELIVERED','FAILED') then raise exception 'TRANSITION: receipt status'; end if;
  -- Same lock order as update_dispatch and resolve_execution: approval first.
  perform 1 from public.approval_requests a join public.message_dispatches m on m.approval_id=a.id
    where m.id=p_id and m.business_id=p_business and a.business_id=p_business for update of a;
  select * into d from public.message_dispatches where id=p_id and business_id=p_business for update;
  if not found then raise exception 'SCOPE: dispatch not found'; end if;
  if d.provider_message_id is null then raise exception 'TRANSITION: receipt needs a sent dispatch with a provider message ID'; end if;
  if d.status<>'SENT' or p_status='SENT' then return d; end if;
  update public.message_dispatches set status=p_status,
    delivered_at=case when p_status='DELIVERED' then pg_catalog.clock_timestamp() else delivered_at end
    where id=d.id returning * into d;
  return d;
end $$;

-- 5. Startup self-check. SECURITY INVOKER on purpose: it reports the caller's own role and rights,
-- which a definer routine would replace with the owner's. It reads catalogs only.
create function private.runtime_role_check()
returns table(role_name text, session_role_name text, superuser boolean, bypass_rls boolean, other_roles integer,
  writes_approvals boolean, writes_executions boolean, writes_dispatches boolean, writes_sync_jobs boolean,
  writes_receipts boolean, restricted boolean)
language sql stable security invoker set search_path = '' as $$
  select c.role_name, c.session_role_name, c.superuser, c.bypass_rls, c.other_roles, c.wa, c.we, c.wd, c.ws, c.wr,
    c.role_name = 'abos_app' and not c.superuser and not c.bypass_rls and c.other_roles = 0
      and not (c.wa or c.we or c.wd or c.ws or c.wr)
  from (select current_user::text role_name, session_user::text session_role_name, r.rolsuper superuser, r.rolbypassrls bypass_rls,
      (select count(*)::integer from pg_catalog.pg_roles o where o.oid<>r.oid and pg_catalog.pg_has_role(r.oid,o.oid,'MEMBER')) other_roles,
      pg_catalog.has_table_privilege('public.approval_requests','INSERT, UPDATE, DELETE, TRUNCATE') wa,
      pg_catalog.has_table_privilege('public.action_executions','INSERT, UPDATE, DELETE, TRUNCATE') we,
      pg_catalog.has_table_privilege('public.message_dispatches','INSERT, UPDATE, DELETE, TRUNCATE') wd,
      pg_catalog.has_table_privilege('public.sync_jobs','INSERT, UPDATE, DELETE, TRUNCATE') ws,
      pg_catalog.has_table_privilege('public.payment_receipts','INSERT, UPDATE, DELETE, TRUNCATE') wr
    from pg_catalog.pg_roles r where r.rolname = current_user) c
$$;

revoke all on function private.businesses_runtime_guard() from public,anon,authenticated,service_role,abos_app;
revoke all on function private.users_runtime_guard() from public,anon,authenticated,service_role,abos_app;
revoke all on function private.orders_material_guard() from public,anon,authenticated,service_role,abos_app;
revoke all on function private.bookings_material_guard() from public,anon,authenticated,service_role,abos_app;
revoke all on function private.mark_webhook_processed(text,text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.mark_webhook_processed(text,text,text) to abos_app;
revoke all on function private.update_dispatch_status(text,text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.update_dispatch_status(text,text,text) to abos_app;
revoke all on function private.runtime_role_check() from public,anon,authenticated,service_role,abos_app;
grant execute on function private.runtime_role_check() to abos_app;
