-- The dedupe claim, against the real schema and a real Postgres.
--
-- worker/src/store.ts claims a number with
-- `upsert(..., { ignoreDuplicates: true }).select('phone')`, which supabase-js
-- sends as `Prefer: resolution=ignore-duplicates` and PostgREST compiles to
-- `insert ... on conflict do nothing returning ...`. Everything in
-- claimContact rests on one property of that statement: a row that conflicts
-- comes back as nothing, so "did I get a row?" is the same question as "did I
-- win the claim?".
--
-- Every worker test uses an in-memory fake, so without this the property is
-- only assumed. It is the authority that stops two simultaneous messages
-- creating two contacts for one person.

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'claim@example.com');

do $$
declare
  u uuid := '00000000-0000-0000-0000-0000000000c1';
  got text;
  n int;
begin
  -- A free number: the insert happens and the row comes back.
  insert into saved_contacts (user_id, phone, saved_name, status)
    values (u, '15550001111', 'First', 'saved')
    on conflict (user_id, phone) do nothing
    returning phone into got;
  assert got = '15550001111', 'a free claim returns its row';

  -- The same number again: nothing is written and nothing comes back. This is
  -- the whole mechanism — the loser of a race learns it lost from the absence
  -- of a returned row, inside the statement that would have written it.
  got := null;
  insert into saved_contacts (user_id, phone, saved_name, status)
    values (u, '15550001111', 'Second', 'saved')
    on conflict (user_id, phone) do nothing
    returning phone into got;
  assert got is null, 'a conflicting claim returns no row';

  select count(*) into n from saved_contacts where user_id = u;
  assert n = 1, 'and wrote nothing';
  assert (select saved_name from saved_contacts where user_id = u) = 'First',
    'the first writer keeps the row';

  -- Another account may hold the same number: the index is per user.
  insert into auth.users (id, email) values
    ('00000000-0000-0000-0000-0000000000c2', 'claim2@example.com');
  insert into saved_contacts (user_id, phone, saved_name, status)
    values ('00000000-0000-0000-0000-0000000000c2', '15550001111', 'Theirs', 'saved')
    on conflict (user_id, phone) do nothing
    returning phone into got;
  assert got = '15550001111', 'the claim is per user, not global';

  -- The revive path: a removed row is not a live claim, and the conditional
  -- update is what lets a fresh request take it over without a second row.
  update saved_contacts set status = 'removed' where user_id = u;
  insert into saved_contacts (user_id, phone, saved_name, status)
    values (u, '15550001111', 'Returned', 'pending')
    on conflict (user_id, phone) do update
      set saved_name = excluded.saved_name, status = excluded.status
    where saved_contacts.status = 'removed'
    returning phone into got;
  assert got = '15550001111', 'a removed row can be revived';
  assert (select status from saved_contacts where user_id = u) = 'pending', 'and is now pending';

  select count(*) into n from saved_contacts where user_id = u;
  assert n = 1, 'on the same row, not a second one';

  -- And once it is live again, the guard refuses the next taker.
  got := null;
  insert into saved_contacts (user_id, phone, saved_name, status)
    values (u, '15550001111', 'Nope', 'pending')
    on conflict (user_id, phone) do update
      set saved_name = excluded.saved_name, status = excluded.status
    where saved_contacts.status = 'removed'
    returning phone into got;
  assert got is null, 'a live row is not revivable';
  assert (select saved_name from saved_contacts where user_id = u) = 'Returned', 'and is untouched';
end $$;

-- Leave the database as the other tests expect to find it.
delete from auth.users where id in (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000c2');

\echo CLAIM OK
