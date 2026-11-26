import { EventEmitter } from 'node:events';
import type { ManagedSocket } from '../src/sessions.js';
import type {
  ContactRow, Policy, Profile, RuleRow, SaveEvent, SessionPatch, SessionStatus, Settings, Store,
} from '../src/store.js';
import { maySave } from '../src/store.js';
import type { PrefixRule, RuleKind } from '../src/rules.js';

export const USER = 'user-1';

export const defaultSettings = (): Settings => ({
  enabled: true,
  save_to_phone: true,
  name_template: '{name}',
  fallback_prefix: 'WA',
  daily_cap: 200,
  // Armed, which is what every existing customer is after 0002 backfills them.
  // Tests that care about watch-only set it false themselves.
  armed: true,
  save_mode: 'everyone',
  save_phrase: 'save my number',
  remove_phrase: 'remove my number',
  default_policy: 'allow',
});

/** An in-memory stand-in for Supabase. */
export class MemoryStore implements Store {
  auth = new Map<string, Map<string, unknown>>();
  sessions = new Map<string, SessionPatch>();
  profiles = new Map<string, Profile>();
  settings = new Map<string, Settings>();
  contacts = new Map<string, (ContactRow & { created_at: string; queue_requested_at?: string | null })[]>();
  rules = new Map<string, RuleRow[]>();
  events = new Map<string, (SaveEvent & { occurred_at: string })[]>();
  deletedUsers: string[] = [];
  #nextRuleId = 1;

  addUser(id: string, status = 'active'): void {
    this.profiles.set(id, { id, email: `${id}@example.com`, stripe_customer_id: null, subscription_status: status });
    this.settings.set(id, defaultSettings());
    this.sessions.set(id, { status: 'disconnected' });
  }
  rows(userId = USER) {
    return this.contacts.get(userId) ?? [];
  }
  ruleRows(userId = USER) {
    return this.rules.get(userId) ?? [];
  }
  eventRows(userId = USER) {
    return this.events.get(userId) ?? [];
  }
  decisions(userId = USER) {
    return this.eventRows(userId).map((e) => e.decision);
  }
  /** Add a rule without going through the API, for tests about matching. */
  addRule(userId: string, kind: RuleKind, prefix: string, label: string | null = null): RuleRow {
    const rows = this.ruleRows(userId);
    this.rules.set(userId, rows);
    const row: RuleRow = {
      id: this.#nextRuleId++, kind, prefix, label, enabled: true,
      created_at: new Date().toISOString(),
    };
    rows.push(row);
    return row;
  }

  async getAuth(userId: string, keys: string[]) {
    const out = new Map<string, unknown>();
    for (const k of keys) {
      const v = this.auth.get(userId)?.get(k);
      // Round-trip through JSON like a jsonb column would.
      if (v !== undefined) out.set(k, JSON.parse(JSON.stringify(v)));
    }
    return out;
  }
  async setAuth(userId: string, entries: [string, unknown | null][]) {
    const m = this.auth.get(userId) ?? new Map<string, unknown>();
    this.auth.set(userId, m);
    for (const [k, v] of entries) {
      if (v === null || v === undefined) m.delete(k);
      else m.set(k, JSON.parse(JSON.stringify(v)));
    }
  }
  async deleteAuth(userId: string) {
    this.auth.delete(userId);
  }
  async hasAuth(userId: string) {
    return Boolean(this.auth.get(userId)?.has('creds'));
  }
  async usersToBoot() {
    // Subscribed or not: an unsubscribed account is previewing, and the
    // preview has to survive a restart like anything else.
    return [...this.profiles.values()]
      .filter((p) => this.auth.get(p.id)?.has('creds'))
      .map((p) => p.id);
  }
  createdAt = new Map<string, string>();
  async usersPastFreePreview(days: number) {
    if (days <= 0) return [];
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return [...this.profiles.values()]
      .filter((p) => !maySave(p.subscription_status, p.grace_until, p.pro_granted))
      .filter((p) => this.sessions.get(p.id)?.desired === 'on')
      .filter((p) => (this.createdAt.get(p.id) ?? new Date().toISOString()) < cutoff)
      .map((p) => p.id);
  }
  async updateSession(userId: string, patch: SessionPatch) {
    this.sessions.set(userId, { ...this.sessions.get(userId), ...patch });
  }
  async getSessionStatus(userId: string) {
    return (this.sessions.get(userId)?.status ?? null) as SessionStatus | null;
  }
  async sessionsToReconcile() {
    return [...this.sessions.entries()]
      .filter(([, row]) =>
        row.desired === 'on' ||
        row.logout_requested_at != null ||
        ['connecting', 'pairing', 'connected'].includes(row.status ?? ''),
      )
      .map(([user_id, row]) => ({
        user_id,
        desired: row.desired ?? 'off',
        pair_phone: row.pair_phone ?? null,
        logout_requested_at: row.logout_requested_at ?? null,
        status: (row.status ?? 'disconnected') as SessionStatus,
      }));
  }
  async queuedContacts() {
    const out: { user_id: string; phone: string }[] = [];
    for (const [user_id, rows] of this.contacts) {
      for (const row of rows) {
        if (row.queue_requested_at) out.push({ user_id, phone: row.phone });
      }
    }
    return out;
  }
  async clearQueueRequest(userId: string, phones: string[]) {
    for (const row of this.rows(userId)) {
      if (phones.includes(row.phone)) row.queue_requested_at = null;
    }
  }
  async requestQueue(userId: string, phones: string[] | 'all-pending') {
    const now = new Date().toISOString();
    let flagged = 0;
    for (const row of this.rows(userId)) {
      const wanted = phones === 'all-pending' ? row.status === 'pending' : phones.includes(row.phone);
      if (!wanted) continue;
      if (phones !== 'all-pending' && row.status === 'failed') {
        row.status = 'pending';
        row.error = null;
      }
      if (row.status !== 'pending') continue;
      row.queue_requested_at = now;
      flagged += 1;
    }
    return flagged;
  }
  async getPolicy(userId: string): Promise<Policy> {
    return {
      subscribed: maySave(
        this.profiles.get(userId)?.subscription_status,
        this.profiles.get(userId)?.grace_until,
        this.profiles.get(userId)?.pro_granted,
      ),
      settings: { ...(this.settings.get(userId) ?? defaultSettings()) },
      rules: this.ruleRows(userId)
        .filter((r) => r.enabled)
        .map((r): PrefixRule => ({ id: r.id, kind: r.kind, prefix: r.prefix, label: r.label })),
    };
  }

