import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildName, cleanPushName } from '../src/naming.js';
import { ContactSaver } from '../src/saver.js';
import { PolicyCache } from '../src/store.js';
import { defaultSettings, FakeSocket, MemoryStore, msg, USER } from './helpers.js';

function setup(opts: { sleeps?: number[] } = {}) {
  const store = new MemoryStore();
  store.addUser(USER);
  const sock = new FakeSocket();
  const policy = new PolicyCache(store, 0);
  const saver = new ContactSaver(USER, store, policy, () => sock, {
    sleep: async (ms) => {
      opts.sleeps?.push(ms);
    },
  });
  return { store, sock, saver, policy };
}

test('a new private sender is saved under their number and push name', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'Dana Levi')]);
  await saver.idle();

  assert.deepEqual(sock.saved, [
    {
      jid: '15551230001@s.whatsapp.net',
      contact: { fullName: 'Dana Levi', firstName: 'Dana', saveOnPrimaryAddressbook: true },
    },
  ]);
  const [row] = store.rows();
  assert.equal(row?.phone, '15551230001');
  assert.equal(row?.status, 'saved');
  assert.equal(row?.saved_name, 'Dana Levi');
  assert.equal(row?.push_name, 'Dana Levi');
});

test('the same number messaging again creates nothing new', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'Dana'), msg('15551230001@s.whatsapp.net', 'Dana')]);
  await saver.idle();
  await saver.onMessages([msg('15551230001:7@s.whatsapp.net', 'Dana')]);
  await saver.idle();
  assert.equal(sock.saved.length, 1);
  assert.equal(store.rows().length, 1);
});

test('a number saved before a restart is not saved again', async () => {
  const { store, sock, saver } = setup();
  await store.insertContact(USER, { phone: '15551230001', status: 'saved' });
  await saver.load();
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'Dana')]);
  await saver.idle();
  assert.equal(sock.saved.length, 0);
});

test('groups, status, broadcasts, channels and own messages create nothing', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([
    msg('120363000000000000@g.us', 'Group Person', { participant: '15551230002@s.whatsapp.net' }),
    msg('status@broadcast', 'Status Person'),
    msg('12345@broadcast', 'List'),
    msg('120363111111111111@newsletter', 'Channel'),
    msg('15551230003@s.whatsapp.net', 'Me', { fromMe: true }),
    msg('15550009999@s.whatsapp.net', 'My other phone'),
  ]);
  await saver.idle();
  assert.equal(sock.saved.length, 0);
  assert.equal(store.rows().length, 0);
});

test('an @lid sender is saved under the real number from remoteJidAlt', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([msg('99887766554433@lid', 'Lid Person', { remoteJidAlt: '15551230004@s.whatsapp.net' })]);
  await saver.idle();
  assert.equal(sock.saved[0]?.jid, '15551230004@s.whatsapp.net');
  assert.equal(store.rows()[0]?.phone, '15551230004');
  assert.equal(store.rows()[0]?.lid, '99887766554433@lid');
});

test('an @lid sender without remoteJidAlt is resolved through the LID mapping', async () => {
  const { store, sock, saver } = setup();
  sock.lidMap.set('99887766554433@lid', '15551230005:0@s.whatsapp.net');
  await saver.load();
  await saver.onMessages([msg('99887766554433@lid', 'Lid Person')]);
  await saver.idle();
  assert.equal(sock.saved[0]?.jid, '15551230005@s.whatsapp.net');
  assert.equal(store.rows()[0]?.phone, '15551230005');
});

test('an @lid sender with no known number is recorded once as unresolved, then saved when it resolves', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([msg('99887766554433@lid', 'Ghost'), msg('99887766554433@lid', 'Ghost')]);
  await saver.idle();
  assert.equal(sock.saved.length, 0);
  assert.deepEqual(
    store.rows().map((r) => [r.phone, r.status]),
    [['lid:99887766554433', 'unresolved']],
  );

  sock.lidMap.set('99887766554433@lid', '15551230006@s.whatsapp.net');
  await saver.onMessages([msg('99887766554433@lid', 'Ghost')]);
  await saver.idle();
  assert.deepEqual(
    store.rows().map((r) => [r.phone, r.status]),
    [['15551230006', 'saved']],
  );
});

test('empty and emoji-only names get the fallback name', async () => {
  const { sock, saver } = setup();
  await saver.load();
  await saver.onMessages([
    msg('15551231111@s.whatsapp.net', ''),
    msg('15551232222@s.whatsapp.net', '🔥🔥'),
    msg('15551233333@s.whatsapp.net', null),
    msg('15551234444@s.whatsapp.net', '   ​ '),
  ]);
  await saver.idle();
  assert.deepEqual(
    sock.saved.map((s) => s.contact.fullName),
    ['WA 1111', 'WA 2222', 'WA 3333', 'WA 4444'],
  );
  assert.equal(sock.saved[0]?.contact.firstName, 'WA');
});

