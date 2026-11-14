-- Forward migration: builder revision counter, checked payment outcomes and stale lease recovery.
-- Apply as the migration/table owner (Supabase's non-superuser "postgres"). 0001 to 0004 are unchanged.

-- The builder's durable draft revision (API 3.4 specRevision). abos_app already holds table-level
-- SELECT, INSERT and UPDATE on agents (0004), which covers this column; no column grant is needed.
alter table public.agents add column spec_revision integer not null default 1
  constraint agents_spec_revision_positive check (spec_revision >= 1);

-- One Square payment can never pay two local orders, as with the Square order and link IDs (AC-10).
create unique index orders_square_payment_id_key
  on public.orders (square_payment_id) where square_payment_id is not null;

-- Square reported a verified COMPLETED payment for this order. The caller reads Square first; this
-- routine checks the verified amount and currency against the signed approval and the order row,
-- records the payment ID, moves the order to PAID_VERIFIED and enqueues the Sheets job, all at once.
create function private.mark_order_paid(p_business text, p_order text, p_payment_id text,
  p_amount_minor integer, p_currency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; a public.approval_requests; m jsonb; j public.sync_jobs; existed boolean; prior text;
begin
  if p_payment_id is null or p_payment_id = '' then raise exception 'PAYMENT: payment ID required'; end if;
  select * into o from public.orders where id=p_order and business_id=p_business for update;
  if not found then raise exception 'SCOPE: order not found'; end if;
  select * into a from public.approval_requests where id=o.approval_id and business_id=p_business
    and subject_id=o.id and bundle_type='order_bundle' and state='APPROVED';
  if not found then raise exception 'SUBJECT: order has no approved bundle'; end if;
  m := a.payload_canonical::jsonb;
  if p_amount_minor is null or p_amount_minor is distinct from (m->>'totalMinor')::integer
    or p_amount_minor is distinct from o.total_minor then raise exception 'PAYMENT: amount differs from approved total'; end if;
  if p_currency is null or p_currency is distinct from m->>'currency' or p_currency is distinct from o.currency then
    raise exception 'PAYMENT: currency differs from approved currency'; end if;
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
      values(p_business,'order.status_changed','system',a.id,pg_catalog.jsonb_build_object('subjectId',o.id,'orderId',o.id,
        'callId',o.call_id,'from',prior,'to','PAID_VERIFIED'));
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'payment.verified','provider',a.id,pg_catalog.jsonb_build_object('orderId',o.id,'squarePaymentId',p_payment_id,
        'amountMinor',p_amount_minor,'currency',p_currency,'sandbox',true));
  end if;
  -- The same checked path as enqueue_sheets_sync. A repeat finds the existing job; a missing job is created.
  existed := exists(select 1 from public.sync_jobs where target='google_sheets' and record_type='order' and record_id=o.id);
  j := private.enqueue_sheets_sync(p_business,'order',o.id);
  if not existed then
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'sync.queued','system',a.id,pg_catalog.jsonb_build_object('target','google_sheets','syncJobId',j.id,
        'recordType','order','recordId',o.id));
  end if;
  return pg_catalog.jsonb_build_object('order',pg_catalog.to_jsonb(o),'syncJob',pg_catalog.to_jsonb(j));
end $$;

-- Square reported a final failed or canceled payment. Only PAYMENT_PENDING moves; a repeat on
-- PAYMENT_FAILED changes nothing; a paid order never moves backwards.
create function private.mark_order_payment_failed(p_business text, p_order text, p_payment_id text, p_reason text)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare o public.orders; a public.approval_requests;
begin
  if p_payment_id is null or p_payment_id = '' then raise exception 'PAYMENT: payment ID required'; end if;
  if p_reason is null or p_reason = '' or pg_catalog.length(p_reason) > 200 then raise exception 'PAYMENT: reason required, at most 200 characters'; end if;
  select * into o from public.orders where id=p_order and business_id=p_business for update;
  if not found then raise exception 'SCOPE: order not found'; end if;
  if o.status = 'PAYMENT_FAILED' then return o; end if;
  if o.status <> 'PAYMENT_PENDING' then raise exception 'SUBJECT: order requires PAYMENT_PENDING'; end if;
  select * into a from public.approval_requests where id=o.approval_id and business_id=p_business
    and subject_id=o.id and bundle_type='order_bundle' and state='APPROVED';
  if not found then raise exception 'SUBJECT: order has no approved bundle'; end if;
  update public.orders set status='PAYMENT_FAILED' where id=o.id returning * into o;
  insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
    values(p_business,'order.status_changed','system',a.id,pg_catalog.jsonb_build_object('subjectId',o.id,'orderId',o.id,
      'callId',o.call_id,'from','PAYMENT_PENDING','to','PAYMENT_FAILED'));
  insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
    values(p_business,'payment.failed','provider',a.id,pg_catalog.jsonb_build_object('orderId',o.id,'squarePaymentId',p_payment_id,
      'reason',p_reason,'sandbox',true));
  return o;
