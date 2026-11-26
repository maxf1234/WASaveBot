/**
 * The core: decide what each incoming message means, and carry the decision out
 * one contact at a time.
 *
 * One ContactSaver per user. It outlives reconnects, so the queue and the
 * in-memory view of known numbers carry over when a socket is replaced.
 *
 * The judgement itself is not here — it is `decide()`, a pure function over the
 * message, the settings, the rules and four facts. This file's job is to gather
 * those facts, run the queue, and write down what happened. Keeping the two
 * apart is what makes "an unarmed account never writes to an address book"
 * provable as a property rather than a flag every branch has to remember.
 *
 * Nothing in here (or anywhere in the worker) sends a message, a read receipt
 * or a presence update. The only writes to WhatsApp are addOrEditContact and
 * removeContact, both changes to the user's own contact list and both invisible
 * to the other person. A test fails the build if that ever stops being true.
 */

import { decide } from './decide.js';
import type { Decision, Verdict } from './decide.js';
import { describeError, log, maskName, maskPhone } from './log.js';
import { buildName, isIgnoredChat, isLidJid, isPnJid, pnJidOf, userPart } from './naming.js';
import type { PolicyCache, SaveEvent, Store } from './store.js';

/** The slice of a Baileys socket this module uses. */
export interface WaSocketLike {
  user?: { id: string } | null;
  addOrEditContact(
    jid: string,
    contact: { fullName: string; firstName: string; saveOnPrimaryAddressbook: boolean },
  ): Promise<void>;
  /** Takes a contact back out, for an opt-out. Also invisible to the other person. */
  removeContact(jid: string): Promise<void>;
  signalRepository: { lidMapping: { getPNForLID(lid: string): Promise<string | null> } };
}

/**
 * The text carriers worth reading. Only plain text and captions can hold a
 * phrase; a sticker or a location cannot, and is not inspected.
 */
export interface MessageContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
}

export interface IncomingMessage {
  key: { remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null };
  pushName?: string | null;
  /**
   * The message itself. Read for the trigger and the opt-out phrase, and for
   * nothing else — it is never logged and never stored.
   */
  message?: MessageContent | null;
}

export interface IncomingContact {
  id?: string;
  lid?: string;
  phoneNumber?: string;
  name?: string | null;
  notify?: string | null;
}

/** The three states a number can be in, mirroring its saved_contacts row. */
type TrackedStatus = 'live' | 'pending' | 'removed';

interface Tracked {
  status: TrackedStatus;
  pushName: string | null;
  lid: string | null;
}

type JobKind = 'save' | 'remove';

interface Job {
  kind: JobKind;
  phone: string;
  /** The row already exists (a backfill, a retry, an opt-out), so the result updates it. */
  update?: boolean;
  /** A retry the user asked for: run even though the number is already known. */
  force?: boolean;
  lid: string | null;
  pushName: string | null;
  requestedName: string | null;
  name: string;
  /** Carried so the activity row can name the rule that let this through. */
  matchedPrefix?: string;
  ruleId?: number;
}

export interface SaverOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const lidKey = (lidUser: string): string => `lid:${lidUser}`;

/** The text of a message, whatever shape it arrived in. Empty when there is none. */
export function bodyOf(message: IncomingMessage): string {
  const content = message.message;
  if (!content) return '';
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    ''
  );
}

export class ContactSaver {
  /**
   * What we know about each number, mirroring its saved_contacts row.
   *
   * One map rather than three sets. The three states are mutually exclusive —
   * a row cannot be both live and removed — and keeping them in separate sets
   * meant every transition had to remember to delete from the other two. Here
   * a transition is one assignment and the illegal combinations cannot be
   * expressed at all.
   *
   *   live    — saved, existing, failed or unresolved: we hold this number
   *   pending — from an existing chat, or held by the cap; not saved yet
   *   removed — they asked not to be held, and only a fresh request revives them
   */
  #tracked = new Map<string, Tracked>();
  /** Push names seen in the history sync, by phone, for naming candidates. */
  #pushNames = new Map<string, string>();
  /** Phones waiting in the queue. */
  #queued = new Set<string>();
  #jobs: Job[] = [];
  #running = false;
  #savedToday = 0;
  #day = '';
  #lastWriteAt = 0;
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

