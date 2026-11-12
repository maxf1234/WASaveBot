import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DisconnectReason, initAuthCreds } from 'baileys';
import type { AuthenticationState } from 'baileys';
import { useSupabaseAuthState } from '../src/authState.js';
import { backoffFor, SessionManager } from '../src/sessions.js';
import { PolicyCache } from '../src/store.js';
import { FakeSocket, MemoryStore, msg, tick, USER } from './helpers.js';

function setup() {
  const store = new MemoryStore();
  store.addUser(USER);
  const sockets: FakeSocket[] = [];
  const auths: AuthenticationState[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const manager = new SessionManager(
    store,
    new PolicyCache(store, 0),
    (auth) => {
      auths.push(auth);
      const sock = new FakeSocket(auth.creds);
      sockets.push(sock);
      return sock;
    },
    ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 0 as unknown as NodeJS.Timeout;
    }) as never,
  );
  const close = (sock: FakeSocket, statusCode: number) =>
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
  return { store, sockets, auths, timers, manager, close };
}

test('auth state round-trips through the store with Buffers intact', async () => {
  const store = new MemoryStore();
  const first = await useSupabaseAuthState(store, USER);
  first.state.creds.me = { id: '15550009999:3@s.whatsapp.net' };
  await first.saveCreds();
  await first.state.keys.set({
    'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } },
    'app-state-sync-key': { abc: { keyData: Buffer.from('k') } as never },
  });

  // A "restarted worker": nothing in memory, everything from the table.
  const second = await useSupabaseAuthState(store, USER);
  assert.deepEqual(second.state.creds.noiseKey, first.state.creds.noiseKey);
  assert.ok(Buffer.isBuffer(second.state.creds.noiseKey.private));
  assert.deepEqual(second.state.creds.me, { id: '15550009999:3@s.whatsapp.net' });
  const keys = await second.state.keys.get('pre-key', ['1', 'missing']);
  assert.deepEqual(Object.keys(keys), ['1']);
  assert.ok(Buffer.isBuffer(keys['1']?.private));
  assert.equal(keys['1']?.private.toString(), 'priv');
  const sync = await second.state.keys.get('app-state-sync-key', ['abc']);
  assert.equal(Buffer.from(sync.abc!.keyData!).toString(), 'k');

  await second.state.keys.set({ 'pre-key': { '1': null as never } });
  assert.deepEqual(await second.state.keys.get('pre-key', ['1']), {});
});

test('pairing code, open and creds.update are written to wa_sessions / wa_auth', async () => {
  const { store, sockets, manager } = setup();
  await manager.start(USER, '15550009999');
  assert.equal(store.sessions.get(USER)?.status, 'connecting');
  const sock = sockets[0]!;

  // Baileys offers a QR when it is ready to link; we ask for a code instead, once.
  sock.ev.emit('connection.update', { qr: 'QR-1' });
  sock.ev.emit('connection.update', { qr: 'QR-2' });
  await tick();
  assert.deepEqual(sock.pairingRequests, ['15550009999']);
  assert.deepEqual([store.sessions.get(USER)?.status, store.sessions.get(USER)?.pairing_code], ['pairing', 'ABCD1234']);

  sock.ev.emit('creds.update', {});
  await tick();
  assert.ok(await store.hasAuth(USER));

  sock.authState.creds.me = { id: 'paired' }; // the user typed the code
  sock.ev.emit('connection.update', { connection: 'open' });
  await tick();
  const s = store.sessions.get(USER)!;
  assert.deepEqual([s.status, s.pairing_code, s.phone], ['connected', null, '15550009999']);
  assert.ok(s.last_connected_at);
  assert.equal(manager.count(), 1);

  await manager.start(USER, '15550001111'); // already linked: nothing happens
  assert.equal(sockets.length, 1);
});

test('a worker restart reconnects every active user with the stored login, no new code', async () => {
  const { store, manager: before, sockets: s1 } = setup();
  store.addUser('lapsed', 'canceled');
  store.addUser('never-linked', 'active');
  await before.start(USER);
  s1[0]!.authState.creds.me = { id: '15550009999:3@s.whatsapp.net' }; // paired by scanning
  s1[0]!.ev.emit('creds.update', {});
  await tick();
  await store.setAuth('lapsed', [['creds', initAuthCreds() as never]]);
  await before.stopAll(); // the process dies; logins stay in the table

  const sockets: FakeSocket[] = [];
  const after = new SessionManager(store, new PolicyCache(store, 0), (auth) => {
    const sock = new FakeSocket(auth.creds);
    sockets.push(sock);
    return sock;
  });
  await after.bootAll();
  assert.equal(sockets.length, 1, 'only the subscribed user with a stored login');
  assert.deepEqual(sockets[0]!.authState.creds.me, { id: '15550009999:3@s.whatsapp.net' }, 'same identity: no pairing needed');
  sockets[0]!.ev.emit('connection.update', { connection: 'open' });
  await tick();
  assert.deepEqual(sockets[0]!.pairingRequests, [], 'no code was requested');
  assert.ok(after.has(USER) && !after.has('lapsed') && !after.has('never-linked'));
});

test('logged out by WhatsApp: login deleted, status logged_out, no reconnect', async () => {
  const { store, sockets, timers, manager, close } = setup();
  await manager.start(USER);
  sockets[0]!.ev.emit('creds.update', {});
  await tick();
  close(sockets[0]!, DisconnectReason.loggedOut);
  await tick();
  assert.equal(await store.hasAuth(USER), false);
  assert.equal(store.sessions.get(USER)?.status, 'logged_out');
  assert.equal(timers.length, 0);
  assert.equal(manager.has(USER), false);
});

