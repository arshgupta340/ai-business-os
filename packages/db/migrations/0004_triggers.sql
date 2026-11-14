-- 0004: triggers.
-- Source: docs/DATA-MODEL.md sections 1, 2.10, 2.14, 2.17 and 2.21, and CONTRACTS.md sections 4 and 6.
-- Every function pins search_path to '' and is not executable by PUBLIC or anon.

-- updated_at: a "before update" trigger on every table in public that has an updated_at column.
do $$
declare t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'updated_at' and tb.table_type = 'BASE TABLE'
    order by c.table_name
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t);
  end loop;
end $$;

-- Published agent versions are immutable for every role, the service role included.
-- The publish transaction sets published_at once; every later update or delete of that row fails.
-- The demo reset removes versions with TRUNCATE, which fires no row trigger, and then reseeds.
create or replace function public.agent_versions_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.published_at is not null then
    raise exception 'agent version % is published and immutable', old.id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function public.agent_versions_immutable() from public, anon;
create trigger agent_versions_immutable before update or delete on public.agent_versions
  for each row execute function public.agent_versions_immutable();

-- Append-only audit: activity_events rejects every UPDATE and DELETE, including from the service role.
-- TRUNCATE fires no row trigger, so the reset script still works.
create or replace function public.activity_events_append_only() returns trigger
language plpgsql set search_path = '' as $$ begin raise exception 'activity_events is append only'; end $$;
revoke execute on function public.activity_events_append_only() from public, anon;
create trigger activity_events_append_only before update or delete on public.activity_events
  for each row execute function public.activity_events_append_only();

-- One-use approvals, bound to the exact payload the owner saw.
-- An approval is always born PENDING; the only way to APPROVED is the guarded decision update.
-- Out of PENDING, only state, decided_by, decided_at and decision_reason may change, once.
-- A decided approval (APPROVED, REJECTED or EXPIRED) never changes again.
create or replace function public.approval_requests_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
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
  or new.payload_hash  is distinct from old.payload_hash
  or new.expires_at    is distinct from old.expires_at
  or new.created_at    is distinct from old.created_at then
    raise exception 'approval %: only state and decision columns can change', old.id;
  end if;
  return new;
end $$;
revoke execute on function public.approval_requests_guard() from public, anon;
create trigger approval_requests_guard before insert or update on public.approval_requests
  for each row execute function public.approval_requests_guard();

-- Never-broken rule 1: an execution exists only for an APPROVED bundle, in the same business,
-- and each row is exactly the step its approval lists at that position. The Sheets steps are
-- left out: they never get an execution row (SPEC 2.9). After insert, the identity of the row
-- and its idempotency key (never-broken rule 3) cannot change.
create or replace function public.action_executions_match_approval() returns trigger
language plpgsql set search_path = '' as $$
declare
  apv   record;
  steps text[];
begin
  if tg_op = 'UPDATE' then
    if new.id              is distinct from old.id
    or new.approval_id     is distinct from old.approval_id
    or new.business_id     is distinct from old.business_id
    or new.step_index      is distinct from old.step_index
    or new.action_type     is distinct from old.action_type
    or new.idempotency_key is distinct from old.idempotency_key then
      raise exception 'action execution %: approval, business, step, action type and idempotency key cannot change', old.id;
    end if;
    return new;
  end if;

  select r.business_id, r.state, r.action_bundle into apv
  from public.approval_requests r where r.id = new.approval_id;
  if not found then
    raise exception 'action execution %: approval % does not exist', new.id, new.approval_id;
  end if;
  if apv.business_id <> new.business_id then
    raise exception 'action execution %: business % does not match the approval''s business', new.id, new.business_id;
  end if;
  if apv.state <> 'APPROVED' then
    raise exception 'action execution %: approval % is %, not APPROVED', new.id, new.approval_id, apv.state;
  end if;
  select coalesce(array_agg(t.step order by t.n), '{}') into steps
  from unnest(apv.action_bundle) with ordinality as t(step, n)
  where t.step not like 'sheets.%';
  if new.step_index >= coalesce(array_length(steps, 1), 0) or steps[new.step_index + 1] <> new.action_type then
    raise exception 'action execution %: step % of approval % is not %', new.id, new.step_index, new.approval_id, new.action_type;
  end if;
  return new;
end $$;
revoke execute on function public.action_executions_match_approval() from public, anon;
create trigger action_executions_match_approval before insert or update on public.action_executions
  for each row execute function public.action_executions_match_approval();
