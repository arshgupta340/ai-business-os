-- Checked provider observations, subject writes and renewable worker leases.
-- Apply as the non-superuser migration owner. Migrations 0001 to 0004 are unchanged.
alter table public.agents add column spec_revision integer not null default 1
  constraint agents_spec_revision_positive check (spec_revision >= 1);
create unique index orders_square_payment_id_key on public.orders(square_payment_id) where square_payment_id is not null;
alter table public.orders add column link_ready_at timestamptz;
-- Preserve causal order for multiple audit rows written in one transaction.
alter table public.activity_events alter column occurred_at set default pg_catalog.clock_timestamp();
alter table public.action_executions add column lease_deadline timestamptz,
  add column square_order_id text, add column square_payment_link_id text, add column checkout_url text;
alter table public.sync_jobs add column lease_deadline timestamptz;
update public.action_executions set lease_deadline=coalesce(locked_at,updated_at)+interval '15 minutes' where status='RUNNING';
update public.sync_jobs set lease_deadline=coalesce(locked_at,updated_at)+interval '15 minutes' where state='RUNNING';

create table public.payment_receipts (
  payment_id text primary key check (payment_id<>''),
  business_id text not null references public.businesses(id),
  order_id text not null,
  square_order_id text not null,
  location_id text not null,
  amount_minor integer not null check (amount_minor>=0),
  currency text not null check (currency='USD'),
  status text not null check (status in ('COMPLETED','FAILED','CANCELED')),
  environment text not null check (environment='sandbox'),
  recorded_at timestamptz not null default pg_catalog.clock_timestamp()
);
-- No cascading order foreign key: deleting an order must never free a payment identity.
alter table public.payment_receipts enable row level security;
revoke all on public.payment_receipts from public,anon,authenticated,service_role,abos_app;
grant select on public.payment_receipts to abos_app;
create policy runtime_read on public.payment_receipts for select to abos_app using (true);
create trigger payment_receipts_append_only before update or delete on public.payment_receipts
  for each row execute function public.activity_events_append_only();
alter table public.payment_receipts enable always trigger payment_receipts_append_only;

create function private.journey(a public.approval_requests) returns text
language sql stable set search_path = '' as $$
  select coalesce(
    (select call_id from public.orders where id=a.subject_id and business_id=a.business_id and a.bundle_type='order_bundle'),
    (select call_id from public.bookings where id=a.subject_id and business_id=a.business_id and a.bundle_type='booking_bundle'),a.id)
$$;
create function private.subject_event(a public.approval_requests,p_from text,p_to text) returns void
language plpgsql set search_path = '' as $$
declare payload jsonb;
begin
  if a.bundle_type='order_bundle' then
    select pg_catalog.jsonb_build_object('subjectId',id,'orderId',id,'callId',call_id,'from',p_from,'to',p_to)
      into payload from public.orders where id=a.subject_id and business_id=a.business_id;
  elsif a.bundle_type='booking_bundle' then
    select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('subjectId',id,'bookingId',id,'callId',call_id,'from',p_from,'to',p_to))
      into payload from public.bookings where id=a.subject_id and business_id=a.business_id;
  else return;
  end if;
  insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
    values(a.business_id,case a.bundle_type when 'order_bundle' then 'order.status_changed' else 'booking.status_changed' end,
      'system',private.journey(a),payload);
end $$;

create function private.orders_transition(p_from text,p_to text) returns boolean
language sql immutable set search_path = '' as $$
  select exists(select 1 from (values ('AWAITING_OWNER_APPROVAL','APPROVED'),
    ('AWAITING_OWNER_APPROVAL','REJECTED'),
    ('AWAITING_OWNER_APPROVAL','APPROVAL_EXPIRED'),
    ('APPROVED','CREATING_CHECKOUT'),
    ('CREATING_CHECKOUT','PAYMENT_LINK_READY'),
    ('CREATING_CHECKOUT','UNAVAILABLE'),
    ('CREATING_CHECKOUT','RECOVERY_REQUIRED'),
    ('RECOVERY_REQUIRED','PAYMENT_LINK_READY'),
    ('PAYMENT_LINK_READY','MESSAGE_SENT'),
    ('MESSAGE_SENT','PAYMENT_PENDING'),
    ('PAYMENT_LINK_READY','PAYMENT_PENDING'),
    ('PAYMENT_PENDING','PAID_VERIFIED'),
    ('PAYMENT_PENDING','PAYMENT_FAILED'),
    ('PAYMENT_FAILED','PAID_VERIFIED'),
    ('PAYMENT_PENDING','RECOVERY_REQUIRED'),
    ('PAYMENT_PENDING','CANCELLED'),
    ('PAYMENT_FAILED','CANCELLED'),
    ('RECOVERY_REQUIRED','CANCELLED'),
    ('PAID_VERIFIED','FULFILLMENT_READY')) as allowed(f,t) where f=p_from and t=p_to)
$$;
create function private.orders_runtime_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Invoker context is the authority boundary. abos_app has no membership or SET ROLE path to the owner.
  -- A caller-set GUC cannot impersonate SECURITY DEFINER's current_user.
  if current_user <> 'abos_app' then return new; end if;
  if tg_op='INSERT' then
    if new.square_payment_id is not null or new.status in ('PAID_VERIFIED','FULFILLMENT_READY') then raise exception 'protected provider state'; end if;
  else
    if (new.id,new.business_id,new.call_id,new.approval_id) is distinct from (old.id,old.business_id,old.call_id,old.approval_id) then
      raise exception 'protected subject identity'; end if;
    if (old.square_order_id is not null and new.square_order_id is distinct from old.square_order_id)
      or (old.square_payment_link_id is not null and new.square_payment_link_id is distinct from old.square_payment_link_id)
      or (old.checkout_url is not null and new.checkout_url is distinct from old.checkout_url)
      or new.link_ready_at is distinct from old.link_ready_at then raise exception 'protected checkout identity'; end if;
    if new.square_payment_id is distinct from old.square_payment_id then raise exception 'protected provider identity'; end if;
    if new.status is distinct from old.status then
      if new.status in ('PAID_VERIFIED','FULFILLMENT_READY') or old.status in ('PAID_VERIFIED','FULFILLMENT_READY') then raise exception 'protected provider state'; end if;
      if not exists(select 1 from (values ('AWAITING_OWNER_APPROVAL','APPROVED'),
    ('AWAITING_OWNER_APPROVAL','REJECTED'),
    ('AWAITING_OWNER_APPROVAL','APPROVAL_EXPIRED'),
    ('APPROVED','CREATING_CHECKOUT'),
    ('CREATING_CHECKOUT','PAYMENT_LINK_READY'),
    ('CREATING_CHECKOUT','UNAVAILABLE'),
    ('CREATING_CHECKOUT','RECOVERY_REQUIRED'),
    ('RECOVERY_REQUIRED','PAYMENT_LINK_READY'),
    ('PAYMENT_LINK_READY','MESSAGE_SENT'),
    ('MESSAGE_SENT','PAYMENT_PENDING'),
    ('PAYMENT_LINK_READY','PAYMENT_PENDING'),
    ('PAYMENT_PENDING','PAID_VERIFIED'),
    ('PAYMENT_PENDING','PAYMENT_FAILED'),
    ('PAYMENT_FAILED','PAID_VERIFIED'),
    ('PAYMENT_PENDING','RECOVERY_REQUIRED'),
    ('PAYMENT_PENDING','CANCELLED'),
    ('PAYMENT_FAILED','CANCELLED'),
    ('RECOVERY_REQUIRED','CANCELLED'),
    ('PAID_VERIFIED','FULFILLMENT_READY')) as allowed(f,t) where f=old.status and t=new.status) then raise exception 'TRANSITION: invalid orders move'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger orders_runtime_guard before insert or update on public.orders
  for each row execute function private.orders_runtime_guard();
