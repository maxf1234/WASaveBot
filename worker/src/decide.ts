/**
 * What to do about one incoming message, as a pure function.
 *
 * Until now this logic lived inside ContactSaver#onMessage, interleaved with
 * LID resolution, queue bookkeeping and database writes, which made it
 * impossible to ask "under what combination of settings does this account write
 * to an address book?" without starting a socket. Now that is a table test.
 *
 * Nothing here touches WhatsApp or Supabase. Facts the function cannot work out
 * for itself — is this number already known, is the cap spent — are arguments,
 * which keeps every lookup in one place in the saver where it can be seen.
 */

import { checkPrefix } from './rules.js';
import type { DefaultPolicy, PrefixRule } from './rules.js';
import { parseTrigger } from './trigger.js';
import type { Intent } from './trigger.js';

/** What the caller should carry out. 'none' means "record it and touch nothing". */
export type SaveAction = 'none' | 'save' | 'remove';

export type Decision =
  | 'saved'
  | 'would_save'
  | 'already_known'
  | 'removed'
  | 'not_found'
  | 'blocked_prefix'
  | 'no_trigger'
  | 'capped'
  | 'disabled'
  | 'unsubscribed'
  | 'unresolved'
  | 'failed';

export type SaveMode = 'everyone' | 'phrase';

export interface DecideSettings {
  enabled: boolean;
  armed: boolean;
  save_mode: SaveMode;
  save_phrase: string;
  remove_phrase: string;
  default_policy: DefaultPolicy;
}

export interface DecideFacts {
  /** A saved_contacts row exists that is not 'removed'. */
  alreadyKnown: boolean;
  /** The customer previously opted this person out; only a fresh request revives them. */
  optedOut: boolean;
  subscribed: boolean;
  /** The daily cap is already spent. */
  capped: boolean;
}

export interface Verdict {
  action: SaveAction;
  decision: Decision;
  intent: Intent;
  /** True when nothing should be recorded either — ordinary traffic, not an event. */
  silent: boolean;
  /** The name the sender asked for, in phrase mode. The caller still applies the template. */
  requestedName?: string;
  matchedPrefix?: string;
  ruleId?: number;
  /** Free text for the activity log. Never message content. */
  detail?: string;
}

function verdict(
  decision: Decision,
  intent: Intent,
  rest: Partial<Verdict> = {},
): Verdict {
  return { action: 'none', decision, intent, silent: false, ...rest };
}

/**
 * `phone` is the resolved number, digits only. A caller that could not resolve
 * one passes undefined and gets an 'unresolved' verdict.
 */
