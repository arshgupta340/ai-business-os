-- TEST ONLY. Never apply this to Supabase and never move it into migrations/.
-- Supabase creates these objects itself. Plain Postgres (PGlite in the tests) does not have them,
-- so the tests create stand-ins before running the real migrations.

-- Roles that Supabase creates. service_role bypasses row level security, as on Supabase.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- The auth schema with the two objects the migrations use: auth.users and auth.uid().
create schema auth;
create table auth.users (
  id    uuid primary key,
  email text
);

-- Supabase reads the JWT "sub" claim from the request settings. Tests set request.jwt.claim.sub.
create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase grants these roles full table privileges in public by default; RLS and the
-- revokes in 0005 then narrow them. Mirror that so the RLS test starts from the same place.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Supabase creates this publication for Realtime. 0006 adds activity_events to it.
create publication supabase_realtime;