alter table public.orders enable always trigger orders_runtime_guard;

create function private.bookings_transition(p_from text,p_to text) returns boolean
language sql immutable set search_path = '' as $$
  select exists(select 1 from (values ('AWAITING_OWNER_APPROVAL','RECHECKING_SLOT'),
    ('AWAITING_OWNER_APPROVAL','SLOT_CONFLICT'),
    ('AWAITING_OWNER_APPROVAL','REJECTED'),
    ('AWAITING_OWNER_APPROVAL','EXPIRED'),
    ('RECHECKING_SLOT','BOOKED_VERIFIED'),
    ('RECHECKING_SLOT','SLOT_CONFLICT'),
    ('RECHECKING_SLOT','RETRY_REQUIRED'),
    ('RETRY_REQUIRED','RECHECKING_SLOT'),
    ('RETRY_REQUIRED','BOOKED_VERIFIED')) as allowed(f,t) where f=p_from and t=p_to)
$$;
create function private.bookings_runtime_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Invoker context is the authority boundary. abos_app has no membership or SET ROLE path to the owner.
  -- A caller-set GUC cannot impersonate SECURITY DEFINER's current_user.
  if current_user <> 'abos_app' then return new; end if;
  if tg_op='INSERT' then
    if new.google_event_id is not null or new.status in ('BOOKED_VERIFIED') then raise exception 'protected provider state'; end if;
  else
    if (new.id,new.business_id,new.call_id,new.approval_id) is distinct from (old.id,old.business_id,old.call_id,old.approval_id) then
      raise exception 'protected subject identity'; end if;
    if new.google_event_id is distinct from old.google_event_id then raise exception 'protected provider identity'; end if;
    if new.status is distinct from old.status then
      if new.status in ('BOOKED_VERIFIED') or old.status in ('BOOKED_VERIFIED') then raise exception 'protected provider state'; end if;
      if not exists(select 1 from (values ('AWAITING_OWNER_APPROVAL','RECHECKING_SLOT'),
    ('AWAITING_OWNER_APPROVAL','SLOT_CONFLICT'),
    ('AWAITING_OWNER_APPROVAL','REJECTED'),
    ('AWAITING_OWNER_APPROVAL','EXPIRED'),
    ('RECHECKING_SLOT','BOOKED_VERIFIED'),
    ('RECHECKING_SLOT','SLOT_CONFLICT'),
    ('RECHECKING_SLOT','RETRY_REQUIRED'),
    ('RETRY_REQUIRED','RECHECKING_SLOT'),
    ('RETRY_REQUIRED','BOOKED_VERIFIED')) as allowed(f,t) where f=old.status and t=new.status) then raise exception 'TRANSITION: invalid bookings move'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger bookings_runtime_guard before insert or update on public.bookings
  for each row execute function private.bookings_runtime_guard();
alter table public.bookings enable always trigger bookings_runtime_guard;

create or replace function private.check_subject(a public.approval_requests) returns void language plpgsql set search_path = '' as $$
declare p jsonb := a.payload_canonical::jsonb; o public.orders; b public.bookings; f public.business_facts; c public.catalog_items;
begin
  if p is distinct from private.material(a.bundle_type,a.payload)
    or p->>'businessId' is distinct from a.business_id or p->>'subjectId' is distinct from a.subject_id
    or p->'actionBundle' is distinct from pg_catalog.to_jsonb(a.action_bundle)
    or (p->>'expiresAt')::timestamptz is distinct from a.expires_at
    or a.payload_hash is distinct from 'sha256:' || pg_catalog.encode(extensions.digest(a.payload_canonical,'sha256'),'hex')
  then raise exception 'MATERIAL: stored approval binding mismatch'; end if;
  if a.bundle_type = 'order_bundle' then
    select * into o from public.orders where id = a.subject_id and business_id = a.business_id;
    if not found or o.cart_hash is distinct from p->>'cartHash' or o.total_minor is distinct from (p->>'totalMinor')::integer
      or o.currency is distinct from p->>'currency' or (o.fulfillment->>'pickupAt') is distinct from p->>'pickupAt'
      or not exists(select 1 from public.calls where id=o.call_id and business_id=a.business_id and agent_version_id=p->>'agentVersionId')
    then raise exception 'SUBJECT: order material mismatch'; end if;
  elsif a.bundle_type = 'booking_bundle' then
    select * into b from public.bookings where id=a.subject_id and business_id=a.business_id;
    if not found or b.service_id is distinct from p->>'serviceId' or b.calendar_id is distinct from p->>'calendarId'
      or b.start_utc is distinct from (p->>'startUtc')::timestamptz or b.end_utc is distinct from (p->>'endUtc')::timestamptz
      or b.timezone is distinct from p->>'timezone'
      or not exists(select 1 from public.calls where id=b.call_id and business_id=a.business_id and agent_version_id=p->>'agentVersionId')
    then raise exception 'SUBJECT: booking material mismatch'; end if;
  elsif a.bundle_type = 'fact_edit' then
    select * into f from public.business_facts where id=a.subject_id and business_id=a.business_id;
    if not found or f.kind is distinct from p->>'kind' or f.key is distinct from p->>'key'
      or not (
        (f.status='verified' and f.version=(p->>'fromVersion')::integer and f.value=p->'before')
        or ((p->>'fromVersion')::integer=0 and p->'before'='null'::jsonb
          and f.status='draft' and f.value=p->'after'
          and not exists(select 1 from public.business_facts v where v.business_id=a.business_id
            and v.kind=f.kind and v.key=f.key and v.status='verified'))
      )
    then raise exception 'SUBJECT: fact material mismatch'; end if;
  elsif a.bundle_type = 'price_edit' then
    select * into c from public.catalog_items where id=a.subject_id and business_id=a.business_id;
    if not found or c.square_item_id is distinct from p->>'squareItemId' or c.square_variation_id is distinct from p->>'variationId'
      or c.price_minor is distinct from (p->>'fromPriceMinor')::integer or c.currency is distinct from p->>'currency'
      or c.square_variation_version is distinct from (p->>'squareVersion')::bigint
    then raise exception 'SUBJECT: price material mismatch'; end if;
  else raise exception 'MATERIAL: invalid bundle'; end if;
end $$;

