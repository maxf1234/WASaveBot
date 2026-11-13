/**
 * The core: decide which incoming messages mean "a new person", and save them
 * as WhatsApp contacts one at a time.
 *
 * One ContactSaver per user. It outlives reconnects, so the queue and the
 * in-memory set of known numbers carry over when a socket is replaced.
 *
 * Nothing in here (or anywhere in the worker) sends a message, a read receipt
 * or a presence update. The only write to WhatsApp is addOrEditContact, which
 * is a change to the user's own contact list and invisible to the other person.
 */

import { errorMessage, log, maskPhone } from './log.js';
import { buildName, isIgnoredChat, isLidJid, isPnJid, pnJidOf, userPart } from './naming.js';
import type { PolicyCache, Store } from './store.js';

/** The slice of a Baileys socket this module uses. */
export interface WaSocketLike {
  user?: { id: string } | null;
  addOrEditContact(
    jid: string,
    contact: { fullName: string; firstName: string; saveOnPrimaryAddressbook: boolean },
  ): Promise<void>;
  signalRepository: { lidMapping: { getPNForLID(lid: string): Promise<string | null> } };
}

export interface IncomingMessage {
  key: { remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null };
  pushName?: string | null;
}

export interface IncomingContact {
  id?: string;
  lid?: string;
  phoneNumber?: string;
  name?: string | null;
  notify?: string | null;
}

interface Job {
  phone: string;
  /** The row already exists (a backfill or a retry), so the result updates it. */
  update?: boolean;
  /** A retry the user asked for: run even though the number is already known. */
  force?: boolean;
  lid: string | null;
  pushName: string | null;
  name: string;
}

export interface SaverOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const lidKey = (lidUser: string): string => `lid:${lidUser}`;

export class ContactSaver {
  /** Every phone that has a saved_contacts row: saved, existing or failed. */
  #known = new Set<string>();
  /** People from existing chats, found when linking, waiting for the user to say "save them". */
  #candidates = new Map<string, { pushName: string | null; lid: string | null }>();
  /** Push names seen in the history sync, by phone, for naming candidates. */
  #pushNames = new Map<string, string>();
  /** Phones waiting in the queue. */
  #queued = new Set<string>();
  #jobs: Job[] = [];
  #running = false;
  #savedToday = 0;
  #day = '';
  #lastSaveAt = 0;
  #loaded = false;
  #chain: Promise<void> = Promise.resolve();

  #sleep: (ms: number) => Promise<void>;
  #random: () => number;
  #now: () => Date;

