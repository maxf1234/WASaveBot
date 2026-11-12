/** Pure helpers: which chats count, what number a JID is, and what to call the contact. */

const PN_SUFFIX = '@s.whatsapp.net';
const LID_SUFFIX = '@lid';

export const isPnJid = (jid: string | null | undefined): jid is string =>
  Boolean(jid?.endsWith(PN_SUFFIX));
export const isLidJid = (jid: string | null | undefined): jid is string =>
  Boolean(jid?.endsWith(LID_SUFFIX));

/** Groups, broadcasts (including status@broadcast) and channels are never saved. */
export const isIgnoredChat = (jid: string): boolean =>
  jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');

/** "15551234567:12@s.whatsapp.net" -> "15551234567". Empty string if there are no digits. */
export function userPart(jid: string): string {
  const user = (jid.split('@')[0] ?? '').split(':')[0] ?? '';
  return /^\d+$/.test(user) ? user : '';
}

export const pnJidOf = (phone: string): string => `${phone}${PN_SUFFIX}`;

/** Trim, collapse whitespace, strip control/invisible characters, cap at 60 characters. */
export function cleanPushName(pushName: string | null | undefined): string {
  const cleaned = (pushName ?? '')
    // Control and format characters (zero-width joiners, direction marks, ...).
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 60).join('').trim();
}

/**
 * A name with no letter or digit in it (empty, or only emoji / punctuation)
 * is not something you can find in an address book, so it gets the fallback.
 */
export const hasReadableText = (name: string): boolean => /[\p{L}\p{N}]/u.test(name);

export function buildName(
  pushName: string | null | undefined,
  phone: string,
  settings: { name_template: string; fallback_prefix: string },
): string {
  const cleaned = cleanPushName(pushName);
  if (cleaned && hasReadableText(cleaned)) {
    const template = settings.name_template.includes('{name}') ? settings.name_template : '{name}';
    return template.replaceAll('{name}', cleaned).replace(/\s+/g, ' ').trim();
  }
  return `${settings.fallback_prefix} ${phone.slice(-4)}`.trim();
}
