/**
 * Everything the worker reads or writes in Postgres, behind one interface so
 * the WhatsApp and billing logic can be tested without a database.
 *
 * The real implementation uses the service-role key, which bypasses RLS: the
 * worker acts for every user and is the only thing allowed to read wa_auth.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Decision, SaveMode } from './decide.js';
import type { DefaultPolicy, PrefixRule, RuleKind } from './rules.js';

export const ACTIVE_STATUSES = ['active', 'trialing'];
export const isActive = (status: string | null | undefined): boolean =>
  ACTIVE_STATUSES.includes(status ?? '');

/**
 * Statuses Stripe will keep retrying, and so the only ones worth a grace
 * period. 'canceled', 'incomplete' and 'incomplete_expired' are final or never
 * started: extending those would be giving the service away, not absorbing a
 * payment hiccup.
 */
export const GRACE_STATUSES = ['past_due', 'unpaid'];
export const isGraceable = (status: string | null | undefined): boolean =>
  GRACE_STATUSES.includes(status ?? '');

/**
 * Whether this customer may save right now: a live Stripe subscription, a
 * payment still inside its grace window, or Pro granted by an admin.
 */
export const maySave = (
  status: string | null | undefined,
  graceUntil: string | null | undefined,
  proGranted: boolean | null | undefined = false,
  now = new Date(),
): boolean =>
  Boolean(proGranted) ||
  isActive(status) ||
  (isGraceable(status) && Boolean(graceUntil) && new Date(graceUntil!) > now);

export type SessionStatus = 'disconnected' | 'pairing' | 'connecting' | 'connected' | 'logged_out';

export interface SessionPatch {
  status?: SessionStatus;
  pairing_code?: string | null;
  phone?: string | null;
  last_connected_at?: string;
  desired?: 'on' | 'off';
  pair_phone?: string | null;
  logout_requested_at?: string | null;
}

/** A session as the reconcile loop reads it: what is wanted, and what to pair with. */
export interface SessionIntent {
  user_id: string;
  desired: 'on' | 'off';
  pair_phone: string | null;
  logout_requested_at: string | null;
  status: SessionStatus;
}

export interface Settings {
  enabled: boolean;
  save_to_phone: boolean;
  name_template: string;
  fallback_prefix: string;
  daily_cap: number;
  /** Watch-only until true: decisions are recorded and no contact is written. */
  armed: boolean;
  save_mode: SaveMode;
  save_phrase: string;
  remove_phrase: string;
  default_policy: DefaultPolicy;
}

export interface Policy {
  subscribed: boolean;
  settings: Settings;
  /** Only the enabled ones: a disabled rule is invisible to the matcher. */
  rules: PrefixRule[];
}

export interface Profile {
  id: string;
  email: string | null;
  stripe_customer_id: string | null;
  subscription_status: string;
  grace_until?: string | null;
  /** Pro given by an admin. Billing never writes it. */
  pro_granted?: boolean;
}

/**
 * 'pending'  — found when linking, or held by the daily cap; not saved yet.
 * 'removed'  — the person opted out. The row stays, because it is the record
 *              that they objected; deleting it would let the next message save
 *              them again as if they never had.
 */
export type ContactStatus =
  | 'saved' | 'existing' | 'failed' | 'unresolved' | 'pending' | 'removed';

export interface ContactRow {
  phone: string;
  lid?: string | null;
  push_name?: string | null;
  saved_name?: string | null;
  requested_name?: string | null;
  status: ContactStatus;
  error?: string | null;
}

export interface KnownContact {
  phone: string;
  status: ContactStatus;
  push_name: string | null;
  lid: string | null;
}

export interface RuleRow {
  id: number;
  kind: RuleKind;
  prefix: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
}

/** One customer, as the admin page shows them. */
export interface AdminRow {
  user_id: string;
  email: string | null;
  subscription_status: string;
  grace_until: string | null;
  pro_granted: boolean;
  created_at: string;
  session_status: string | null;
  session_phone: string | null;
  last_connected_at: string | null;
  armed: boolean | null;
  enabled: boolean | null;
  save_mode: string | null;
  saved_count: number;
  failed_count: number;
  pending_count: number;
  removed_count: number;
  last_event_at: string | null;
}