  async recordEvent(userId: string, event: SaveEvent) {
    const rows = this.eventRows(userId);
    this.events.set(userId, rows);
    rows.push({ ...event, occurred_at: new Date().toISOString() });
  }
  async countSavesSince(userId: string, sinceIso: string) {
    return this.eventRows(userId).filter((e) => e.decision === 'saved' && e.occurred_at >= sinceIso).length;
  }

  async claimContact(userId: string, row: ContactRow) {
    const rows = this.rows(userId);
    this.contacts.set(userId, rows);
    const existing = rows.find((r) => r.phone === row.phone);
    if (!existing) {
      rows.push({ ...row, created_at: new Date().toISOString() });
      return true;
    }
    // A removed row is not a live claim: asking again is fresh consent.
    if (existing.status !== 'removed') return false;
    Object.assign(existing, row, { error: null, created_at: new Date().toISOString() });
    return true;
  }
  async getProfile(userId: string) {
    return this.profiles.get(userId) ?? null;
  }
  async findProfileByCustomer(customerId: string) {
    return [...this.profiles.values()].find((p) => p.stripe_customer_id === customerId) ?? null;
  }
  async setCustomerId(userId: string, customerId: string) {
    this.profiles.get(userId)!.stripe_customer_id = customerId;
  }
  periodEnd = new Map<string, string | null>();
  async setSubscription(userId: string, status: string, periodEnd: string | null) {
    this.profiles.get(userId)!.subscription_status = status;
    this.periodEnd.set(userId, periodEnd);
  }
  grace = new Map<string, string | null>();
  async setGrace(userId: string, until: string | null) {
    this.grace.set(userId, until);
    const profile = this.profiles.get(userId);
    if (profile) profile.grace_until = until;
  }
  async usersWithLapsedGrace() {
    const now = new Date().toISOString();
    return [...this.profiles.values()]
      .filter(
        (p) =>
          ['past_due', 'unpaid'].includes(p.subscription_status) &&
          p.grace_until != null &&
          p.grace_until < now,
      )
      .map((p) => p.id);
  }
  async purgeEvents(retentionDays: number) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    let removed = 0;
    for (const [userId, rows] of this.events) {
      const kept = rows.filter((e) => e.occurred_at >= cutoff);
      removed += rows.length - kept.length;
      this.events.set(userId, kept);
    }
    return removed;
  }
  async setProGranted(userId: string, granted: boolean) {
    const profile = this.profiles.get(userId);
    if (!profile) return false;
    profile.pro_granted = granted;
    return true;
  }
  async adminOverview(limit: number) {
    return [...this.profiles.values()].slice(0, limit).map((p) => {
      const rows = this.rows(p.id);
      const count = (status: string) => rows.filter((r) => r.status === status).length;
      const settings = this.settings.get(p.id);
      const session = this.sessions.get(p.id);
      return {
        user_id: p.id,
        email: p.email,
        subscription_status: p.subscription_status,
        grace_until: p.grace_until ?? null,
        pro_granted: p.pro_granted ?? false,
        created_at: this.createdAt.get(p.id) ?? new Date().toISOString(),
        session_status: session?.status ?? null,
        session_phone: session?.phone ?? null,
        last_connected_at: session?.last_connected_at ?? null,
        armed: settings?.armed ?? null,
        enabled: settings?.enabled ?? null,
        save_mode: settings?.save_mode ?? null,
        saved_count: count('saved'),
        failed_count: count('failed'),
        pending_count: count('pending'),
        removed_count: count('removed'),
        last_event_at: this.eventRows(p.id).at(-1)?.occurred_at ?? null,
      };
    });
  }

  async deleteUser(userId: string) {
    this.deletedUsers.push(userId);
    this.profiles.delete(userId);
  }
  async loadContacts(userId: string) {
    return this.rows(userId).map((r) => ({ phone: r.phone, status: r.status, push_name: r.push_name ?? null, lid: r.lid ?? null }));
  }
  async getContact(userId: string, phone: string) {
    return (await this.loadContacts(userId)).find((r) => r.phone === phone) ?? null;
  }
  async updateContact(userId: string, phone: string, patch: Partial<ContactRow>) {
    const row = this.rows(userId).find((r) => r.phone === phone);
    if (row) Object.assign(row, patch, { created_at: new Date().toISOString() });
  }
  async countSavedSince(userId: string, sinceIso: string) {
    return this.rows(userId).filter((r) => r.status === 'saved' && r.created_at >= sinceIso).length;
  }
  async insertContact(userId: string, row: ContactRow) {
    const rows = this.rows(userId);
    this.contacts.set(userId, rows);
    if (rows.some((r) => r.phone === row.phone)) return; // unique (user_id, phone)
    rows.push({ ...row, created_at: new Date().toISOString() });
  }
  async deleteContact(userId: string, phone: string) {
    this.contacts.set(userId, this.rows(userId).filter((r) => r.phone !== phone));
  }
}

