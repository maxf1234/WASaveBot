-- Two users; neither may see or change the other's rows.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');

-- The trigger made the three rows for each user.
do $$ begin
  assert (select count(*) from profiles) = 2, 'profiles rows';
  assert (select count(*) from settings) = 2, 'settings rows';
  assert (select count(*) from wa_sessions) = 2, 'wa_sessions rows';
end $$;

insert into saved_contacts (user_id, phone, status) values
  ('00000000-0000-0000-0000-00000000000a', '15550000001', 'saved'),
  ('00000000-0000-0000-0000-00000000000b', '15550000002', 'saved');
insert into wa_auth (user_id, key, value) values
  ('00000000-0000-0000-0000-00000000000a', 'creds', '{}'),
  ('00000000-0000-0000-0000-00000000000b', 'creds', '{}');

create function pg_temp.denied(sql text) returns boolean language plpgsql as $$
begin
  execute sql;
  return false;
exception when insufficient_privilege then
  return true;
end $$;

-- Act as user A.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

do $$
declare n int;
begin
  assert (select count(*) from profiles) = 1, 'A sees only own profile';
  assert (select count(*) from settings) = 1, 'A sees only own settings';
  assert (select count(*) from wa_sessions) = 1, 'A sees only own session';
  assert (select count(*) from saved_contacts) = 1, 'A sees only own contacts';
  assert (select phone from saved_contacts) = '15550000001', 'and it is A''s row';
  assert (select count(*) from profiles where id = '00000000-0000-0000-0000-00000000000b') = 0, 'A cannot read B';

  assert pg_temp.denied('select * from wa_auth'), 'wa_auth is unreadable';
  assert pg_temp.denied($q$insert into wa_auth values ('00000000-0000-0000-0000-00000000000a','x','{}')$q$), 'wa_auth is unwritable';

  -- Settings: own row updates, B's does not.
  update settings set daily_cap = 50;
  get diagnostics n = row_count;
  assert n = 1, 'A updates exactly one settings row';
  update settings set enabled = false where user_id = '00000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count;
  assert n = 0, 'A cannot update B settings';

  -- Read-only tables: writes change nothing.
  update profiles set subscription_status = 'active';
  get diagnostics n = row_count;
  assert n = 0, 'A cannot make themselves a subscriber';
  update wa_sessions set status = 'connected';
  get diagnostics n = row_count;
  assert n = 0, 'A cannot write wa_sessions';
  delete from saved_contacts;
  get diagnostics n = row_count;
  assert n = 0, 'A cannot delete contacts';
  assert pg_temp.denied($q$insert into saved_contacts (user_id, phone, status) values ('00000000-0000-0000-0000-00000000000a','1','saved')$q$), 'A cannot insert contacts';
  assert pg_temp.denied($q$insert into settings (user_id) values ('00000000-0000-0000-0000-00000000000b')$q$), 'A cannot insert settings';
end $$;

-- Logged out (anon) sees nothing at all.
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
do $$ begin
  assert (select count(*) from profiles) = 0, 'anon sees no profiles';
  assert (select count(*) from saved_contacts) = 0, 'anon sees no contacts';
end $$;

reset role;
do $$ begin
  assert (select daily_cap from settings where user_id = '00000000-0000-0000-0000-00000000000b') = 200, 'B settings untouched';
  assert (select subscription_status from profiles where id = '00000000-0000-0000-0000-00000000000a') = 'none', 'A still unsubscribed';
  assert (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 2, 'both tables in Realtime';
end $$;

-- Deleting the auth user takes everything with it.
delete from auth.users where id = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from profiles) = 1 and (select count(*) from wa_auth) = 1
     and (select count(*) from saved_contacts) = 1 and (select count(*) from settings) = 1, 'cascade';
end $$;
\echo RLS OK
