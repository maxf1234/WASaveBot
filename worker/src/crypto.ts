/**
 * AES-256-GCM for the WhatsApp login keys kept in wa_auth (the pattern from
 * my contact-saver). Without it a leaked database would be a working login to
 * every customer's WhatsApp; with it the rows are useless without the key,
 * which lives only in the worker's environment.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed {
  enc: 1;
  iv: string;
  tag: string;
  data: string;
}

export function parseKey(hex: string, name = 'WA_AUTH_ENCRYPTION_KEY'): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * The keys a worker will decrypt with, newest first.
 *
 * Rotating a single key used to mean logging every customer out of WhatsApp,
 * because nothing could read the rows written under the old one. With a second
 * key accepted for decryption only, a rotation becomes three ordinary deploys
 * and no customer notices:
 *
 *   1. set WA_AUTH_ENCRYPTION_KEY_PREVIOUS to the current key, and
 *      WA_AUTH_ENCRYPTION_KEY to the new one
 *   2. leave it a while — every value is rewritten under the new key as
 *      Baileys saves credentials and signal keys, which happens constantly
 *   3. remove WA_AUTH_ENCRYPTION_KEY_PREVIOUS
 *
 * Writes always use the first key, so no row stays on the old one once it has
 * been touched. Step 2 is the only part that takes patience; a session that is
 * never used again keeps its old ciphertext, and when it finally reconnects
 * after step 3 it is treated as a dead login and asked to re-link — which is
 * the same outcome it would have had anyway.
 */
export interface KeyRing {
  /** Used for every write. */
  current: Buffer;
  /** Tried, in order, when `current` cannot open a row. */
  previous: Buffer[];
}

export const keyRing = (current: Buffer, previous: Buffer[] = []): KeyRing => ({ current, previous });

export function seal(key: Buffer, value: unknown): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    enc: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export const isSealed = (value: unknown): value is Sealed =>
  typeof value === 'object' && value !== null && (value as Sealed).enc === 1 && 'data' in value;

/** Throws if the key is wrong or the row was tampered with. */
export function open(key: Buffer, sealed: Sealed): unknown {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * Open a row with whichever key wrote it.
 *
 * GCM authenticates, so a wrong key throws rather than returning plausible
 * nonsense — which is what makes trying keys in turn safe here. The error
 * raised is the one from the newest key, because that is the interesting
 * failure when none of them work.
 */
export function openWithRing(ring: KeyRing, sealed: Sealed): unknown {
  try {
    return open(ring.current, sealed);
  } catch (error) {
    for (const key of ring.previous) {
      try {
        return open(key, sealed);
      } catch {
        // Try the next one; the original error is the one worth reporting.
      }
    }
    throw error;
  }
}