create or replace function private.decide_and_enqueue(p_business text,p_id text,p_owner text,p_hash text,p_decision text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; cutoff timestamptz; step text; pos integer := 0; key text; e public.action_executions; moved boolean := false;
begin
  select * into a from public.approval_requests where id=p_id and business_id=p_business for update;
  cutoff := pg_catalog.clock_timestamp();
  if not found then raise exception 'SCOPE: approval not found'; end if;
  if p_owner is distinct from (select owner_id from public.businesses where id=p_business) then raise exception 'OWNER: business owner required'; end if;
  if p_hash is distinct from a.payload_hash then raise exception 'HASH: payload mismatch'; end if;
  if p_decision is null or p_decision not in ('APPROVED','REJECTED') then raise exception 'DECISION: invalid'; end if;
  if a.state = 'PENDING' then
    if cutoff >= a.expires_at then raise exception 'EXPIRED: decision deadline'; end if;
    perform private.check_subject(a);
    update public.approval_requests set state=p_decision,decided_by=p_owner,decided_at=cutoff,decision_reason=p_reason where id=a.id returning * into a;
    if a.bundle_type='order_bundle' then
      update public.orders set status=p_decision,approval_id=a.id where id=a.subject_id and business_id=p_business and status='AWAITING_OWNER_APPROVAL';
      if not found then raise exception 'SUBJECT: order is no longer awaiting approval'; end if;
    elsif a.bundle_type='booking_bundle' then
      update public.bookings set status=case p_decision when 'APPROVED' then 'RECHECKING_SLOT' else 'REJECTED' end,approval_id=a.id
        where id=a.subject_id and business_id=p_business and status='AWAITING_OWNER_APPROVAL';
      if not found then raise exception 'SUBJECT: booking is no longer awaiting approval'; end if;
    end if;
    if a.bundle_type in ('order_bundle','booking_bundle') then
      insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
        values(p_business,case a.bundle_type when 'order_bundle' then 'order.status_changed' else 'booking.status_changed' end,'system',private.journey(a),
          pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            case a.bundle_type when 'order_bundle' then 'orderId' else 'bookingId' end,a.subject_id,
            'callId',nullif(private.journey(a),a.id),'subjectId',a.subject_id,'from','AWAITING_OWNER_APPROVAL','to',
            case when a.bundle_type='booking_bundle' and p_decision='APPROVED' then 'RECHECKING_SLOT' else p_decision end)));
    end if;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'approval.decided','owner',private.journey(a),pg_catalog.jsonb_build_object('approvalId',a.id,'subjectId',a.subject_id,'decision',p_decision,'decidedBy',p_owner));
  elsif a.state is distinct from p_decision or a.decided_by is distinct from p_owner or a.decision_reason is distinct from p_reason then
    raise exception 'DECIDED: conflicting repeat';
  end if;
  -- Complete historical partial decisions under the same approval lock. Unchanged repeats
  -- perform no UPDATE and add no duplicate audit events.
  if a.state='APPROVED' and exists (
    select 1 from pg_catalog.unnest(a.action_bundle) s where s not like 'sheets.%'
    and not exists(select 1 from public.action_executions missing_step where missing_step.approval_id=a.id and missing_step.action_type=s)
  ) then
    perform private.check_subject(a);
    if a.bundle_type='order_bundle' then
      update public.orders set status='APPROVED',approval_id=a.id where id=a.subject_id and business_id=p_business and status='AWAITING_OWNER_APPROVAL';
      moved:=found;
    elsif a.bundle_type='booking_bundle' then
      update public.bookings set status='RECHECKING_SLOT',approval_id=a.id where id=a.subject_id and business_id=p_business and status='AWAITING_OWNER_APPROVAL';
      moved:=found;
    end if;
    if moved then
      insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
        values(p_business,case a.bundle_type when 'order_bundle' then 'order.status_changed' else 'booking.status_changed' end,'system',private.journey(a),
          pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            case a.bundle_type when 'order_bundle' then 'orderId' else 'bookingId' end,a.subject_id,
            'callId',nullif(private.journey(a),a.id),'subjectId',a.subject_id,'from','AWAITING_OWNER_APPROVAL','to',
            case a.bundle_type when 'order_bundle' then 'APPROVED' else 'RECHECKING_SLOT' end)));
    end if;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      select p_business,'approval.decided','owner',private.journey(a),pg_catalog.jsonb_build_object('approvalId',a.id,'subjectId',a.subject_id,'decision',p_decision,'decidedBy',p_owner)
      where not exists(select 1 from public.activity_events where business_id=p_business and type='approval.decided' and payload->>'approvalId'=a.id);
  end if;
  if a.state='APPROVED' then
    foreach step in array a.action_bundle loop
      if step like 'sheets.%' then continue; end if;
      key:=pg_catalog.encode(extensions.digest(p_business||':'||a.subject_id||':'||step||':'||a.id,'sha256'),'hex');
      select * into e from public.action_executions where approval_id=a.id and step_index=pos;
      if found then
        if e.idempotency_key <> key or e.action_type <> step or e.business_id <> p_business then raise exception 'IDENTITY: historical step mismatch'; end if;
      else
        insert into public.action_executions(business_id,approval_id,action_type,step_index,idempotency_key,status)
          values(p_business,a.id,step,pos,key,case when step like 'message.%' and a.payload->>'messageChannel'='qr_only' then 'SKIPPED' else 'QUEUED' end);
      end if;
      pos:=pos+1;
    end loop;
  end if;
  return pg_catalog.jsonb_build_object('approval',pg_catalog.to_jsonb(a),'executions',
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by step_index),'[]'::jsonb) from public.action_executions x where approval_id=a.id));
end $$;

create or replace function private.expire_approvals(p_business text)
returns table(id text,business_id text,bundle_type text,subject_id text,subject_moved boolean)
language plpgsql security definer set search_path = '' as $$
declare cutoff timestamptz := pg_catalog.clock_timestamp(); a public.approval_requests; moved boolean;
begin
  for a in select r.* from public.approval_requests r where r.business_id=p_business and r.state='PENDING' and r.expires_at<=cutoff for update loop
    update public.approval_requests r set state='EXPIRED',decided_at=cutoff where r.id=a.id;
    moved:=false;
    if a.bundle_type='order_bundle' then
      update public.orders o set status='APPROVAL_EXPIRED' where o.id=a.subject_id and o.business_id=p_business and o.status='AWAITING_OWNER_APPROVAL';
      moved:=found;
    elsif a.bundle_type='booking_bundle' then
      update public.bookings b set status='EXPIRED' where b.id=a.subject_id and b.business_id=p_business and b.status='AWAITING_OWNER_APPROVAL';
      moved:=found;
    end if;
    if moved then
      insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
        values(p_business,case a.bundle_type when 'order_bundle' then 'order.status_changed' else 'booking.status_changed' end,'system',private.journey(a),
          pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            case a.bundle_type when 'order_bundle' then 'orderId' else 'bookingId' end,a.subject_id,
            'callId',nullif(private.journey(a),a.id),'subjectId',a.subject_id,'from','AWAITING_OWNER_APPROVAL','to',
            case a.bundle_type when 'order_bundle' then 'APPROVAL_EXPIRED' else 'EXPIRED' end)));
    end if;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'approval.expired','system',private.journey(a),pg_catalog.jsonb_build_object('approvalId',a.id,'subjectId',a.subject_id));
    id:=a.id; business_id:=a.business_id; bundle_type:=a.bundle_type; subject_id:=a.subject_id; subject_moved:=moved; return next;
  end loop;
end $$;

