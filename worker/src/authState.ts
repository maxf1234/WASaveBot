/**
 * Baileys' auth state kept in the wa_auth table instead of on disk, so a
 * session survives a redeploy and a restarted worker reconnects without a QR.
 *
 * Returns the same shape as Baileys' useMultiFileAuthState. Baileys hands us
 * Buffers and expects Buffers back, which JSON does not carry, so BufferJSON's
 * replacer/reviver do the round trip (the same pair Baileys' file store uses).
 */

import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from 'baileys';
import type { Store } from './store.js';

const toJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
const fromJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

export async function useSupabaseAuthState(
  store: Store,
  userId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const stored = (await store.getAuth(userId, ['creds'])).get('creds');
  const creds = (stored ? fromJson(stored) : initAuthCreds()) as AuthenticationCreds;

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const rows = await store.getAuth(
            userId,
            ids.map((id) => `${type}-${id}`),
          );
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            const raw = rows.get(`${type}-${id}`);
            if (raw === undefined || raw === null) continue;
            let value = fromJson(raw);
            // App-state sync keys are the one type Baileys wants back as a
            // decoded protobuf rather than the plain object we stored.
            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            }
            out[id] = value as SignalDataTypeMap[T];
          }
          return out;
        },
        set: async (data) => {
          const entries: [string, unknown | null][] = [];
          for (const [type, byId] of Object.entries(data)) {
            for (const [id, value] of Object.entries(byId ?? {})) {
              entries.push([`${type}-${id}`, value ? toJson(value) : null]);
            }
          }
          await store.setAuth(userId, entries);
        },
      },
    },
    saveCreds: async () => {
      await store.setAuth(userId, [['creds', toJson(creds)]]);
    },
  };
}
