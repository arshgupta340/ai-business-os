-- TEST ONLY. Run by the test superuser after supabase-prelude.sql.
-- On Supabase the migrations run as "postgres", which is NOT a superuser: it has CREATEROLE,
-- CREATEDB, REPLICATION and BYPASSRLS, owns the public schema, and finds pgcrypto and btree_gist
-- already installed in an "extensions" schema it owns. This role stands in for it, so every migration is applied
-- without superuser powers and a statement that needs a superuser fails here as it would there.
create role supabase_postgres nologin noinherit nosuperuser createrole createdb replication bypassrls;
create schema extensions;
create extension btree_gist with schema extensions;
create extension pgcrypto with schema extensions;
alter schema extensions owner to supabase_postgres;
alter schema public owner to supabase_postgres;
grant usage on schema auth to supabase_postgres;
grant select, references on auth.users to supabase_postgres;
alter publication supabase_realtime owner to supabase_postgres;
-- Supabase's own default grants for objects that postgres creates in public.
alter default privileges for role supabase_postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role supabase_postgres in schema public grant all on functions to anon, authenticated, service_role;
do $$ begin execute format('grant create on database %I to supabase_postgres', current_database()); end $$;
