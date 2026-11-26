-- 0002_rules_events_modes.sql
--
-- Three things contact-saver had and this did not:
--
--   1. A reason recorded for every decision, including the ones where nothing
--      happened. Until now a person skipped because the daily cap was reached,
--      or because the subscription had lapsed, or because saving was switched
--      off, left no trace at all — so "my friend messaged me and never got
--      saved" was unanswerable. save_events answers it.
--
--   2. Prefix rules, so a customer can refuse to save numbers from country or
--      area codes they never want in their address book. One mechanism covers
--      both, because a NANP number is 1 + area code + 7 digits, which makes an
--      area code just a longer country prefix.
--
--   3. A watch-only first run. This product saves *everyone* who messages, into
--      the customer's real address book, which syncs to their phone. Getting
--      that wrong is a hundred rows to delete by hand. New accounts now record
--      what they would have saved until the customer arms them.
--
-- And one thing neither had: an opt-out. Somebody saved without ever asking to
-- be can now say so, and the contact is removed.

-- ---------------------------------------------------------------- settings

alter table settings
  -- 'everyone' is the behaviour every existing customer has: save each new
  -- person who messages privately. 'phrase' saves only people who open with
  -- save_phrase, which is the cleanest consent story and the one to offer a
  -- customer whose number is public.
  add column save_mode text not null default 'everyone'
    check (save_mode in ('everyone', 'phrase')),
  add column save_phrase text not null default 'save my number'
    check (length(btrim(save_phrase)) between 3 and 64),
  add column remove_phrase text not null default 'remove my number'
    check (length(btrim(remove_phrase)) between 3 and 64),
  -- What happens to a number no rule matched. 'allow' is a blocklist: rules
  -- name who to refuse. 'block' turns the allow rules into an allowlist, which
  -- is the only way to say "only these countries" — a blocklist naming every
  -- country is wrong the moment a prefix nobody thought of arrives.
  add column default_policy text not null default 'allow'
    check (default_policy in ('allow', 'block')),
  -- The safety catch. Note the column default is false but the backfill below
  -- sets every existing row true: a live customer must not silently stop
  -- saving because of a migration, and a new one must not silently start.
  add column armed boolean not null default false,
  add column armed_at timestamptz;

-- Existing customers are already saving, with `enabled` as their only switch.
-- Arming them preserves exactly the behaviour they have today.
update settings set armed = true, armed_at = now();

comment on column settings.armed is
  'Watch-only until true: decisions are recorded and no contact is written. '
  'Defaults false for new accounts; backfilled true in 0002 for existing ones.';

-- ---------------------------------------------------------------- rules

create table rules (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references profiles on delete cascade,
  kind       text not null default 'block' check (kind in ('block', 'allow')),
  -- Leading digits of the full international number, no '+'.
  prefix     text not null check (prefix ~ '^[1-9][0-9]{0,14}$'),
  label      text,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  -- One verdict per prefix per user. Two rows disagreeing about the same digits
  -- would make the match order load-bearing, and it is not: longest wins.
  unique (user_id, prefix)
);
create index rules_user_enabled_idx on rules (user_id) where enabled;

-- ---------------------------------------------------------------- activity

create table save_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references profiles on delete cascade,
  occurred_at timestamptz not null default now(),
  -- Digits only, or null when the sender arrived as a @lid we could not resolve.
  phone       text,
  push_name   text,
  saved_name  text,
  decision    text not null check (decision in (
    'saved',          -- written to the contact list
    'would_save',     -- matched, but the account is watch-only
    'already_known',  -- we hold this number already
    'removed',        -- an opt-out took them out again
    'not_found',      -- an opt-out from somebody we never had
    'blocked_prefix', -- a rule refused this number
    'no_trigger',     -- phrase mode, and the message was not the phrase
    'capped',         -- the daily cap was already spent
    'disabled',       -- saving is switched off
    'unsubscribed',   -- no active subscription
    'unresolved',     -- a @lid with no phone number behind it
    'failed'          -- WhatsApp refused the write
  )),
  matched_prefix text,
  rule_id        bigint references rules on delete set null,
  detail         text,
  -- Never message content. In phrase mode the trigger is already known and the
  -- name is what the sender chose to give; nothing else from the body is kept.
  constraint save_events_no_body check (detail is null or length(detail) <= 500)
);
create index save_events_user_time_idx on save_events (user_id, occurred_at desc);
-- Backs the daily cap, which counts real writes in the current UTC day.
create index save_events_cap_idx on save_events (user_id, decision, occurred_at desc);

-- ---------------------------------------------------------------- contacts

-- An opt-out leaves the row behind rather than deleting it: the row is the
-- record that this person asked not to be held, and deleting it would let the
-- next message save them again as if they had never objected.
alter table saved_contacts
  drop constraint if exists saved_contacts_status_check;
alter table saved_contacts
  add constraint saved_contacts_status_check
  check (status in ('saved', 'existing', 'failed', 'unresolved', 'pending', 'removed'));

-- The name the sender asked to be saved under, in phrase mode. Kept apart from
-- saved_name so "what they asked for" and "what we wrote" stay distinguishable.
alter table saved_contacts add column requested_name text;

-- ---------------------------------------------------------------- dial plan

-- Reference data for the rule picker, and for putting a name next to the digits
-- on a rule a month later. Matching never consults this table: a customer can
-- enter a prefix that is not listed and it will match correctly. Deleting the
-- whole table would change no decision.
create table dial_prefixes (
  prefix text primary key check (prefix ~ '^[1-9][0-9]{0,14}$'),
  kind   text not null check (kind in ('country', 'nanp_area')),
  name   text not null,
  region text
);
create index dial_prefixes_kind_idx on dial_prefixes (kind);

-- ---------------------------------------------------------------- RLS

alter table rules enable row level security;
alter table save_events enable row level security;
alter table dial_prefixes enable row level security;

-- Rules are the second thing the web app edits directly, after settings.
create policy "owner can read rules" on rules
  for select to authenticated using (user_id = (select auth.uid()));
create policy "owner can insert rules" on rules
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "owner can update rules" on rules
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "owner can delete rules" on rules
  for delete to authenticated using (user_id = (select auth.uid()));

-- Append-only from the customer's side: they can read their activity and not
-- edit it, which is the point of keeping it.
create policy "owner can read events" on save_events
  for select to authenticated using (user_id = (select auth.uid()));

-- Public reference data. Readable by anyone signed in; written only by migrations.
create policy "anyone can read dial prefixes" on dial_prefixes
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------- Realtime

-- The dashboard already live-updates sessions and contacts; the activity log
-- is the third thing worth watching while a backfill runs.
alter publication supabase_realtime add table save_events;
