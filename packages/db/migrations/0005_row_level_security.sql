-- 0005: row level security.
-- Source: docs/DATA-MODEL.md section 4.
-- The server uses the service role, which bypasses RLS. RLS is the second wall: with an owner JWT
-- an owner sees only their own businesses (AC-17), and anon and authenticated can write nothing.
-- This file must run after every table exists, because the revokes below apply to existing tables only.

-- True when the signed-in Supabase user owns business b.
create or replace function public.owns_business(b text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.businesses biz join public.users u on u.id = biz.owner_id
    where biz.id = b and u.auth_user_id = (select auth.uid()));
$$;

alter table public.users enable row level security;
create policy users_self_read on public.users
  for select to authenticated using (auth_user_id = (select auth.uid()));

alter table public.businesses enable row level security;
create policy businesses_owner_read on public.businesses
  for select to authenticated using (public.owns_business(id));

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
    execute format('create policy %I on public.%I for select to authenticated using (public.owns_business(business_id))',
                   t || '_owner_read', t);
  end loop;
end $$;

-- No policy at all: service role only.
alter table public.webhook_events enable row level security;

-- No table has an insert, update or delete policy. The revokes make that a privilege rule as well.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
