/**
 * The saver, driven end to end against fakes: the two save modes, the opt-out,
 * the rules, the watch-only catch and the activity log.
 *
 * These complement decide.test.ts rather than repeating it. Where that asserts
 * the judgement, these assert that the judgement is actually carried out — that
 * a verdict of 'remove' reaches removeContact, that a watch-only account leaves
 * the fake socket untouched, and that every refusal leaves a row behind.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContactSaver } from '../src/saver.js';
import { PolicyCache } from '../src/store.js';
import { FakeSocket, MemoryStore, msg, USER } from './helpers.js';

/** A message with a body, which the new trigger handling needs. */
const said = (jid: string, body: string, pushName = 'Sender') => ({
  ...msg(jid, pushName),
  message: { conversation: body },
});

function setup() {
  const store = new MemoryStore();
  store.addUser(USER);
  const sock = new FakeSocket();
  const saver = new ContactSaver(USER, store, new PolicyCache(store, 0), () => sock, {
    sleep: async () => {},
  });
  return { store, sock, saver };
}

const JID = '15551230001@s.whatsapp.net';
const PHONE = '15551230001';

// ---------------------------------------------------------------- watch-only

test('a watch-only account writes nothing and records what it would have done', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.armed = false;
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();

  assert.deepEqual(sock.saved, [], 'nothing reached WhatsApp');
  assert.deepEqual(store.decisions(), ['would_save']);
  assert.equal(store.rows().length, 0, 'and no contact row was claimed');
});

test('arming it afterwards saves the next person', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.armed = false;
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();
  assert.equal(sock.saved.length, 0);

  store.settings.get(USER)!.armed = true;
  await saver.onMessages([said('15551230002@s.whatsapp.net', 'hello')]);
  await saver.idle();
  assert.equal(sock.saved.length, 1);
});

// ---------------------------------------------------------------- phrase mode

test('in phrase mode an ordinary message saves nobody and logs nothing', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.save_mode = 'phrase';
  await saver.load();
  await saver.onMessages([said(JID, 'hey, are you around?')]);
  await saver.idle();

  assert.deepEqual(sock.saved, []);
  assert.deepEqual(store.decisions(), [], 'ordinary traffic is not an event');
});

test('in phrase mode the phrase saves them under the name they gave', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.save_mode = 'phrase';
  await saver.load();
  await saver.onMessages([said(JID, 'save my number Dave Cohen', 'dave99')]);
  await saver.idle();

  assert.equal(sock.saved.length, 1);
  // The name they asked for beats their push name, which is the whole point of
  // letting them ask.
  assert.equal(sock.saved[0]!.contact.fullName, 'Dave Cohen');
  assert.equal(store.rows()[0]!.requested_name, 'Dave Cohen');
  assert.deepEqual(store.decisions(), ['saved']);
});

test('in phrase mode a caption counts as a message', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.save_mode = 'phrase';
  await saver.load();
  await saver.onMessages([
    { ...msg(JID, 'Sender'), message: { imageMessage: { caption: 'save my number Ada' } } },
  ]);
  await saver.idle();
  assert.equal(sock.saved[0]?.contact.fullName, 'Ada');
});

test('a message with no readable body saves nobody in phrase mode', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.save_mode = 'phrase';
  await saver.load();
  // A sticker: nothing to read, so nothing to act on.
  await saver.onMessages([{ ...msg(JID, 'Sender'), message: {} }]);
  await saver.idle();
  assert.deepEqual(sock.saved, []);
});

// ---------------------------------------------------------------- opt-out

test('an opt-out removes the contact and remembers that they asked', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();
  assert.equal(sock.saved.length, 1);

  await saver.onMessages([said(JID, 'remove my number')]);
  await saver.idle();

  assert.deepEqual(sock.removed, [JID], 'the contact was taken out of WhatsApp');
  assert.equal(store.rows()[0]!.status, 'removed');
  assert.deepEqual(store.decisions(), ['saved', 'removed']);
});

test('a removed person is not re-saved by their next ordinary message', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();
  await saver.onMessages([said(JID, 'remove my number')]);
  await saver.idle();
  assert.equal(sock.saved.length, 1);

  // In everyone mode this is the case that matters: without the opt-out being
  // remembered, the very next message would put them straight back.
  await saver.onMessages([said(JID, 'hello again')]);
  await saver.idle();
  assert.equal(sock.saved.length, 1, 'still just the original save');
  assert.equal(store.rows()[0]!.status, 'removed');
});

