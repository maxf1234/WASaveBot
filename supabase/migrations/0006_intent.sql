-- 0006_intent.sql
--
-- Linking, unlinking, backfill and retry used to be in-process calls: the HTTP
-- handler reached straight into the session manager and opened a socket. That
-- works only while there is exactly one worker, which is why railway.json
-- pinned numReplicas to 1.
--
-- With sessions sharded across replicas, a request can land on a replica that
-- does not own the user — and opening a socket there is precisely the
-- two-workers-fighting case the single replica was preventing. So the HTTP
-- layer now writes down *what the customer wants* and returns, and the replica
-- that owns the user reconciles it on its next tick.
--
-- This is also better on one replica. Nothing in the request path waits on
-- WhatsApp any more, so a slow or refusing WhatsApp is a dashboard that says
-- "still working" rather than a timed-out HTTP request.

alter table wa_sessions
  -- What the customer wants, as opposed to `status`, which is what is
  -- happening. Keeping the two apart is the whole point: 'on' with status
  -- 'connecting' is a healthy session coming up, and 'off' with status
  -- 'connected' is one the owning replica has not shut down yet.
  add column desired text not null default 'off' check (desired in ('on', 'off')),
  -- The number to pair with, for a link that has no stored login yet. Cleared
  -- once pairing succeeds, so it is never a standing copy of their number.
  add column pair_phone text,
  -- Set by the unlink endpoint. Distinct from desired='off', which only closes
  -- the socket: a logout also tells WhatsApp to drop the linked device.
  add column logout_requested_at timestamptz;

-- Existing customers with a stored login are connected right now and must stay
-- that way: their intent is 'on'. Anything else is left at the default.
update wa_sessions s
   set desired = 'on'
 where exists (select 1 from wa_auth a where a.user_id = s.user_id and a.key = 'creds');

comment on column wa_sessions.desired is
  'What the customer asked for. The owning replica reconciles `status` towards '
  'it on each tick; the HTTP layer never touches a socket.';

-- The reconcile loop reads this on every tick, filtered to its own shard, so
-- the rows it cares about are worth an index.
create index wa_sessions_desired_idx on wa_sessions (desired) where desired = 'on';
create index wa_sessions_logout_idx on wa_sessions (logout_requested_at)
  where logout_requested_at is not null;

-- ---------------------------------------------------------------- queueing

-- "Save these people now", for both the backfill button and the retry button.
--
-- One mechanism rather than two, because they are the same request: put this
-- person back in the save queue. Backfill sets it on every pending row,
-- Retry sets it on one — and the worker does not need to know which happened.
alter table saved_contacts add column queue_requested_at timestamptz;

create index saved_contacts_queued_idx on saved_contacts (queue_requested_at)
  where queue_requested_at is not null;

comment on column saved_contacts.queue_requested_at is
  'Set by the dashboard to ask for this person to be saved now. The owning '
  'replica queues them and clears it.';
