/**
 * Sharding and the intent loop.
 *
 * The property that matters above everything else here: two replicas must
 * never both hold a socket for the same WhatsApp login. WhatsApp treats a
 * second connection from the same credentials as a replacement, so the two
 * would knock each other offline indefinitely — and that is the failure the
 * single-replica pin existed to prevent. Lifting the pin is only safe if this
 * holds, so it is tested directly with real managers over a shared store.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '../src/sessions.js';
import { assertShard, hashUser, owns } from '../src/shard.js';
import type { Shard } from '../src/shard.js';
import { PolicyCache } from '../src/store.js';
import { FakeSocket, MemoryStore, tick } from './helpers.js';

const users = Array.from({ length: 200 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

// ---------------------------------------------------------------- the function

test('every user is owned by exactly one replica, for every count', () => {
  for (let count = 1; count <= 8; count++) {
    for (const user of users) {
      const owners = Array.from({ length: count }, (_, index) => index).filter((index) =>
        owns({ index, count }, user),
      );
      assert.equal(owners.length, 1, `user ${user} with ${count} replicas has ${owners.length} owners`);
    }
  }
});

test('ownership depends only on the id and the count', () => {
  // Two replicas decide independently and must agree, so this cannot depend
  // on anything they do not share.
  for (const user of users.slice(0, 20)) {
    assert.equal(hashUser(user), hashUser(user));
    assert.equal(owns({ index: 1, count: 3 }, user), owns({ index: 1, count: 3 }, user));
  }
});

test('the hash is pinned, so a code change cannot silently reshuffle every session', () => {
  // If this value ever changes, every customer moves to a different replica
  // at the next deploy and every socket reconnects at once. That may be
  // acceptable, but it must be a decision, not a side effect of an edit.
  assert.equal(hashUser('00000000-0000-0000-0000-000000000000'), 3053639060);
});

test('customers spread across replicas rather than piling onto one', () => {
  const count = 4;
  const load = Array.from({ length: count }, (_, index) => users.filter((u) => owns({ index, count }, u)).length);
  for (const n of load) {
    // 200 users over 4 replicas is 50 each in expectation. A wide tolerance,
    // because the point is "not all on one", not statistical precision.
    assert.ok(n > 25 && n < 75, `uneven spread: ${load.join(', ')}`);
  }
});

test('a single replica owns everybody', () => {
  for (const user of users) assert.equal(owns({ index: 0, count: 1 }, user), true);
});

test('a shard that would orphan or double-own customers fails the boot', () => {
  assert.throws(() => assertShard({ index: 3, count: 3 }), /0-based/);
  assert.throws(() => assertShard({ index: -1, count: 3 }));
  assert.throws(() => assertShard({ index: 0, count: 0 }));
  assert.throws(() => assertShard({ index: 0.5, count: 2 }));
  assert.doesNotThrow(() => assertShard({ index: 2, count: 3 }));
  assert.doesNotThrow(() => assertShard({ index: 0, count: 1 }));
});

// ---------------------------------------------------------------- the loop

function manager(store: MemoryStore, shard: Shard, sockets: FakeSocket[]) {
  return new SessionManager(
    store,
    new PolicyCache(store, 0),
    (auth) => {
      const sock = new FakeSocket(auth.creds);
      sockets.push(sock);
      return sock;
    },
    undefined,
    { shard },
  );
}

function storeWith(ids: string[]) {
  const store = new MemoryStore();
  for (const id of ids) {
    store.addUser(id);
    store.sessions.set(id, { status: 'disconnected', desired: 'on', pair_phone: '15550009999' });
  }
  return store;
}

test('two replicas over one store never both open a socket for the same user', async () => {
  const ids = users.slice(0, 40);
  const store = storeWith(ids);
  const socketsA: FakeSocket[] = [];
  const socketsB: FakeSocket[] = [];
  const a = manager(store, { index: 0, count: 2 }, socketsA);
  const b = manager(store, { index: 1, count: 2 }, socketsB);

  // Both reconcile against exactly the same intent, as two real replicas would.
  await a.reconcile();
  await b.reconcile();
  await tick();

  const heldByA = ids.filter((id) => a.has(id));
  const heldByB = ids.filter((id) => b.has(id));
  assert.deepEqual(heldByA.filter((id) => heldByB.includes(id)), [], 'no user is held twice');
  assert.equal(heldByA.length + heldByB.length, ids.length, 'and no user is held by nobody');
  assert.equal(socketsA.length + socketsB.length, ids.length, 'one socket per user, in total');
});

test('reconciling twice opens nothing extra', async () => {
  const ids = users.slice(0, 5);
  const store = storeWith(ids);
  const sockets: FakeSocket[] = [];
  const m = manager(store, { index: 0, count: 1 }, sockets);
  await m.reconcile();
  await m.reconcile();
  await m.reconcile();
  assert.equal(sockets.length, ids.length, 'a timer firing repeatedly is harmless');
});

test('desired off closes the socket and keeps the login', async () => {
  const [id] = users;
  const store = storeWith([id!]);
  const sockets: FakeSocket[] = [];
  const m = manager(store, { index: 0, count: 1 }, sockets);
  await m.reconcile();
  assert.ok(m.has(id!));

  store.sessions.get(id!)!.desired = 'off';
  store.sessions.get(id!)!.status = 'connected';
  await m.reconcile();
  assert.equal(m.has(id!), false);
  assert.equal(sockets[0]!.loggedOut, false, 'a stop is not a logout');
});

test('a logout request unlinks the device and is not repeated', async () => {
  const [id] = users;
  const store = storeWith([id!]);
  const sockets: FakeSocket[] = [];
  const m = manager(store, { index: 0, count: 1 }, sockets);
  await m.reconcile();

  store.sessions.get(id!)!.desired = 'off';
  store.sessions.get(id!)!.logout_requested_at = new Date().toISOString();
  await m.reconcile();
  assert.equal(sockets[0]!.loggedOut, true);
  assert.equal(await store.hasAuth(id!), false, 'the stored login is gone');
});

test('a replica ignores intent for users it does not own', async () => {
  const ids = users.slice(0, 20);
  const store = storeWith(ids);
  const sockets: FakeSocket[] = [];
  const shard = { index: 1, count: 3 };
  const m = manager(store, shard, sockets);
  await m.reconcile();
  for (const id of ids) {
    assert.equal(m.has(id), owns(shard, id), id);
  }
});

test('a queue request is drained only by the owning replica', async () => {
  const ids = users.slice(0, 10);
  const store = storeWith(ids);
  for (const id of ids) {
    await store.claimContact(id, { phone: '15551230001', status: 'pending' });
    await store.requestQueue(id, 'all-pending');
  }

  const a = manager(store, { index: 0, count: 2 }, []);
  // Replica A drains. Only its own users' flags may clear: B's must survive
  // for B, or those customers' button presses would be silently lost.
  await a.reconcile();
  for (const id of ids) {
    const flagged = Boolean(store.rows(id)[0]!.queue_requested_at);
    assert.equal(flagged, !owns({ index: 0, count: 2 }, id), id);
  }
});
