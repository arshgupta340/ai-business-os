-- Forward-only runtime privilege boundary. Apply as the migration/table owner.
-- On Supabase that owner ("postgres") is not a superuser. CREATE ROLE may state negative
-- attributes, but ALTER ROLE ... NOSUPERUSER or NOBYPASSRLS needs privileges it may lack, so an
-- existing role is checked and refused instead of altered.
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'abos_app') then
    create role abos_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'abos_app'
             and (rolsuper or rolinherit or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    raise exception 'ROLE: existing abos_app has unsafe attributes; an administrator must remove them before this migration';
  end if;
end $$;
-- Remove inherited or SET ROLE routes even if the role was provisioned previously.
do $$ declare r record; begin
  for r in select parent.rolname from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles parent on parent.oid = m.roleid
    join pg_catalog.pg_roles child on child.oid = m.member where child.rolname = 'abos_app'
  loop execute pg_catalog.format('revoke %I from abos_app', r.rolname); end loop;
end $$;
-- No USAGE on extensions: abos_app needs no extension function directly; definer routines do.
grant usage on schema public, private to abos_app;
grant usage on schema private to service_role;
grant execute on function public.gen_id(text) to abos_app;
revoke all on all tables in schema public from abos_app;
do $$ declare t text; begin
  foreach t in array array['users','businesses','capabilities','integrations','files','business_facts',
    'catalog_items','fact_conflicts','agents','agent_versions','live_agent','builder_sessions','calls',
    'approval_requests','orders','bookings','action_executions','message_dispatches','webhook_events','sync_jobs','activity_events']
  loop
    execute pg_catalog.format('grant select on public.%I to abos_app', t);
    execute pg_catalog.format('create policy runtime_read on public.%I for select to abos_app using (true)', t);
  end loop;
  foreach t in array array['businesses','users','business_facts','files','catalog_items','fact_conflicts',
    'agents','agent_versions','live_agent','builder_sessions','calls','orders','bookings','integrations','activity_events','webhook_events']
  loop
    execute pg_catalog.format('grant insert on public.%I to abos_app', t);
    execute pg_catalog.format('create policy runtime_insert on public.%I for insert to abos_app with check (true)', t);
    if t not in ('activity_events','webhook_events') then
      execute pg_catalog.format('grant update on public.%I to abos_app', t);
      execute pg_catalog.format('create policy runtime_update on public.%I for update to abos_app using (true) with check (true)', t);
    end if;
  end loop;
  foreach t in array array['builder_sessions','files','fact_conflicts','catalog_items','live_agent'] loop
    execute pg_catalog.format('grant delete on public.%I to abos_app', t);
    execute pg_catalog.format('create policy runtime_delete on public.%I for delete to abos_app using (true)', t);
  end loop;
end $$;
revoke delete, truncate on public.approval_requests, public.action_executions,
  public.message_dispatches, public.sync_jobs from service_role;

create function private.retain_identity() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'RETAIN: dedupe records cannot be deleted'; end if;
  if (new.id, new.business_id, new.target, new.record_type, new.record_id, new.approval_id, new.idempotency_key)
     is distinct from (old.id, old.business_id, old.target, old.record_type, old.record_id, old.approval_id, old.idempotency_key)
  then raise exception 'IDENTITY: sync identity is frozen'; end if;
  return new;
end $$;
alter table public.sync_jobs add column approval_id text references public.approval_requests(id),
  add column idempotency_key text unique,
  add column locked_by text, add column locked_at timestamptz;
create trigger retain_execution before delete on public.action_executions for each row execute function private.retain_identity();
create trigger retain_dispatch before delete on public.message_dispatches for each row execute function private.retain_identity();
create trigger retain_sync before delete or update on public.sync_jobs for each row execute function private.retain_identity();
alter table public.action_executions enable always trigger retain_execution;
alter table public.message_dispatches enable always trigger retain_dispatch;
alter table public.sync_jobs enable always trigger retain_sync;

-- Material projection is constructed here, never supplied as a list of keys by the caller.
create function private.material(p_type text, p jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare keys text[]; k text; result jsonb := '{}';
begin
  if p_type is null or p_type not in ('order_bundle','booking_bundle','fact_edit','price_edit') then raise exception 'MATERIAL: invalid bundle'; end if;
  keys := array['businessId','subjectId','actionBundle','expiresAt'] || case p_type
    when 'order_bundle' then array['agentVersionId','cartHash','totalMinor','currency','pickupAt','messageRecipient','messageChannel']
    when 'booking_bundle' then array['agentVersionId','serviceId','calendarId','startUtc','endUtc','timezone','messageRecipient','messageChannel']
    when 'fact_edit' then array['kind','key','fromVersion','before','after']
    when 'price_edit' then array['squareItemId','variationId','fromPriceMinor','newPriceMinor','currency','squareVersion']
    else null end;
  if keys is null or pg_catalog.jsonb_typeof(p) is distinct from 'object' then raise exception 'MATERIAL: invalid bundle'; end if;
  foreach k in array keys loop
    -- A customer who declined messages has no recipient. Only qr_only, which never sends,
    -- may omit it or sign it as null; the routing check below validates every other case.
    if k = 'messageRecipient' and p->>'messageChannel' = 'qr_only' and (not p ? k or p->k = 'null'::jsonb) then
      if p ? k then result := result || pg_catalog.jsonb_build_object(k, p->k); end if;
      continue;
    end if;
    if not p ? k then raise exception 'MATERIAL: missing %', k; end if;
    if k in ('actionBundle') then
      if pg_catalog.jsonb_typeof(p->k) is distinct from 'array' then raise exception 'MATERIAL: % must be array', k; end if;
    elsif k in ('totalMinor','fromVersion','fromPriceMinor','newPriceMinor','squareVersion') then
      if pg_catalog.jsonb_typeof(p->k) is distinct from 'number' or (p->>k)::numeric < 0
         or (p->>k)::numeric <> pg_catalog.trunc((p->>k)::numeric) then raise exception 'MATERIAL: % must be nonnegative integer', k; end if;
    elsif k not in ('before','after') and not (k = 'pickupAt' and p->k = 'null'::jsonb) then
      if pg_catalog.jsonb_typeof(p->k) is distinct from 'string' or p->>k = '' then raise exception 'MATERIAL: % must be string', k; end if;
    end if;
    result := result || pg_catalog.jsonb_build_object(k, p->k);
  end loop;
  if p_type in ('order_bundle','price_edit') and p->>'currency' <> 'USD' then raise exception 'MATERIAL: currency'; end if;
  if p_type in ('order_bundle','booking_bundle') and (p->>'messageChannel' not in ('surge','android_gateway','whatsapp_sandbox','qr_only')
    or (p->>'messageRecipient' is null and p->>'messageChannel' <> 'qr_only')
    or p->>'messageRecipient' !~ '^\+[1-9][0-9]{6,14}$') then raise exception 'MATERIAL: message routing'; end if;
  return result;
end $$;

-- Bind stored source rows at creation and before claims. Status checks are separate.
create function private.check_subject(a public.approval_requests) returns void language plpgsql set search_path = '' as $$
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
      or f.version is distinct from (p->>'fromVersion')::integer or f.value is distinct from p->'before'
    then raise exception 'SUBJECT: fact material mismatch'; end if;
  elsif a.bundle_type = 'price_edit' then
    select * into c from public.catalog_items where id=a.subject_id and business_id=a.business_id;
    if not found or c.square_item_id is distinct from p->>'squareItemId' or c.square_variation_id is distinct from p->>'variationId'
      or c.price_minor is distinct from (p->>'fromPriceMinor')::integer or c.currency is distinct from p->>'currency'
      or c.square_variation_version is distinct from (p->>'squareVersion')::bigint
    then raise exception 'SUBJECT: price material mismatch'; end if;
  else raise exception 'MATERIAL: invalid bundle'; end if;
end $$;

create function private.create_approval(p_business text, p_type text, p_subject text, p_actor_type text,
  p_actor text, p_payload jsonb, p_canonical text, p_hash text, p_actions text[], p_expires timestamptz)
returns public.approval_requests language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; m jsonb;
begin
  m := private.material(p_type, p_payload);
  if p_canonical::jsonb is distinct from m or m->>'businessId' is distinct from p_business
    or m->>'subjectId' is distinct from p_subject or m->'actionBundle' is distinct from pg_catalog.to_jsonb(p_actions)
    or (m->>'expiresAt')::timestamptz is distinct from p_expires
    or p_hash is distinct from 'sha256:' || pg_catalog.encode(extensions.digest(p_canonical,'sha256'),'hex')
  then raise exception 'MATERIAL: canonical, hash or row binding mismatch'; end if;
  a.business_id:=p_business; a.bundle_type:=p_type; a.subject_id:=p_subject; a.payload_canonical:=p_canonical;
  a.payload:=p_payload; a.payload_hash:=p_hash; a.action_bundle:=p_actions; a.expires_at:=p_expires;
  perform private.check_subject(a);
  if p_type = 'order_bundle' and not exists(select 1 from public.orders where id=p_subject and business_id=p_business and status='AWAITING_OWNER_APPROVAL')
    or p_type = 'booking_bundle' and not exists(select 1 from public.bookings where id=p_subject and business_id=p_business and status='AWAITING_OWNER_APPROVAL')
  then raise exception 'SUBJECT: requires AWAITING_OWNER_APPROVAL'; end if;
  if p_expires is null or p_expires <= pg_catalog.clock_timestamp() then raise exception 'EXPIRED: proposal'; end if;
  -- SPEC 2.9: an approval lives 10 minutes. One extra minute absorbs server and database clock skew.
  if p_expires > pg_catalog.clock_timestamp() + interval '11 minutes' then raise exception 'EXPIRED: proposal window exceeds 10 minutes'; end if;
  insert into public.approval_requests(business_id,bundle_type,subject_id,actor_type,actor_id,payload,payload_canonical,payload_hash,action_bundle,expires_at)
    values(p_business,p_type,p_subject,p_actor_type,p_actor,p_payload,p_canonical,p_hash,p_actions,p_expires) returning * into a;
  return a;
end $$;

create function private.decide_and_enqueue(p_business text,p_id text,p_owner text,p_hash text,p_decision text,p_reason text default null)
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
        values(p_business,case a.bundle_type when 'order_bundle' then 'order.status_changed' else 'booking.status_changed' end,'system',a.id,
          pg_catalog.jsonb_build_object('subjectId',a.subject_id,'from','AWAITING_OWNER_APPROVAL','to',
            case when a.bundle_type='booking_bundle' and p_decision='APPROVED' then 'RECHECKING_SLOT' else p_decision end));
    end if;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'approval.decided','owner',a.id,pg_catalog.jsonb_build_object('approvalId',a.id,'subjectId',a.subject_id,'decision',p_decision,'decidedBy',p_owner));
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
        values(p_business,case a.bundle_type when 'order_bundle' then 'order.status_changed' else 'booking.status_changed' end,'system',a.id,
          pg_catalog.jsonb_build_object('subjectId',a.subject_id,'from','AWAITING_OWNER_APPROVAL','to',
            case a.bundle_type when 'order_bundle' then 'APPROVED' else 'RECHECKING_SLOT' end));
    end if;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      select p_business,'approval.decided','owner',a.id,pg_catalog.jsonb_build_object('approvalId',a.id,'subjectId',a.subject_id,'decision',p_decision,'decidedBy',p_owner)
      where not exists(select 1 from public.activity_events where business_id=p_business and type='approval.decided' and correlation_id=a.id);
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

create function private.claim_execution(p_business text,p_id text,p_worker text)
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
  return query update public.action_executions set status='RUNNING',attempts=attempts+1,locked_by=p_worker,
    locked_at=pg_catalog.clock_timestamp(),started_at=coalesce(started_at,pg_catalog.clock_timestamp()) where id=p_id returning *;
end $$;

create function private.claim_next_execution(p_business text,p_worker text)
returns setof public.action_executions language plpgsql security definer set search_path = '' as $$
declare candidate record; x public.action_executions;
begin
  for candidate in select id from public.action_executions where business_id=p_business and status='QUEUED'
    and attempts<3 and next_attempt_at<=pg_catalog.clock_timestamp() order by next_attempt_at,created_at,id
  loop
    begin
      select * into x from private.claim_execution(p_business,candidate.id,p_worker);
    exception when raise_exception then
      -- A step whose subject no longer matches its approval stays QUEUED for review; a direct
      -- claim still reports it. It must not block every later step in the business.
      if sqlerrm like 'SUBJECT:%' or sqlerrm like 'MATERIAL:%' then continue; end if;
      raise;
    end;
    if found then return next x; return; end if;
  end loop;
end $$;

create function private.finish_execution(p_business text,p_id text,p_worker text,p_attempt integer,p_status text,
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
    locked_by=null,locked_at=null,finished_at=case when p_status='QUEUED' then null else pg_catalog.clock_timestamp() end
    where id=x.id returning * into x;
  return x;
end $$;

create function private.record_dispatch(p_business text,p_execution text,p_worker text,p_attempt integer,p_body_hash text)
returns public.message_dispatches language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; x public.action_executions; d public.message_dispatches;
begin
  select r.* into a from public.approval_requests r join public.action_executions e on e.approval_id=r.id
    where e.id=p_execution and e.business_id=p_business and r.business_id=p_business for update of r;
  if not found then raise exception 'SCOPE: message execution not found'; end if;
  select * into x from public.action_executions where id=p_execution for update;
  if x.status<>'RUNNING' or x.action_type not like 'message.%' or x.locked_by is distinct from p_worker
    or p_worker is null or x.attempts is distinct from p_attempt then raise exception 'LEASE: running message required'; end if;
  perform private.check_subject(a);
  if not public.execution_claim_allowed(x.approval_id,p_business,x.step_index,x.action_type) then raise exception 'PREDECESSOR: message blocked'; end if;
  select * into d from public.message_dispatches where execution_id=x.id;
  if found then
    if d.body_hash is distinct from p_body_hash then raise exception 'IDENTITY: dispatch body changed'; end if;
    return d;
  end if;
  insert into public.message_dispatches(business_id,approval_id,execution_id,order_id,booking_id,channel,recipient,template,body_hash,idempotency_key)
    values(p_business,a.id,x.id,case when a.bundle_type='order_bundle' then a.subject_id end,
      case when a.bundle_type='booking_bundle' then a.subject_id end,a.payload_canonical::jsonb->>'messageChannel',
      a.payload_canonical::jsonb->>'messageRecipient',case when a.bundle_type='order_bundle' then 'checkout_link' else 'booking_confirmed' end,
      p_body_hash,x.idempotency_key) returning * into d;
  return d;
end $$;

create function private.update_dispatch(p_business text,p_id text,p_worker text,p_attempt integer,p_status text,p_provider_id text default null,p_error text default null)
returns public.message_dispatches language plpgsql security definer set search_path = '' as $$
declare x public.action_executions; d public.message_dispatches;
begin
  perform 1 from public.approval_requests a join public.message_dispatches m on m.approval_id=a.id
    where m.id=p_id and m.business_id=p_business and a.business_id=p_business for update of a;
  select e.* into x from public.action_executions e join public.message_dispatches m on m.execution_id=e.id
    where m.id=p_id and m.business_id=p_business for update of e;
  if not found then raise exception 'SCOPE: dispatch not found'; end if;
  if x.status<>'RUNNING' or x.locked_by is distinct from p_worker or p_worker is null or x.attempts is distinct from p_attempt then
    raise exception 'LEASE: running message required'; end if;
  select * into d from public.message_dispatches where id=p_id for update;
  if p_status is null or p_status not in ('SENT','DELIVERED','FAILED','UNKNOWN')
    or d.status in ('DELIVERED','FAILED','UNKNOWN') or (d.status='SENT' and p_status<>'DELIVERED') then raise exception 'TRANSITION: dispatch result'; end if;
  if d.provider_message_id is not null and d.provider_message_id is distinct from p_provider_id then raise exception 'IDENTITY: provider message changed'; end if;
  update public.message_dispatches set status=p_status,provider_message_id=p_provider_id,error_code=p_error,
    attempts=least(x.attempts,3),sent_at=case when p_status in ('SENT','DELIVERED') then coalesce(sent_at,pg_catalog.clock_timestamp()) else sent_at end,
    delivered_at=case when p_status='DELIVERED' then pg_catalog.clock_timestamp() else delivered_at end where id=p_id returning * into d;
  return d;
end $$;

create function private.sync_approval(p_business text,p_type text,p_subject text)
returns public.approval_requests language plpgsql set search_path = '' as $$
declare a public.approval_requests; aid text; action text;
begin
  if p_type='order' then
    select approval_id into aid from public.orders where id=p_subject and business_id=p_business and status in ('PAID_VERIFIED','FULFILLMENT_READY');
    action:='sheets.order.append';
  elsif p_type='booking' then
    select approval_id into aid from public.bookings where id=p_subject and business_id=p_business and status='BOOKED_VERIFIED';
    action:='sheets.booking.append';
  else raise exception 'SUBJECT: sync type'; end if;
  select * into a from public.approval_requests where id=aid and business_id=p_business and subject_id=p_subject
    and state='APPROVED' and decided_at<expires_at and action=any(action_bundle)
    and bundle_type=case p_type when 'order' then 'order_bundle' else 'booking_bundle' end;
  if not found then raise exception 'SYNC: verified subject and approved Sheets action required'; end if;
  perform private.check_subject(a);
  return a;
end $$;

create function private.enqueue_sheets_sync(p_business text,p_type text,p_subject text)
returns public.sync_jobs language plpgsql security definer set search_path = '' as $$
declare a public.approval_requests; j public.sync_jobs; action text;
begin
  a:=private.sync_approval(p_business,p_type,p_subject);
  perform 1 from public.approval_requests where id=a.id for update;
  a:=private.sync_approval(p_business,p_type,p_subject);
  action:=case p_type when 'order' then 'sheets.order.append' else 'sheets.booking.append' end;
  insert into public.sync_jobs(business_id,target,record_type,record_id,approval_id,idempotency_key)
    values(p_business,'google_sheets',p_type,p_subject,a.id,
      pg_catalog.encode(extensions.digest(p_business||':'||p_subject||':'||action||':'||a.id,'sha256'),'hex'))
    on conflict(target,record_type,record_id) do nothing;
  select * into j from public.sync_jobs where target='google_sheets' and record_type=p_type and record_id=p_subject;
  if j.business_id is distinct from p_business or j.approval_id is distinct from a.id then raise exception 'IDENTITY: existing sync mismatch'; end if;
  return j;
end $$;

create function private.claim_sync_job(p_business text,p_id text,p_worker text)
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
  return query update public.sync_jobs set state='RUNNING',attempts=attempts+1,locked_by=p_worker,locked_at=pg_catalog.clock_timestamp()
    where id=p_id returning *;
end $$;

create function private.finish_sync_job(p_business text,p_id text,p_worker text,p_attempt integer,p_state text,
  p_external_ref text default null,p_error text default null,p_retry_at timestamptz default null)
returns public.sync_jobs language plpgsql security definer set search_path = '' as $$
declare j public.sync_jobs;
begin
  select * into j from public.sync_jobs where id=p_id and business_id=p_business for update;
  if not found then raise exception 'SCOPE: sync not found'; end if;
  if j.state<>'RUNNING' or j.locked_by is distinct from p_worker or p_worker is null or j.attempts is distinct from p_attempt then raise exception 'LEASE: running sync required'; end if;
  if p_state is null or p_state not in ('DONE','RETRYING','FAILED') then raise exception 'TRANSITION: sync result'; end if;
  if p_state='RETRYING' and (j.attempts>=5 or p_retry_at is null) then raise exception 'RETRY: sync attempt limit'; end if;
  if p_state='DONE' and nullif(p_external_ref,'') is null then raise exception 'RESULT: Sheets reference required'; end if;
  update public.sync_jobs set state=p_state,external_ref=p_external_ref,last_error=p_error,locked_by=null,locked_at=null,
    next_retry_at=case when p_state='RETRYING' then p_retry_at else next_retry_at end where id=p_id returning * into j;
  return j;
end $$;

create function private.expire_approvals(p_business text)
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
        values(p_business,case a.bundle_type when 'order_bundle' then 'order.status_changed' else 'booking.status_changed' end,'system',a.id,
          pg_catalog.jsonb_build_object('subjectId',a.subject_id,'from','AWAITING_OWNER_APPROVAL','to',
            case a.bundle_type when 'order_bundle' then 'APPROVAL_EXPIRED' else 'EXPIRED' end));
    end if;
    insert into public.activity_events(business_id,type,actor_type,correlation_id,payload)
      values(p_business,'approval.expired','system',a.id,pg_catalog.jsonb_build_object('approvalId',a.id,'subjectId',a.subject_id));
    id:=a.id; business_id:=a.business_id; bundle_type:=a.bundle_type; subject_id:=a.subject_id; subject_moved:=moved; return next;
  end loop;
end $$;

-- Only these entry points are callable; internal helpers and triggers remain private.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature,p.proname from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname<>'owns_business'
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role, abos_app',f.signature);
    if f.proname in ('create_approval','decide_and_enqueue','claim_execution','claim_next_execution','finish_execution',
      'record_dispatch','update_dispatch','enqueue_sheets_sync','claim_sync_job','finish_sync_job','expire_approvals') then
      execute pg_catalog.format('grant execute on function %s to abos_app, service_role',f.signature);
    end if;
  end loop;
end $$;

-- Fail closed if abos_app could create objects where they would be reachable or run with its rights.
do $$ declare s text; begin
  foreach s in array array['public','private','extensions','graphql_public'] loop
    if pg_catalog.to_regnamespace(s) is not null and pg_catalog.has_schema_privilege('abos_app', s, 'CREATE') then
      raise exception 'ROLE: abos_app can create objects in schema %; revoke that CREATE before this migration', s;
    end if;
  end loop;
end $$;

-- Security advisor: Supabase's SECURITY DEFINER public.rls_auto_enable() must not be callable
-- through the API. Absent in plain Postgres, so this loop does nothing there.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  loop
    execute pg_catalog.format('revoke execute on function %s from public, anon, authenticated', f.signature);
  end loop;
end $$;

create or replace function public.approval_requests_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'approvals cannot be deleted'; end if;
  if tg_op = 'INSERT' then
    if new.state <> 'PENDING' or new.decided_by is not null or new.decided_at is not null or new.decision_reason is not null then
      raise exception 'approval % must be created PENDING with no decision', new.id;
    end if;
    return new;
  end if;
  if old.state <> 'PENDING' then
    raise exception 'approval % is already %, it cannot change', old.id, old.state;
  end if;
  if new.id            is distinct from old.id
  or new.business_id   is distinct from old.business_id
  or new.actor_type    is distinct from old.actor_type
  or new.actor_id      is distinct from old.actor_id
  or new.bundle_type   is distinct from old.bundle_type
  or new.action_bundle is distinct from old.action_bundle
  or new.subject_id    is distinct from old.subject_id
  or new.payload       is distinct from old.payload
  or new.payload_canonical is distinct from old.payload_canonical
  or new.payload_hash  is distinct from old.payload_hash
  or new.expires_at    is distinct from old.expires_at
  or new.created_at    is distinct from old.created_at then
    raise exception 'approval %: only state and decision columns can change', old.id;
  end if;
  if new.state in ('APPROVED', 'REJECTED') then
    if new.decided_by is distinct from (select b.owner_id from public.businesses b where b.id = new.business_id)
       or new.decided_at is null or new.decided_at >= new.expires_at or pg_catalog.clock_timestamp() >= new.expires_at then
      raise exception 'approval decision requires the business owner and an unexpired decision';
    end if;
  elsif new.state = 'EXPIRED' then
    if pg_catalog.clock_timestamp() < new.expires_at or new.decided_by is not null or new.decided_at is null then
      raise exception 'EXPIRED requires elapsed expiry, decided_at and no decided_by';
    end if;
  elsif new.state = 'PENDING' and (new.decided_at is not null or new.decided_by is not null or new.decision_reason is not null) then
    raise exception 'PENDING cannot carry a decision';
  end if;
  return new;
end $$;
