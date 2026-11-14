-- 0004: triggers.
-- Source: docs/DATA-MODEL.md sections 1, 2.10 and 2.21.

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

-- Published agent versions are immutable. The publish transaction sets published_at once;
-- every later update or delete of that row fails. Only the reset script, which sets
-- app.allow_reset = 'on' in its own transaction, can remove published versions.
create or replace function public.agent_versions_immutable() returns trigger
language plpgsql as $$
begin
  if old.published_at is not null and coalesce(current_setting('app.allow_reset', true), '') <> 'on' then
    raise exception 'agent version % is published and immutable', old.id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger agent_versions_immutable before update or delete on public.agent_versions
  for each row execute function public.agent_versions_immutable();

-- Append-only audit: activity_events rejects every UPDATE and DELETE, including from the service role.
-- TRUNCATE fires no row trigger, so the reset script still works.
create or replace function public.activity_events_append_only() returns trigger
language plpgsql as $$ begin raise exception 'activity_events is append only'; end $$;
create trigger activity_events_append_only before update or delete on public.activity_events
  for each row execute function public.activity_events_append_only();
