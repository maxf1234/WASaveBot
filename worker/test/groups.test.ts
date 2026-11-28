/**
 * Group members: extracted for everyone, saved only when asked, and never
 * past the rules, the opt-outs, the subscription or the day's cap.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { noBilling } from '../src/billing.js';
import { ContactSaver } from '../src/saver.js';
import { GROUP_RESCAN_MS, GROUP_SCAN_SETTLE_MS, SessionManager } from '../src/sessions.js';
import { PolicyCache } from '../src/store.js';
import { FakeSocket, MemoryStore, tick, USER } from './helpers.js';

function setup() {
  const store = new MemoryStore();
  store.addUser(USER);
  const sock = new FakeSocket();
  sock.groups = {
    'g1@g.us': {
      id: 'g1@g.us',
      subject: 'Football',
      participants: [
        { id: '15551110001@s.whatsapp.net', notify: 'Ana', admin: 'superadmin' },
        { id: '15551110002@s.whatsapp.net' },
        // Hidden number, but WhatsApp told us the mapping.
        { id: '900001@lid' },
        // Hidden number and no mapping: extracted, never saved.
        { id: '900002@lid' },
        // The user themselves.
        { id: '15550009999@s.whatsapp.net' },
      ],
    },
    'g2@g.us': {
      id: 'g2@g.us',
      subject: 'Family',
      participants: [
        { id: '15551110001@s.whatsapp.net', notify: 'Ana' },
        { id: '4471110003@s.whatsapp.net', notify: 'Ben', admin: 'admin' },
      ],
    },
  };
  sock.lidMap.set('900001@lid', '15551110004@s.whatsapp.net');
  const policy = new PolicyCache(store, 0);
  const saver = new ContactSaver(USER, store, policy, () => sock, { sleep: async () => {} });
  return { store, sock, saver };
}

test('every member of every group is extracted, with group, name, number and role', async () => {
  const { store, saver, sock } = setup();
  await saver.load();
  const scan = await saver.importGroups();

  assert.deepEqual(scan, { groups: 2, members: 6, people: 4, hidden: 1, queued: 0 });
  const rows = store.groupMembers.get(USER)!;
  assert.deepEqual(
    rows.map((r) => [r.group_name, r.phone, r.name, r.is_admin]),
    [
      ['Football', '15551110001', 'Ana', true],
      ['Football', '15551110002', null, false],
      ['Football', '15551110004', null, false],
      ['Football', null, null, false],
      ['Family', '15551110001', 'Ana', false],
      ['Family', '4471110003', 'Ben', true],
    ],
  );
  assert.equal(rows[3]!.lid, '900002@lid', 'a hidden number keeps its id');
  // Off by default: extracted, not saved, and no candidates created.
  assert.equal(sock.saved.length, 0);
  assert.equal(store.rows().length, 0);
  assert.deepEqual(sock.visibleCalls, []);
});

test('with group saving on, everyone with a number is saved once, by name', async () => {
  const { store, saver, sock } = setup();
  store.settings.get(USER)!.save_groups = true;
  await saver.load();
  const scan = await saver.importGroups();
  await saver.idle();

  assert.equal(scan.queued, 4);
  assert.deepEqual(
    sock.saved.map((s) => [s.jid, s.contact.fullName]).sort(),
    [
      ['15551110001@s.whatsapp.net', 'Ana'],
      ['15551110002@s.whatsapp.net', 'WA 0002'],
      ['15551110004@s.whatsapp.net', 'WA 0004'],
      ['4471110003@s.whatsapp.net', 'Ben'],
    ],
  );
  // A second scan finds them all already saved.
  assert.equal((await saver.importGroups()).queued, 0);
});

test('group saving respects the cap, and the next scan carries on', async () => {
  const { store, saver, sock } = setup();
  store.settings.get(USER)!.save_groups = true;
  store.settings.get(USER)!.daily_cap = 2;
  await saver.load();
  assert.equal((await saver.importGroups()).queued, 2);
  await saver.idle();
  assert.equal(sock.saved.length, 2);
  assert.equal(store.rows().filter((r) => r.status === 'pending').length, 2, 'the rest wait as candidates');
  // Same day: no room left.
  assert.equal((await saver.importGroups()).queued, 0);
});

test('group saving skips opt-outs and refused prefixes', async () => {
  const { store, saver, sock } = setup();
  const settings = store.settings.get(USER)!;
  settings.save_groups = true;
  await store.claimContact(USER, { phone: '15551110002', status: 'removed' });
  store.addRule(USER, 'block', '44');
  await saver.load();
  await saver.importGroups();
  await saver.idle();
  assert.deepEqual(sock.saved.map((s) => s.jid).sort(), ['15551110001@s.whatsapp.net', '15551110004@s.whatsapp.net']);
});

test('an unsubscribed or unarmed account extracts members but saves nobody', async () => {
  for (const tweak of ['unsubscribed', 'unarmed'] as const) {
    const { store, saver, sock } = setup();
    store.settings.get(USER)!.save_groups = true;
    if (tweak === 'unsubscribed') store.profiles.get(USER)!.subscription_status = 'none';
    else store.settings.get(USER)!.armed = false;
    await saver.load();
    const scan = await saver.importGroups();
    await saver.idle();
    assert.equal(scan.queued, 0, tweak);
    assert.equal(sock.saved.length, 0, tweak);
    assert.equal(store.groupMembers.get(USER)!.length, 6, `${tweak}: still extracted`);
  }
});

test('a name seen in a group message names that member', async () => {
  const { store, saver } = setup();
  await saver.load();
  await saver.onMessages([
    {
      key: { remoteJid: 'g1@g.us', participant: '15551110002@s.whatsapp.net' },
      pushName: 'Carla',
      message: { conversation: 'hi all' },
    },
  ]);
  await saver.importGroups();
  assert.equal(store.groupMembers.get(USER)!.find((r) => r.phone === '15551110002')?.name, 'Carla');
  assert.equal(store.rows().length, 0, 'a group message is never a save');
});

// ---------------------------------------------------------------- session manager

function managerSetup() {
  const store = new MemoryStore();
  store.addUser(USER);
  const sockets: FakeSocket[] = [];
  let clock = Date.parse('2026-11-28T12:00:00Z');
  const manager = new SessionManager(
    store,
    new PolicyCache(store, 0),
    (auth) => {
      const sock = new FakeSocket(auth.creds);
      sock.groups = { 'g@g.us': { id: 'g@g.us', subject: 'G', participants: [{ id: '15551110001@s.whatsapp.net' }] } };
      sockets.push(sock);
      return sock;
    },
    (() => 0 as unknown as NodeJS.Timeout) as never,
    { now: () => clock },
  );
  const advance = (ms: number) => {
    clock += ms;
  };
  return { store, sockets, manager, advance };
}

async function connect(m: ReturnType<typeof managerSetup>) {
  m.store.sessions.set(USER, { status: 'disconnected', desired: 'on' });
  await m.manager.reconcile();
  m.sockets[0]!.ev.emit('connection.update', { connection: 'open' });
  await tick();
}

test('a scan the customer asks for runs on the next reconcile and is cleared', async () => {
  const m = managerSetup();
  await connect(m);
  m.store.sessions.get(USER)!.groups_requested_at = new Date().toISOString();
  await m.manager.reconcile();
  assert.equal(m.store.groupMembers.get(USER)?.length, 1);
  assert.equal(m.store.sessions.get(USER)!.groups_requested_at, null);
  assert.ok(m.store.sessions.get(USER)!.groups_scanned_at);
});

test('with group saving on, scans happen by themselves after connecting and then daily', async () => {
  const m = managerSetup();
  m.store.settings.get(USER)!.save_groups = true;
  await connect(m);

  await m.manager.reconcile();
  assert.equal(m.store.groupMembers.get(USER), undefined, 'waits for WhatsApp to settle first');

  m.advance(GROUP_SCAN_SETTLE_MS);
  await m.manager.reconcile();
  assert.equal(m.store.groupMembers.get(USER)?.length, 1);

  m.store.groupMembers.delete(USER);
  m.advance(60_000);
  await m.manager.reconcile();
  assert.equal(m.store.groupMembers.get(USER), undefined, 'not again the same day');

  m.advance(GROUP_RESCAN_MS);
  await m.manager.reconcile();
  assert.equal(m.store.groupMembers.get(USER)?.length, 1, 'rescanned a day later');
});

test('with group saving off, nothing scans unless asked', async () => {
  const m = managerSetup();
  await connect(m);
  m.advance(GROUP_RESCAN_MS * 2);
  await m.manager.reconcile();
  assert.equal(m.store.groupMembers.get(USER), undefined);
});

// ---------------------------------------------------------------- API

test('the scan endpoint needs a connected WhatsApp and writes intent', async () => {
  const store = new MemoryStore();
  store.addUser(USER);
  const nudges: string[] = [];
  const app = createApp({
    webUrl: 'https://savebot.example',
    verifyToken: async () => ({ id: USER, email: null }),
    store,
    billing: noBilling,
    sessions: { count: () => 0, nudge: () => void nudges.push('n') },
  });
  const server = app.listen(0);
  after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/groups/scan`;
  const post = () => fetch(url, { method: 'POST', headers: { authorization: 'Bearer t' } });

  assert.equal((await post()).status, 409);
  store.sessions.get(USER)!.status = 'connected';
  assert.equal((await post()).status, 200);
  assert.ok(store.sessions.get(USER)!.groups_requested_at);
  assert.equal(nudges.length, 1);
});