create or replace function private.claim_execution(p_business text,p_id text,p_worker text)
returns setof public.action_executions language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; x public.action_executions;
begin
  if p_worker is null or p_worker='' then raise exception 'LEASE: worker required'; end if;
  select r.* into a from public.approval_requests r join public.action_executions e on e.approval_id=r.id
    where e.id=p_id and e.business_id=p_business and r.business_id=p_business for update of r skip locked;
  if not found then return; end if;
  select * into x from public.action_executions where id=p_id and business_id=p_business for update;
  if x.status <> 'QUEUED' or x.attempts >= 3 or x.next_attempt_at > pg_catalog.clock_timestamp()
    or not public.execution_claim_allowed(x.approval_id,p_business,x.step_index,x.action_type) then return; end if;
  -- Revalidate stored subject material before the first step consumes it. Later steps follow a
  -- completed provider write that may legitimately change the subject (price_edit's catalog row).
  if x.step_index = 0 then perform private.check_subject(a); end if;
  if x.action_type='square.checkout.create' then
    update public.orders set status='CREATING_CHECKOUT' where id=a.subject_id and business_id=p_business and status='APPROVED';
    if found then perform private.subject_event(a,'APPROVED','CREATING_CHECKOUT'); end if;
  end if;
  return query update public.action_executions set status='RUNNING',attempts=attempts+1,locked_by=p_worker,
    locked_at=pg_catalog.clock_timestamp(),lease_deadline=pg_catalog.clock_timestamp()+interval '15 minutes',started_at=coalesce(started_at,pg_catalog.clock_timestamp()) where id=p_id returning *;
end $$;

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
  update public.action_executions set status=p_status,external_ref=p_external_ref,last_error=p_error,
    next_attempt_at=case when p_status='QUEUED' then p_retry_at else next_attempt_at end,
    locked_by=null,locked_at=null,lease_deadline=null,finished_at=case when p_status='QUEUED' then null else pg_catalog.clock_timestamp() end
    where id=x.id returning * into x;
  return x;
end $$;

create or replace function private.claim_sync_job(p_business text,p_id text,p_worker text)
returns setof public.sync_jobs language plpgsql security definer set search_path = '' as $$
declare j public.sync_jobs; a public.approval_requests; expected_key text;
begin
  if p_worker is null or p_worker='' then raise exception 'LEASE: worker required'; end if;
  select * into j from public.sync_jobs where id=p_id and business_id=p_business for update skip locked;
  if not found then return; end if;
  if j.state not in ('PENDING','RETRYING') or j.attempts>=5 or j.next_retry_at>pg_catalog.clock_timestamp() then return; end if;
  a:=private.sync_approval(p_business,j.record_type,j.record_id);
  expected_key:=pg_catalog.encode(extensions.digest(p_business||':'||j.record_id||':'||
    case j.record_type when 'order' then 'sheets.order.append' else 'sheets.booking.append' end||':'||a.id,'sha256'),'hex');
  if j.approval_id is distinct from a.id or j.idempotency_key is distinct from expected_key then
    raise exception 'IDENTITY: sync approval or dedupe key mismatch'; end if;
  return query update public.sync_jobs set state='RUNNING',attempts=attempts+1,locked_by=p_worker,locked_at=pg_catalog.clock_timestamp(),lease_deadline=pg_catalog.clock_timestamp()+interval '15 minutes'
    where id=p_id returning *;
end $$;

create or replace function private.finish_sync_job(p_business text,p_id text,p_worker text,p_attempt integer,p_state text,
  p_external_ref text default null,p_error text default null,p_retry_at timestamptz default null)
returns public.sync_jobs language plpgsql security definer set search_path = '' as $$
declare j public.sync_jobs;
begin
  select * into j from public.sync_jobs where id=p_id and business_id=p_business for update;
  if not found then raise exception 'SCOPE: sync not found'; end if;
  if j.state<>'RUNNING' or j.locked_by is distinct from p_worker or p_worker is null or j.attempts is distinct from p_attempt then raise exception 'LEASE: running sync required'; end if;
  if j.lease_deadline is null or j.lease_deadline <= pg_catalog.clock_timestamp() then raise exception 'LEASE: expired deadline'; end if;
  if p_state is null or p_state not in ('DONE','RETRYING','FAILED') then raise exception 'TRANSITION: sync result'; end if;
  if p_state='RETRYING' and (j.attempts>=5 or p_retry_at is null) then raise exception 'RETRY: sync attempt limit'; end if;
  if p_state='DONE' and nullif(p_external_ref,'') is null then raise exception 'RESULT: Sheets reference required'; end if;
  update public.sync_jobs set state=p_state,external_ref=p_external_ref,last_error=p_error,locked_by=null,locked_at=null,lease_deadline=null,
    next_retry_at=case when p_state='RETRYING' then p_retry_at else next_retry_at end where id=p_id returning * into j;
  return j;
end $$;

-- Consistency checks are not a provider read. The server supplies its redacted Square observation.
create function private.check_payment(o public.orders,a public.approval_requests,p_payment text,p_square text,p_location text,
  p_amount integer,p_currency text,p_status text,p_environment text) returns void
language plpgsql set search_path = '' as $$
begin
  if nullif(p_payment,'') is null then raise exception 'PAYMENT: payment ID required'; end if;
  if a.id is null or a.state<>'APPROVED' or a.bundle_type<>'order_bundle' or a.subject_id<>o.id or a.business_id<>o.business_id then
    raise exception 'SUBJECT: order has no approved bundle'; end if;
  perform private.check_subject(a);
  if p_amount is null or p_amount is distinct from o.total_minor or p_amount is distinct from (a.payload_canonical::jsonb->>'totalMinor')::integer then
    raise exception 'PAYMENT: amount differs from approved total'; end if;
  if p_currency is null or p_currency is distinct from o.currency or p_currency is distinct from a.payload_canonical::jsonb->>'currency' then
    raise exception 'PAYMENT: currency differs from approved currency'; end if;
  if p_square is null or p_square is distinct from o.square_order_id then raise exception 'PAYMENT: Square order mismatch'; end if;
  if nullif(p_location,'') is null or not exists(select 1 from public.integrations where business_id=o.business_id
    and provider='square' and config->>'locationId'=p_location) then raise exception 'PAYMENT: location mismatch'; end if;
  if p_environment is distinct from 'sandbox' then raise exception 'PAYMENT: sandbox required'; end if;
  if p_status is null or p_status not in ('COMPLETED','FAILED','CANCELED') then raise exception 'PAYMENT: final status required'; end if;
  if exists(select 1 from public.payment_receipts r where r.payment_id=p_payment and
    (r.business_id,r.order_id,r.square_order_id,r.location_id,r.amount_minor,r.currency,r.status,r.environment)
    is distinct from (o.business_id,o.id,p_square,p_location,p_amount,p_currency,p_status,p_environment)) then
    raise exception 'IDENTITY: payment already recorded with different evidence'; end if;
end $$;
create function private.insert_receipt(o public.orders,p_payment text,p_square text,p_location text,
  p_amount integer,p_currency text,p_status text,p_environment text) returns void
language plpgsql set search_path = '' as $$
declare r public.payment_receipts;
begin
  insert into public.payment_receipts(payment_id,business_id,order_id,square_order_id,location_id,amount_minor,currency,status,environment)
    values(p_payment,o.business_id,o.id,p_square,p_location,p_amount,p_currency,p_status,p_environment)
    on conflict(payment_id) do nothing;
  select * into r from public.payment_receipts where payment_id=p_payment;
  if (r.business_id,r.order_id,r.square_order_id,r.location_id,r.amount_minor,r.currency,r.status,r.environment)
    is distinct from (o.business_id,o.id,p_square,p_location,p_amount,p_currency,p_status,p_environment) then
    raise exception 'IDENTITY: payment already recorded with different evidence'; end if;
end $$;

create function private.mark_order_paid(p_business text, p_order text, p_payment_id text,
  p_amount_minor integer, p_currency text, p_square_order_id text, p_location_id text, p_status text, p_environment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; a public.approval_requests; m jsonb; j public.sync_jobs; existed boolean; prior text;
begin
  if p_payment_id is null or p_payment_id = '' then raise exception 'PAYMENT: payment ID required'; end if;
  perform 1 from public.approval_requests where id=(select approval_id from public.orders where id=p_order and business_id=p_business) and business_id=p_business for update;
  select * into o from public.orders where id=p_order and business_id=p_business for update;
  if not found then raise exception 'SCOPE: order not found'; end if;
  select * into a from public.approval_requests where id=o.approval_id and business_id=p_business
    and subject_id=o.id and bundle_type='order_bundle' and state='APPROVED';
  if not found then raise exception 'SUBJECT: order has no approved bundle'; end if;
  perform private.check_payment(o,a,p_payment_id,p_square_order_id,p_location_id,p_amount_minor,p_currency,p_status,p_environment);
  if p_status is distinct from 'COMPLETED' then raise exception 'PAYMENT: COMPLETED required'; end if;
  m := a.payload_canonical::jsonb;
  if p_amount_minor is null or p_amount_minor is distinct from (m->>'totalMinor')::integer
    or p_amount_minor is distinct from o.total_minor then raise exception 'PAYMENT: amount differs from approved total'; end if;
  if p_currency is null or p_currency is distinct from m->>'currency' or p_currency is distinct from o.currency then
    raise exception 'PAYMENT: currency differs from approved currency'; end if;
  perform private.insert_receipt(o,p_payment_id,p_square_order_id,p_location_id,p_amount_minor,p_currency,p_status,p_environment);
  if o.status in ('PAID_VERIFIED','FULFILLMENT_READY') then
    -- Repeat of the same verified payment: no state change and no duplicate audit.
    if o.square_payment_id is distinct from p_payment_id then raise exception 'IDENTITY: order already paid with a different payment'; end if;
  else
    if o.status not in ('PAYMENT_PENDING','PAYMENT_FAILED') then
      raise exception 'SUBJECT: order requires PAYMENT_PENDING or PAYMENT_FAILED'; end if;
    if exists(select 1 from public.orders where square_payment_id=p_payment_id and id<>o.id) then
      raise exception 'IDENTITY: payment already recorded on another order'; end if;
    prior := o.status;
    update public.orders set status='PAID_VERIFIED',square_payment_id=p_payment_id where id=o.id returning * into o;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'order.status_changed','system',o.call_id,pg_catalog.jsonb_build_object('subjectId',o.id,'orderId',o.id,
        'callId',o.call_id,'from',prior,'to','PAID_VERIFIED'));
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'payment.verified','provider',o.call_id,pg_catalog.jsonb_build_object('orderId',o.id,'squarePaymentId',p_payment_id,
        'amountMinor',p_amount_minor,'currency',p_currency,'sandbox',true));
  end if;
  -- The same checked path as enqueue_sheets_sync. A repeat finds the existing job; a missing job is created.
  existed := exists(select 1 from public.sync_jobs where target='google_sheets' and record_type='order' and record_id=o.id);
  j := private.enqueue_sheets_sync(p_business,'order',o.id);
  if not existed then
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'sync.queued','system',o.call_id,pg_catalog.jsonb_build_object('target','google_sheets','syncJobId',j.id,
        'recordType','order','recordId',o.id));
  end if;
  return pg_catalog.jsonb_build_object('order',pg_catalog.to_jsonb(o),'syncJob',pg_catalog.to_jsonb(j));