export function decide(
  input: { phone?: string; body: string },
  settings: DecideSettings,
  rules: readonly PrefixRule[],
  facts: DecideFacts,
): Verdict {
  // A sender we cannot read a number from. Recorded rather than dropped, so
  // "this person messages me and never gets saved" is visible instead of
  // looking like a quiet pass — a contact with no number is useless anyway.
  if (!input.phone) {
    return verdict('unresolved', 'none', {
      detail: 'WhatsApp gave no phone number for this sender',
    });
  }

  // Parsed once, with the account's real phrases. The mode then decides whether
  // a message that is not the save phrase still counts as a request: in
  // 'everyone' mode it does, which is the whole difference between the two.
  //
  // The opt-out phrase is read in both modes. Somebody saved automatically,
  // without ever asking, must be able to say so — that is the one thing worth
  // looking for in every single message.
  const parsed = parseTrigger(input.body, {
    save: settings.save_phrase,
    remove: settings.remove_phrase,
  });
  const wantsSave = settings.save_mode === 'everyone' || parsed.intent === 'save';

  // ------------------------------------------------------------ opt-out
  //
  // Handled before the rules, the cap, the subscription and `armed`. Somebody
  // asking to be forgotten gets that whatever else is configured: a rule that
  // refuses to *save* their country must not also trap them in the address
  // book, and a cap is about how fast we write, not about refusing to stop.
  if (parsed.intent === 'remove') {
    if (!facts.alreadyKnown) {
      return verdict('not_found', 'remove', {
        detail: facts.optedOut ? 'already removed' : 'never saved',
      });
    }
    return { action: 'remove', decision: 'removed', intent: 'remove', silent: false };
  }

  // Ordinary traffic from somebody already in the list: by far the commonest
  // case, and recording it would bury the log the customer actually reads.
  if (facts.alreadyKnown) {
    return verdict('already_known', wantsSave ? 'save' : 'none', { silent: true });
  }

  // Somebody who asked to be removed stays removed until they explicitly ask
  // again with the save phrase. In 'everyone' mode their next message is not
  // asking — they simply messaged — so honouring the opt-out means leaving them
  // alone. Without this, an opt-out in 'everyone' mode would last exactly until
  // the next thing they sent, which is no opt-out at all.
  if (facts.optedOut && parsed.intent !== 'save') {
    return verdict('already_known', 'none', { silent: true });
  }

  if (!wantsSave) {
    // Silent unless the phrase was in there somewhere: that near miss is the
    // one case where the customer and the sender disagree about whether
    // anything should have happened, so it is worth a row.
    return verdict('no_trigger', 'none', {
      silent: !parsed.nearMiss,
      detail: parsed.nearMiss ? 'the phrase appeared, but not at the start of the message' : undefined,
    });
  }

  // Somebody who opted out and is now asking again has consented afresh, so
  // the save goes ahead; the detail records that this is a second time.
  const revived = facts.optedOut;

  if (!settings.enabled) {
    return verdict('disabled', 'save', {
      requestedName: parsed.name,
      detail: 'saving is switched off',
    });
  }

  // Rules before the cap, so a flood of numbers the customer refuses anyway
  // does not eat the budget for the ones they want.
  const prefix = checkPrefix(input.phone, rules, settings.default_policy);
  if (!prefix.allowed) {
    return verdict('blocked_prefix', 'save', {
      requestedName: parsed.name,
      matchedPrefix: prefix.matchedPrefix,
      ruleId: prefix.ruleId,
      detail: prefix.byDefault ? 'no rule matched, and this account refuses by default' : undefined,
    });
  }

  // Below the rules on purpose. Somebody with no subscription is running the
  // free preview, and the preview is only useful if it is honest about who
  // *would* have been saved — telling them to subscribe in order to save a
  // number their own rule refuses would be a lie in the one place they are
  // deciding whether to pay. Above the cap on purpose too: a preview writes
  // nothing, so there is no write budget for it to spend.
  if (!facts.subscribed) {
    return verdict('unsubscribed', 'save', {
      requestedName: parsed.name,
      matchedPrefix: prefix.matchedPrefix,
      ruleId: prefix.ruleId,
      detail: 'preview only: subscribe to start saving',
    });
  }

  if (facts.capped) {
    // Kept rather than dropped: the caller parks it as 'pending' so tomorrow's
    // run picks it up. The old behaviour discarded the queue, which meant
    // somebody who never messaged again was simply lost.
    return verdict('capped', 'save', {
      requestedName: parsed.name,
      matchedPrefix: prefix.matchedPrefix,
      ruleId: prefix.ruleId,
      detail: 'the daily cap is spent; held for tomorrow',
    });
  }

  // Whether anything is written is a separate question, and this is the only
  // place that answers it. An unarmed account records what it would have done
  // and stops. That is what makes it safe to point this at a real address book
  // that syncs to a phone — the customer can watch it be right for a day
  // before it puts anything there they would have to delete by hand.
  if (!settings.armed) {
    return verdict('would_save', 'save', {
      requestedName: parsed.name,
      matchedPrefix: prefix.matchedPrefix,
      ruleId: prefix.ruleId,
      detail: 'watch-only: nothing was written',
    });
  }

  return {
    action: 'save',
    decision: 'saved',
    intent: 'save',
    silent: false,
    requestedName: parsed.name,
    matchedPrefix: prefix.matchedPrefix,
    ruleId: prefix.ruleId,
    detail: revived ? 'saved again after an earlier opt-out' : undefined,
  };
}