/** One row of the activity log. Never carries message content. */
export interface SaveEvent {
  phone: string | null;
  push_name?: string | null;
  saved_name?: string | null;
  decision: Decision;
  matched_prefix?: string | null;
  rule_id?: number | null;
  detail?: string | null;
}

export interface Store {
  // wa_auth
  getAuth(userId: string, keys: string[]): Promise<Map<string, unknown>>;
  setAuth(userId: string, entries: [key: string, value: unknown | null][]): Promise<void>;
  deleteAuth(userId: string): Promise<void>;
  hasAuth(userId: string): Promise<boolean>;
  /**
   * Every user with a stored WhatsApp login, subscribed or not.
   *
   * Unsubscribed accounts are booted too, because they are running the free
   * preview and it has to survive a redeploy like anything else. Whether they
   * may actually write is decide()'s business, not the boot list's.
   */
  usersToBoot(): Promise<string[]>;
  /**
   * Unsubscribed accounts whose free preview has run past `days`, measured
   * from when they signed up. Empty when `days` is 0.
   */
  usersPastFreePreview(days: number): Promise<string[]>;

  // wa_sessions
  updateSession(userId: string, patch: SessionPatch): Promise<void>;
  /**
   * The session's state as the owning worker last wrote it. The HTTP layer
   * reads this instead of asking a socket, so it works on any replica.
   */
  getSessionStatus(userId: string): Promise<SessionStatus | null>;
  /**
   * Every session with something for a worker to do: wanted up, wanted down
   * while still up, or waiting to be logged out. Each replica filters this to
   * the users it owns.
   */
  sessionsToReconcile(): Promise<SessionIntent[]>;
  /** Phones the customer has asked to have saved now, by user. */
  queuedContacts(): Promise<{ user_id: string; phone: string }[]>;
  /** Clear the request once it has been queued, so it is not picked up twice. */
  clearQueueRequest(userId: string, phones: string[]): Promise<void>;
  /** Ask for these people to be saved. Returns how many rows were flagged. */
  requestQueue(userId: string, phones: string[] | 'all-pending'): Promise<number>;

  // profiles + settings
  getPolicy(userId: string): Promise<Policy>;
  getProfile(userId: string): Promise<Profile | null>;
  findProfileByCustomer(customerId: string): Promise<Profile | null>;
  setCustomerId(userId: string, customerId: string): Promise<void>;
  setSubscription(userId: string, status: string, periodEnd: string | null): Promise<void>;
  /** Start or clear a payment grace window. */
  setGrace(userId: string, until: string | null): Promise<void>;
  /** Customers whose grace has run out and who should stop saving. */
  usersWithLapsedGrace(): Promise<string[]>;
  /** Nightly sweep. Returns how many rows went. */
  purgeEvents(retentionDays: number): Promise<number>;
  /** One row per customer, for the operator's admin page. */
  adminOverview(limit: number): Promise<AdminRow[]>;
  /** Grant or take away admin-given Pro. False if there is no such customer. */
  setProGranted(userId: string, granted: boolean): Promise<boolean>;
  deleteUser(userId: string): Promise<void>;

  // save_events
  recordEvent(userId: string, event: SaveEvent): Promise<void>;
  /** Real writes in the window, which is what the daily cap counts. */
  countSavesSince(userId: string, sinceIso: string): Promise<number>;

