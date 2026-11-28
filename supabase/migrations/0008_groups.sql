-- 0008_groups.sql
--
-- Group members: who is in each of the customer's WhatsApp groups, extracted
-- into a table of their own, and an option to save them all as contacts.
--
-- Extraction and saving are separate on purpose. Reading a group's member
-- list writes nothing to anybody's address book, so it runs for every account
-- that asks, previews included; whether those people then become contacts is
-- `settings.save_groups`, and goes through the same rules, opt-outs, daily cap
-- and arming as everyone else.

alter table settings
  add column save_groups boolean not null default false;

comment on column settings.save_groups is
  'Also save everyone in the customer''s groups as contacts, within the daily cap.';

-- Intent, like queue_requested_at: the dashboard asks, the replica that owns
-- the customer does the scan.
alter table wa_sessions
  add column groups_requested_at timestamptz,
  add column groups_scanned_at timestamptz;

create table group_members (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references profiles on delete cascade,
  group_jid   text not null,
  group_name  text,
  -- Digits only, no +. Null when WhatsApp hides the number (some groups and
  -- communities show members only by an internal id).
  phone       text,
  lid         text,
  name        text,
  is_admin    boolean not null default false,
  seen_at     timestamptz not null default now(),
  -- One row per person per group, keyed on whichever id we have.
  member      text generated always as (coalesce(phone, lid)) stored,
  unique (user_id, group_jid, member)
);

create index group_members_user_idx on group_members (user_id, group_name);

alter table group_members enable row level security;

-- The customer reads their own; only the worker writes.
create policy "owner can read group members" on group_members
  for select to authenticated using (user_id = (select auth.uid()));
