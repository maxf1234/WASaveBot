-- Just enough of Supabase to run the migration on a plain Postgres:
-- the three API roles, auth.users, auth.uid() and the Realtime publication.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
create publication supabase_realtime;
-- Supabase grants table privileges on public to all three roles by default
-- and relies on RLS to restrict them; mirror that so the test is honest.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
