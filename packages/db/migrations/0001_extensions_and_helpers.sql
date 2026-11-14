-- 0001: extensions, the private schema, default privileges and helper functions.
-- Source: docs/DATA-MODEL.md sections 1 and 4.
-- Runs before any table exists, so no later table is ever created with open default grants.

-- Supabase already has the "extensions" schema. Plain Postgres does not, so create it when missing.
create schema if not exists extensions;

-- btree_gist lets the bookings_no_overlap exclusion constraint compare text columns with "=".
create extension if not exists btree_gist with schema extensions;

-- Functions that must not be reachable through the Supabase Data API live here.
-- Supabase exposes only the schemas listed in its API settings; "private" is not one of them.
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon;

-- Supabase grants anon and authenticated full privileges on every new table in public.
-- Remove those defaults for tables this role creates, so a table is never exposed before its
-- row level security is in place. 0002 grants back only the reads it means to allow.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- New functions are not executable by PUBLIC or anon unless a migration grants it.
-- The PUBLIC default is global in Postgres, so it can only be removed globally.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

-- Primary keys are text with a type prefix (SPEC 2.1), for example gen_id('ord_').
create or replace function public.gen_id(prefix text) returns text
language sql volatile set search_path = '' as $$
  select prefix || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
$$;
-- Column defaults call gen_id as the inserting role. Only the server's service role inserts.
revoke execute on function public.gen_id(text) from public, anon;
grant execute on function public.gen_id(text) to service_role;

-- Attached as a "before update" trigger to every table with an updated_at column (0004).
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at = pg_catalog.now(); return new; end $$;
revoke execute on function public.set_updated_at() from public, anon;
