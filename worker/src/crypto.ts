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

export function parseKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('WA_AUTH_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

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
