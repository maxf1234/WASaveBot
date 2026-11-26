import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DisconnectReason } from 'baileys';
import { useSupabaseAuthState } from '../src/authState.js';
import { keyRing, open, parseKey, seal } from '../src/crypto.js';
import { createMailer } from '../src/email.js';
import { ContactSaver } from '../src/saver.js';
import { SessionManager } from '../src/sessions.js';
import { PolicyCache } from '../src/store.js';
import { FakeSocket, MemoryStore, msg, tick, USER } from './helpers.js';

const KEY = parseKey('ab'.repeat(32));

function setup() {
  const store = new MemoryStore();
  store.addUser(USER);
  const sock = new FakeSocket();
  const saver = new ContactSaver(USER, store, new PolicyCache(store, 0), () => sock, { sleep: async () => {} });
  return { store, sock, saver };
}
const summary = (store: MemoryStore) => store.rows().map((r) => [r.phone, r.status, r.saved_name ?? null]);

test('encryption: round trip, wrong key and tampering are rejected, bad keys refused', () => {
  const sealed = seal(KEY, { secret: 'value' });
  assert.equal(JSON.stringify(sealed).includes('value'), false);
  assert.deepEqual(open(KEY, sealed), { secret: 'value' });
  assert.notEqual(seal(KEY, { secret: 'value' }).data, sealed.data, 'fresh IV every time');
  assert.throws(() => open(parseKey('cd'.repeat(32)), sealed));
  assert.throws(() => open(KEY, { ...sealed, data: Buffer.from('tampered').toString('base64') }));
  assert.throws(() => parseKey('too-short'));
});

test('wa_auth holds only ciphertext, and a restarted worker with the key reads it back', async () => {
  const store = new MemoryStore();
  const first = await useSupabaseAuthState(store, USER, keyRing(KEY));
  first.state.creds.me = { id: '15550009999:3@s.whatsapp.net' };
  await first.saveCreds();
  await first.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } } });

  for (const [key, value] of store.auth.get(USER)!) {
    assert.deepEqual(Object.keys(value as object).sort(), ['data', 'enc', 'iv', 'tag'], key);
  }
  assert.equal(JSON.stringify([...store.auth.get(USER)!]).includes('15550009999'), false);

  const second = await useSupabaseAuthState(store, USER, keyRing(KEY));
  assert.deepEqual(second.state.creds.me, { id: '15550009999:3@s.whatsapp.net' });
  assert.deepEqual(second.state.creds.noiseKey, first.state.creds.noiseKey);
  assert.equal((await second.state.keys.get('pre-key', ['1']))['1']?.private.toString(), 'priv');

  await assert.rejects(useSupabaseAuthState(store, USER, keyRing(parseKey('cd'.repeat(32)))));
  await assert.rejects(useSupabaseAuthState(store, USER), /no key/);
});

test('backfill: unsaved 1:1 chats found at linking wait as pending, then are saved on request', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onHistory([
    { id: '15551230001@s.whatsapp.net', notify: 'Dana Levi' }, // push name arrives first
    { id: '15551230007@s.whatsapp.net', notify: 'Only In A Group' }, // push name only: not a chat
    { id: '15551230001@s.whatsapp.net' }, // unsaved chat
    { id: '15551230002@s.whatsapp.net', name: 'Mum' }, // saved by hand
    { id: '99887766554433@lid', phoneNumber: '15551230003@s.whatsapp.net' }, // unsaved, no push name yet
    { id: '120363000000000000@g.us', name: 'Family' },
    { id: '15550009999@s.whatsapp.net' }, // the user's own number
  ]);
  await saver.onHistory([{ id: '15551230003@s.whatsapp.net', notify: 'Late Name' }]);
  await saver.idle();
  assert.equal(sock.saved.length, 0, 'nothing is saved until the user asks');
  assert.deepEqual(summary(store), [
    ['15551230001', 'pending', null],
    ['15551230002', 'existing', 'Mum'],
    ['15551230003', 'pending', null],
  ]);
  assert.equal(store.rows()[2]?.push_name, 'Late Name');

  assert.equal(await saver.backfill(), 2);
  assert.equal(await saver.backfill(), 0, 'pressing twice queues nothing extra');
  await saver.idle();
  assert.deepEqual(
    sock.saved.map((s) => [s.jid, s.contact.fullName]),
    [
      ['15551230001@s.whatsapp.net', 'Dana Levi'],
      ['15551230003@s.whatsapp.net', 'Late Name'],
    ],
  );
  assert.deepEqual(summary(store).map((r) => r[1]), ['saved', 'existing', 'saved']);
  assert.equal(await saver.backfill(), 0);
});

