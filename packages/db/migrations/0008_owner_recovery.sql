-- Owner recovery of stuck steps (issue #54, SPEC P-19) and an honest dispatch status after a crash
-- (issue #93). Additive only: two new SECURITY DEFINER routines and their grants. No table, column,
-- constraint, trigger, policy or existing routine changes, and no row is written by the migration
-- itself. Apply as the non-superuser migration owner; the runner wraps this file in one transaction.
-- 0001 to 0007 are unchanged.

-- 1. Stale recovery leaves a message dispatch honest (issue #93). recover_stale_executions (0005)
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

-- 2. The owner's retry or abandon of a step in NEEDS_REVIEW (POST /api/executions/:id/resolve).
-- It checks the signed-in owner of the business here, in the database, then takes the 0005 lock order
-- (approval, step, dispatch). Every move is one the CONTRACTS state machines allow:
--   abandon, any step          NEEDS_REVIEW -> FAILED through resolve_execution, no subject move and
--                              no external write. A message step's QUEUED or UNKNOWN dispatch becomes
--                              FAILED with it ("owner marks failed"); a SENT or DELIVERED one is refused,
--                              since it is completed from its provider ID instead.
--   retry, message step        completes from a stored SENT or DELIVERED dispatch only. An unknown send
--                              is never resent (CONTRACTS: no resend from UNKNOWN; SPEC 4: AgentPhone has
--                              no idempotency key), so there is no move back to QUEUED.
--   retry, other steps         with provider evidence: resolve_execution SUCCEEDED (checkout references,
--                              verified booking). With proof that nothing was written: resolve_execution
--                              QUEUED with the same step row, so the same idempotency key (frozen by
--                              action_executions_match_approval). A checkout needs its order in
--                              RECOVERY_REQUIRED or CREATING_CHECKOUT and a calendar step its booking in
--                              RETRY_REQUIRED or RECHECKING_SLOT. resolve_execution moves RETRY_REQUIRED
--                              to RECHECKING_SLOT; an order keeps RECOVERY_REQUIRED, which save_checkout
--                              moves to PAYMENT_LINK_READY when the retried step completes.
-- resolve_execution writes the execution.succeeded or execution.failed event in the same transaction.
-- A repeat of an action already applied returns the step unchanged and writes nothing.
create function private.owner_resolve_execution(p_business text,p_id text,p_owner text,p_action text,
  p_external_ref text default null,p_nothing_written boolean default false,p_checkout jsonb default null)
returns public.action_executions language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; x public.action_executions; d public.message_dispatches; has_dispatch boolean;
begin
  if p_action is null or p_action not in ('retry','abandon') then raise exception 'TRANSITION: recovery action must be retry or abandon'; end if;
  if nullif(p_owner,'') is null or p_owner is distinct from (select owner_id from public.businesses where id=p_business) then
    raise exception 'OWNER: business owner required'; end if;
  select r.* into a from public.approval_requests r join public.action_executions e on e.approval_id=r.id
    where e.id=p_id and e.business_id=p_business and r.business_id=p_business for update of r;
  if not found then raise exception 'SCOPE: execution not found'; end if;
  select * into x from public.action_executions where id=p_id and business_id=p_business for update;
  select * into d from public.message_dispatches where execution_id=x.id and business_id=p_business for update;
  has_dispatch:=found;
  -- Repeats of an action that already took effect.
  if p_action='abandon' and x.status='FAILED' and (not has_dispatch or d.status not in ('QUEUED','UNKNOWN')) then return x; end if;
  if p_action='retry' and x.status='SUCCEEDED' and nullif(p_external_ref,'') is not null and x.external_ref=p_external_ref then return x; end if;
  if p_action='retry' and x.status='QUEUED' and x.started_at is not null and x.action_type not like 'message.%' then return x; end if;
  if x.status<>'NEEDS_REVIEW' then raise exception 'LEASE: NEEDS_REVIEW required'; end if;
  if x.action_type like 'message.%' then
    if has_dispatch and d.status in ('SENT','DELIVERED') then
      if p_action='abandon' then raise exception 'SUBJECT: a sent message is completed from its provider message ID, not abandoned'; end if;
      return private.resolve_execution(p_business,p_id,'SUCCEEDED',d.provider_message_id,false,null);
    end if;
    if p_action='retry' then raise exception 'SUBJECT: a message whose delivery is unknown is never sent again'; end if;
    if has_dispatch and d.status in ('QUEUED','UNKNOWN') then
      update public.message_dispatches set status='FAILED' where id=d.id returning * into d;
      insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
        values(p_business,'message.failed','owner',private.journey(a),pg_catalog.jsonb_build_object('dispatchId',d.id,
          'subjectId',a.subject_id,'channel',d.channel,'status','FAILED'));
    end if;
    return private.resolve_execution(p_business,p_id,'FAILED',null,false,null);
  end if;
  if p_action='abandon' then return private.resolve_execution(p_business,p_id,'FAILED',null,false,null); end if;
  if nullif(p_external_ref,'') is not null then
    return private.resolve_execution(p_business,p_id,'SUCCEEDED',p_external_ref,false,p_checkout);
  end if;
  if p_nothing_written is distinct from true then raise exception 'RESULT: retry needs provider evidence or proof that nothing was written'; end if;
  if x.action_type='square.checkout.create' and not exists(select 1 from public.orders where id=a.subject_id and business_id=p_business
    and status in ('RECOVERY_REQUIRED','CREATING_CHECKOUT')) then raise exception 'SUBJECT: checkout retry needs an order in recovery'; end if;
  if x.action_type='calendar.event.create' and not exists(select 1 from public.bookings where id=a.subject_id and business_id=p_business
    and status in ('RETRY_REQUIRED','RECHECKING_SLOT')) then raise exception 'SUBJECT: calendar retry needs a booking to retry'; end if;
  return private.resolve_execution(p_business,p_id,'QUEUED',null,true,null);
end $$;

-- Only abos_app may call the two entry points, as 0005 and 0006 grant theirs.
revoke all on function private.mark_stale_dispatches_unknown(text) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.mark_stale_dispatches_unknown(text) to abos_app;
revoke all on function private.owner_resolve_execution(text,text,text,text,text,boolean,jsonb) from public,anon,authenticated,service_role,abos_app;
grant execute on function private.owner_resolve_execution(text,text,text,text,text,boolean,jsonb) to abos_app;
