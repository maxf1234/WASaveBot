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
insert into rules (user_id, kind, prefix) values
  ('00000000-0000-0000-0000-00000000000a', 'block', '234'),
  ('00000000-0000-0000-0000-00000000000b', 'block', '91');
insert into save_events (user_id, phone, decision) values
  ('00000000-0000-0000-0000-00000000000a', '15550000001', 'saved'),
  ('00000000-0000-0000-0000-00000000000b', '15550000002', 'saved');

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

  -- Rules are the second thing the web app edits directly, so A gets full CRUD
  -- on their own and none at all on B's.
  assert (select count(*) from rules) = 1, 'A sees only own rules';
  assert (select prefix from rules) = '234', 'and it is A''s rule';
  insert into rules (user_id, kind, prefix) values ('00000000-0000-0000-0000-00000000000a', 'allow', '2348');
  assert (select count(*) from rules) = 2, 'A can add a rule';
  update rules set enabled = false where prefix = '2348';
  assert (select count(*) from rules where not enabled) = 1, 'A can edit a rule';
  delete from rules where prefix = '2348';
  assert (select count(*) from rules) = 1, 'A can delete a rule';

  -- A rule for somebody else must not be insertable even with their id spelled out.
  assert pg_temp.denied($q$insert into rules (user_id, kind, prefix)
    values ('00000000-0000-0000-0000-00000000000b','block','1')$q$), 'cannot add a rule for B';

  -- B's rows are invisible, so an update aimed at them matches nothing.
  update rules set enabled = false where user_id = '00000000-0000-0000-0000-00000000000b';
  select count(*) into n from rules where not enabled;
  assert n = 0, 'A cannot disable B''s rules';

  -- The activity log is readable and not editable: that is the point of keeping it.
  --
  -- Note the shape of these two assertions. Supabase grants table privileges to
  -- `authenticated` and relies on RLS to restrict them, which the shim mirrors,
  -- so a table with a SELECT policy and no UPDATE policy does not raise on an
  -- UPDATE — it simply matches no rows. "Changed nothing" is therefore the
  -- honest assertion, and "was denied" would pass for the wrong reason.
  assert (select count(*) from save_events) = 1, 'A sees only own events';
  update save_events set decision = 'failed';
  assert (select count(*) from save_events where decision = 'failed') = 0, 'events cannot be rewritten';
  delete from save_events;
  assert (select count(*) from save_events) = 1, 'events cannot be deleted';
  -- An INSERT with no policy does raise, because the new row is checked.
  assert pg_temp.denied($q$insert into save_events (user_id, phone, decision)
    values ('00000000-0000-0000-0000-00000000000a','1','saved')$q$), 'events cannot be forged';

  -- The admin view reads across every tenant, so a customer must not reach it.
  -- A view runs with its owner's rights by default, which would be a way
  -- straight past the policies above; the migration both revokes it and sets
  -- security_invoker, and this is the check that neither was lost.
  assert pg_temp.denied('select * from admin_overview'), 'admin_overview is unreadable by a customer';

  -- The dial plan is shared reference data, readable by anyone signed in.
  assert (select count(*) from dial_prefixes) > 200, 'the dial plan is readable';
  assert pg_temp.denied($q$insert into dial_prefixes values ('999','country','Nowhere','XX')$q$),
    'but not writable';

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
  -- wa_sessions and saved_contacts from 0001, save_events from 0002. Named
  -- rather than counted so adding a table to the publication by accident is
  -- still caught, but adding one on purpose does not need the number edited.
  assert (select array_agg(tablename::text order by tablename::text)
            from pg_publication_tables where pubname = 'supabase_realtime')
         = array['save_events', 'saved_contacts', 'wa_sessions'], 'the three Realtime tables';
end $$;

-- The worker's role is the one that may read it, and it sees every customer.
set role service_role;
do $$ begin
  assert (select count(*) from admin_overview) = 2, 'the worker sees both customers';
  assert (select saved_count from admin_overview
           where user_id = '00000000-0000-0000-0000-00000000000a') = 1,
    'and the per-customer counts are aggregated';
end $$;
reset role;

-- Deleting the auth user takes everything with it.
delete from auth.users where id = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from profiles) = 1 and (select count(*) from wa_auth) = 1
     and (select count(*) from saved_contacts) = 1 and (select count(*) from settings) = 1, 'cascade';
end $$;
\echo RLS OK