test('a removed person who asks again is saved again', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.save_mode = 'phrase';
  await saver.load();
  await saver.onMessages([said(JID, 'save my number')]);
  await saver.idle();
  await saver.onMessages([said(JID, 'remove my number')]);
  await saver.idle();
  assert.equal(store.rows()[0]!.status, 'removed');

  await saver.onMessages([said(JID, 'save my number Ada')]);
  await saver.idle();
  assert.equal(sock.saved.length, 2, 'asking again is fresh consent');
  assert.equal(store.rows().length, 1, 'on the same row, not a second one');
  assert.equal(store.rows()[0]!.status, 'saved');
});

test('an opt-out we cannot carry out leaves the row alone and says so', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();

  sock.failNextRemove = 1;
  await saver.onMessages([said(JID, 'remove my number')]);
  await saver.idle();

  // The contact is still in their address book, so the row must not claim
  // otherwise — that row is the only place the customer can check.
  assert.equal(store.rows()[0]!.status, 'saved');
  assert.deepEqual(store.decisions(), ['saved', 'failed']);
});

test('an opt-out from somebody we never had is recorded, not acted on', async () => {
  const { store, sock, saver } = setup();
  await saver.load();
  await saver.onMessages([said(JID, 'remove my number')]);
  await saver.idle();
  assert.deepEqual(sock.removed, []);
  assert.deepEqual(store.decisions(), ['not_found']);
});

// ---------------------------------------------------------------- rules

test('a blocking rule refuses the save and names itself in the log', async () => {
  const { store, sock, saver } = setup();
  const rule = store.addRule(USER, 'block', '1555');
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();

  assert.deepEqual(sock.saved, []);
  const event = store.eventRows()[0]!;
  assert.equal(event.decision, 'blocked_prefix');
  assert.equal(event.matched_prefix, '1555');
  assert.equal(event.rule_id, rule.id);
});

test('a longer allow rule lets one range through a blocked country', async () => {
  const { store, sock, saver } = setup();
  store.addRule(USER, 'block', '1');
  store.addRule(USER, 'allow', '1555');
  await saver.load();
  await saver.onMessages([said(JID, 'hello'), said('16175550000@s.whatsapp.net', 'hello')]);
  await saver.idle();

  assert.deepEqual(
    sock.saved.map((s) => s.jid),
    [JID],
    'only the allowed range is saved',
  );
});

test('a disabled rule is ignored', async () => {
  const { store, sock, saver } = setup();
  const rule = store.addRule(USER, 'block', '1555');
  rule.enabled = false;
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();
  assert.equal(sock.saved.length, 1);
});

test('an allowlist refuses everyone no rule covers', async () => {
  const { store, sock, saver } = setup();
  store.settings.get(USER)!.default_policy = 'block';
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();
  assert.deepEqual(sock.saved, []);
  assert.deepEqual(store.decisions(), ['blocked_prefix']);
});

// ---------------------------------------------------------------- the log

test('every refusal leaves a row that explains itself', async () => {
  const { store, saver } = setup();
  store.profiles.get(USER)!.subscription_status = 'canceled';
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();

  const event = store.eventRows()[0]!;
  assert.equal(event.decision, 'unsubscribed');
  assert.equal(event.phone, PHONE);
  assert.ok(event.detail, 'and carries a reason in words');
});

test('the log never carries the message body', async () => {
  const { store, saver } = setup();
  store.settings.get(USER)!.save_mode = 'phrase';
  await saver.load();
  const secret = 'save my number Ada and by the way my password is hunter2';
  await saver.onMessages([said(JID, secret)]);
  await saver.idle();

  const serialised = JSON.stringify(store.eventRows());
  assert.doesNotMatch(serialised, /hunter2/, 'no message content reaches the activity log');
  assert.doesNotMatch(JSON.stringify(store.rows()), /hunter2/, 'nor the contact row');
});

test('an ongoing conversation with a known person logs nothing', async () => {
  const { store, saver } = setup();
  await saver.load();
  await saver.onMessages([said(JID, 'hello')]);
  await saver.idle();
  const after = store.eventRows().length;

  for (let i = 0; i < 5; i++) await saver.onMessages([said(JID, `message ${i}`)]);
  await saver.idle();
  assert.equal(store.eventRows().length, after, 'no rows for traffic from somebody already saved');
});
