-- SaveBot schema. One migration: tables, RLS, the sign-up trigger and Realtime.

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  stripe_customer_id text unique,
  subscription_status text not null default 'none',
  current_period_end timestamptz,
  created_at timestamptz default now()
);

create table settings (
  user_id uuid primary key references profiles on delete cascade,
  enabled boolean not null default true,
  save_to_phone boolean not null default true,
  name_template text not null default '{name}',
  fallback_prefix text not null default 'WA',
  daily_cap int not null default 200
);

create table wa_sessions (
  user_id uuid primary key references profiles on delete cascade,
  status text not null default 'disconnected',
  -- disconnected | pairing | connecting | connected | logged_out
  pairing_code text,      -- the 8-character code the user types into WhatsApp
  phone text,
  last_connected_at timestamptz
);

create table wa_auth (
  user_id uuid references profiles on delete cascade,
  key text,
  value jsonb not null,
  primary key (user_id, key)
);

create table saved_contacts (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles on delete cascade,
  phone text not null,          -- digits only, no +
  lid text,
  push_name text,
  saved_name text,
  status text not null,         -- saved | existing | failed | unresolved
  error text,
  created_at timestamptz default now(),
  unique (user_id, phone)
);

-- The dashboard lists a user's latest rows and counts today's saves.
create index saved_contacts_user_created_idx on saved_contacts (user_id, created_at desc);

-- ---------------------------------------------------------------- RLS

alter table profiles enable row level security;
alter table settings enable row level security;
alter table wa_sessions enable row level security;
alter table wa_auth enable row level security;
alter table saved_contacts enable row level security;

-- The owner can read these; only the worker (service role, which bypasses
-- RLS) writes them.
create policy "owner can read profile" on profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "owner can read session" on wa_sessions
  for select to authenticated using (user_id = (select auth.uid()));

create policy "owner can read contacts" on saved_contacts
  for select to authenticated using (user_id = (select auth.uid()));

-- Settings are the one thing the web app edits directly.
create policy "owner can read settings" on settings
  for select to authenticated using (user_id = (select auth.uid()));

create policy "owner can update settings" on settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- wa_auth holds WhatsApp login keys: no policies at all, so with RLS on only
-- the service role can touch it. The revoke is belt and braces.
revoke all on wa_auth from anon, authenticated;

-- ---------------------------------------------------------------- sign-up

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  insert into public.settings (user_id) values (new.id);
  insert into public.wa_sessions (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- Realtime

alter publication supabase_realtime add table wa_sessions, saved_contacts;
