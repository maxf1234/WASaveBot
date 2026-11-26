-- 0005_admin_overview.sql
--
-- One row per customer, for the operator's admin page: their subscription,
-- their WhatsApp session, and how much the product has actually done for them.
--
-- A view rather than queries in the worker because the counts need grouping,
-- which PostgREST cannot express — the alternative was fetching every contact
-- row for every customer and counting in JavaScript, which stops working at
-- exactly the point the page becomes worth having.
--
-- SECURITY. A view in Postgres runs with its *owner's* rights by default, so it
-- would hand any caller a way straight past the RLS on the tables underneath —
-- precisely the hole this schema is otherwise careful about. Two things close
-- it: `security_invoker = true`, so the view is evaluated as whoever queries it
-- and the underlying policies still apply; and an explicit revoke, because
-- Supabase grants privileges on new relations to anon and authenticated by
-- default. Either alone would do. Both are here because the cost of being
-- wrong is every customer's row, and supabase/tests/rls.sql checks it.

create view admin_overview
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
  e.last_event_at
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

comment on view admin_overview is
  'Operator view, one row per customer. Readable only by service_role: the '
  'worker checks ADMIN_EMAILS before serving it. security_invoker keeps the '
  'underlying RLS in force even if the grants below are ever loosened.';

-- Only the worker's service role may read this. `authenticated` gets nothing,
-- so a customer cannot reach other customers' rows through the view even if
-- they discover its name.
revoke all on admin_overview from anon, authenticated;
grant select on admin_overview to service_role;
