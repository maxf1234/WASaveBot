/**
 * Stripe: Checkout, the Customer Portal and the webhook.
 *
 * Every webhook event is handled the same way: look up the customer's
 * subscriptions on Stripe and write what is true right now. That makes event
 * order irrelevant (my whatsapp-auto-poster guards against out-of-order
 * events by timestamp; asking Stripe is the same protection without a column).
 */

import type Stripe from 'stripe';
import { log } from './log.js';
import { isActive, isGraceable, maySave } from './store.js';
import type { PolicyCache, Store } from './store.js';

export interface BillingConfig {
  priceId: string;
  trialDays: number;
  webUrl: string;
  /** How long a past_due or unpaid subscription keeps saving. 0 stops at once. */
  graceHours: number;
}

/**
 * What billing needs in order to act on a subscription change.
 *
 * It writes intent like everything else rather than touching a socket, because
 * a Stripe webhook arrives at whichever replica the load balancer picked, which
 * is very unlikely to be the one that owns the customer.
 */
export interface SessionControl {
  nudge?(): void;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

const idOf = (ref: string | { id: string } | null | undefined): string | null =>
  !ref ? null : typeof ref === 'string' ? ref : ref.id;

/** Newer Stripe API versions moved the period end from the subscription to its items. */
function periodEnd(sub: Stripe.Subscription): string | null {
  const seconds =
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    (sub.items?.data?.[0] as { current_period_end?: number } | undefined)?.current_period_end;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

/** The subscription that decides access: a live one if there is one, else the newest. */
function pick(subs: Stripe.Subscription[]): Stripe.Subscription | undefined {
  const rank = (s: Stripe.Subscription) => (isActive(s.status) ? 0 : s.status === 'past_due' ? 1 : 2);
  return [...subs].sort((a, b) => rank(a) - rank(b) || b.created - a.created)[0];
}

export class Billing {
  constructor(
    private stripe: Stripe,
    private store: Store,
    private policy: PolicyCache,
    private sessions: SessionControl,
    private config: BillingConfig,
  ) {}

  async #customerFor(userId: string, email: string | null): Promise<string> {
    const profile = await this.store.getProfile(userId);
    if (!profile) throw new HttpError(404, 'Account not found');
    if (profile.stripe_customer_id) return profile.stripe_customer_id;
    const customer = await this.stripe.customers.create({
      email: profile.email ?? email ?? undefined,
      metadata: { user_id: userId },
    });
    await this.store.setCustomerId(userId, customer.id);
    return customer.id;
  }

  async checkoutUrl(userId: string, email: string | null): Promise<string> {
    if ((await this.store.getPolicy(userId)).subscribed) {
      throw new HttpError(409, 'You already have a subscription');
    }
    const customer = await this.#customerFor(userId, email);
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: userId,
      line_items: [{ price: this.config.priceId, quantity: 1 }],
      subscription_data: {
        metadata: { user_id: userId },
        ...(this.config.trialDays > 0 ? { trial_period_days: this.config.trialDays } : {}),
      },
      success_url: `${this.config.webUrl}/billing?checkout=success`,
      cancel_url: `${this.config.webUrl}/billing?checkout=cancelled`,
    });
    if (!session.url) throw new HttpError(502, 'Stripe did not return a checkout link');
    return session.url;
  }

  async portalUrl(userId: string): Promise<string> {
    const profile = await this.store.getProfile(userId);
    if (!profile?.stripe_customer_id) throw new HttpError(400, 'No billing account yet');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${this.config.webUrl}/billing`,
    });
    return session.url;
  }

  /** Cancel everything the user is paying for (used when they delete their account). */
  async cancelAll(userId: string): Promise<void> {
    const profile = await this.store.getProfile(userId);
    if (!profile?.stripe_customer_id) return;
    const subs = await this.stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: 'all',
      limit: 100,
    });
    for (const sub of subs.data) {
      if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
        await this.stripe.subscriptions.cancel(sub.id);
      }
    }
  }

  /** Handle a verified webhook event. */
  async handleEvent(event: Stripe.Event): Promise<void> {
    if (!HANDLED.has(event.type)) return;
    const object = event.data.object as {
      customer?: string | { id: string } | null;
      client_reference_id?: string | null;
      metadata?: Record<string, string> | null;
    };
    const customerId = idOf(object.customer);
    if (!customerId) return;

    let profile = await this.store.findProfileByCustomer(customerId);
    if (!profile) {
      // First contact with this customer: Checkout carries our user id.
      const userId = object.client_reference_id ?? object.metadata?.user_id;
      const candidate = userId ? await this.store.getProfile(userId) : null;
      if (!candidate) {
        log.warn('stripe event for unknown customer', { type: event.type });
        return;
      }
      if (!candidate.stripe_customer_id) await this.store.setCustomerId(candidate.id, customerId);
      profile = candidate;
    }
    await this.syncUser(profile.id, customerId);
  }

  /** Write the customer's current subscription state, then open or close their socket. */
  async syncUser(userId: string, customerId: string): Promise<void> {
    const subs = await this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    const sub = pick(subs.data);
    const status = sub?.status ?? 'none';
    await this.store.setSubscription(userId, status, sub ? periodEnd(sub) : null);

    const graceUntil = await this.#reconcileGrace(userId, status);
    this.policy.invalidate(userId);
    log.info('subscription synced', { userId, status, ...(graceUntil ? { graceUntil } : {}) });

    // An unsubscribed account still runs the preview, so a lapsed subscription
    // no longer closes the socket: decide() is what stops it writing. The
    // socket only comes down when the free preview window expires, which
    // maintenance.ts owns.
    if (maySave(status, graceUntil) && (await this.store.hasAuth(userId))) {
      await this.store.updateSession(userId, { desired: 'on' });
    }
    this.sessions.nudge?.();
  }

  /**
   * Open, keep or close the grace window for this status.
   *
   * Started once and not extended: each later `invoice.payment_failed` for the
   * same lapse must not push the deadline out again, or a card that keeps
   * failing would buy an unbounded free ride. Cleared as soon as the
   * subscription recovers, so the next lapse gets a fresh window.
   */
  async #reconcileGrace(userId: string, status: string): Promise<string | null> {
    const profile = await this.store.getProfile(userId);
    const existing = profile?.grace_until ?? null;

    if (!isGraceable(status)) {
      if (existing) await this.store.setGrace(userId, null);
      return null;
    }
    if (this.config.graceHours <= 0) {
      if (existing) await this.store.setGrace(userId, null);
      return null;
    }
    if (existing) return existing;

    const until = new Date(Date.now() + this.config.graceHours * 3_600_000).toISOString();
    await this.store.setGrace(userId, until);
    log.info('payment grace started', { userId, status, until });
    return until;
  }
}
