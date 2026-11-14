-- Owner recovery of stuck steps (issue #54, SPEC P-19) and an honest dispatch status after a crash
-- (issue #93). Additive only: one append-only table the runtime role may only read, two new SECURITY
-- DEFINER routines and their grants. No existing table, column, constraint, trigger, policy or routine
-- changes, and the migration writes no row. Apply as the non-superuser migration owner; the runner
-- wraps this file in one transaction. 0001 to 0007 are unchanged.
--
-- Trust boundary (the 0005 and 0006 convention, unchanged): the database cannot read Square or Google.
-- The server is the trusted reader of providers, and it is also the party that verified the owner's
-- sign-in. So a caller holding the abos_app login can assert provider evidence, exactly as it can through
-- 0005's resolve_execution today. 0008 adds no success path of its own: owner_resolve_execution passes
-- the evidence straight to resolve_execution, with every 0005 and 0006 check on the approved material,
-- and it records a decision only for a step it moved out of NEEDS_REVIEW itself, in the same call.

-- 1. One durable recovery decision per step attempt (review finding 3). Written only by
-- owner_resolve_execution, in the same transaction as the move it records. The runtime role may read
-- it and nothing else; rows are never changed or deleted.
create table public.recovery_decisions (
  business_id   text not null references public.businesses (id),
  execution_id  text not null references public.action_executions (id),
  attempt       integer not null check (attempt between 0 and 3),
  action        text not null check (action in ('retry', 'abandon')),
  decided_by    text not null references public.users (id),
  -- What the server read from the provider, as one short code. 'none': nothing was read (a message
  -- abandon writes nothing external and needs no read).
  provider_read text not null check (provider_read in ('none', 'checkout_found', 'calendar_event_found', 'calendar_event_absent', 'message_sent')),
  result_status text not null check (result_status in ('SUCCEEDED', 'QUEUED', 'FAILED')),
  decided_at    timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (execution_id, attempt)
);
alter table public.recovery_decisions enable row level security;
revoke all on public.recovery_decisions from public, anon, authenticated, service_role, abos_app;
grant select on public.recovery_decisions to abos_app, authenticated;
create policy runtime_read on public.recovery_decisions for select to abos_app using (true);
create policy recovery_decisions_owner_read on public.recovery_decisions for select to authenticated using (private.owns_business(business_id));
create trigger recovery_decisions_append_only before update or delete on public.recovery_decisions
  for each row execute function public.activity_events_append_only();
alter table public.recovery_decisions enable always trigger recovery_decisions_append_only;

-- 2. Stale recovery leaves a message dispatch honest (issue #93). recover_stale_executions (0005)
-- moves a RUNNING step whose lease expired to NEEDS_REVIEW, but cannot touch its dispatch: the row
-- stays QUEUED although the provider may have the message. CONTRACTS "Message dispatch": a timeout
-- with no answer is QUEUED -> UNKNOWN, and nothing resends from UNKNOWN. This sweep makes that move
-- for every dispatch of a message step in NEEDS_REVIEW that is still QUEUED with no provider message
-- ID, including rows recovered before this migration. Lock order is update_dispatch's: approval,
-- execution, dispatch. A locked approval is skipped and found again on the next sweep. Only the status
-- changes, so message_dispatches_guard accepts the update. It writes message.failed with status
-- UNKNOWN, as the sender does for an unknown result. A repeat finds nothing and writes nothing.
create function private.mark_stale_dispatches_unknown(p_business text)
returns setof public.message_dispatches language plpgsql security definer set search_path = '' as $$
declare c record; a public.approval_requests; x public.action_executions; d public.message_dispatches;
begin
  if nullif(p_business,'') is null then raise exception 'SCOPE: business required'; end if;
  for c in select m.id,m.approval_id,m.execution_id from public.message_dispatches m
    join public.action_executions e on e.id=m.execution_id and e.business_id=m.business_id
    where m.business_id=p_business and m.status='QUEUED' and m.provider_message_id is null and e.status='NEEDS_REVIEW'
    order by m.id
  loop
    select * into a from public.approval_requests where id=c.approval_id and business_id=p_business for update skip locked;
    if not found then continue; end if;
    select * into x from public.action_executions where id=c.execution_id and business_id=p_business for update;
    select * into d from public.message_dispatches where id=c.id and business_id=p_business for update;
    if x.status<>'NEEDS_REVIEW' or x.action_type not like 'message.%' or d.status<>'QUEUED' or d.provider_message_id is not null then continue; end if;
    update public.message_dispatches set status='UNKNOWN' where id=d.id returning * into d;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'message.failed','system',private.journey(a),pg_catalog.jsonb_build_object('dispatchId',d.id,
        'subjectId',a.subject_id,'channel',d.channel,'status','UNKNOWN'));
    return next d;
  end loop;
end $$;

-- 3. The owner's retry or abandon of a step in NEEDS_REVIEW (POST /api/executions/:id/resolve), and the
-- only writer of recovery_decisions. Every decision row is written in the same call that moved the step
-- out of NEEDS_REVIEW, so no receipt exists for a step this routine did not move. In order:
--   1. Check the action and the read code, and that p_owner is the business's owner (the ID the server
--      verified at sign-in).
--   2. Lock the approval, then the step (0005 lock order), scoped to the business.
--   3. A decision already recorded for this step and its current attempt: the identical request (same
--      action and read) returns the step; anything else is refused. This comes before any state check.
--   4. The step must be in NEEDS_REVIEW. A step completed or moved by any other path is refused.
--   5. Move it, always through 0005's private.resolve_execution, with all of its checks:
--      * retry with a found read (checkout_found, calendar_event_found, message_sent): SUCCEEDED from the
--        evidence. p_external_ref and p_checkout are passed straight through to resolve_execution and are
--        accepted for nothing else; a message uses its stored dispatch's provider message ID.
--      * retry with calendar_event_absent: QUEUED, the same row (same idempotency key, same attempt
--        count); the booking moves RETRY_REQUIRED -> RECHECKING_SLOT. A checkout cannot be proven absent
--        (the Square adapter has no read by idempotency key), and a message whose delivery is unknown is
--        never sent again (CONTRACTS: no resend from UNKNOWN), so neither is requeued.
--      * abandon: FAILED, no subject move, nothing external. A calendar step needs the absence read; a
--        message step needs none ('none'), and its QUEUED or UNKNOWN dispatch becomes FAILED with it
--        ("owner marks failed"); a SENT or DELIVERED one is refused. A checkout is never abandoned here.
--   6. Insert the decision row for the attempt the step was in.
-- resolve_execution writes the execution event; this routine writes the decision row (and message.failed).
create function private.owner_resolve_execution(p_business text,p_id text,p_owner text,p_action text,p_provider_read text,
  p_external_ref text default null,p_checkout jsonb default null)
returns public.action_executions language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; x public.action_executions; d public.message_dispatches; has_dispatch boolean;
  r public.recovery_decisions; result public.action_executions; found_read boolean;
begin
  if p_action is null or p_action not in ('retry','abandon') then raise exception 'TRANSITION: recovery action must be retry or abandon'; end if;
  if p_provider_read is null or p_provider_read not in ('none','checkout_found','calendar_event_found','calendar_event_absent','message_sent') then
    raise exception 'TRANSITION: unknown provider read'; end if;
  found_read:=p_provider_read in ('checkout_found','calendar_event_found','message_sent');
  if (not found_read or p_action<>'retry') and (p_external_ref is not null or p_checkout is not null) then
    raise exception 'RESULT: provider evidence is taken only with a found read on retry'; end if;
  if nullif(p_owner,'') is null or p_owner is distinct from (select owner_id from public.businesses where id=p_business) then
    raise exception 'OWNER: business owner required'; end if;
  select ar.* into a from public.approval_requests ar join public.action_executions e on e.approval_id=ar.id
    where e.id=p_id and e.business_id=p_business and ar.business_id=p_business for update of ar;
  if not found then raise exception 'SCOPE: execution not found'; end if;
  select * into x from public.action_executions where id=p_id and business_id=p_business for update;
  select * into r from public.recovery_decisions where execution_id=x.id and attempt=x.attempts;
  if found then
    if r.action=p_action and r.provider_read=p_provider_read then return x; end if;
    raise exception 'SUBJECT: another recovery decision was recorded for this attempt';
  end if;
  if x.status<>'NEEDS_REVIEW' then raise exception 'LEASE: NEEDS_REVIEW required'; end if;
  select * into d from public.message_dispatches where execution_id=x.id and business_id=p_business for update;
  has_dispatch:=found;

  if p_action='retry' and found_read then
    if p_provider_read='checkout_found' and x.action_type='square.checkout.create' and nullif(p_external_ref,'') is not null then
      result:=private.resolve_execution(p_business,p_id,'SUCCEEDED',p_external_ref,false,p_checkout);
    elsif p_provider_read='calendar_event_found' and x.action_type='calendar.event.create' and nullif(p_external_ref,'') is not null and p_checkout is null then
      result:=private.resolve_execution(p_business,p_id,'SUCCEEDED',p_external_ref,false,null);
    elsif p_provider_read='message_sent' and x.action_type like 'message.%' and has_dispatch and d.status in ('SENT','DELIVERED')
      and d.provider_message_id is not null and (p_external_ref is null or p_external_ref=d.provider_message_id) and p_checkout is null then
      result:=private.resolve_execution(p_business,p_id,'SUCCEEDED',d.provider_message_id,false,null);
    else raise exception 'RESULT: the provider read does not fit this step';
    end if;
  elsif x.action_type like 'message.%' then
    if p_action='retry' then raise exception 'SUBJECT: a message whose delivery is unknown is never sent again'; end if;
    if p_provider_read<>'none' then raise exception 'RESULT: a message abandon takes no provider read'; end if;
    if has_dispatch and d.status in ('SENT','DELIVERED') then
      raise exception 'SUBJECT: a sent message is completed from its provider message ID, not abandoned'; end if;
    if has_dispatch and d.status in ('QUEUED','UNKNOWN') then
      update public.message_dispatches set status='FAILED' where id=d.id returning * into d;
      insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
        values(p_business,'message.failed','owner',private.journey(a),pg_catalog.jsonb_build_object('dispatchId',d.id,
          'subjectId',a.subject_id,'channel',d.channel,'status','FAILED'));
    end if;
    result:=private.resolve_execution(p_business,p_id,'FAILED',null,false,null);
  elsif x.action_type='calendar.event.create' and p_provider_read='calendar_event_absent' then
    if not exists(select 1 from public.bookings where id=a.subject_id and business_id=p_business and status='RETRY_REQUIRED') then
      raise exception 'SUBJECT: calendar recovery needs a booking in RETRY_REQUIRED'; end if;
    result:=private.resolve_execution(p_business,p_id,case p_action when 'retry' then 'QUEUED' else 'FAILED' end,null,p_action='retry',null);
  elsif x.action_type='square.checkout.create' then
    raise exception 'SUBJECT: a checkout cannot be proven absent, so it is neither retried nor abandoned; cancel the order';
  else
    raise exception 'RESULT: this step needs a provider read that proves nothing was written';
  end if;
  insert into public.recovery_decisions(business_id,execution_id,attempt,action,decided_by,provider_read,result_status)
    values(p_business,x.id,x.attempts,p_action,p_owner,p_provider_read,result.status);
  return result;
end $$;

-- Only abos_app may call the two entry points, as 0005 and 0006 grant theirs.
revoke all on function private.mark_stale_dispatches_unknown(text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.mark_stale_dispatches_unknown(text) to abos_app;
revoke all on function private.owner_resolve_execution(text,text,text,text,text,text,jsonb) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.owner_resolve_execution(text,text,text,text,text,text,jsonb) to abos_app;
