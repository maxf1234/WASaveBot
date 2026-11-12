import { EventEmitter } from 'node:events';
import type { ManagedSocket } from '../src/sessions.js';
import type { ContactRow, Policy, Profile, SessionPatch, Settings, Store } from '../src/store.js';

export const USER = 'user-1';

export const defaultSettings = (): Settings => ({
  enabled: true,
  save_to_phone: true,
  name_template: '{name}',
  fallback_prefix: 'WA',
  daily_cap: 200,
});

/** An in-memory stand-in for Supabase. */
export class MemoryStore implements Store {
  auth = new Map<string, Map<string, unknown>>();
  sessions = new Map<string, SessionPatch>();
  profiles = new Map<string, Profile>();
  settings = new Map<string, Settings>();
  contacts = new Map<string, (ContactRow & { created_at: string })[]>();
  deletedUsers: string[] = [];

  addUser(id: string, status = 'active'): void {
    this.profiles.set(id, { id, email: `${id}@example.com`, stripe_customer_id: null, subscription_status: status });
    this.settings.set(id, defaultSettings());
    this.sessions.set(id, { status: 'disconnected' });
  }
  rows(userId = USER) {
    return this.contacts.get(userId) ?? [];
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
    return [...this.profiles.values()]
      .filter((p) => ['active', 'trialing'].includes(p.subscription_status) && this.auth.get(p.id)?.has('creds'))
      .map((p) => p.id);
  }
  async updateSession(userId: string, patch: SessionPatch) {
    this.sessions.set(userId, { ...this.sessions.get(userId), ...patch });
  }
  async getPolicy(userId: string): Promise<Policy> {
    return {
      subscribed: ['active', 'trialing'].includes(this.profiles.get(userId)?.subscription_status ?? ''),
      settings: { ...(this.settings.get(userId) ?? defaultSettings()) },
    };
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
  async deleteUser(userId: string) {
    this.deletedUsers.push(userId);
    this.profiles.delete(userId);
  }
  async loadPhones(userId: string) {
    return this.rows(userId).map((r) => r.phone);
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

export const msg = (remoteJid: string, pushName?: string | null, extra: object = {}) => ({
  key: { remoteJid, fromMe: false, ...extra },
  pushName,
});

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
