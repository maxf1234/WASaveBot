/**
 * Reading intent out of a message, for the accounts that run in phrase mode.
 *
 * Ported from contact-saver, minus its reply templates: this worker never
 * sends, so the only thing taken from a message is whether it is a request and
 * what name the sender attached to it.
 *
 * Pure — no socket, no database, no clock — which is what lets the whole matrix
 * of phrasings be tested as a table.
 */

export type Intent = 'save' | 'remove' | 'none';

export interface TriggerPhrases {
  save: string;
  remove: string;
}

export interface ParsedTrigger {
  intent: Intent;
  /** What the sender gave as their name, cleaned. Absent when they gave none. */
  name?: string;
  /**
   * The phrase is in the message but not at the front, so this is almost
   * certainly not a request — "don't save my number", "did you save my number".
   * Worth recording, because it is the one case where a customer and a sender
   * disagree about whether anything should have happened.
   */
  nearMiss?: boolean;
}

/**
 * Politeness and filler that arrives glued to the trigger. Stripped from the
 * name, because "save my number please" must not put a contact called "please"
 * in somebody's address book — which is exactly what the naive version does,
 * and the kind of mistake the customer then fixes by hand.
 */
const FILLER = new Set([
  'please', 'pls', 'plz', 'thanks', 'thank', 'thankyou', 'ty', 'thx', 'cheers',
  'now', 'asap', 'ok', 'okay', 'hi', 'hey', 'hello', 'sir', 'maam', "ma'am",
  'bro', 'boss', 'mate', 'dear', 'kindly', 'and', 'it', 'this', 'me', 'my',
]);

/**
 * Zero-width and direction-mark characters, which are invisible in a contact
 * name and must not survive into one.
 *
 * Deliberately \p{Cf} and not \p{Cc}\p{Cf}: \p{Cc} includes newline and
 * carriage return, and removing those outright would glue "John\nthanks for
 * the call" into one word before the name splitter could see the line break.
 * Other control characters are turned into spaces further down instead.
 */
const INVISIBLE = /\p{Cf}/gu;

/** Control characters that are not line breaks. A space is the safe reading. */
const CONTROL = /[\p{Cc}]/gu;

/**
 * Emoji and pictographs. A name may be non-Latin — most of the world's are —
 * but a row of emoji is not a name, and stripping them is how
 * "save my number 🔥🔥🔥" falls back to the push name instead of saving a
 * contact called three flames.
 */
const EMOJI = /[\p{Extended_Pictographic}]/gu;

/** Whitespace, punctuation and symbols at either end of a name. */
const NAME_EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

const MAX_NAME_LENGTH = 60;
const MAX_NAME_WORDS = 5;

/** Lower case, collapse whitespace, drop invisibles. Punctuation is left for the name splitter. */
function fold(input: string): string {
  return input.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A pattern for the phrase that tolerates the whitespace folding would have collapsed. */
function phrasePattern(phrase: string, anchored: boolean): RegExp | undefined {
  const words = fold(phrase).split(' ').filter(Boolean);
  if (words.length === 0) return undefined;
  const body = words.map(escapeRegex).join('\\s+');
  return new RegExp(anchored ? `^\\s*${body}` : body, 'iu');
}

/**
 * The part of the original message that followed the phrase, or undefined if
 * the phrase does not open it.
 *
 * Matched against the original rather than the folded copy because folding
 * lower-cases, and "save my number John Smith" must not save "john smith".
 */
function tailAfterPhrase(body: string, phrase: string): string | undefined {
  const cleaned = body.replace(INVISIBLE, '');
  const pattern = phrasePattern(phrase, true);
  if (!pattern) return undefined;
  const match = pattern.exec(cleaned);
  if (!match) return undefined;
  const rest = cleaned.slice(match[0].length);
  // The phrase has to end the message or end on a boundary, so a phrase of
  // "save" does not fire on "saved" or "savings".
  if (rest.length > 0 && /[\p{L}\p{N}]/u.test(rest[0]!)) return undefined;
  return rest;
}

/**
 * Pull a usable display name out of what followed the trigger.
 *
 * Returns undefined rather than a bad guess whenever what is left is filler,
 * punctuation, emoji or too long to be a name — the caller then falls back to
 * the WhatsApp push name, which is nearly always better than a fragment of a
 * sentence.
 */
export function extractName(raw: string): string | undefined {
  // Only the first line, and only up to the first sentence end: people send
  // "save my number John\nthanks for the call", and the rest is not the name.
  // The line split happens before control characters are folded away, so the
  // break is still there to split on.
  let text = raw.replace(INVISIBLE, '').replace(EMOJI, ' ');
  text = text.split(/[\n\r]/)[0]!.split(/[.!?;]/)[0]!;
  text = text.replace(CONTROL, ' ').replace(NAME_EDGE, '').replace(/\s+/g, ' ');
  if (!text) return undefined;

  const words = text.split(' ').filter(Boolean);
  const bare = (word: string) => word.replace(NAME_EDGE, '').toLowerCase();
  while (words.length > 0 && FILLER.has(bare(words[0]!))) words.shift();
  while (words.length > 0 && FILLER.has(bare(words[words.length - 1]!))) words.pop();

  // More than a handful of words is a sentence, not a name.
  if (words.length === 0 || words.length > MAX_NAME_WORDS) return undefined;

  const name = words.join(' ').replace(NAME_EDGE, '');
  if (!name || name.length > MAX_NAME_LENGTH) return undefined;
  // Rejects "save my number ???" and "save my number ---".
  if (!/[\p{L}\p{N}]/u.test(name)) return undefined;
  return name;
}

/**
 * Match a message against an account's phrases.
 *
 * The remove phrase is checked first: if a customer sets two overlapping
 * phrases, the safer reading of an ambiguous message is the one that stops us
 * holding somebody's number rather than the one that starts.
 *
 * Both phrases are anchored at the start of the message, which is a product
 * decision as much as a technical one — "don't save my number" and "why would I
 * save my number" both contain the phrase and neither is a request.
 */
export function parseTrigger(body: string, phrases: TriggerPhrases): ParsedTrigger {
  const folded = fold(body ?? '');
  if (!folded) return { intent: 'none' };

  if (tailAfterPhrase(body, phrases.remove) !== undefined) return { intent: 'remove' };

  const tail = tailAfterPhrase(body, phrases.save);
  if (tail === undefined) {
    // Not a request. Flag the case where the phrase is in there somewhere, so
    // the activity log can explain why nothing happened.
    const loose = phrasePattern(phrases.save, false);
    const nearMiss = Boolean(loose?.test(folded));
    return nearMiss ? { intent: 'none', nearMiss } : { intent: 'none' };
  }

  const name = extractName(tail);
  return name ? { intent: 'save', name } : { intent: 'save' };
}