/** A Baileys socket that records what was asked of it. */
export class FakeSocket implements ManagedSocket {
  ev = new EventEmitter() as EventEmitter & ManagedSocket['ev'];
  user: { id: string } | null = { id: '15550009999:3@s.whatsapp.net' };
  authState: { creds: { me?: unknown } };
  saved: { jid: string; contact: { fullName: string; firstName: string; saveOnPrimaryAddressbook: boolean } }[] = [];
  lidMap = new Map<string, string>();
  failNext = 0;
  ended = false;
  loggedOut = false;
  /** Any method that would be visible to the other person. Must stay empty. */
  visibleCalls: string[] = [];

  constructor(creds: { me?: unknown } = { me: { id: 'x' } }) {
    this.authState = { creds };
  }

  signalRepository = {
    lidMapping: { getPNForLID: async (lid: string) => this.lidMap.get(lid) ?? null },
  };
  async addOrEditContact(jid: string, contact: FakeSocket['saved'][number]['contact']) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('boom');
    }
    this.saved.push({ jid, contact });
  }
  removed: string[] = [];
  failNextRemove = 0;
  async removeContact(jid: string) {
    if (this.failNextRemove > 0) {
      this.failNextRemove -= 1;
      throw new Error('boom');
    }
    this.removed.push(jid);
  }
  end() {
    this.ended = true;
  }
  async logout() {
    this.loggedOut = true;
  }
  pairingRequests: string[] = [];
  async requestPairingCode(phone: string) {
    this.pairingRequests.push(phone);
    return 'ABCD1234';
  }
  sendMessage() {
    this.visibleCalls.push('sendMessage');
  }
  readMessages() {
    this.visibleCalls.push('readMessages');
  }
  sendPresenceUpdate() {
    this.visibleCalls.push('sendPresenceUpdate');
  }
  sendReceipt() {
    this.visibleCalls.push('sendReceipt');
  }
}

/**
 * What the worker's reconcile loop does for a backfill: flag the pending rows,
 * hand the phones to the saver, clear the flags.
 *
 * Tests go through this rather than calling queuePhones directly, so they
 * exercise the same path production does — including the store-level guards
 * that decide which rows are eligible at all.
 */
export async function queuePending(
  store: MemoryStore,
  saver: { queuePhones(phones: readonly string[]): Promise<number> },
  userId = USER,
): Promise<number> {
  await store.requestQueue(userId, 'all-pending');
  const phones = (await store.queuedContacts())
    .filter((r) => r.user_id === userId)
    .map((r) => r.phone);
  const queued = await saver.queuePhones(phones);
  await store.clearQueueRequest(userId, phones);
  return queued;
}

/** The same, for one person: the Retry button. */
export async function queueOne(
  store: MemoryStore,
  saver: { queuePhones(phones: readonly string[]): Promise<number> },
  phone: string,
  userId = USER,
): Promise<number> {
  const flagged = await store.requestQueue(userId, [phone]);
  if (flagged === 0) return 0;
  const queued = await saver.queuePhones([phone]);
  await store.clearQueueRequest(userId, [phone]);
  return queued;
}

export const msg = (remoteJid: string, pushName?: string | null, extra: object = {}) => ({
  key: { remoteJid, fromMe: false, ...extra },
  pushName,
});

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