test('backfill candidates: a message saves one now, a hand-saved one becomes existing, a restart keeps the rest', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onHistory([1, 2, 3].map((n) => ({ id: `1555123000${n}@s.whatsapp.net` })));
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'Messaged Me')]);
  await saver.onContacts([{ id: '15551230002@s.whatsapp.net', name: 'Saved By Hand' }]);
  await saver.idle();
  assert.deepEqual(summary(store), [
    ['15551230001', 'saved', 'Messaged Me'],
    ['15551230002', 'existing', 'Saved By Hand'],
    ['15551230003', 'pending', null],
  ]);

  const restarted = new ContactSaver(USER, store, new PolicyCache(store, 0), () => sock, { sleep: async () => {} });
  await restarted.load();
  assert.equal(await restarted.backfill(), 1);
  await restarted.idle();
  assert.deepEqual(sock.saved.map((s) => s.contact.fullName), ['Messaged Me', 'WA 0003']);
});

test('backfill respects the daily cap and leaves the rest pending for another day', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.daily_cap = 1;
  await saver.load();
  await saver.onHistory([1, 2, 3].map((n) => ({ id: `1555123000${n}@s.whatsapp.net` })));
  await saver.backfill();
  await saver.idle();
  assert.equal(sock.saved.length, 1);
  assert.deepEqual(summary(store).map((r) => r[1]), ['saved', 'pending', 'pending']);
});

test('retry: a failed contact is tried again on request and its row is updated', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  sock.failNext = 2;
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'Unlucky')]);
  await saver.idle();
  assert.deepEqual(summary(store), [['15551230001', 'failed', 'Unlucky']]);

  assert.equal(await saver.retry('15559999999'), false, 'unknown number');
  assert.equal(await saver.retry('15551230001'), true);
  await saver.idle();
  assert.deepEqual(summary(store), [['15551230001', 'saved', 'Unlucky']]);
  assert.equal(store.rows()[0]?.error, null);
  assert.equal(await saver.retry('15551230001'), false, 'a saved contact is not retried');
  assert.equal(sock.saved.length, 1);
});

test('the disconnect email goes out once when WhatsApp logs the user out', async () => {
  const sent: { url: string; body: { to: string; from: string; subject: string; text: string }; auth: string }[] = [];
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization! });
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  const mailer = createMailer({ apiKey: 're_x', from: 'SaveBot <hi@example.com>', appName: 'SaveBot', webUrl: 'https://app.example.com', fetchImpl });

  const store = new MemoryStore();
  store.addUser(USER);
  const sockets: FakeSocket[] = [];
  const loggedOut: string[] = [];
  const manager = new SessionManager(
    store,
    new PolicyCache(store, 0),
    (auth) => (sockets.push(new FakeSocket(auth.creds)), sockets.at(-1)!),
    undefined,
    { authRing: keyRing(KEY), onLoggedOut: (id) => void loggedOut.push(id) },
  );
  await manager.start(USER, '15550009999');
  assert.equal(manager.connectedSaver(USER), undefined, 'not connected yet');
  sockets[0]!.authState.creds.me = { id: 'paired' };
  sockets[0]!.ev.emit('connection.update', { connection: 'open' });
  await tick();
  assert.ok(manager.connectedSaver(USER));

  sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await tick();
  assert.deepEqual(loggedOut, [USER]);
  assert.equal(manager.connectedSaver(USER), undefined);

  await mailer.sendLoggedOut('max@example.com');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://api.resend.com/emails');
  assert.equal(sent[0]!.auth, 'Bearer re_x');
  assert.equal(sent[0]!.body.to, 'max@example.com');
  assert.match(sent[0]!.body.text, /https:\/\/app\.example\.com\/dashboard/);

  // Not configured: silently does nothing. A failing provider never throws.
  await createMailer({ appName: 'SaveBot', webUrl: 'x', fetchImpl }).sendLoggedOut('a@b.c');
  assert.equal(sent.length, 1);
  await createMailer({ apiKey: 'k', from: 'f', appName: 'S', webUrl: 'x', fetchImpl: (async () => { throw new Error('down'); }) as never }).sendLoggedOut('a@b.c');
});
