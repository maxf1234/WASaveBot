/**
 * Everything the worker reads or writes in Postgres, behind one interface so
 * the WhatsApp and billing logic can be tested without a database.
 *
 * The real implementation uses the service-role key, which bypasses RLS: the
 * worker acts for every user and is the only thing allowed to read wa_auth.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const ACTIVE_STATUSES = ['active', 'trialing'];
export const isActive = (status: string | null | undefined): boolean =>
  ACTIVE_STATUSES.includes(status ?? '');

export type SessionStatus = 'disconnected' | 'pairing' | 'connecting' | 'connected' | 'logged_out';

export interface SessionPatch {
  status?: SessionStatus;
  pairing_code?: string | null;
  phone?: string | null;
  last_connected_at?: string;
}

export interface Settings {
  enabled: boolean;
  save_to_phone: boolean;
  name_template: string;
  fallback_prefix: string;
  daily_cap: number;
}

export interface Policy {
  subscribed: boolean;
  settings: Settings;
}

export interface Profile {
  id: string;
  email: string | null;
  stripe_customer_id: string | null;
  subscription_status: string;
}

export type ContactStatus = 'saved' | 'existing' | 'failed' | 'unresolved';

export interface ContactRow {
  phone: string;
  lid?: string | null;
  push_name?: string | null;
  saved_name?: string | null;
  status: ContactStatus;
  error?: string | null;
}

export interface Store {
  // wa_auth
  getAuth(userId: string, keys: string[]): Promise<Map<string, unknown>>;
  setAuth(userId: string, entries: [key: string, value: unknown | null][]): Promise<void>;
  deleteAuth(userId: string): Promise<void>;
  hasAuth(userId: string): Promise<boolean>;
  /** Users with an active/trialing subscription AND a stored WhatsApp login. */
  usersToBoot(): Promise<string[]>;

  // wa_sessions
  updateSession(userId: string, patch: SessionPatch): Promise<void>;

  // profiles + settings
  getPolicy(userId: string): Promise<Policy>;
  getProfile(userId: string): Promise<Profile | null>;
  findProfileByCustomer(customerId: string): Promise<Profile | null>;
  setCustomerId(userId: string, customerId: string): Promise<void>;
  setSubscription(userId: string, status: string, periodEnd: string | null): Promise<void>;
  deleteUser(userId: string): Promise<void>;

  // saved_contacts
  loadPhones(userId: string): Promise<string[]>;
  countSavedSince(userId: string, sinceIso: string): Promise<number>;
  /** Insert; a row that already exists for (user, phone) is left exactly as it is. */
  insertContact(userId: string, row: ContactRow): Promise<void>;
  deleteContact(userId: string, phone: string): Promise<void>;
}

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  save_to_phone: true,
  name_template: '{name}',
  fallback_prefix: 'WA',
  daily_cap: 200,
};

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createSupabaseStore(url: string, serviceRoleKey: string): Store {
  const db: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const PROFILE = 'id, email, stripe_customer_id, subscription_status';

  return {
    async getAuth(userId, keys) {
      const out = new Map<string, unknown>();
      // Chunked: the keys travel in the query string.
      for (const part of chunk(keys, 50)) {
        const rows = check(
          await db.from('wa_auth').select('key, value').eq('user_id', userId).in('key', part),
          'read wa_auth',
        );
        for (const row of rows ?? []) out.set(row.key as string, row.value);
      }
      return out;
    },

    async setAuth(userId, entries) {
      const upserts = entries
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => ({ user_id: userId, key, value }));
      const deletes = entries.filter(([, v]) => v === null || v === undefined).map(([k]) => k);
      for (const part of chunk(upserts, 200)) {
        check(await db.from('wa_auth').upsert(part, { onConflict: 'user_id,key' }), 'write wa_auth');
      }
      for (const part of chunk(deletes, 50)) {
        check(
          await db.from('wa_auth').delete().eq('user_id', userId).in('key', part),
          'delete wa_auth keys',
        );
      }
    },

    async deleteAuth(userId) {
      check(await db.from('wa_auth').delete().eq('user_id', userId), 'delete wa_auth');
    },

    async hasAuth(userId) {
      const rows = check(
        await db.from('wa_auth').select('key').eq('user_id', userId).eq('key', 'creds').limit(1),
        'check wa_auth',
      );
      return (rows?.length ?? 0) > 0;
    },

    async usersToBoot() {
      const out: string[] = [];
      for (let from = 0; ; from += 1000) {
        const rows = check(
          await db
            .from('wa_auth')
            .select('user_id, profiles!inner(subscription_status)')
            .eq('key', 'creds')
            .in('profiles.subscription_status', ACTIVE_STATUSES)
            .order('user_id')
            .range(from, from + 999),
          'list sessions to boot',
        );
        for (const row of rows ?? []) out.push(row.user_id as string);
        if ((rows?.length ?? 0) < 1000) break;
      }
      return out;
    },

    async updateSession(userId, patch) {
      check(await db.from('wa_sessions').update(patch).eq('user_id', userId), 'update wa_sessions');
    },

    async getPolicy(userId) {
      const [profile, settings] = await Promise.all([
        db.from('profiles').select('subscription_status').eq('id', userId).maybeSingle(),
        db.from('settings').select('*').eq('user_id', userId).maybeSingle(),
      ]);
      const p = check(profile, 'read profile');
      const s = check(settings, 'read settings');
      return {
        subscribed: isActive(p?.subscription_status as string | undefined),
        settings: { ...DEFAULT_SETTINGS, ...(s ?? {}) } as Settings,
      };
    },

    async getProfile(userId) {
      return check(
        await db.from('profiles').select(PROFILE).eq('id', userId).maybeSingle(),
        'read profile',
      ) as Profile | null;
    },

    async findProfileByCustomer(customerId) {
      return check(
        await db.from('profiles').select(PROFILE).eq('stripe_customer_id', customerId).maybeSingle(),
        'find profile by customer',
      ) as Profile | null;
    },

    async setCustomerId(userId, customerId) {
      check(
        await db.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId),
        'save stripe customer',
      );
    },

    async setSubscription(userId, status, periodEnd) {
      check(
        await db
          .from('profiles')
          .update({ subscription_status: status, current_period_end: periodEnd })
          .eq('id', userId),
        'save subscription',
      );
    },

    async deleteUser(userId) {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) throw new Error(`delete user: ${error.message}`);
    },

    async loadPhones(userId) {
      const out: string[] = [];
      for (let from = 0; ; from += 1000) {
        const rows = check(
          await db
            .from('saved_contacts')
            .select('phone')
            .eq('user_id', userId)
            .order('id')
            .range(from, from + 999),
          'load saved phones',
        );
        for (const row of rows ?? []) out.push(row.phone as string);
        if ((rows?.length ?? 0) < 1000) break;
      }
      return out;
    },

    async countSavedSince(userId, sinceIso) {
      const { count, error } = await db
        .from('saved_contacts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'saved')
        .gte('created_at', sinceIso);
      if (error) throw new Error(`count saved: ${error.message}`);
      return count ?? 0;
    },

    async insertContact(userId, row) {
      check(
        await db
          .from('saved_contacts')
          .upsert({ user_id: userId, ...row }, { onConflict: 'user_id,phone', ignoreDuplicates: true }),
        'insert saved_contact',
      );
    },

    async deleteContact(userId, phone) {
      check(
        await db.from('saved_contacts').delete().eq('user_id', userId).eq('phone', phone),
        'delete saved_contact',
      );
    },
  };
}

/** Policy is read on every incoming message, so it is cached briefly per user. */
export class PolicyCache {
  #cache = new Map<string, { policy: Policy; at: number }>();
  constructor(
    private store: Store,
    private ttlMs = 15_000,
  ) {}

  async get(userId: string): Promise<Policy> {
    const hit = this.#cache.get(userId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.policy;
    const policy = await this.store.getPolicy(userId);
    this.#cache.set(userId, { policy, at: Date.now() });
    return policy;
  }

  invalidate(userId: string): void {
    this.#cache.delete(userId);
  }
}
