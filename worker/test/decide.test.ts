/**
 * The decision, as a pure function.
 *
 * This is the file that makes the product's riskiest property checkable: the
 * service writes into somebody's real address book, which syncs to their phone,
 * and "an unarmed account never writes" has to hold on every path rather than
 * on the ones somebody remembered to guard.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { decide } from '../src/decide.js';
import type { DecideFacts, DecideSettings } from '../src/decide.js';
import type { PrefixRule } from '../src/rules.js';

const PHONE = '15551234567';

const settings = (patch: Partial<DecideSettings> = {}): DecideSettings => ({
  enabled: true,
  armed: true,
  save_mode: 'everyone',
  save_phrase: 'save my number',
  remove_phrase: 'remove my number',
  default_policy: 'allow',
  ...patch,
});

const facts = (patch: Partial<DecideFacts> = {}): DecideFacts => ({
  alreadyKnown: false,
  optedOut: false,
  subscribed: true,
  capped: false,
  ...patch,
});

const noRules: PrefixRule[] = [];

// ---------------------------------------------------------------- everyone mode

test('in everyone mode, any message from a new person is a save', () => {
  const verdict = decide({ phone: PHONE, body: 'hi there' }, settings(), noRules, facts());
  assert.equal(verdict.action, 'save');
  assert.equal(verdict.decision, 'saved');
});

test('a message from somebody already known is silent, not an event', () => {
  // Ongoing conversations are most of the traffic; a row each would bury the log.
  const verdict = decide({ phone: PHONE, body: 'hi' }, settings(), noRules, facts({ alreadyKnown: true }));
  assert.equal(verdict.decision, 'already_known');
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.silent, true);
});

test('a sender with no number is recorded rather than dropped', () => {
  const verdict = decide({ body: 'hi' }, settings(), noRules, facts());
  assert.equal(verdict.decision, 'unresolved');
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.silent, false);
});

// ---------------------------------------------------------------- phrase mode

test('in phrase mode, an ordinary message saves nobody and says nothing', () => {
  const verdict = decide(
    { phone: PHONE, body: 'hey, are you free tomorrow?' },
    settings({ save_mode: 'phrase' }),
    noRules,
    facts(),
  );
  assert.equal(verdict.decision, 'no_trigger');
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.silent, true, 'ordinary traffic is not an event');
});

test('in phrase mode, the phrase saves them under the name they gave', () => {
  const verdict = decide(
    { phone: PHONE, body: 'save my number Dave Cohen' },
    settings({ save_mode: 'phrase' }),
    noRules,
    facts(),
  );
  assert.equal(verdict.action, 'save');
  assert.equal(verdict.requestedName, 'Dave Cohen');
});

test('in phrase mode, a near miss is recorded so it can be explained', () => {
  const verdict = decide(
    { phone: PHONE, body: "don't save my number" },
    settings({ save_mode: 'phrase' }),
    noRules,
    facts(),
  );
  assert.equal(verdict.decision, 'no_trigger');
  assert.equal(verdict.silent, false);
  assert.match(verdict.detail ?? '', /not at the start/);
});

test('the save phrase is ignored in everyone mode, because everything saves anyway', () => {
  const verdict = decide({ phone: PHONE, body: 'anything at all' }, settings(), noRules, facts());
  assert.equal(verdict.action, 'save');
});

// ---------------------------------------------------------------- opt-out

test('an opt-out removes somebody we hold', () => {
  const verdict = decide(
    { phone: PHONE, body: 'remove my number' },
    settings(),
    noRules,
    facts({ alreadyKnown: true }),
  );
  assert.equal(verdict.action, 'remove');
  assert.equal(verdict.decision, 'removed');
});

test('an opt-out works in everyone mode too', () => {
  // The mode decides who gets saved; it must not decide who may leave.
  const verdict = decide(
    { phone: PHONE, body: 'remove my number' },
    settings({ save_mode: 'everyone' }),
    noRules,
    facts({ alreadyKnown: true }),
  );
  assert.equal(verdict.action, 'remove');
});

test('an opt-out from somebody we never had is recorded, not an error', () => {
  const verdict = decide({ phone: PHONE, body: 'remove my number' }, settings(), noRules, facts());
  assert.equal(verdict.decision, 'not_found');
  assert.equal(verdict.action, 'none');
});

test('an opt-out outranks everything that could block a save', () => {
  // A rule refusing their country must not also trap them in the address book,
  // a spent cap is about how fast we write rather than whether we may stop, and
  // the safety catch exists to prevent writing somebody in, not letting them out.
  const blocked: PrefixRule[] = [{ id: 1, kind: 'block', prefix: '1555' }];
  for (const [label, s, f] of [
    ['a blocking rule', settings(), facts({ alreadyKnown: true })],
    ['a spent cap', settings(), facts({ alreadyKnown: true, capped: true })],
    ['saving switched off', settings({ enabled: false }), facts({ alreadyKnown: true })],
    ['watch-only', settings({ armed: false }), facts({ alreadyKnown: true })],
    ['no subscription', settings(), facts({ alreadyKnown: true, subscribed: false })],
    ['an allowlist', settings({ default_policy: 'block' }), facts({ alreadyKnown: true })],
  ] as const) {
    const verdict = decide({ phone: PHONE, body: 'remove my number' }, s, blocked, f);
    assert.equal(verdict.action, 'remove', `opt-out must survive ${label}`);
  }
});

test('an opt-out is not undone by the next ordinary message', () => {
  // The bug this pins: in everyone mode, messaging is not asking. If an opt-out
  // only lasted until the sender's next message it would be no opt-out at all.
  for (const save_mode of ['everyone', 'phrase'] as const) {
    const verdict = decide(
      { phone: PHONE, body: 'hey, you around?' },
      settings({ save_mode }),
      noRules,
      facts({ optedOut: true }),
    );
    assert.equal(verdict.action, 'none', save_mode);
    assert.equal(verdict.silent, true, save_mode);
  }
});

test('somebody who opted out and asks again is saved, and the row says so', () => {
  const verdict = decide(
    { phone: PHONE, body: 'save my number' },
    settings({ save_mode: 'phrase' }),
    noRules,
    facts({ optedOut: true }),
  );
  assert.equal(verdict.action, 'save', 'asking again is fresh consent');
  assert.match(verdict.detail ?? '', /after an earlier opt-out/);
});

// ---------------------------------------------------------------- gates

test('a blocking rule refuses the save and names the rule', () => {
  const rules: PrefixRule[] = [{ id: 9, kind: 'block', prefix: '1555' }];
  const verdict = decide({ phone: PHONE, body: 'hi' }, settings(), rules, facts());
  assert.equal(verdict.decision, 'blocked_prefix');
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.matchedPrefix, '1555');
  assert.equal(verdict.ruleId, 9);
});

test('an allowlist refuses an unmatched number and explains why', () => {
  const verdict = decide({ phone: PHONE, body: 'hi' }, settings({ default_policy: 'block' }), noRules, facts());
  assert.equal(verdict.decision, 'blocked_prefix');
  assert.match(verdict.detail ?? '', /refuses by default/);
});

test('a refused number does not consume the daily budget', () => {
  // Rules are checked before the cap, so a flood of numbers the customer
  // refuses anyway leaves the budget for the ones they want.
  const rules: PrefixRule[] = [{ id: 1, kind: 'block', prefix: '1555' }];
  const verdict = decide({ phone: PHONE, body: 'hi' }, settings(), rules, facts({ capped: true }));
  assert.equal(verdict.decision, 'blocked_prefix');
});

test('a spent cap holds the person rather than losing them', () => {
  const verdict = decide({ phone: PHONE, body: 'hi' }, settings(), noRules, facts({ capped: true }));
  assert.equal(verdict.decision, 'capped');
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.silent, false, 'the customer can see who is waiting');
});

test('no subscription and saving switched off are told apart', () => {
  assert.equal(
    decide({ phone: PHONE, body: 'hi' }, settings(), noRules, facts({ subscribed: false })).decision,
    'unsubscribed',
  );
  assert.equal(
    decide({ phone: PHONE, body: 'hi' }, settings({ enabled: false }), noRules, facts()).decision,
    'disabled',
  );
});

// ---------------------------------------------------------------- free preview

test('an unsubscribed account previews rather than being turned away', () => {
  const verdict = decide({ phone: PHONE, body: 'hi' }, settings(), noRules, facts({ subscribed: false }));
  assert.equal(verdict.decision, 'unsubscribed');
  assert.equal(verdict.action, 'none', 'nothing is written');
  assert.equal(verdict.silent, false, 'but they can see who it would have been');
  assert.match(verdict.detail ?? '', /subscribe/);
});

test('the preview is honest about numbers a rule would have refused', () => {
  // The subscription check sits below the rules for this reason: telling
  // somebody to subscribe in order to save a number their own rule refuses
  // would be a lie in the exact place they are deciding whether to pay.
  const rules: PrefixRule[] = [{ id: 1, kind: 'block', prefix: '1555' }];
  const verdict = decide({ phone: PHONE, body: 'hi' }, settings(), rules, facts({ subscribed: false }));
  assert.equal(verdict.decision, 'blocked_prefix');
});

test('a preview is not limited by the daily cap, because it writes nothing', () => {
  const verdict = decide(
    { phone: PHONE, body: 'hi' },
    settings(),
    noRules,
    facts({ subscribed: false, capped: true }),
  );
  assert.equal(verdict.decision, 'unsubscribed', 'not capped');
});

test('arming without paying still writes nothing', () => {
  // The web app writes settings straight to Supabase, so `armed` is not a
  // trusted input. The worker is the only thing that writes contacts, and this
  // is where it refuses.
  const verdict = decide(
    { phone: PHONE, body: 'hi' },
    settings({ armed: true }),
    noRules,
    facts({ subscribed: false }),
  );
  assert.notEqual(verdict.action, 'save');
  assert.equal(verdict.decision, 'unsubscribed');
});

// ---------------------------------------------------------------- the property

test('an unarmed account never writes to an address book, under any settings', () => {
  const bodies = ['hi there', 'save my number', 'save my number Dave', "don't save my number", ''];
  const ruleSets: PrefixRule[][] = [
    [],
    [{ id: 1, kind: 'block', prefix: '1555' }],
    [{ id: 2, kind: 'allow', prefix: '1555' }],
    [{ id: 3, kind: 'block', prefix: '1' }, { id: 4, kind: 'allow', prefix: '1555' }],
  ];

  let checked = 0;
  for (const body of bodies) {
    for (const rules of ruleSets) {
      for (const save_mode of ['everyone', 'phrase'] as const) {
        for (const default_policy of ['allow', 'block'] as const) {
          for (const enabled of [true, false]) {
            for (const subscribed of [true, false]) {
              for (const capped of [true, false]) {
                for (const optedOut of [true, false]) {
                  const verdict = decide(
                    { phone: PHONE, body },
                    settings({ armed: false, save_mode, default_policy, enabled }),
                    rules,
                    // alreadyKnown is false throughout: with it true the only
                    // reachable write is the opt-out, which is asserted above
                    // to work precisely because `armed` must not gate it.
                    facts({ alreadyKnown: false, subscribed, capped, optedOut }),
                  );
                  checked += 1;
                  assert.notEqual(
                    verdict.action,
                    'save',
                    `unarmed account produced a save: body=${JSON.stringify(body)} mode=${save_mode} policy=${default_policy}`,
                  );
                  assert.notEqual(verdict.decision, 'saved', 'and must not report one either');
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked >= 640, `expected a broad sweep, only checked ${checked}`);
});

test('an unarmed account still records what it would have done', () => {
  const verdict = decide({ phone: PHONE, body: 'hi' }, settings({ armed: false }), noRules, facts());
  assert.equal(verdict.decision, 'would_save');
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.silent, false);
  assert.match(verdict.detail ?? '', /watch-only/);
});