end $$;


create function private.mark_order_payment_failed(p_business text,p_order text,p_payment_id text,p_reason text,
  p_amount_minor integer,p_currency text,p_square_order_id text,p_location_id text,p_status text,p_environment text)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare o public.orders; a public.approval_requests;
begin
  if nullif(p_reason,'') is null or pg_catalog.length(p_reason)>200 then raise exception 'PAYMENT: reason required, at most 200 characters'; end if;
  select * into a from public.approval_requests where id=(select approval_id from public.orders where id=p_order and business_id=p_business)
    and business_id=p_business for update;
  select * into o from public.orders where id=p_order and business_id=p_business for update;
  if not found then raise exception 'SCOPE: order not found'; end if;
  perform private.check_payment(o,a,p_payment_id,p_square_order_id,p_location_id,p_amount_minor,p_currency,p_status,p_environment);
  if p_status is null or p_status not in ('FAILED','CANCELED') then raise exception 'PAYMENT: final failed or canceled status required'; end if;
  if o.status in ('PAID_VERIFIED','FULFILLMENT_READY') then return o; end if;
  if o.status not in ('PAYMENT_PENDING','PAYMENT_FAILED') then raise exception 'SUBJECT: order requires PAYMENT_PENDING'; end if;
  perform private.insert_receipt(o,p_payment_id,p_square_order_id,p_location_id,p_amount_minor,p_currency,p_status,p_environment);
  if o.status='PAYMENT_FAILED' then return o; end if;
  update public.orders set status='PAYMENT_FAILED' where id=o.id returning * into o;
  perform private.subject_event(a,'PAYMENT_PENDING','PAYMENT_FAILED');
  insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
    values(p_business,'payment.failed','provider',o.call_id,pg_catalog.jsonb_build_object('orderId',o.id,
      'squarePaymentId',p_payment_id,'reason',p_reason,'sandbox',true));
  return o;
end $$;

create function private.save_checkout(p_business text,p_execution text,p_worker text,p_attempt integer,
  p_square_order text,p_link text,p_url text)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare x public.action_executions; a public.approval_requests; o public.orders; prior text;
begin
  select r.* into a from public.approval_requests r join public.action_executions e on e.approval_id=r.id
    where e.id=p_execution and e.business_id=p_business and r.business_id=p_business for update of r;
  if not found then raise exception 'SCOPE: checkout execution not found'; end if;
  select * into x from public.action_executions where id=p_execution and business_id=p_business for update;
  if x.action_type='square.checkout.create' and x.status='SUCCEEDED'
    and (x.square_order_id,x.square_payment_link_id,x.checkout_url) is not distinct from (p_square_order,p_link,p_url) then
    select * into o from public.orders where id=a.subject_id and business_id=p_business;
    if (o.square_order_id,o.square_payment_link_id,o.checkout_url) is distinct from (p_square_order,p_link,p_url) then
      raise exception 'IDENTITY: checkout references changed'; end if;
    return o;
  end if;
  if x.status='SUCCEEDED' then raise exception 'IDENTITY: checkout references changed'; end if;
  if x.action_type<>'square.checkout.create' or x.status<>'RUNNING' or x.locked_by is distinct from p_worker
    or p_worker is null or x.attempts is distinct from p_attempt or x.lease_deadline is null or x.lease_deadline<=pg_catalog.clock_timestamp() then
    raise exception 'LEASE: current checkout worker required'; end if;
  perform private.check_subject(a);
  select * into o from public.orders where id=a.subject_id and business_id=p_business for update;
  if not found then raise exception 'SCOPE: order not found'; end if;
  if nullif(p_square_order,'') is null or nullif(p_link,'') is null or p_url is null or p_url !~ '^https://' then
    raise exception 'RESULT: checkout references required'; end if;
  if (o.square_order_id is not null and o.square_order_id is distinct from p_square_order)
    or (o.square_payment_link_id is not null and o.square_payment_link_id is distinct from p_link)
    or (o.checkout_url is not null and o.checkout_url is distinct from p_url)
    or (x.square_order_id is not null and (x.square_order_id,x.square_payment_link_id,x.checkout_url) is distinct from (p_square_order,p_link,p_url)) then
    raise exception 'IDENTITY: checkout references changed'; end if;
  if o.status not in ('CREATING_CHECKOUT','RECOVERY_REQUIRED','PAYMENT_LINK_READY') then raise exception 'SUBJECT: checkout state'; end if;
  update public.action_executions set square_order_id=p_square_order,square_payment_link_id=p_link,checkout_url=p_url,external_ref=p_square_order where id=x.id;
  if o.status='PAYMENT_LINK_READY' then return o; end if;
  prior:=o.status;
  update public.orders set square_order_id=p_square_order,square_payment_link_id=p_link,checkout_url=p_url,
    status='PAYMENT_LINK_READY',link_ready_at=pg_catalog.clock_timestamp() where id=o.id returning * into o;
  perform private.subject_event(a,prior,o.status);
  insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
    values(p_business,'checkout.created','provider',private.journey(a),pg_catalog.jsonb_build_object('orderId',o.id,
      'squareOrderId',p_square_order,'squarePaymentLinkId',p_link,'totalMinor',o.total_minor,'currency',o.currency,'sandbox',true));
  return o;
