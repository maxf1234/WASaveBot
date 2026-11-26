/**
 * Prefix rules: which numbers a customer is willing to have in their address book.
 *
 * Every rule is a leading-digit prefix on the full international number with no
 * '+'. That one shape covers both things customers ask for:
 *
 *   '234'   — all of Nigeria, because 234 is its country code
 *   '1917'  — the 917 area code, because a NANP number is 1 + NPA + 7 digits,
 *             which makes an area code just a longer country prefix
 *
 * so there is no separate "area code mode" to get wrong, and no numbering-plan
 * table to go stale. Ported from whatsapp-filter / contact-saver, where the same
 * matcher decides which conversations to delete.
 */

export type RuleKind = 'block' | 'allow';

/** A rule as the matcher needs it: the `rules` row minus the bookkeeping. */
export interface PrefixRule {
  id: number;
  kind: RuleKind;
  prefix: string;
  label?: string | null;
}

export interface PrefixMatch {
  rule: PrefixRule;
  prefix: string;
}

const PREFIX = /^[1-9][0-9]{0,14}$/;

export class InvalidPrefixError extends Error {
  constructor(input: string) {
    super(`"${input}" is not a usable dialling prefix`);
    this.name = 'InvalidPrefixError';
  }
}

/**
 * Accepts what a person types — `+234`, `234`, `(917)` — and returns the digits
 * a rule is stored as.
 *
 * A bare three-digit NANP area code is the one input that cannot be taken at
 * face value: '917' as written means the New York area code, but as a prefix it
 * means every number that happens to start 917. The caller decides which
 * reading applies via `assumeNanpAreaCode`, which the dashboard sets when the
 * picker's area-code tab is active.
 */
export function normalizePrefix(input: string, assumeNanpAreaCode = false): string {
  let digits = input.replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (assumeNanpAreaCode && digits.length === 3) digits = `1${digits}`;
  if (!PREFIX.test(digits)) throw new InvalidPrefixError(input);
  return digits;
}

/**
 * Longest matching prefix wins, and that is the entire conflict resolution.
 *
 * It gives the exception customers actually want with no second concept: refuse
 * '234', allow '234803', and the one Lagos number they do business with is
 * still saved, because its rule is longer. Two rules can never tie — the schema
 * holds one verdict per (user, prefix) — so the winner is unique and the order
 * rules are loaded in does not matter.
 */
export function matchPrefix(
  phone: string,
  rules: readonly PrefixRule[],
): PrefixMatch | undefined {
  let best: PrefixRule | undefined;
  for (const rule of rules) {
    if (!phone.startsWith(rule.prefix)) continue;
    if (best === undefined || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best ? { rule: best, prefix: best.prefix } : undefined;
}

export type DefaultPolicy = 'allow' | 'block';

export interface PrefixVerdict {
  allowed: boolean;
  matchedPrefix?: string;
  ruleId?: number;
  /** Set when nothing matched and the account refuses by default. */
  byDefault?: boolean;
}

/**
 * Whether this number may be saved.
 *
 * An allow rule wins outright under either policy. Under 'block' it is the
 * allowlist entry; under 'allow' it is the exception carved out of a longer
 * block rule. Same rule, same meaning.
 */
export function checkPrefix(
  phone: string,
  rules: readonly PrefixRule[],
  defaultPolicy: DefaultPolicy,
): PrefixVerdict {
  const match = matchPrefix(phone, rules);
  if (match?.rule.kind === 'allow') {
    return { allowed: true, matchedPrefix: match.prefix, ruleId: match.rule.id };
  }
  if (match) {
    return { allowed: false, matchedPrefix: match.prefix, ruleId: match.rule.id };
  }
  return defaultPolicy === 'allow' ? { allowed: true } : { allowed: false, byDefault: true };
}