  constructor(
    private userId: string,
    private store: Store,
    private policy: PolicyCache,
    private getSock: () => WaSocketLike | undefined,
    options: SaverOptions = {},
  ) {
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => new Date());
  }

  /** Load the known numbers and today's count. Called once, before the socket opens. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    for (const row of await this.store.loadContacts(this.userId)) {
      if (row.status === 'pending') this.#candidates.set(row.phone, { pushName: row.push_name, lid: row.lid });
      else this.#known.add(row.phone);
    }
    const now = this.#now();
    this.#day = utcDay(now);
    this.#savedToday = await this.store.countSavedSince(this.userId, `${this.#day}T00:00:00Z`);
    this.#loaded = true;
  }

  /** Events are handled strictly in arrival order, one batch at a time. */
  #inOrder(work: () => Promise<void>): Promise<void> {
    this.#chain = this.#chain.then(work).catch((error) => {
      log.error('saver event failed', { userId: this.userId, error: errorMessage(error) });
    });
    return this.#chain;
  }

  onMessages(messages: IncomingMessage[]): Promise<void> {
    return this.#inOrder(async () => {
      for (const message of messages) await this.#onMessage(message);
    });
  }

  onContacts(contacts: IncomingContact[]): Promise<void> {
    return this.#inOrder(async () => {
      for (const contact of contacts) await this.#onContact(contact);
    });
  }

  /**
   * The chat list WhatsApp sends right after linking. Entries with a saved
   * name are the user's own contacts; a 1:1 chat with no name is someone they
   * talk to but never saved: a backfill candidate.
   */
  onHistory(contacts: IncomingContact[]): Promise<void> {
    return this.#inOrder(async () => {
      for (const contact of contacts) {
        if (contact.name?.trim()) {
          await this.#onContact(contact);
          continue;
        }
        const phone = await this.#phoneOf(contact);
        if (!phone) continue;
        if (contact.notify) {
          // A push-name entry. These cover group members too, so on its own it
          // is not a candidate; it only names one.
          this.#pushNames.set(phone, contact.notify);
          const candidate = this.#candidates.get(phone);
          if (candidate && !candidate.pushName) {
            candidate.pushName = contact.notify;
            await this.store.updateContact(this.userId, phone, { push_name: contact.notify });
          }
          continue;
        }
        if (!contact.id || isIgnoredChat(contact.id)) continue;
        if (this.#known.has(phone) || this.#candidates.has(phone) || this.#queued.has(phone)) continue;
        const sock = this.getSock();
        if (sock?.user?.id && userPart(sock.user.id) === phone) continue;
        const lid = isLidJid(contact.lid) ? contact.lid : isLidJid(contact.id) ? contact.id : null;
        const pushName = this.#pushNames.get(phone) ?? null;
        this.#candidates.set(phone, { pushName, lid });
        await this.store.insertContact(this.userId, { phone, lid, push_name: pushName, status: 'pending' });
      }
    });
  }

  /** Queue every backfill candidate. Returns how many were queued. */
  async backfill(): Promise<number> {
    const policy = await this.policy.get(this.userId);
    let queued = 0;
    for (const [phone, candidate] of this.#candidates) {
      if (this.#known.has(phone) || this.#queued.has(phone)) continue;
      this.#queued.add(phone);
      this.#jobs.push({
        phone,
        update: true,
        lid: candidate.lid,
        pushName: candidate.pushName,
        name: buildName(candidate.pushName, phone, policy.settings),
      });
      queued += 1;
    }
    void this.#run();
    return queued;
  }

  /** Try a failed contact again, because the user asked. False if there is nothing to retry. */
  async retry(phone: string): Promise<boolean> {
    const row = await this.store.getContact(this.userId, phone);
    if (!row || row.status !== 'failed' || this.#queued.has(phone)) return false;
    const policy = await this.policy.get(this.userId);
    this.#queued.add(phone);
    this.#jobs.push({
      phone,
      update: true,
      force: true,
      lid: row.lid,
      pushName: row.push_name,
      name: buildName(row.push_name, phone, policy.settings),
    });
    void this.#run();
    return true;
  }

  async #phoneOf(contact: IncomingContact): Promise<string> {
    let pnJid: string | null = null;
    if (isPnJid(contact.id)) pnJid = contact.id;
    else if (isPnJid(contact.phoneNumber)) pnJid = contact.phoneNumber;
    else {
      const lid = isLidJid(contact.id) ? contact.id : contact.lid;
      if (isLidJid(lid)) {
        pnJid = (await this.getSock()?.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)) ?? null;
      }
    }
    return pnJid ? userPart(pnJid) : '';
  }

  async #onMessage(message: IncomingMessage): Promise<void> {
    if (message.key.fromMe) return;
    const remoteJid = message.key.remoteJid;
    if (!remoteJid || isIgnoredChat(remoteJid)) return;

    const policy = await this.policy.get(this.userId);
    if (!policy.settings.enabled || !policy.subscribed) return;

    const sock = this.getSock();
    let pnJid: string | null;
    let lid: string | null = null;
    if (isPnJid(remoteJid)) {
      pnJid = remoteJid;
      if (isLidJid(message.key.remoteJidAlt)) lid = message.key.remoteJidAlt;
    } else if (isLidJid(remoteJid)) {
      lid = remoteJid;
      if (isPnJid(message.key.remoteJidAlt)) pnJid = message.key.remoteJidAlt;
      else pnJid = (await sock?.signalRepository.lidMapping.getPNForLID(remoteJid).catch(() => null)) ?? null;
    } else {
      return; // Some other kind of address; not a person's private chat.
    }

    const phone = pnJid ? userPart(pnJid) : '';
    if (!phone) {
      const key = lidKey(userPart(lid ?? '') || (lid ?? remoteJid));
      if (this.#known.has(key)) return;
      this.#known.add(key);
      await this.store.insertContact(this.userId, {
        phone: key,
        lid,
        push_name: message.pushName ?? null,
        status: 'unresolved',
      });
      return;
    }

    // The user's own number (a note to self from another device) is not a contact.
    if (sock?.user?.id && userPart(sock.user.id) === phone) return;
    if (this.#known.has(phone) || this.#queued.has(phone)) return;

    // A sender we could not resolve earlier now has a number: drop the placeholder.
    const stale = lid ? lidKey(userPart(lid)) : null;
    if (stale && this.#known.delete(stale)) await this.store.deleteContact(this.userId, stale);

    this.#queued.add(phone);
    this.#jobs.push({
      phone,
      // A backfill candidate who messages gets saved now; their row already exists.
      update: this.#candidates.has(phone),
      lid,
      pushName: message.pushName ?? null,
      name: buildName(message.pushName, phone, policy.settings),
    });
    void this.#run();
  }

  /**
   * A contact that arrives with `name` set is one the user saved themselves.
   * Record it as 'existing' so it is never touched.
   */
  async #onContact(contact: IncomingContact): Promise<void> {
    const name = contact.name?.trim();
    if (!name) return;

    const phone = await this.#phoneOf(contact);
    if (!phone || this.#known.has(phone)) return;

    this.#known.add(phone);
    if (this.#candidates.delete(phone)) {
      // A backfill candidate the user has since saved by hand.
      await this.store.updateContact(this.userId, phone, { status: 'existing', saved_name: name });
      return;
    }
    await this.store.insertContact(this.userId, {
      phone,
      lid: isLidJid(contact.lid) ? contact.lid : isLidJid(contact.id) ? contact.id : null,
      push_name: contact.notify ?? null,
      saved_name: name,
      status: 'existing',
    });
  }

  /** One save at a time, 3 to 6 seconds apart, until the daily cap. */
  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let job = this.#jobs.shift(); job; job = this.#jobs.shift()) {
        const today = utcDay(this.#now());
        if (today !== this.#day) {
          this.#day = today;
          this.#savedToday = 0;
        }

        const policy = await this.policy.get(this.userId);
        if (this.#savedToday >= policy.settings.daily_cap) {
          // Done for the day: leftover jobs are dropped, not carried over.
          log.info('daily cap reached, dropping queue', {
            userId: this.userId,
            dropped: this.#jobs.length + 1,
          });
          this.#jobs = [];
          this.#queued.clear();
          return;
        }

        this.#queued.delete(job.phone);
        // Switched off, unsubscribed, or saved by hand while it waited.
        const done = this.#known.has(job.phone) && !job.force;
        if (!policy.settings.enabled || !policy.subscribed || done) continue;

        await this.#pause();
        if (this.#known.has(job.phone) && !job.force) continue;
        // Claimed before the call, so the contact event WhatsApp echoes back
        // for our own save is not mistaken for one the user made by hand.
        this.#known.add(job.phone);
        await this.#save(job, policy.settings.save_to_phone);
      }
    } catch (error) {
      log.error('save queue failed', { userId: this.userId, error: errorMessage(error) });
    } finally {
      this.#running = false;
    }
  }

  async #pause(): Promise<void> {
    if (!this.#lastSaveAt) return;
    const gap = 3000 + this.#random() * 3000;
    const wait = this.#lastSaveAt + gap - Date.now();
    if (wait > 0) await this.#sleep(wait);
  }

  async #save(job: Job, saveToPhone: boolean): Promise<void> {
    let failure = '';
    // One attempt, and at most one retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await this.#pause();
      try {
        const sock = this.getSock();
        if (!sock) throw new Error('WhatsApp is not connected');
        await sock.addOrEditContact(pnJidOf(job.phone), {
          fullName: job.name,
          firstName: job.name.split(' ')[0] ?? job.name,
          saveOnPrimaryAddressbook: saveToPhone,
        });
        failure = '';
      } catch (error) {
        failure = errorMessage(error) || 'unknown error';
      }
      this.#lastSaveAt = Date.now();
      if (!failure) break;
    }

    if (!failure) this.#savedToday += 1;
    const row = {
      phone: job.phone,
      lid: job.lid,
      push_name: job.pushName,
      saved_name: job.name,
      status: failure ? ('failed' as const) : ('saved' as const),
      error: failure || null,
    };
    this.#candidates.delete(job.phone);
    if (job.update) await this.store.updateContact(this.userId, job.phone, row);
    else await this.store.insertContact(this.userId, row);
    log.info(failure ? 'contact save failed' : 'contact saved', {
      userId: this.userId,
      phone: maskPhone(job.phone),
      ...(failure ? { error: failure } : {}),
    });
  }

  /** For tests and /health: resolves when the queue is empty and idle. */
  async idle(): Promise<void> {
    for (;;) {
      await this.#chain;
      if (!this.#running && this.#jobs.length === 0) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