  // saved_contacts
  loadContacts(userId: string): Promise<KnownContact[]>;
  /**
   * Stake a claim on a number. Returns false when a live row already exists.
   *
   * The insert and the conflict check are one statement, so two messages from
   * the same number arriving together cannot both win — the database refuses
   * the second inside the transaction that would have written it. The
   * in-memory set this replaced was correct only because the worker is pinned
   * to one replica; this is correct regardless.
   */
  claimContact(userId: string, row: ContactRow): Promise<boolean>;
  getContact(userId: string, phone: string): Promise<KnownContact | null>;
  /** Change an existing row (a backfill or retry finishing). Also moves it to the top of the list. */
  updateContact(userId: string, phone: string, patch: Partial<ContactRow>): Promise<void>;
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
  // False, matching the column default: a settings row that failed to load must
  // not be treated as armed. 0002 backfills existing customers to true, so this
  // only ever applies to a genuinely missing row.
  armed: false,
  save_mode: 'everyone',
  save_phrase: 'save my number',
  remove_phrase: 'remove my number',
  default_policy: 'allow',
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
  const PROFILE = 'id, email, stripe_customer_id, subscription_status, grace_until, pro_granted';

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
            .select('user_id')
            .eq('key', 'creds')
            .order('user_id')
            .range(from, from + 999),
          'list sessions to boot',
        );
        for (const row of rows ?? []) out.push(row.user_id as string);
        if ((rows?.length ?? 0) < 1000) break;
      }
      return out;
    },

    async usersPastFreePreview(days) {
      if (days <= 0) return [];
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const rows = check(
        await db
          .from('profiles')
          // Only sessions still wanted up: an expired preview already switched
          // off must not be rewritten on every tick for ever.
          .select('id, subscription_status, grace_until, pro_granted, created_at, wa_sessions!inner(desired)')
          .eq('wa_sessions.desired', 'on')
          .lt('created_at', cutoff),
        'list expired previews',
      );
      return (rows ?? [])
        .filter((r) => !maySave(r.subscription_status as string, r.grace_until as string | null, r.pro_granted as boolean))
        .map((r) => r.id as string);
    },

    async updateSession(userId, patch) {
      check(await db.from('wa_sessions').update(patch).eq('user_id', userId), 'update wa_sessions');
    },

    async getSessionStatus(userId) {
      const row = check(
        await db.from('wa_sessions').select('status').eq('user_id', userId).maybeSingle(),
        'read session status',
      ) as { status: SessionStatus } | null;
      return row?.status ?? null;
    },

    async sessionsToReconcile() {
      const rows = check(
        await db
          .from('wa_sessions')
          .select('user_id, desired, pair_phone, logout_requested_at, status')
          // Anything wanted up, anything still up that is not wanted, and
          // anything waiting to be unlinked. A row that is 'off' and already
          // disconnected has nothing for anyone to do.
          .or('desired.eq.on,logout_requested_at.not.is.null,status.in.(connecting,pairing,connected)'),
        'list sessions to reconcile',
      );
      return (rows ?? []) as SessionIntent[];
    },

    async queuedContacts() {
      const rows = check(
        await db
          .from('saved_contacts')
          .select('user_id, phone')
          .not('queue_requested_at', 'is', null)
          .order('queue_requested_at')
          .limit(2000),
        'list queued contacts',
      );
      return (rows ?? []) as { user_id: string; phone: string }[];
    },

    async clearQueueRequest(userId, phones) {
      if (phones.length === 0) return;
      for (const part of chunk(phones, 100)) {
        check(
          await db
            .from('saved_contacts')
            .update({ queue_requested_at: null })
            .eq('user_id', userId)
            .in('phone', part),
          'clear queue request',
        );
      }
    },

    async requestQueue(userId, phones) {
      const now = new Date().toISOString();
      let q = db.from('saved_contacts').update({ queue_requested_at: now }).eq('user_id', userId);
      if (phones === 'all-pending') {
        q = q.eq('status', 'pending');
      } else {
        if (phones.length === 0) return 0;
        // A failed row goes back to pending, so the queue treats it like any
        // other waiting person rather than needing a separate 'force' path.
        check(
          await db
            .from('saved_contacts')
            .update({ status: 'pending', error: null })
            .eq('user_id', userId)
            .eq('status', 'failed')
            .in('phone', phones),
          'reset failed contacts',
        );
        q = q.in('phone', phones).eq('status', 'pending');
      }
      const rows = check(await q.select('phone'), 'request queue');
      return rows?.length ?? 0;
    },

    async getPolicy(userId) {
      const [profile, settings, rules] = await Promise.all([
        db.from('profiles').select('subscription_status, grace_until, pro_granted').eq('id', userId).maybeSingle(),
        db.from('settings').select('*').eq('user_id', userId).maybeSingle(),
        // Only the enabled ones: a disabled rule is invisible to the matcher,
        // which is cheaper and clearer than filtering at match time.
        db.from('rules').select('id, kind, prefix, label').eq('user_id', userId).eq('enabled', true),
      ]);
      const p = check(profile, 'read profile');
      const s = check(settings, 'read settings');
      return {
        // Grace included: a card Stripe is still retrying must not cost the
        // customer the contacts who message in the meantime.
        subscribed: maySave(
          p?.subscription_status as string | undefined,
          p?.grace_until as string | null | undefined,
          p?.pro_granted as boolean | undefined,
        ),
        settings: { ...DEFAULT_SETTINGS, ...(s ?? {}) } as Settings,
        rules: (check(rules, 'read rules') ?? []) as PrefixRule[],
      };
    },

    async recordEvent(userId, event) {
      check(await db.from('save_events').insert({ user_id: userId, ...event }), 'record event');
    },

    async countSavesSince(userId, sinceIso) {
      const { count, error } = await db
        .from('save_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('decision', 'saved')
        .gte('occurred_at', sinceIso);
      if (error) throw new Error(`count saves: ${error.message}`);
      return count ?? 0;
    },

    async claimContact(userId, row) {
      // `ignoreDuplicates` makes this insert-or-nothing; the select tells us
      // which happened. A row sitting in 'removed' is not a live claim, so an
      // opt-out followed by a fresh request is allowed to save again.
      const inserted = check(
        await db
          .from('saved_contacts')
          .upsert({ user_id: userId, ...row }, { onConflict: 'user_id,phone', ignoreDuplicates: true })
          .select('phone'),
        'claim contact',
      );
      if ((inserted?.length ?? 0) > 0) return true;

      const existing = check(
        await db
          .from('saved_contacts')
          .select('status')
          .eq('user_id', userId)
          .eq('phone', row.phone)
          .maybeSingle(),
        'read claim',
      ) as { status: ContactStatus } | null;
      if (existing?.status !== 'removed') return false;

      // Revive the removed row rather than inserting a second one: the unique
      // index would refuse that, and the history belongs on the same row.
      check(
        await db
          .from('saved_contacts')
          .update({ ...row, error: null, created_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('phone', row.phone),
        'revive contact',
      );
      return true;
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

    async setGrace(userId, until) {
      check(
        await db.from('profiles').update({ grace_until: until }).eq('id', userId),
        'set grace',
      );
    },

    async usersWithLapsedGrace() {
      const rows = check(
        await db
          .from('profiles')
          .select('id')
          .in('subscription_status', GRACE_STATUSES)
          .lt('grace_until', new Date().toISOString()),
        'list lapsed grace',
      );
      return (rows ?? []).map((r) => r.id as string);
    },

    async purgeEvents(retentionDays) {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      const rows = check(
        await db.from('save_events').delete().lt('occurred_at', cutoff).select('id'),
        'purge events',
      );
      return rows?.length ?? 0;
    },

    async adminOverview(limit) {
      return (check(
        await db
          .from('admin_overview')
          .select('*')
          // Newest signups first: the interesting customer is usually the
          // one who just arrived and cannot get something working.
          .order('created_at', { ascending: false })
          .limit(limit),
        'read admin overview',
      ) ?? []) as AdminRow[];
    },

    async setProGranted(userId, granted) {
      const rows = check(
        await db.from('profiles').update({ pro_granted: granted }).eq('id', userId).select('id'),
        'set pro',
      );
      return (rows?.length ?? 0) > 0;
    },

    async deleteUser(userId) {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) throw new Error(`delete user: ${error.message}`);
    },

    async loadContacts(userId) {
      const out: KnownContact[] = [];
      for (let from = 0; ; from += 1000) {
        const rows = check(
          await db
            .from('saved_contacts')
            .select('phone, status, push_name, lid')
            .eq('user_id', userId)
            .order('id')
            .range(from, from + 999),
          'load saved phones',
        );
        out.push(...((rows ?? []) as KnownContact[]));
        if ((rows?.length ?? 0) < 1000) break;
      }
      return out;
    },

    async getContact(userId, phone) {
      return check(
        await db
          .from('saved_contacts')
          .select('phone, status, push_name, lid')
          .eq('user_id', userId)
          .eq('phone', phone)
          .maybeSingle(),
        'read saved_contact',
      ) as KnownContact | null;
    },

    async updateContact(userId, phone, patch) {
      check(
        await db
          .from('saved_contacts')
          .update({ ...patch, created_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('phone', phone),
        'update saved_contact',
      );
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