  #state(phone: string): TrackedStatus | undefined {
    return this.#tracked.get(phone)?.status;
  }

  /** We hold this number: it must not be saved again. */
  #isLive(phone: string): boolean {
    return this.#state(phone) === 'live';
  }

  #isRemoved(phone: string): boolean {
    return this.#state(phone) === 'removed';
  }

  #isPending(phone: string): boolean {
    return this.#state(phone) === 'pending';
  }

  /** Move a number to a state, keeping whatever we already knew about it. */
  #track(
    phone: string,
    status: TrackedStatus,
    extra: { pushName?: string | null; lid?: string | null } = {},
  ): void {
    const existing = this.#tracked.get(phone);
    this.#tracked.set(phone, {
      status,
      pushName: extra.pushName ?? existing?.pushName ?? null,
      lid: extra.lid ?? existing?.lid ?? null,
    });
  }

  #pending(): [string, Tracked][] {
    return [...this.#tracked].filter(([, t]) => t.status === 'pending');
  }

  /** Load the known numbers and today's count. Called once, before the socket opens. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    for (const row of await this.store.loadContacts(this.userId)) {
      const status: TrackedStatus =
        row.status === 'pending' ? 'pending' : row.status === 'removed' ? 'removed' : 'live';
      this.#track(row.phone, status, { pushName: row.push_name, lid: row.lid });
    }
    const now = this.#now();
    this.#day = utcDay(now);
    // Counted from the activity log rather than from saved_contacts: the log is
    // append-only, so a contact that is later removed cannot quietly give the
    // customer back a slot they already spent.
    this.#savedToday = await this.store.countSavesSince(this.userId, `${this.#day}T00:00:00Z`);
    this.#loaded = true;
  }

  /** Events are handled strictly in arrival order, one batch at a time. */
  #inOrder(work: () => Promise<void>): Promise<void> {
    this.#chain = this.#chain.then(work).catch((error) => {
      log.error('saver event failed', { userId: this.userId, ...describeError(error) });
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
          if (this.#isPending(phone) && !this.#tracked.get(phone)!.pushName) {
            this.#track(phone, 'pending', { pushName: contact.notify });
            await this.store.updateContact(this.userId, phone, { push_name: contact.notify });
          }
          continue;
        }
        if (!contact.id || isIgnoredChat(contact.id)) continue;
        if (this.#isTracked(phone) || this.#queued.has(phone)) continue;
        if (this.#isSelf(phone)) continue;
        const lid = isLidJid(contact.lid) ? contact.lid : isLidJid(contact.id) ? contact.id : null;
        const pushName = this.#pushNames.get(phone) ?? null;
        this.#track(phone, 'pending', { pushName, lid });
        await this.store.claimContact(this.userId, {
          phone, lid, push_name: pushName, status: 'pending',
        });
      }
    });
  }

  /** Queue every waiting candidate — backfill or held by the cap. Returns how many. */
  async backfill(): Promise<number> {
    const { settings, rules } = await this.policy.get(this.userId);
    let queued = 0;
    for (const [phone, candidate] of this.#pending()) {
      if (this.#queued.has(phone)) continue;
      // A candidate is still subject to the rules: the customer may have added
      // one since the backfill list was gathered.
      const verdict = decide(
        { phone, body: '' },
        // Backfill is an explicit instruction, so the save phrase does not
        // apply to it — the customer pressed the button for these people.
        { ...settings, save_mode: 'everyone' },
        rules,
        { alreadyKnown: false, optedOut: this.#isRemoved(phone), subscribed: true, capped: false },
      );
      if (verdict.action !== 'save') {
        await this.#record(verdict.decision, {
          phone,
          push_name: candidate.pushName,
          matched_prefix: verdict.matchedPrefix ?? null,
          rule_id: verdict.ruleId ?? null,
          detail: verdict.detail ?? null,
        });
        continue;
      }
      this.#queued.add(phone);
      this.#jobs.push({
        kind: 'save',
        phone,
        update: true,
        lid: candidate.lid,
        pushName: candidate.pushName,
        requestedName: null,
        name: buildName(candidate.pushName, phone, settings),
        matchedPrefix: verdict.matchedPrefix,
        ruleId: verdict.ruleId,
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
    const { settings } = await this.policy.get(this.userId);
    this.#queued.add(phone);
    this.#jobs.push({
      kind: 'save',
      phone,
      update: true,
      force: true,
      lid: row.lid,
      pushName: row.push_name,
      requestedName: null,
      name: buildName(row.push_name, phone, settings),
    });
    void this.#run();
    return true;
  }

  #isTracked(phone: string): boolean {
    return this.#tracked.has(phone);
  }

  /** The user's own number, reached from another of their devices. Not a contact. */
  #isSelf(phone: string): boolean {
    const me = this.getSock()?.user?.id;
    return Boolean(me && userPart(me) === phone);
  }

  async #record(decision: Decision, event: Omit<SaveEvent, 'decision'>): Promise<void> {
    await this.store.recordEvent(this.userId, { ...event, decision });
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
    if (phone && this.#isSelf(phone)) return;

    const { settings, subscribed, rules } = await this.policy.get(this.userId);

    // A sender with no readable number. Recorded once, then left alone: there
    // is nothing to put in an address book, and the row is how the customer
    // finds out rather than wondering.
    if (!phone) {
      const key = lidKey(userPart(lid ?? '') || (lid ?? remoteJid));
      if (this.#isLive(key)) return;
      this.#track(key, 'live', { lid, pushName: message.pushName ?? null });
      await this.store.claimContact(this.userId, {
        phone: key, lid, push_name: message.pushName ?? null, status: 'unresolved',
      });
      await this.#record('unresolved', {
        phone: null,
        push_name: message.pushName ?? null,
        detail: 'WhatsApp gave no phone number for this sender',
      });
      return;
    }

    if (this.#queued.has(phone)) return;

    const verdict = decide(
      { phone, body: bodyOf(message) },
      settings,
      rules,
      {
        alreadyKnown: this.#isLive(phone),
        optedOut: this.#isRemoved(phone),
        subscribed,
        capped: this.#savedToday >= settings.daily_cap,
      },
    );

    // A sender we could not resolve earlier now has a number: drop the placeholder.
    const stale = lid ? lidKey(userPart(lid)) : null;
    if (stale && this.#isLive(stale)) {
      this.#tracked.delete(stale);
      await this.store.deleteContact(this.userId, stale);
    }

    await this.#apply(verdict, {
      phone,
      lid,
      pushName: message.pushName ?? null,
      settings,
    });
  }

  /** Turn a verdict into a queued job, a held row, an activity row, or nothing. */
  async #apply(
    verdict: Verdict,
    context: {
      phone: string;
      lid: string | null;
      pushName: string | null;
      settings: Awaited<ReturnType<PolicyCache['get']>>['settings'];
    },
  ): Promise<void> {
    const { phone, lid, pushName, settings } = context;

    if (verdict.silent) return;

    const event: Omit<SaveEvent, 'decision'> = {
      phone,
      push_name: pushName,
      matched_prefix: verdict.matchedPrefix ?? null,
      rule_id: verdict.ruleId ?? null,
      detail: verdict.detail ?? null,
    };

    if (verdict.action === 'none') {
      // Held by the cap: kept as a candidate so the customer can press
      // "Save them" rather than the person being silently dropped and lost if
      // they never message again — which is what the old queue did.
      if (verdict.decision === 'capped' && !this.#isPending(phone)) {
        this.#track(phone, 'pending', { pushName, lid });
        await this.store.claimContact(this.userId, {
          phone, lid, push_name: pushName, status: 'pending',
        });
      }
      await this.#record(verdict.decision, event);
      return;
    }

    const name =
      verdict.action === 'save'
        ? buildName(verdict.requestedName ?? pushName, phone, settings)
        : '';

    this.#queued.add(phone);
    this.#jobs.push({
      kind: verdict.action,
      phone,
      // A candidate or an opted-out person already has a row to update.
      update: this.#isPending(phone) || this.#isRemoved(phone),
      lid,
      pushName,
      requestedName: verdict.requestedName ?? null,
      name,
      matchedPrefix: verdict.matchedPrefix,
      ruleId: verdict.ruleId,
    });
    void this.#run();
  }

  /**
   * A contact that arrives with `name` set is one the user saved themselves.
   * Record it as 'existing' so it is never touched.
   *
   * No activity row: the whole address book arrives this way right after
   * linking, and hundreds of "you already had them" rows would bury the log.
   * The saved_contacts row is the record.
   */
  async #onContact(contact: IncomingContact): Promise<void> {
    const name = contact.name?.trim();
    if (!name) return;

    const phone = await this.#phoneOf(contact);
    if (!phone || this.#isLive(phone)) return;

    const wasPending = this.#isPending(phone);
    this.#track(phone, 'live', { pushName: contact.notify ?? null });
    if (wasPending) {
      // A backfill candidate the user has since saved by hand.
      await this.store.updateContact(this.userId, phone, { status: 'existing', saved_name: name });
      return;
    }
    await this.store.claimContact(this.userId, {
      phone,
      lid: isLidJid(contact.lid) ? contact.lid : isLidJid(contact.id) ? contact.id : null,
      push_name: contact.notify ?? null,
      saved_name: name,
      status: 'existing',
    });
  }

  /** One write at a time, 3 to 6 seconds apart, until the daily cap. */
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

        const { settings, subscribed } = await this.policy.get(this.userId);
        this.#queued.delete(job.phone);

        // An opt-out is honoured whatever else is true: not gated on the cap,
        // on `enabled`, on `armed`, or on the subscription. Somebody asking not
        // to be held is not a write the safety catch exists to prevent.
        if (job.kind === 'remove') {
          await this.#pause();
          await this.#remove(job);
          continue;
        }

        if (this.#savedToday >= settings.daily_cap) {
          // Out of budget. What is left becomes a candidate rather than being
          // thrown away, so the customer can save them from the dashboard.
          await this.#holdRemaining(job);
          return;
        }

        // Switched off, unsubscribed, or saved by hand while it waited.
        const done = this.#isLive(job.phone) && !job.force;
        if (!settings.enabled || !subscribed || done) continue;

        await this.#pause();
        if (this.#isLive(job.phone) && !job.force) continue;
        // Claimed before the call, so the contact event WhatsApp echoes back
        // for our own save is not mistaken for one the user made by hand.
        this.#track(job.phone, 'live', { pushName: job.pushName, lid: job.lid });
        await this.#save(job, settings.save_to_phone);
      }
    } catch (error) {
      log.error('save queue failed', { userId: this.userId, ...describeError(error) });
    } finally {
      this.#running = false;
    }
  }

  /** The cap ran out mid-queue: park this job and the rest as candidates. */
  async #holdRemaining(current: Job): Promise<void> {
    const held = [current, ...this.#jobs.filter((j) => j.kind === 'save')];
    this.#jobs = [];
    this.#queued.clear();
    for (const job of held) {
      if (this.#isLive(job.phone)) continue;
      if (!this.#isPending(job.phone)) {
        this.#track(job.phone, 'pending', { pushName: job.pushName, lid: job.lid });
        await this.store.claimContact(this.userId, {
          phone: job.phone, lid: job.lid, push_name: job.pushName, status: 'pending',
        });
      }
      await this.#record('capped', {
        phone: job.phone,
        push_name: job.pushName,
        detail: 'the daily cap is spent; held for you to save when you are ready',
      });
    }
    log.info('daily cap reached, holding the rest', { userId: this.userId, held: held.length });
  }

  async #pause(): Promise<void> {
    if (!this.#lastWriteAt) return;
    const gap = 3000 + this.#random() * 3000;
    const wait = this.#lastWriteAt + gap - Date.now();
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
        failure = describeError(error).error || 'unknown error';
      }
      this.#lastWriteAt = Date.now();
      if (!failure) break;
    }

    if (!failure) this.#savedToday += 1;
    const row = {
      phone: job.phone,
      lid: job.lid,
      push_name: job.pushName,
      saved_name: job.name,
      requested_name: job.requestedName,
      status: failure ? ('failed' as const) : ('saved' as const),
      error: failure || null,
    };
    this.#track(job.phone, 'live', { pushName: job.pushName, lid: job.lid });
    if (job.update) await this.store.updateContact(this.userId, job.phone, row);
    else await this.store.claimContact(this.userId, row);

    await this.#record(failure ? 'failed' : 'saved', {
      phone: job.phone,
      push_name: job.pushName,
      saved_name: job.name,
      matched_prefix: job.matchedPrefix ?? null,
      rule_id: job.ruleId ?? null,
      detail: failure || null,
    });
    log.info(failure ? 'contact save failed' : 'contact saved', {
      userId: this.userId,
      phone: maskPhone(job.phone),
      name: maskName(job.name),
      ...(failure ? { error: failure } : {}),
    });
  }

  /**
   * Take a contact back out, because they asked.
   *
   * A failure leaves the row as it was and records the attempt: the contact is
   * still in the customer's address book, and saying otherwise in the one place
   * they can check would be a lie. They can see it and ask us again.
   */
  async #remove(job: Job): Promise<void> {
    let failure = '';
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await sock.removeContact(pnJidOf(job.phone));
    } catch (error) {
      failure = describeError(error).error || 'unknown error';
    }
    this.#lastWriteAt = Date.now();

    if (failure) {
      await this.#record('failed', {
        phone: job.phone,
        push_name: job.pushName,
        detail: `could not remove the contact: ${failure}`,
      });
      log.error('contact removal failed', {
        userId: this.userId, phone: maskPhone(job.phone), error: failure,
      });
      return;
    }

    this.#track(job.phone, 'removed', { pushName: job.pushName, lid: job.lid });
    await this.store.updateContact(this.userId, job.phone, {
      status: 'removed', error: null, saved_name: null,
    });
    await this.#record('removed', {
      phone: job.phone,
      push_name: job.pushName,
      detail: 'the sender asked to be removed',
    });
    log.info('contact removed on request', { userId: this.userId, phone: maskPhone(job.phone) });
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
