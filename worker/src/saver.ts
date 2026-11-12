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
    for (const phone of await this.store.loadPhones(this.userId)) this.#known.add(phone);
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

    let pnJid: string | null = null;
    if (isPnJid(contact.id)) pnJid = contact.id;
    else if (isPnJid(contact.phoneNumber)) pnJid = contact.phoneNumber;
    else {
      const lid = isLidJid(contact.id) ? contact.id : contact.lid;
      if (isLidJid(lid)) {
        pnJid = (await this.getSock()?.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)) ?? null;
      }
    }
    const phone = pnJid ? userPart(pnJid) : '';
    if (!phone || this.#known.has(phone)) return;

    this.#known.add(phone);
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
        if (!policy.settings.enabled || !policy.subscribed || this.#known.has(job.phone)) continue;

        await this.#pause();
        if (this.#known.has(job.phone)) continue;
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
    await this.store.insertContact(this.userId, {
      phone: job.phone,
      lid: job.lid,
      push_name: job.pushName,
      saved_name: job.name,
      status: failure ? 'failed' : 'saved',
      error: failure || null,
    });
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