end $$;

-- A crashed worker leaves its step RUNNING. Its provider call may have happened, so a step whose lease
-- (locked_at, set by every claim) is older than p_stale_after goes to NEEDS_REVIEW, never back to QUEUED
-- and never rerun with a new key. NEEDS_REVIEW on a message step still lets local recording run
-- (execution_claim_allowed). The subject moves as a failed step would: checkout to RECOVERY_REQUIRED,
-- calendar to RETRY_REQUIRED. The executor writes execution.failed for each returned row.
create function private.recover_stale_executions(p_business text, p_stale_after interval)
returns setof public.action_executions language plpgsql security definer set search_path = '' as $$
declare cutoff timestamptz; c record; a public.approval_requests; x public.action_executions;
  o public.orders; b public.bookings;
begin
  if p_business is null or p_business = '' then raise exception 'SCOPE: business required'; end if;
  -- A live step must not be sent to review; no provider call is expected to take a minute.
  if p_stale_after is null or p_stale_after < interval '1 minute' then raise exception 'LEASE: stale interval must be at least one minute'; end if;
  cutoff := pg_catalog.clock_timestamp() - p_stale_after;
  for c in select e.id, e.approval_id from public.action_executions e
    where e.business_id=p_business and e.status='RUNNING' and coalesce(e.locked_at,e.updated_at) < cutoff
    order by coalesce(e.locked_at,e.updated_at), e.id
  loop
    -- Approval before execution, the lock order every other routine uses. A row held by a worker that
    -- is finishing right now is skipped and seen again on the next sweep.
    select * into a from public.approval_requests where id=c.approval_id and business_id=p_business for update skip locked;
    if not found then continue; end if;
    select * into x from public.action_executions where id=c.id and business_id=p_business for update;
    if x.status <> 'RUNNING' or coalesce(x.locked_at,x.updated_at) >= cutoff then continue; end if;
    update public.action_executions set status='NEEDS_REVIEW',locked_by=null,locked_at=null,error_code='INTERNAL',
      last_error='Stale lease: provider outcome unknown',finished_at=pg_catalog.clock_timestamp()
      where id=x.id returning * into x;
    if x.action_type='square.checkout.create' and a.bundle_type='order_bundle' then
      select * into o from public.orders where id=a.subject_id and business_id=p_business
        and status in ('APPROVED','CREATING_CHECKOUT') for update;
      if found then
        update public.orders set status='RECOVERY_REQUIRED' where id=o.id;
        insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
          values(p_business,'order.status_changed','system',a.id,pg_catalog.jsonb_build_object('subjectId',o.id,'orderId',o.id,
            'callId',o.call_id,'from',o.status,'to','RECOVERY_REQUIRED'));
      end if;
    elsif x.action_type='calendar.event.create' and a.bundle_type='booking_bundle' then
      select * into b from public.bookings where id=a.subject_id and business_id=p_business and status='RECHECKING_SLOT' for update;
      if found then
        update public.bookings set status='RETRY_REQUIRED' where id=b.id;
        insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
          values(p_business,'booking.status_changed','system',a.id,pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'subjectId',b.id,'bookingId',b.id,'callId',b.call_id,'from','RECHECKING_SLOT','to','RETRY_REQUIRED')));
      end if;
    end if;
    return next x;
  end loop;
end $$;

-- Only abos_app may call the new entry points.
revoke all on function private.mark_order_paid(text,text,text,integer,text) from public, anon, authenticated, service_role;
revoke all on function private.mark_order_payment_failed(text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function private.recover_stale_executions(text,interval) from public, anon, authenticated, service_role;
grant execute on function private.mark_order_paid(text,text,text,integer,text) to abos_app;
grant execute on function private.mark_order_payment_failed(text,text,text,text) to abos_app;
grant execute on function private.recover_stale_executions(text,interval) to abos_app;
