/**
 * Prefix rules: normalisation, longest-match resolution, and the two policies.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPrefix, InvalidPrefixError, matchPrefix, normalizePrefix } from '../src/rules.js';
import type { PrefixRule } from '../src/rules.js';

const rule = (id: number, kind: 'block' | 'allow', prefix: string): PrefixRule => ({ id, kind, prefix });

test('normalizePrefix accepts the shapes people type', () => {
  assert.equal(normalizePrefix('+234'), '234');
  assert.equal(normalizePrefix('234'), '234');
  assert.equal(normalizePrefix('00234'), '234');
  assert.equal(normalizePrefix(' +2 3 4 '), '234');
  assert.equal(normalizePrefix('+1 (917)'), '1917');
});

test('a bare three-digit code means an area code only when the caller says so', () => {
  // '917' as typed means New York to a person and "anything starting 917" to a
  // matcher, so the caller has to say which was meant.
  assert.equal(normalizePrefix('917'), '917');
  assert.equal(normalizePrefix('917', true), '1917');
  // Four digits is already unambiguous, so the flag does not apply.
  assert.equal(normalizePrefix('1917', true), '1917');
});

test('unusable prefixes are refused rather than guessed at', () => {
  for (const input of ['', 'abc', '0', '0123', '+0', '-', '0000']) {
    assert.throws(() => normalizePrefix(input), InvalidPrefixError, input);
  }
});

test('the longest matching prefix wins', () => {
  const rules = [rule(1, 'block', '1'), rule(2, 'allow', '1917'), rule(3, 'block', '19175')];
  assert.equal(matchPrefix('15551234567', rules)?.rule.id, 1);
  assert.equal(matchPrefix('19171234567', rules)?.rule.id, 2);
  assert.equal(matchPrefix('19175551234', rules)?.rule.id, 3);
  assert.equal(matchPrefix('447911123456', rules), undefined);
});

test('match order does not matter', () => {
  const forwards = [rule(1, 'block', '1'), rule(2, 'allow', '1917')];
  const backwards = [rule(2, 'allow', '1917'), rule(1, 'block', '1')];
  assert.equal(matchPrefix('19171234567', forwards)?.rule.id, 2);
  assert.equal(matchPrefix('19171234567', backwards)?.rule.id, 2);
});

test('under a blocklist, anything unmatched is allowed', () => {
  const rules = [rule(1, 'block', '234')];
  assert.equal(checkPrefix('447911123456', rules, 'allow').allowed, true);
  assert.equal(checkPrefix('2348031234567', rules, 'allow').allowed, false);
});

test('under an allowlist, anything unmatched is refused and says so', () => {
  const rules = [rule(1, 'allow', '44')];
  const allowed = checkPrefix('447911123456', rules, 'block');
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.matchedPrefix, '44');

  const refused = checkPrefix('2348031234567', rules, 'block');
  assert.equal(refused.allowed, false);
  assert.equal(refused.byDefault, true, 'the reason is the policy, not a rule');
  assert.equal(refused.matchedPrefix, undefined);
});

test('a longer allow rule carves an exception out of a block rule', () => {
  // The case customers actually ask for: refuse a country, keep one contact.
  const rules = [rule(1, 'block', '234'), rule(2, 'allow', '234803')];
  assert.equal(checkPrefix('2348031234567', rules, 'allow').allowed, true);
  assert.equal(checkPrefix('2347011234567', rules, 'allow').allowed, false);
});

test('a longer block rule carves an exception out of an allow rule', () => {
  const rules = [rule(1, 'allow', '1'), rule(2, 'block', '1900')];
  assert.equal(checkPrefix('15551234567', rules, 'block').allowed, true);
  assert.equal(checkPrefix('19005551234', rules, 'block').allowed, false);
});

test('an empty rule set follows the policy alone', () => {
  assert.equal(checkPrefix('15551234567', [], 'allow').allowed, true);
  assert.equal(checkPrefix('15551234567', [], 'block').allowed, false);
});

test('the matched rule is reported so the activity log can name it', () => {
  const rules = [rule(7, 'block', '234')];
  const verdict = checkPrefix('2348031234567', rules, 'allow');
  assert.equal(verdict.ruleId, 7);
  assert.equal(verdict.matchedPrefix, '234');
});
