-- 0004_grace_and_retention.sql
--
-- Two gaps, both found by looking at what happens over time rather than at
-- what happens on a message.
--
-- 1. A failed payment closed the socket the instant Stripe said so, which is
--    unambiguous and also means a customer whose card merely expired loses
--    every contact who messaged them while Stripe retried — and Stripe retries
--    for days. `grace_until` keeps them saving for a configurable window.
--
-- 2. save_events had no retention at all. Every new person who messages writes
--    a row, forever. The nightly purge is the whole story; there are no
--    rollups underneath, which is why the default window is generous.

alter table profiles
  -- Set when the subscription first goes to a status that Stripe will retry
  -- (past_due, unpaid), cleared the moment it is good again. Null means there
  -- is no grace running, which is the normal state in both directions.
  add column grace_until timestamptz;

comment on column profiles.grace_until is
  'While in the future, a past_due or unpaid subscription still saves. Set by '
  'the worker from PAYMENT_GRACE_HOURS; cleared when the subscription recovers.';

-- The sweep looks for lapsed grace across every tenant, so it wants an index
-- on just the rows that have one.
create index profiles_grace_idx on profiles (grace_until) where grace_until is not null;