test('any other close reconnects with backoff 2s, 5s, 15s, 60s, 60s', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoffFor), [2000, 5000, 15000, 60000, 60000, 60000]);

  const { store, sockets, timers, manager, close } = setup();
  await manager.start(USER);
  for (let i = 0; i < 5; i++) {
    sockets[i]!.authState.creds.me = { id: 'paired' };
    close(sockets[i]!, DisconnectReason.connectionLost);
    await tick();
    assert.equal(store.sessions.get(USER)?.status, 'connecting');
    timers[i]!.fn();
    await tick();
    assert.equal(sockets.length, i + 2, 'a fresh socket was opened');
  }
  assert.deepEqual(
    timers.map((t) => t.ms),
    [2000, 5000, 15000, 60000, 60000],
  );

  // A successful open resets the backoff.
  sockets[5]!.authState.creds.me = { id: 'paired' };
  sockets[5]!.ev.emit('connection.update', { connection: 'open' });
  await tick();
  close(sockets[5]!, DisconnectReason.connectionClosed);
  await tick();
  assert.equal(timers[5]!.ms, 2000);
});

test('the restart WhatsApp asks for right after pairing reconnects', async () => {
  const { sockets, timers, manager, close } = setup();
  await manager.start(USER);
  sockets[0]!.authState.creds.me = undefined;
  close(sockets[0]!, DisconnectReason.restartRequired);
  await tick();
  assert.equal(timers.length, 1);
});

test('a code nobody enters times out and stops quietly instead of looping', async () => {
  const { store, sockets, timers, manager, close } = setup();
  await manager.start(USER, '15550009999');
  sockets[0]!.ev.emit('connection.update', { qr: 'QR-1' });
  await tick();
  close(sockets[0]!, DisconnectReason.timedOut);
  await tick();
  assert.equal(timers.length, 0);
  assert.deepEqual([store.sessions.get(USER)?.status, store.sessions.get(USER)?.pairing_code], ['disconnected', null]);
  assert.equal(manager.has(USER), false);
});

test('pressing Connect again with a corrected number starts a fresh pairing', async () => {
  const { sockets, manager } = setup();
  await manager.start(USER, '15550000000');
  sockets[0]!.ev.emit('connection.update', { qr: 'QR-1' });
  await tick();
  await manager.start(USER, '15550009999');
  assert.ok(sockets[0]!.ended);
  sockets[1]!.ev.emit('connection.update', { qr: 'QR-1' });
  await tick();
  assert.deepEqual(sockets[1]!.pairingRequests, ['15550009999']);
});

test('a stored login WhatsApp no longer accepts, with no number to pair, ends as logged_out', async () => {
  const { store, sockets, manager } = setup();
  await manager.start(USER);
  sockets[0]!.ev.emit('connection.update', { qr: 'QR-1' });
  await tick();
  assert.deepEqual(sockets[0]!.pairingRequests, []);
  assert.equal(store.sessions.get(USER)?.status, 'logged_out');
  assert.equal(manager.has(USER), false);
});

test('stop keeps the login; logout deletes it', async () => {
  const { store, sockets, manager } = setup();
  await manager.start(USER);
  sockets[0]!.ev.emit('creds.update', {});
  await tick();

  await manager.stop(USER);
  assert.ok(sockets[0]!.ended);
  assert.ok(await store.hasAuth(USER), 'wa_auth kept');
  assert.equal(store.sessions.get(USER)?.status, 'disconnected');
  assert.equal(manager.count(), 0);

  await manager.start(USER);
  await manager.logout(USER);
  assert.ok(sockets[1]!.loggedOut);
  assert.equal(await store.hasAuth(USER), false);
});

test('only notify batches are handled, and events from a replaced socket are ignored', async () => {
  const { store, sockets, manager } = setup();
  await manager.start(USER);
  const sock = sockets[0]!;
  sock.ev.emit('messages.upsert', { type: 'append', messages: [msg('15551230001@s.whatsapp.net', 'Old')] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [msg('15551230002@s.whatsapp.net', 'New')] });
  sock.ev.emit('contacts.upsert', [{ id: '15551230003@s.whatsapp.net', name: 'Mum' }]);
  sock.ev.emit('messaging-history.set', { contacts: [{ id: '15551230004@s.whatsapp.net', name: 'Dad' }] });
  await tick(20);
  assert.deepEqual(
    store.rows().map((r) => [r.phone, r.status]).sort(),
    [
      ['15551230002', 'saved'],
      ['15551230003', 'existing'],
      ['15551230004', 'existing'],
    ],
  );
  assert.deepEqual(sock.visibleCalls, []);

  await manager.stop(USER);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [msg('15551230009@s.whatsapp.net', 'Late')] });
  await tick(20);
  assert.equal(store.rows().length, 3);
});

test('the worker source never calls anything the other person could see', () => {
  const dir = new URL('../src/', import.meta.url);
  const forbidden = /\.(sendMessage|readMessages|sendReceipt|sendReceipts|sendPresenceUpdate|presenceSubscribe|chatModify)\s*\(/;
  for (const file of readdirSync(dir)) {
    assert.doesNotMatch(readFileSync(new URL(file, dir), 'utf8'), forbidden, file);
  }
});