test('name cleaning and the template', () => {
  assert.equal(cleanPushName('  Dana \t\n  Levi\u0007 '), 'Dana Levi');
  assert.equal(cleanPushName('x'.repeat(100)).length, 60);
  const s = { ...defaultSettings(), name_template: '{name} (WA)' };
  assert.equal(buildName('Dana 🌸', '15551230001', s), 'Dana 🌸 (WA)');
  assert.equal(buildName('', '15551230001', { ...s, fallback_prefix: 'Lead' }), 'Lead 0001');
  // A template that lost its placeholder must not give everyone the same name.
  assert.equal(buildName('Dana', '1', { ...s, name_template: 'oops' }), 'Dana');
});

test('settings: disabled or unsubscribed saves nothing; save_to_phone is passed through', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  store.settings.get(USER)!.enabled = false;
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'A')]);
  await saver.idle();
  store.settings.get(USER)!.enabled = true;
  store.profiles.get(USER)!.subscription_status = 'canceled';
  await saver.onMessages([msg('15551230002@s.whatsapp.net', 'B')]);
  await saver.idle();
  assert.equal(sock.saved.length, 0);
  assert.equal(store.rows().length, 0);

  store.profiles.get(USER)!.subscription_status = 'trialing';
  store.settings.get(USER)!.save_to_phone = false;
  await saver.onMessages([msg('15551230003@s.whatsapp.net', 'C')]);
  await saver.idle();
  assert.equal(sock.saved[0]?.contact.saveOnPrimaryAddressbook, false);
});

test('saves run one at a time, 3 to 6 seconds apart', async () => {
  const sleeps: number[] = [];
  const { sock, saver } = setup({ sleeps });
  await saver.load();
  await saver.onMessages([
    msg('15551230001@s.whatsapp.net', 'A'),
    msg('15551230002@s.whatsapp.net', 'B'),
    msg('15551230003@s.whatsapp.net', 'C'),
  ]);
  await saver.idle();
  assert.equal(sock.saved.length, 3);
  assert.equal(sleeps.length, 2, 'no wait before the first save, one before each later one');
  for (const ms of sleeps) assert.ok(ms > 2900 && ms <= 6000, `gap ${ms}`);
});

test('the daily cap stops the queue and drops what is left', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.daily_cap = 2;
  await saver.load();
  await saver.onMessages([1, 2, 3, 4].map((n) => msg(`1555123000${n}@s.whatsapp.net`, `P${n}`)));
  await saver.idle();
  assert.equal(sock.saved.length, 2);
  assert.equal(store.rows().length, 2, 'dropped jobs leave no row');

  // Saves made earlier today (before a restart) count towards the cap too.
  const again = new ContactSaver(USER, store, new PolicyCache(store, 0), () => sock, { sleep: async () => {} });
  await again.load();
  await again.onMessages([msg('15551230009@s.whatsapp.net', 'Late')]);
  await again.idle();
  assert.equal(sock.saved.length, 2);
});

test('a failed save is retried once, then recorded as failed and never tried again', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  sock.failNext = 1;
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'Retry Me')]);
  await saver.idle();
  assert.equal(store.rows()[0]?.status, 'saved', 'one retry succeeds');

  sock.failNext = 5;
  await saver.onMessages([msg('15551230002@s.whatsapp.net', 'Unlucky')]);
  await saver.idle();
  assert.equal(sock.failNext, 3, 'exactly two attempts');
  assert.equal(store.rows()[1]?.status, 'failed');
  assert.equal(store.rows()[1]?.error, 'boom');

  await saver.onMessages([msg('15551230002@s.whatsapp.net', 'Unlucky')]);
  await saver.idle();
  assert.equal(sock.failNext, 3);
});

test('a contact the user named by hand is recorded as existing and left untouched', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onContacts([
    { id: '15551230001@s.whatsapp.net', name: 'Mum', notify: 'Ruth' },
    { id: '99887766554433@lid', phoneNumber: '15551230002@s.whatsapp.net', name: 'Boss' },
    { id: '15551230003@s.whatsapp.net', notify: 'No saved name' },
  ]);
  await saver.onMessages([
    msg('15551230001@s.whatsapp.net', 'Ruth'),
    msg('15551230002@s.whatsapp.net', 'B'),
    msg('15551230003@s.whatsapp.net', 'No saved name'),
  ]);
  await saver.idle();

  assert.deepEqual(
    sock.saved.map((s) => s.jid),
    ['15551230003@s.whatsapp.net'],
    'only the one with no name of its own',
  );
  assert.deepEqual(
    store.rows().map((r) => [r.phone, r.status, r.saved_name]),
    [
      ['15551230001', 'existing', 'Mum'],
      ['15551230002', 'existing', 'Boss'],
      ['15551230003', 'saved', 'No saved name'],
    ],
  );
});

test("WhatsApp echoing our own save back does not turn 'saved' into 'existing'", async () => {
  const { store, saver } = setup();
  await saver.load();
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'Dana')]);
  await saver.idle();
  await saver.onContacts([{ id: '15551230001@s.whatsapp.net', name: 'Dana' }]);
  await saver.idle();
  assert.deepEqual(
    store.rows().map((r) => r.status),
    ['saved'],
  );
});

test('nothing visible to the other person is ever called', async () => {
  const { sock, saver } = setup();
  await saver.load();
  await saver.onMessages([msg('15551230001@s.whatsapp.net', 'Dana')]);
  await saver.idle();
  assert.deepEqual(sock.visibleCalls, []);
});