end $$;

create function private.fulfill_order(p_business text,p_order text) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare o public.orders; a public.approval_requests;
begin
  select * into a from public.approval_requests where id=(select approval_id from public.orders where id=p_order and business_id=p_business)
    and business_id=p_business for update;
  select * into o from public.orders where id=p_order and business_id=p_business for update;
  if not found then raise exception 'SCOPE: order not found'; end if;
  if o.status not in ('PAID_VERIFIED','FULFILLMENT_READY') then raise exception 'SUBJECT: paid order required'; end if;
  if a.state is distinct from 'APPROVED' or a.bundle_type is distinct from 'order_bundle' or a.subject_id is distinct from o.id then
    raise exception 'SUBJECT: approved order bundle required'; end if;
  perform private.check_subject(a);
  if not exists(select 1 from public.payment_receipts where payment_id=o.square_payment_id and order_id=o.id and business_id=p_business and status='COMPLETED') then
    raise exception 'PAYMENT: completed receipt required'; end if;
  if o.status='FULFILLMENT_READY' then return o; end if;
  update public.orders set status='FULFILLMENT_READY' where id=o.id returning * into o;
  perform private.subject_event(a,'PAID_VERIFIED','FULFILLMENT_READY');
  return o;
end $$;

-- Internal booking result application is shared by the current worker and evidence reconciliation.
create function private.apply_booking(a public.approval_requests,p_event text) returns public.bookings
language plpgsql set search_path = '' as $$
declare b public.bookings; prior text; j public.sync_jobs; existed boolean;
begin
  if a.state is distinct from 'APPROVED' or a.bundle_type is distinct from 'booking_bundle' then raise exception 'SUBJECT: approved booking required'; end if;
  perform private.check_subject(a);
  if nullif(p_event,'') is null then raise exception 'RESULT: calendar event ID required'; end if;
  select * into b from public.bookings where id=a.subject_id and business_id=a.business_id for update;
  if not found then raise exception 'SCOPE: booking not found'; end if;
  if b.google_event_id is not null and b.google_event_id is distinct from p_event then raise exception 'IDENTITY: calendar event changed'; end if;
  if b.status not in ('RECHECKING_SLOT','RETRY_REQUIRED','BOOKED_VERIFIED') then raise exception 'SUBJECT: booking state'; end if;
  if b.status<>'BOOKED_VERIFIED' then
    prior:=b.status;
    update public.bookings set status='BOOKED_VERIFIED',google_event_id=p_event where id=b.id returning * into b;
    perform private.subject_event(a,prior,b.status);
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(a.business_id,'booking.verified','provider',private.journey(a),pg_catalog.jsonb_build_object('bookingId',b.id,
        'googleEventId',p_event,'serviceName',b.service_name,'startUtc',pg_catalog.to_char(b.start_utc at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'timezone',b.timezone));
  end if;
  existed:=exists(select 1 from public.sync_jobs where target='google_sheets' and record_type='booking' and record_id=b.id);
  j:=private.enqueue_sheets_sync(a.business_id,'booking',b.id);
  if not existed then
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(a.business_id,'sync.queued','system',private.journey(a),pg_catalog.jsonb_build_object('target','google_sheets',
        'syncJobId',j.id,'recordType','booking','recordId',b.id));
  end if;
  return b;
end $$;
create function private.verify_booking(p_business text,p_execution text,p_worker text,p_attempt integer,p_event text)
returns public.bookings language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; x public.action_executions; b public.bookings;
begin
  select r.* into a from public.approval_requests r join public.action_executions e on e.approval_id=r.id
    where e.id=p_execution and e.business_id=p_business and r.business_id=p_business for update of r;
  if not found then raise exception 'SCOPE: booking execution not found'; end if;
  select * into x from public.action_executions where id=p_execution and business_id=p_business for update;
  if x.action_type<>'calendar.event.create' then raise exception 'SUBJECT: calendar step required'; end if;
  if x.status='SUCCEEDED' and x.external_ref=p_event then
    return private.apply_booking(a,p_event);
  end if;
  if x.status<>'RUNNING' or x.locked_by is distinct from p_worker or p_worker is null or x.attempts is distinct from p_attempt
    or x.lease_deadline is null or x.lease_deadline<=pg_catalog.clock_timestamp() then raise exception 'LEASE: current calendar worker required'; end if;
  b:=private.apply_booking(a,p_event);
  perform private.finish_execution(p_business,x.id,p_worker,p_attempt,'SUCCEEDED',p_event,null,null);
  return b;
end $$;

create function private.renew_execution_lease(p_business text,p_id text,p_worker text,p_attempt integer,p_duration interval)
returns public.action_executions language plpgsql security definer set search_path = '' as $$
declare x public.action_executions;
begin
  if p_duration is null or p_duration<interval '1 minute' or p_duration>interval '15 minutes' then raise exception 'LEASE: duration must be 1 to 15 minutes'; end if;
  perform 1 from public.approval_requests a join public.action_executions e on e.approval_id=a.id
    where e.id=p_id and e.business_id=p_business and a.business_id=p_business for update of a;
  select * into x from public.action_executions where id=p_id and business_id=p_business for update;
  if not found then raise exception 'SCOPE: execution not found'; end if;
  if x.status<>'RUNNING' or p_worker is null or x.locked_by is distinct from p_worker or x.attempts is distinct from p_attempt
    or x.lease_deadline is null or x.lease_deadline<=pg_catalog.clock_timestamp() then raise exception 'LEASE: current live worker required'; end if;
  update public.action_executions set lease_deadline=greatest(lease_deadline,pg_catalog.clock_timestamp()+p_duration) where id=x.id returning * into x;
  return x;
end $$;

create function private.recover_stale_executions(p_business text,p_stale_after interval)
returns setof public.action_executions language plpgsql security definer set search_path = '' as $$
declare c record; a public.approval_requests; x public.action_executions; o public.orders; b public.bookings;
begin
  if nullif(p_business,'') is null then raise exception 'SCOPE: business required'; end if;
  if p_stale_after is null or p_stale_after<interval '1 minute' then raise exception 'LEASE: stale interval must be at least one minute'; end if;
  -- The compatibility interval is used only for legacy rows with no deadline. New claims always have one.
  for c in select e.id,e.approval_id from public.action_executions e where e.business_id=p_business and e.status='RUNNING'
    and coalesce(e.lease_deadline,coalesce(e.locked_at,e.updated_at)+p_stale_after)<=pg_catalog.clock_timestamp() order by e.id
  loop
    select * into a from public.approval_requests where id=c.approval_id and business_id=p_business for update skip locked;
    if not found then continue; end if;
    select * into x from public.action_executions where id=c.id and business_id=p_business for update;
    if x.status<>'RUNNING' or coalesce(x.lease_deadline,coalesce(x.locked_at,x.updated_at)+p_stale_after)>pg_catalog.clock_timestamp() then continue; end if;
    update public.action_executions set status='NEEDS_REVIEW',locked_by=null,locked_at=null,lease_deadline=null,
      error_code='INTERNAL',last_error='Stale lease: provider outcome unknown',finished_at=pg_catalog.clock_timestamp() where id=x.id returning * into x;
    if x.action_type='square.checkout.create' then
      select * into o from public.orders where id=a.subject_id and business_id=p_business for update;
      if o.status='APPROVED' then
        update public.orders set status='CREATING_CHECKOUT' where id=o.id;
        perform private.subject_event(a,'APPROVED','CREATING_CHECKOUT');
        o.status:='CREATING_CHECKOUT';
      end if;
      if o.status='CREATING_CHECKOUT' then
        update public.orders set status='RECOVERY_REQUIRED' where id=o.id;
        perform private.subject_event(a,'CREATING_CHECKOUT','RECOVERY_REQUIRED');
      end if;
    elsif x.action_type='calendar.event.create' then
      select * into b from public.bookings where id=a.subject_id and business_id=p_business for update;
      if b.status='RECHECKING_SLOT' then
        update public.bookings set status='RETRY_REQUIRED' where id=b.id;
        perform private.subject_event(a,'RECHECKING_SLOT','RETRY_REQUIRED');
      end if;
    end if;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'execution.failed','system',private.journey(a),pg_catalog.jsonb_build_object('executionId',x.id,
        'actionType',x.action_type,'errorCode','INTERNAL','retryable',false,'nextStatus','NEEDS_REVIEW'));
    return next x;
  end loop;
