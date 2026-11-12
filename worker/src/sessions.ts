/**
 * One WhatsApp socket per linked user, supervised.
 *
 * Reused from my contact-saver / whatsapp-filter workers: socket options, the
 * silent logger, the cached signal key store and the reconnect supervision.
 * The pairing-code login is theirs too; what differs is that state lives in Supabase.
 */

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from 'baileys';
import type { AuthenticationState, WAVersion } from 'baileys';
import { useSupabaseAuthState } from './authState.js';
import { errorMessage, log, maskPhone, silentLogger } from './log.js';
import { userPart } from './naming.js';
import { ContactSaver } from './saver.js';
import type { IncomingContact, IncomingMessage, WaSocketLike } from './saver.js';
import type { PolicyCache, Store } from './store.js';

/** The slice of a Baileys socket the manager uses (a fake satisfies it in tests). */
export interface ManagedSocket extends WaSocketLike {
  ev: { on(event: string, listener: (payload: never) => void): void };
  authState: { creds: { me?: unknown } };
  end(error: Error | undefined): void;
  logout(): Promise<void>;
  requestPairingCode(phone: string): Promise<string>;
}

export type SocketFactory = (auth: AuthenticationState) => Promise<ManagedSocket> | ManagedSocket;

interface ConnectionUpdate {
  connection?: 'open' | 'connecting' | 'close';
  qr?: string;
  lastDisconnect?: { error?: unknown };
}

interface Live {
  sock?: ManagedSocket;
  saver: ContactSaver;
  /** Set when we close the socket on purpose, so its close event is ignored. */
  closing: boolean;
  attempts: number;
  /** The number to pair with, until pairing succeeds. Digits only. */
  pairPhone?: string;
  /** The socket a code has already been requested on (one code per socket). */
  codeRequestedOn?: ManagedSocket;
  timer?: NodeJS.Timeout;
}

const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000];
export const backoffFor = (attempt: number): number =>
  BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 60_000;

let waVersion: WAVersion | undefined;

/** The real socket. Options beyond the two the product requires are the ones proven in my other bots. */
export const baileysSocketFactory: SocketFactory = async (auth) => {
  waVersion ??= await fetchLatestBaileysVersion()
    .then((r) => r.version)
    .catch(() => undefined);
  return makeWASocket({
    auth: {
      creds: auth.creds,
      // The key store is hit hard during a handshake; without the cache every
      // pre-key lookup is a round trip to Postgres.
      keys: makeCacheableSignalKeyStore(auth.keys, silentLogger as never),
    },
    version: waVersion,
    logger: silentLogger as never,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  }) as unknown as ManagedSocket;
};

export class SessionManager {
  #live = new Map<string, Live>();

  constructor(
    private store: Store,
    private policy: PolicyCache,
    private makeSocket: SocketFactory = baileysSocketFactory,
    private setTimer: (fn: () => void, ms: number) => NodeJS.Timeout = setTimeout,
  ) {}

