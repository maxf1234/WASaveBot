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
  /** How often to look. Grace is checked every tick; the purge once a day. */
  intervalMs?: number;
  now?: () => Date;
}

/** What maintenance needs from the session manager. */
export interface SessionStop {
  stop(userId: string): Promise<void>;
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
      await this.#purgeDaily();
    } catch (error) {
      log.error('maintenance failed', describeError(error));
    } finally {
      this.#running = false;
    }
  }

  /**
   * Close the sockets of customers whose grace has run out.
   *
   * The policy cache already refuses to save for them — `maySave` compares the
   * deadline on every read — so this is about not holding a WhatsApp socket
   * open for somebody who is no longer paying, rather than about correctness.
   */
  async #expireGrace(): Promise<void> {
    const users = await this.store.usersWithLapsedGrace();
    for (const userId of users) {
      // Clearing it first means a failure below cannot leave this user being
      // swept on every tick forever.
      await this.store.setGrace(userId, null);
      await this.sessions.stop(userId);
      log.info('payment grace expired, saving stopped', { userId });
    }
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