end $$;

create function private.resolve_execution(p_business text,p_id text,p_status text,p_external_ref text,
  p_nothing_written boolean,p_checkout jsonb default null)
returns public.action_executions language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; x public.action_executions; o public.orders; b public.bookings; prior text;
  sq text; link text; url text; d public.message_dispatches;
begin
  select r.* into a from public.approval_requests r join public.action_executions e on e.approval_id=r.id
    where e.id=p_id and e.business_id=p_business and r.business_id=p_business for update of r;
  if not found then raise exception 'SCOPE: execution not found'; end if;
  select * into x from public.action_executions where id=p_id and business_id=p_business for update;
  if x.status<>'NEEDS_REVIEW' then raise exception 'LEASE: NEEDS_REVIEW required'; end if;
  if p_status is null or p_status not in ('SUCCEEDED','QUEUED','FAILED') then raise exception 'TRANSITION: invalid resolution'; end if;
  if a.state<>'APPROVED' or a.decided_at>=a.expires_at then raise exception 'SUBJECT: approved bundle required'; end if;
  perform private.check_subject(a);
  if p_status='QUEUED' and exists(select 1 from public.action_executions where approval_id=a.id and step_index>x.step_index and started_at is not null) then
    raise exception 'PREDECESSOR: successor already started'; end if;
  if p_status='QUEUED' and (p_nothing_written is distinct from true or x.attempts>=3 or x.external_ref is not null or x.square_order_id is not null) then
    raise exception 'RESULT: proved absent provider write and attempts below limit required'; end if;
  if p_status='SUCCEEDED' and nullif(p_external_ref,'') is null then raise exception 'RESULT: provider reference required'; end if;
  if p_status='SUCCEEDED' and x.external_ref is not null and x.external_ref is distinct from p_external_ref then
    raise exception 'IDENTITY: provider reference changed'; end if;
  if p_status='SUCCEEDED' and x.action_type='square.checkout.create' then
    sq:=coalesce(p_checkout->>'squareOrderId',x.square_order_id);
    link:=coalesce(p_checkout->>'paymentLinkId',x.square_payment_link_id);
    url:=coalesce(p_checkout->>'url',x.checkout_url);
    if sq is distinct from p_external_ref or nullif(link,'') is null or url is null or url !~ '^https://' then raise exception 'RESULT: checkout evidence required'; end if;
    select * into o from public.orders where id=a.subject_id and business_id=p_business for update;
    if o.status not in ('RECOVERY_REQUIRED','PAYMENT_LINK_READY') then raise exception 'SUBJECT: checkout recovery state'; end if;
    if (o.square_order_id is not null and o.square_order_id is distinct from sq)
      or (o.square_payment_link_id is not null and o.square_payment_link_id is distinct from link)
      or (o.checkout_url is not null and o.checkout_url is distinct from url)
      or (x.square_order_id is not null and (x.square_order_id,x.square_payment_link_id,x.checkout_url) is distinct from (sq,link,url)) then
      raise exception 'IDENTITY: checkout evidence changed'; end if;
    prior:=o.status;
    update public.orders set status='PAYMENT_LINK_READY',square_order_id=sq,square_payment_link_id=link,checkout_url=url,
      link_ready_at=coalesce(link_ready_at,pg_catalog.clock_timestamp()) where id=o.id;
    update public.action_executions set square_order_id=sq,square_payment_link_id=link,checkout_url=url where id=x.id;
    if prior<>'PAYMENT_LINK_READY' then
      perform private.subject_event(a,prior,'PAYMENT_LINK_READY');
      insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
        values(p_business,'checkout.created','provider',private.journey(a),pg_catalog.jsonb_build_object('orderId',o.id,
          'squareOrderId',sq,'squarePaymentLinkId',link,'totalMinor',o.total_minor,'currency',o.currency,'sandbox',true));
    end if;
  elsif x.action_type='calendar.event.create' then
    if p_status='SUCCEEDED' then
      b:=private.apply_booking(a,p_external_ref);
    elsif p_status='QUEUED' then
      update public.bookings set status='RECHECKING_SLOT' where id=a.subject_id and business_id=p_business and status='RETRY_REQUIRED';
      if found then perform private.subject_event(a,'RETRY_REQUIRED','RECHECKING_SLOT'); end if;
    end if;
  elsif p_status='SUCCEEDED' and x.action_type like 'message.%' then
    select * into d from public.message_dispatches where execution_id=x.id and business_id=p_business for update;
    if not found or d.status='FAILED' then raise exception 'RESULT: reconcilable dispatch required'; end if;
    if d.provider_message_id is not null and d.provider_message_id is distinct from p_external_ref then raise exception 'IDENTITY: provider message changed'; end if;
    if d.status in ('QUEUED','UNKNOWN') then
      update public.message_dispatches set status='SENT',provider_message_id=p_external_ref,
        sent_at=coalesce(sent_at,pg_catalog.clock_timestamp()) where id=d.id;
      insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
        values(p_business,'message.sent','provider',private.journey(a),pg_catalog.jsonb_build_object('dispatchId',d.id,
          'subjectId',a.subject_id,'channel',d.channel,'template',d.template,'recipientLast4',pg_catalog.right(d.recipient,4)));
    end if;
  elsif p_status='SUCCEEDED' and x.action_type like 'local.%' then
    raise exception 'RESULT: local steps require their checked write, not provider evidence';
  end if;
  update public.action_executions set status=p_status,external_ref=case when p_status='SUCCEEDED' then p_external_ref else external_ref end,
    finished_at=case when p_status='QUEUED' then null else pg_catalog.clock_timestamp() end,
    next_attempt_at=case when p_status='QUEUED' then pg_catalog.clock_timestamp() else next_attempt_at end,
    locked_by=null,locked_at=null,lease_deadline=null where id=x.id returning * into x;
  insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
    values(p_business,case when p_status='SUCCEEDED' then 'execution.succeeded' else 'execution.failed' end,'system',private.journey(a),
      case when p_status='SUCCEEDED' then pg_catalog.jsonb_build_object('executionId',x.id,'actionType',x.action_type,'externalRef',p_external_ref)
      else pg_catalog.jsonb_build_object('executionId',x.id,'actionType',x.action_type,'errorCode','INTERNAL','retryable',p_status='QUEUED','nextStatus',p_status) end);
  return x;
end $$;

