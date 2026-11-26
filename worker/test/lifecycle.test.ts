/**
 * The three time-and-secrets mechanisms: key rotation, payment grace and
 * activity retention.
 *
 * None of these is reachable from a message, so none of them is covered by the
 * saver tests. Each one is also the kind of thing that is only ever exercised
 * in anger — during a rotation, after a failed payment, months into running —
 * which is exactly when you want it to have been tested.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { useSupabaseAuthState } from '../src/authState.js';
import { keyRing, openWithRing, parseKey, seal } from '../src/crypto.js';
import { Maintenance } from '../src/maintenance.js';
import { isGraceable, maySave } from '../src/store.js';
import { MemoryStore, USER } from './helpers.js';

const OLD = parseKey('ab'.repeat(32));
const NEW = parseKey('cd'.repeat(32));
const OTHER = parseKey('ef'.repeat(32));

// ---------------------------------------------------------------- key rotation

test('a ring opens rows written by any of its keys', () => {
  const sealed = seal(OLD, { hello: 'world' });
  assert.deepEqual(openWithRing(keyRing(NEW, [OLD]), sealed), { hello: 'world' });
  assert.deepEqual(openWithRing(keyRing(OLD), sealed), { hello: 'world' });
});

test('a ring that holds none of the right keys still throws', () => {
  // GCM authenticates, so a wrong key cannot return plausible nonsense. That
  // is what makes trying keys in turn safe.
  const sealed = seal(OLD, { hello: 'world' });
  assert.throws(() => openWithRing(keyRing(NEW, [OTHER]), sealed));
});

test('a rotation reads old sessions and rewrites them under the new key', async () => {
  const store = new MemoryStore();

  // Before: everything written under the old key.
  const before = await useSupabaseAuthState(store, USER, keyRing(OLD));
  before.state.creds.me = { id: '15550009999:3@s.whatsapp.net' };
  await before.saveCreds();
  await before.state.keys.set({
    'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } },
  });

  // During: the new key writes, the old one still reads. The session survives,
  // which is the whole point — a rotation used to log everybody out.
  const during = await useSupabaseAuthState(store, USER, keyRing(NEW, [OLD]));
  assert.deepEqual(during.state.creds.me, { id: '15550009999:3@s.whatsapp.net' });
  assert.equal((await during.state.keys.get('pre-key', ['1']))['1']?.private.toString(), 'priv');

  // Anything written now is under the new key, so the row leaves the old one
  // behind as soon as Baileys touches it.
  await during.saveCreds();
  await during.state.keys.set({
    'pre-key': { '1': { public: Buffer.from('pub2'), private: Buffer.from('priv2') } },
  });

  // After: the old key is gone from the ring and everything still reads.
  const after = await useSupabaseAuthState(store, USER, keyRing(NEW));
  assert.deepEqual(after.state.creds.me, { id: '15550009999:3@s.whatsapp.net' });
  assert.equal((await after.state.keys.get('pre-key', ['1']))['1']?.private.toString(), 'priv2');
});

test('a session untouched during the rotation is unreadable once the old key goes', async () => {
  // The honest limit of the approach, pinned so nobody is surprised by it: a
  // row nothing rewrote keeps its old ciphertext, and after the old key is
  // removed that session has to re-link. Which is what would have happened to
  // every session under the previous single-key behaviour anyway.
  const store = new MemoryStore();
  const before = await useSupabaseAuthState(store, USER, keyRing(OLD));
  before.state.creds.me = { id: 'never-reconnected' };
  await before.saveCreds();

  await assert.rejects(useSupabaseAuthState(store, USER, keyRing(NEW)));
});

// ---------------------------------------------------------------- grace

test('maySave covers active, trialing and a live grace window', () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();

  assert.equal(maySave('active', null), true);
  assert.equal(maySave('trialing', null), true);
  assert.equal(maySave('past_due', null), false, 'no grace started means no grace');
  assert.equal(maySave('past_due', future), true, 'inside the window');
  assert.equal(maySave('past_due', past), false, 'the window has closed');
  assert.equal(maySave('unpaid', future), true);
  // A cancelled subscription gets nothing, even with a stale deadline sitting
  // on the row: it is over, not retrying.
  assert.equal(maySave('canceled', future), false);
  assert.equal(maySave('incomplete', future), false);
  assert.equal(maySave('none', future), false);
});

test('only the statuses Stripe retries are graceable', () => {
  assert.equal(isGraceable('past_due'), true);
  assert.equal(isGraceable('unpaid'), true);
  for (const status of ['active', 'trialing', 'canceled', 'incomplete', 'incomplete_expired', 'none']) {
    assert.equal(isGraceable(status), false, status);
  }
});

test('maintenance stops the socket once grace has run out, and only once', async () => {
  const store = new MemoryStore();
  store.addUser(USER, 'past_due');
  store.profiles.get(USER)!.grace_until = new Date(Date.now() - 1000).toISOString();

  const stopped: string[] = [];
  const maintenance = new Maintenance(store, { stop: async (id) => void stopped.push(id) }, {
    retentionDays: 0,
  });

  await maintenance.runOnce();
  assert.deepEqual(stopped, [USER]);
  // The deadline is cleared, so this user is not swept again on every tick.
  assert.equal(store.profiles.get(USER)!.grace_until, null);

  await maintenance.runOnce();
  assert.deepEqual(stopped, [USER], 'not stopped a second time');
});

test('maintenance leaves a live grace window alone', async () => {
  const store = new MemoryStore();
  store.addUser(USER, 'past_due');
  store.profiles.get(USER)!.grace_until = new Date(Date.now() + 3_600_000).toISOString();

  const stopped: string[] = [];
  await new Maintenance(store, { stop: async (id) => void stopped.push(id) }, { retentionDays: 0 })
    .runOnce();
  assert.deepEqual(stopped, [], 'still inside the window');
});

// ---------------------------------------------------------------- retention

test('the purge drops rows past the window and keeps the rest', async () => {
  const store = new MemoryStore();
  store.addUser(USER);
  await store.recordEvent(USER, { phone: '1', decision: 'saved' });
  await store.recordEvent(USER, { phone: '2', decision: 'saved' });
  // Age one of them past the window.
  store.eventRows(USER)[0]!.occurred_at = new Date(Date.now() - 100 * 86_400_000).toISOString();

  await new Maintenance(store, { stop: async () => {} }, { retentionDays: 90 }).runOnce();
  assert.equal(store.eventRows(USER).length, 1);
  assert.equal(store.eventRows(USER)[0]!.phone, '2');
});

test('the purge runs once a day, not on every tick', async () => {
  const store = new MemoryStore();
  store.addUser(USER);
  let purges = 0;
  const counting = Object.assign(Object.create(Object.getPrototypeOf(store)) as MemoryStore, store, {
    purgeEvents: async () => {
      purges += 1;
      return 0;
    },
  });

  const maintenance = new Maintenance(counting, { stop: async () => {} }, { retentionDays: 90 });
  await maintenance.runOnce();
  await maintenance.runOnce();
  await maintenance.runOnce();
  assert.equal(purges, 1, 'three ticks in one day is one purge');
});

test('a free preview past its window has its socket closed, and keeps its data', async () => {
  const store = new MemoryStore();
  store.addUser(USER, 'none');
  store.createdAt.set(USER, new Date(Date.now() - 30 * 86_400_000).toISOString());
  await store.recordEvent(USER, { phone: '1', decision: 'unsubscribed' });

  const stopped: string[] = [];
  await new Maintenance(store, { stop: async (id) => void stopped.push(id) }, {
    retentionDays: 0,
    freePreviewDays: 14,
  }).runOnce();

  assert.deepEqual(stopped, [USER]);
  // Only the socket goes. What they built up is the argument for subscribing.
  assert.equal(store.eventRows(USER).length, 1);
  assert.ok(store.settings.get(USER));
});

test('a subscribed account is never swept as an expired preview', async () => {
  const store = new MemoryStore();
  store.addUser(USER, 'active');
  store.createdAt.set(USER, new Date(Date.now() - 1000 * 86_400_000).toISOString());

  const stopped: string[] = [];
  await new Maintenance(store, { stop: async (id) => void stopped.push(id) }, {
    retentionDays: 0,
    freePreviewDays: 14,
  }).runOnce();
  assert.deepEqual(stopped, []);
});

test('a preview window of zero never expires anybody', async () => {
  const store = new MemoryStore();
  store.addUser(USER, 'none');
  store.createdAt.set(USER, new Date(Date.now() - 1000 * 86_400_000).toISOString());

  const stopped: string[] = [];
  await new Maintenance(store, { stop: async (id) => void stopped.push(id) }, {
    retentionDays: 0,
    freePreviewDays: 0,
  }).runOnce();
  assert.deepEqual(stopped, [], 'unlimited is the default');
});

test('retention of zero switches the purge off', async () => {
  const store = new MemoryStore();
  store.addUser(USER);
  await store.recordEvent(USER, { phone: '1', decision: 'saved' });
  store.eventRows(USER)[0]!.occurred_at = new Date(Date.now() - 1000 * 86_400_000).toISOString();

  await new Maintenance(store, { stop: async () => {} }, { retentionDays: 0 }).runOnce();
  assert.equal(store.eventRows(USER).length, 1, 'nothing is swept when retention is off');
});
