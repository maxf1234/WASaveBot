-- 0007_pro_grant.sql
--
-- Pro granted by an admin, without Stripe.
--
-- A separate column rather than writing 'active' into subscription_status,
-- because that column is Stripe's: every webhook re-reads the customer's
-- subscriptions and overwrites it, so a hand-set status would silently vanish
-- the next time anything happened on their Stripe customer. This flag is
-- never touched by billing, and `maySave` treats it as subscribed.
--
-- Customers can read their own profile but have no update policy on it, so
-- they cannot grant themselves Pro. supabase/tests/rls.sql checks that.

alter table profiles
  add column pro_granted boolean not null default false;

comment on column profiles.pro_granted is
  'Pro given by an admin from the admin page, independent of Stripe.';

create or replace view admin_overview
with (security_invoker = true) as
select
  p.id                     as user_id,
  p.email,
  p.subscription_status,
  p.grace_until,
  p.created_at,
  s.status                 as session_status,
  s.phone                  as session_phone,
  s.last_connected_at,
  t.armed,
  t.enabled,
  t.save_mode,
  coalesce(c.saved, 0)     as saved_count,
  coalesce(c.failed, 0)    as failed_count,
  coalesce(c.pending, 0)   as pending_count,
  coalesce(c.removed, 0)   as removed_count,
  e.last_event_at,
  -- Appended, not inserted: `create or replace view` may only add columns at the end.
  p.pro_granted
from profiles p
left join wa_sessions s on s.user_id = p.id
left join settings t on t.user_id = p.id
left join (
  select
    user_id,
    count(*) filter (where status = 'saved')   as saved,
    count(*) filter (where status = 'failed')  as failed,
    count(*) filter (where status = 'pending') as pending,
    count(*) filter (where status = 'removed') as removed
  from saved_contacts
  group by user_id
) c on c.user_id = p.id
left join (
  select user_id, max(occurred_at) as last_event_at
  from save_events
  group by user_id
) e on e.user_id = p.id;

revoke all on admin_overview from anon, authenticated;
grant select on admin_overview to service_role;