create function private.renew_sync_lease(p_business text,p_id text,p_worker text,p_attempt integer,p_duration interval)
returns public.sync_jobs language plpgsql security definer set search_path = '' as $$
declare j public.sync_jobs;
begin
  if p_duration is null or p_duration<interval '1 minute' or p_duration>interval '15 minutes' then raise exception 'LEASE: duration must be 1 to 15 minutes'; end if;
  select * into j from public.sync_jobs where id=p_id and business_id=p_business for update;
  if not found then raise exception 'SCOPE: sync not found'; end if;
  if j.state<>'RUNNING' or p_worker is null or j.locked_by is distinct from p_worker or j.attempts is distinct from p_attempt
    or j.lease_deadline is null or j.lease_deadline<=pg_catalog.clock_timestamp() then raise exception 'LEASE: current live worker required'; end if;
  update public.sync_jobs set lease_deadline=greatest(lease_deadline,pg_catalog.clock_timestamp()+p_duration) where id=j.id returning * into j;
  return j;
end $$;
create function private.recover_stale_sync_jobs(p_business text) returns setof public.sync_jobs
language plpgsql security definer set search_path = '' as $$
declare j public.sync_jobs; a public.approval_requests;
begin
  if nullif(p_business,'') is null then raise exception 'SCOPE: business required'; end if;
  for j in select * from public.sync_jobs where business_id=p_business and state='RUNNING'
    and lease_deadline<=pg_catalog.clock_timestamp() order by id for update skip locked
  loop
    update public.sync_jobs set state=case when attempts>=5 then 'FAILED' else 'RETRYING' end,
      locked_by=null,locked_at=null,lease_deadline=null,next_retry_at=pg_catalog.clock_timestamp(),
      last_error='Stale lease: look up record ID before appending' where id=j.id returning * into j;
    select * into a from public.approval_requests where id=j.approval_id and business_id=p_business;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'sync.failed','system',private.journey(a),pg_catalog.jsonb_build_object('target','google_sheets','syncJobId',j.id,
        'recordType',j.record_type,'recordId',j.record_id,'attempts',j.attempts,'final',j.state='FAILED'));
    return next j;
  end loop;
end $$;

-- The approved local step applies both existing-key changes and new-key draft promotion.
create function private.apply_fact_update(p_business text,p_execution text,p_worker text,p_attempt integer)
returns public.business_facts language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; x public.action_executions; f public.business_facts; result public.business_facts; m jsonb;
begin
  select r.* into a from public.approval_requests r join public.action_executions e on e.approval_id=r.id
    where e.id=p_execution and e.business_id=p_business and r.business_id=p_business for update of r;
  if not found then raise exception 'SCOPE: fact execution not found'; end if;
  select * into x from public.action_executions where id=p_execution and business_id=p_business for update;
  if x.action_type<>'local.fact.update' or x.status<>'RUNNING' or x.locked_by is distinct from p_worker or p_worker is null
    or x.attempts is distinct from p_attempt or x.lease_deadline is null or x.lease_deadline<=pg_catalog.clock_timestamp() then raise exception 'LEASE: current fact worker required'; end if;
  -- Serializes two different draft subjects proposing the same new key.
  perform 1 from public.businesses where id=p_business for update;
  perform private.check_subject(a);
  m:=a.payload_canonical::jsonb;
  select * into f from public.business_facts where id=a.subject_id and business_id=p_business for update;
  if (m->>'fromVersion')::integer=0 then
    update public.business_facts set status='verified',version=1,verified_at=pg_catalog.clock_timestamp(),verified_by=a.decided_by where id=f.id returning * into result;
  else
    update public.business_facts set status='superseded' where id=f.id;
    insert into public.business_facts(business_id,kind,key,value,source_type,status,version,supersedes_id,verified_at,verified_by)
      values(p_business,f.kind,f.key,m->'after','owner_ui','verified',f.version+1,f.id,pg_catalog.clock_timestamp(),a.decided_by) returning * into result;
  end if;
  perform private.finish_execution(p_business,x.id,p_worker,p_attempt,'SUCCEEDED',result.id,null,null);
  insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
    values(p_business,'fact.changed','owner',a.id,pg_catalog.jsonb_build_object('factId',result.id,'kind',result.kind,'key',result.key,
      'fromVersion',(m->>'fromVersion')::integer,'toVersion',result.version,'sourceType',result.source_type));
  return result;
end $$;

revoke all on function private.journey(public.approval_requests) from public,anon,authenticated,service_role,abos_app;
revoke all on function private.subject_event(public.approval_requests,text,text) from public,anon,authenticated,service_role,abos_app;
revoke all on function private.orders_transition(text,text) from public,anon,authenticated,service_role,abos_app;
revoke all on function private.orders_runtime_guard() from public,anon,authenticated,service_role,abos_app;
revoke all on function private.bookings_transition(text,text) from public,anon,authenticated,service_role,abos_app;
revoke all on function private.bookings_runtime_guard() from public,anon,authenticated,service_role,abos_app;
revoke all on function private.check_subject(public.approval_requests) from public,anon,authenticated,service_role,abos_app;
revoke all on function private.decide_and_enqueue(text,text,text,text,text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.decide_and_enqueue(text,text,text,text,text,text) to abos_app;
revoke all on function private.expire_approvals(text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.expire_approvals(text) to abos_app;
revoke all on function private.claim_execution(text,text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.claim_execution(text,text,text) to abos_app;
revoke all on function private.finish_execution(text,text,text,integer,text,text,text,timestamptz) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.finish_execution(text,text,text,integer,text,text,text,timestamptz) to abos_app;
revoke all on function private.claim_sync_job(text,text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.claim_sync_job(text,text,text) to abos_app;
revoke all on function private.finish_sync_job(text,text,text,integer,text,text,text,timestamptz) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.finish_sync_job(text,text,text,integer,text,text,text,timestamptz) to abos_app;
revoke all on function private.check_payment(public.orders,public.approval_requests,text,text,text,integer,text,text,text) from public,anon,authenticated,service_role,abos_app;
revoke all on function private.insert_receipt(public.orders,text,text,text,integer,text,text,text) from public,anon,authenticated,service_role,abos_app;
revoke all on function private.mark_order_paid(text,text,text,integer,text,text,text,text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.mark_order_paid(text,text,text,integer,text,text,text,text,text) to abos_app;
revoke all on function private.mark_order_payment_failed(text,text,text,text,integer,text,text,text,text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.mark_order_payment_failed(text,text,text,text,integer,text,text,text,text,text) to abos_app;
revoke all on function private.save_checkout(text,text,text,integer,text,text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.save_checkout(text,text,text,integer,text,text,text) to abos_app;
revoke all on function private.fulfill_order(text,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.fulfill_order(text,text) to abos_app;
revoke all on function private.apply_booking(public.approval_requests,text) from public,anon,authenticated,service_role,abos_app;
revoke all on function private.verify_booking(text,text,text,integer,text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.verify_booking(text,text,text,integer,text) to abos_app;
revoke all on function private.renew_execution_lease(text,text,text,integer,interval) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.renew_execution_lease(text,text,text,integer,interval) to abos_app;
revoke all on function private.recover_stale_executions(text,interval) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.recover_stale_executions(text,interval) to abos_app;
revoke all on function private.resolve_execution(text,text,text,text,boolean,jsonb) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.resolve_execution(text,text,text,text,boolean,jsonb) to abos_app;
revoke all on function private.renew_sync_lease(text,text,text,integer,interval) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.renew_sync_lease(text,text,text,integer,interval) to abos_app;
revoke all on function private.recover_stale_sync_jobs(text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.recover_stale_sync_jobs(text) to abos_app;
revoke all on function private.apply_fact_update(text,text,text,integer) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.apply_fact_update(text,text,text,integer) to abos_app;
