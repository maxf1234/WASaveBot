/**
 * Trigger parsing, for the accounts that run in phrase mode.
 *
 * No database and no socket, so every phrasing is cheap to assert. The cases
 * that matter are the ones that would otherwise put something embarrassing in a
 * real person's address book — a contact called "please", a whole sentence, a
 * row of emoji.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { extractName, parseTrigger } from '../src/trigger.js';

const phrases = { save: 'save my number', remove: 'remove my number' };

test('the phrase is recognised, and no name is invented when none is given', () => {
  for (const body of ['save my number', 'Save My Number', '  save my number  ', 'SAVE MY NUMBER']) {
    const result = parseTrigger(body, phrases);
    assert.equal(result.intent, 'save', body);
    assert.equal(result.name, undefined, body);
  }
});

test('a name in the message keeps its capitals', () => {
  assert.deepEqual(parseTrigger('save my number Dave Cohen', phrases), {
    intent: 'save',
    name: 'Dave Cohen',
  });
  assert.equal(parseTrigger('Save my number María José', phrases).name, 'María José');
  // Non-Latin names are names.
  assert.equal(parseTrigger('save my number 田中太郎', phrases).name, '田中太郎');
  assert.equal(parseTrigger('save my number مُحَمَّد', phrases).name, 'مُحَمَّد');
});

test('politeness never becomes a contact name', () => {
  // The bug in the obvious implementation: everyone polite gets saved as "please".
  for (const body of [
    'save my number please',
    'save my number, please',
    'save my number pls',
    'save my number thanks',
    'save my number please!',
    'save my number - thanks',
    'save my number ok thanks',
  ]) {
    const result = parseTrigger(body, phrases);
    assert.equal(result.intent, 'save', body);
    assert.equal(result.name, undefined, `${body} should yield no name`);
  }
});

test('politeness around a real name is stripped and the name survives', () => {
  assert.equal(parseTrigger('save my number please John', phrases).name, 'John');
  assert.equal(parseTrigger('save my number John thanks', phrases).name, 'John');
  assert.equal(parseTrigger('save my number - Dave Cohen', phrases).name, 'Dave Cohen');
});

test('a sentence is not a name', () => {
  for (const body of [
    'save my number I met you at the conference last week in Lagos',
    'save my number so you have it for the thing we discussed',
  ]) {
    assert.equal(parseTrigger(body, phrases).name, undefined, body);
  }
});

test('only the first line and first sentence are read', () => {
  assert.equal(parseTrigger('save my number John\nthanks for the call', phrases).name, 'John');
  assert.equal(parseTrigger('save my number John. Call me tomorrow', phrases).name, 'John');
});

test('emoji and punctuation alone do not make a name', () => {
  assert.equal(parseTrigger('save my number 🔥🔥🔥', phrases).name, undefined);
  assert.equal(parseTrigger('save my number ???', phrases).name, undefined);
  assert.equal(parseTrigger('save my number ---', phrases).name, undefined);
  // A name followed by an emoji keeps the name.
  assert.equal(parseTrigger('save my number John 👍', phrases).name, 'John');
});

test('the phrase has to lead the message', () => {
  // Each of these contains the phrase and none of them is a request.
  for (const body of [
    "don't save my number",
    'why would I save my number',
    'I would never save my number with a bot',
    'did you save my number?',
  ]) {
    assert.equal(parseTrigger(body, phrases).intent, 'none', body);
  }
});

test('a phrase that appears but does not lead is flagged as a near miss', () => {
  // The one case where the customer and the sender disagree about whether
  // anything should have happened, so it earns a row in the activity log.
  assert.equal(parseTrigger("don't save my number", phrases).nearMiss, true);
  assert.equal(parseTrigger('hello there', phrases).nearMiss, undefined);
  assert.equal(parseTrigger('save my number', phrases).nearMiss, undefined);
});

test('the phrase has to end on a word boundary', () => {
  const short = { save: 'save', remove: 'remove' };
  assert.equal(parseTrigger('saved the file', short).intent, 'none');
  assert.equal(parseTrigger('savings account', short).intent, 'none');
  assert.equal(parseTrigger('save', short).intent, 'save');
  assert.equal(parseTrigger('save Dave', short).intent, 'save');
});

test('the opt-out phrase wins over an overlapping save phrase', () => {
  assert.equal(parseTrigger('remove my number', phrases).intent, 'remove');
  assert.equal(parseTrigger('Remove My Number please', phrases).intent, 'remove');

  // A customer who sets overlapping phrases gets the reading that stops us
  // holding somebody's number, not the one that starts.
  const overlapping = { save: 'my number', remove: 'my number please' };
  assert.equal(parseTrigger('my number please', overlapping).intent, 'remove');
});

test('custom phrases work, including punctuated ones', () => {
  const custom = { save: 'add me', remove: 'forget me' };
  assert.deepEqual(parseTrigger('add me Sarah', custom), { intent: 'save', name: 'Sarah' });
  assert.equal(parseTrigger('forget me', custom).intent, 'remove');
  assert.equal(parseTrigger('save my number', custom).intent, 'none');
});

test('whitespace inside the phrase is tolerated', () => {
  assert.equal(parseTrigger('save  my   number  Dave', phrases).name, 'Dave');
});

test('an absurdly long name falls back rather than being truncated oddly', () => {
  assert.equal(parseTrigger(`save my number ${'x'.repeat(200)}`, phrases).name, undefined);
});

test('zero-width characters do not survive into a name', () => {
  assert.equal(parseTrigger('save my number Jo​hn', phrases).name, 'John');
});

test('an empty or filler-only tail yields no name', () => {
  assert.equal(extractName(''), undefined);
  assert.equal(extractName('   '), undefined);
  assert.equal(extractName('please'), undefined);
  assert.equal(extractName('ok thanks'), undefined);
});