  /** Sockets that exist right now (connected or on their way). */
  count(): number {
    return [...this.#live.values()].filter((l) => l.sock).length;
  }

  has(userId: string): boolean {
    return this.#live.has(userId);
  }

  /** On boot: every subscribed user who has a stored login. */
  async bootAll(): Promise<void> {
    const users = await this.store.usersToBoot();
    log.info('starting sessions', { count: users.length });
    for (const userId of users) {
      await this.start(userId).catch((error) => {
        log.error('could not start session', { userId, error: errorMessage(error) });
      });
    }
  }

  /**
   * Start (or keep) a user's socket. Safe to call twice.
   *
   * `pairPhone` is the user's own WhatsApp number (digits, with country code).
   * It is only needed the first time: with a stored login the socket just
   * reconnects and no code is involved.
   */
  async start(userId: string, pairPhone?: string): Promise<void> {
    const existing = this.#live.get(userId);
    if (existing) {
      // Pressing Connect again with a corrected number restarts the pairing.
      const paired = Boolean(existing.sock?.authState.creds.me);
      if (!pairPhone || paired || existing.pairPhone === pairPhone) return;
      this.#drop(userId, existing);
      await this.store.deleteAuth(userId);
    }
    const live: Live = {
      saver: new ContactSaver(userId, this.store, this.policy, () => this.#live.get(userId)?.sock),
      closing: false,
      attempts: 0,
      pairPhone,
    };
    this.#live.set(userId, live);
    try {
      await live.saver.load();
      await this.store.updateSession(userId, { status: 'connecting', pairing_code: null });
      await this.#open(userId, live);
    } catch (error) {
      this.#drop(userId, live);
      await this.store.updateSession(userId, { status: 'disconnected', pairing_code: null }).catch(() => {});
      throw error;
    }
  }

  /** Close the socket but keep the login, e.g. when a subscription lapses. */
  async stop(userId: string): Promise<void> {
    const live = this.#live.get(userId);
    if (live) this.#drop(userId, live);
    await this.store.updateSession(userId, { status: 'disconnected', pairing_code: null });
  }

  /** Unlink this device from the user's WhatsApp and forget the login. */
  async logout(userId: string): Promise<void> {
    const live = this.#live.get(userId);
    if (live) {
      live.closing = true;
      await live.sock?.logout().catch((error) => {
        log.warn('logout call failed', { userId, error: errorMessage(error) });
      });
      this.#drop(userId, live);
    }
    await this.store.deleteAuth(userId);
    await this.store.updateSession(userId, { status: 'disconnected', pairing_code: null, phone: null });
  }

  async stopAll(): Promise<void> {
    for (const [userId, live] of this.#live) this.#drop(userId, live);
  }

  #drop(userId: string, live: Live): void {
    live.closing = true;
    if (live.timer) clearTimeout(live.timer);
    if (this.#live.get(userId) === live) this.#live.delete(userId);
    try {
      live.sock?.end(undefined);
    } catch {
      // Already gone, which is what we wanted.
    }
    live.sock = undefined;
  }

  async #open(userId: string, live: Live): Promise<void> {
    const { state, saveCreds } = await useSupabaseAuthState(this.store, userId);
    const sock = await this.makeSocket(state);
    if (live.closing) {
      sock.end(undefined);
      return;
    }
    live.sock = sock;
    const current = () => this.#live.get(userId) === live && live.sock === sock && !live.closing;
    const guard = (what: string, work: () => Promise<void>) => {
      work().catch((error) => log.error(what, { userId, error: errorMessage(error) }));
    };

    sock.ev.on('creds.update', (() => guard('could not save creds', saveCreds)) as never);

    sock.ev.on('connection.update', ((update: ConnectionUpdate) => {
      if (current()) guard('connection update failed', () => this.#onConnection(userId, live, sock, update));
    }) as never);

    sock.ev.on('messages.upsert', ((upsert: { type: string; messages: IncomingMessage[] }) => {
      if (upsert.type === 'notify' && current()) void live.saver.onMessages(upsert.messages);
    }) as never);

    const onContacts = ((contacts: IncomingContact[]) => {
      if (current()) void live.saver.onContacts(contacts);
    }) as never;
    sock.ev.on('contacts.upsert', onContacts);
    sock.ev.on('contacts.update', onContacts);
    // The contact list WhatsApp sends right after linking arrives here.
    sock.ev.on('messaging-history.set', ((sync: { contacts?: IncomingContact[] }) => {
      if (current() && sync.contacts?.length) void live.saver.onContacts(sync.contacts);
    }) as never);
  }

  async #onConnection(
    userId: string,
    live: Live,
    sock: ManagedSocket,
    update: ConnectionUpdate,
  ): Promise<void> {
    // Baileys signals "ready to link a new device" by offering a QR. We do not
    // show it: we ask for a pairing code for the user's number instead.
    if (update.qr && live.codeRequestedOn !== sock) {
      live.codeRequestedOn = sock;
      if (!live.pairPhone) {
        // A stored login that WhatsApp no longer accepts, and no number to pair with.
        this.#drop(userId, live);
        await this.store.deleteAuth(userId);
        await this.store.updateSession(userId, { status: 'logged_out', pairing_code: null });
        return;
      }
      try {
        const code = await sock.requestPairingCode(live.pairPhone);
        if (this.#live.get(userId) !== live || live.sock !== sock) return;
        await this.store.updateSession(userId, { status: 'pairing', pairing_code: code });
        log.info('pairing code issued', { userId, phone: maskPhone(live.pairPhone) });
      } catch (error) {
        log.error('WhatsApp refused a pairing code', { userId, error: errorMessage(error) });
        this.#drop(userId, live);
        await this.store.deleteAuth(userId);
        await this.store.updateSession(userId, { status: 'disconnected', pairing_code: null });
      }
      return;
    }

    if (update.connection === 'open') {
      live.attempts = 0;
      live.pairPhone = undefined;
      const phone = userPart(sock.user?.id ?? '') || null;
      await this.store.updateSession(userId, {
        status: 'connected',
        pairing_code: null,
        phone,
        last_connected_at: new Date().toISOString(),
      });
      log.info('WhatsApp connected', { userId, phone: maskPhone(phone) });
      return;
    }

    if (update.connection !== 'close') return;

    // Baileys wraps the cause in a Boom error; read the status structurally.
    const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
      ?.output?.statusCode;
    live.sock = undefined;

    if (code === DisconnectReason.loggedOut) {
      // Removed from Linked Devices. The login is dead; reconnecting would loop.
      this.#drop(userId, live);
      await this.store.deleteAuth(userId);
      await this.store.updateSession(userId, { status: 'logged_out', pairing_code: null });
      log.warn('logged out by WhatsApp', { userId });
      return;
    }

    const paired = Boolean(sock.authState.creds.me);
    if (!paired && code !== DisconnectReason.restartRequired) {
      // Nobody entered the code before WhatsApp gave up. Stop quietly; the user
      // presses Connect again when they are ready.
      this.#drop(userId, live);
      await this.store.deleteAuth(userId);
      await this.store.updateSession(userId, { status: 'disconnected', pairing_code: null });
      return;
    }

    await this.store.updateSession(userId, { status: 'connecting', pairing_code: null });
    log.warn('WhatsApp disconnected, reconnecting', { userId, code });
    this.#scheduleReconnect(userId, live);
  }

  /** Backoff: 2s, 5s, 15s, 60s, then every 60s until it works. */
  #scheduleReconnect(userId: string, live: Live): void {
    const delay = backoffFor(live.attempts);
    live.attempts += 1;
    live.timer = this.setTimer(() => {
      void (async () => {
        if (this.#live.get(userId) !== live || live.closing) return;
        this.policy.invalidate(userId);
        if (!(await this.policy.get(userId)).subscribed) {
          await this.stop(userId);
          return;
        }
        await this.#open(userId, live);
      })().catch((error) => {
        log.error('reconnect failed', { userId, error: errorMessage(error) });
        if (this.#live.get(userId) === live && !live.closing) this.#scheduleReconnect(userId, live);
      });
    }, delay);
  }
}
