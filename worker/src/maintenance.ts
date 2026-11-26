/**
 * The periodic jobs nothing else owns.
 *
 * The worker is otherwise entirely event-driven: a socket event, an HTTP
 * request, a Stripe webhook. Two things have no event to hang off, because
 * they are about the passage of time rather than about anything happening:
 *
 *   - a payment grace window running out, which no webhook announces, because
 *     Stripe said what it had to say when the payment first failed
 *   - activity rows ageing past their retention window
 *
 * Both are idempotent and cheap, so the loop is a plain interval with no
 * locking. With sessions sharded, each replica sweeps and the work is simply
 * done more than once; `purgeEvents` deleting zero rows the second time is the
 * whole cost.
 */

import { describeError, log } from './log.js';
import type { Store } from './store.js';

export interface MaintenanceOptions {
  retentionDays: number;
  /** 0 disables the limit; an unsubscribed account then previews indefinitely. */
  freePreviewDays?: number;
  /** How often to look. Grace is checked every tick; the purge once a day. */
  intervalMs?: number;
  now?: () => Date;
}

/**
 * What maintenance needs from the session manager: only a nudge.
 *
 * It used to call `stop()` directly. With sessions sharded that is wrong twice
 * over — the sweep runs on every replica, and most of the users it finds are
 * owned by a different one — so it writes intent like everything else and the
 * owning replica acts on it.
 */
export interface SessionStop {
  nudge?(): void;
}

const DAY = 86_400_000;

export class Maintenance {
  #timer?: NodeJS.Timeout;
  #lastPurgeDay = '';
  #running = false;
  #now: () => Date;
  #intervalMs: number;

  constructor(
    private store: Store,
    private sessions: SessionStop,
    private options: MaintenanceOptions,
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#intervalMs = options.intervalMs ?? 5 * 60_000;
  }

  start(): void {
    const tick = () => void this.runOnce();
    this.#timer = setInterval(tick, this.#intervalMs);
    // Unref'd so a pending tick never holds the process open at shutdown.
    this.#timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Exposed for tests, and for calling once at boot. */
  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.#expireGrace();
      await this.#expireFreePreviews();
      await this.#purgeDaily();
    } catch (error) {
      log.error('maintenance failed', describeError(error));
    } finally {
      this.#running = false;
    }
  }

  /**
   * Clear the grace window for customers whose window has run out.
   *
   * This does not close their socket. A customer whose payment lapsed drops to
   * the free preview, exactly like one who never paid: still connected, still
   * shown who would have been saved, writing nothing. `maySave` already stops
   * the writes the moment the deadline passes; clearing the column only stops
   * this sweep finding the same user on every tick. Closing the socket is the
   * free-preview window's job, below, so there is one rule for it.
   */
  async #expireGrace(): Promise<void> {
    const users = await this.store.usersWithLapsedGrace();
    for (const userId of users) {
      await this.store.setGrace(userId, null);
      log.info('payment grace expired, dropped to preview', { userId });
    }
  }

  /**
   * Close the sockets of unsubscribed accounts that have previewed long enough.
   *
   * Only the socket goes. Their settings, rules and activity stay, so
   * subscribing later picks up where they left off — and the activity log they
   * built up is the argument for subscribing.
   */
  async #expireFreePreviews(): Promise<void> {
    const days = this.options.freePreviewDays ?? 0;
    if (days <= 0) return;
    const expired = await this.store.usersPastFreePreview(days);
    for (const userId of expired) {
      // Intent, not a direct stop: the owning replica closes it. The login is
      // kept, so subscribing later reconnects without a new pairing code.
      await this.store.updateSession(userId, { desired: 'off' });
      log.info('free preview expired, socket closing', { userId, days });
    }
    if (expired.length > 0) this.sessions.nudge?.();
  }

  async #purgeDaily(): Promise<void> {
    if (this.options.retentionDays <= 0) return;
    const today = this.#now().toISOString().slice(0, 10);
    if (this.#lastPurgeDay === today) return;
    this.#lastPurgeDay = today;
    const removed = await this.store.purgeEvents(this.options.retentionDays);
    if (removed > 0) log.info('purged expired activity rows', { removed });
  }

  /** Visible for tests: how long a tick is, in days, for readability. */
  static days(n: number): number {
    return n * DAY;
  }
}
