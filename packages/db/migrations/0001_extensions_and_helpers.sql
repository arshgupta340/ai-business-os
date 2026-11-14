-- 0001: extensions and helper functions.
-- Source: docs/DATA-MODEL.md section 1.

-- Supabase already has the "extensions" schema. Plain Postgres does not, so create it when missing.
create schema if not exists extensions;

-- btree_gist lets the bookings_no_overlap exclusion constraint compare text columns with "=".
create extension if not exists btree_gist with schema extensions;

-- Primary keys are text with a type prefix (SPEC 2.1), for example gen_id('ord_').
create or replace function public.gen_id(prefix text) returns text
language sql volatile as $$ select prefix || replace(gen_random_uuid()::text, '-', '') $$;

-- Attached as a "before update" trigger to every table with an updated_at column (0004).
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
