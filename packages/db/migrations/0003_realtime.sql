-- 0005: Supabase Realtime.
-- Source: docs/DATA-MODEL.md section 4.
-- The dashboard subscribes to activity_events with the owner's JWT. Realtime applies
-- activity_events_owner_read to each subscriber, so an owner receives only their own events (P-16).
-- Supabase creates the supabase_realtime publication. If it is missing this fails on purpose.
-- The membership check makes the statement safe to paste into the SQL editor twice.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_events'
  ) then
    alter publication supabase_realtime add table public.activity_events;
  end if;
end $$;
