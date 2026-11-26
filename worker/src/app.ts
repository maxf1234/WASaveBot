/** The worker's HTTP API. Everything except the Stripe webhook and /health needs a Supabase JWT. */

import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type Stripe from 'stripe';
import type { AuthedUser, TokenVerifier } from './auth.js';
import { HttpError } from './billing.js';
import type { Billing } from './billing.js';
import { errorMessage, log } from './log.js';
import { maySave } from './store.js';
import type { Store } from './store.js';

export interface AppDeps {
  webUrl: string;
  /** Lower-cased emails allowed to see the admin page. Empty means nobody. */
  adminEmails?: string[];
  verifyToken: TokenVerifier;
  /** Verifies the signature and parses the event; throws if it is not from Stripe. */
  constructEvent: (rawBody: Buffer, signature: string) => Stripe.Event;
  store: Store;
  billing: Pick<Billing, 'checkoutUrl' | 'portalUrl' | 'cancelAll' | 'handleEvent'>;
  sessions: {
    count(): number;
    start(userId: string, pairPhone?: string): Promise<void>;
    logout(userId: string): Promise<void>;
    connectedSaver(userId: string): { backfill(): Promise<number>; retry(phone: string): Promise<boolean> } | undefined;
  };
}

type Handler = (req: Request, res: Response, user: AuthedUser) => Promise<void>;

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: deps.webUrl, allowedHeaders: ['Authorization', 'Content-Type'] }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, sockets: deps.sessions.count() });
  });

  // Raw body: the signature is computed over the exact bytes Stripe sent.
  app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    let event: Stripe.Event;
    try {
      event = deps.constructEvent(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''));
    } catch {
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }
    try {
      await deps.billing.handleEvent(event);
      res.json({ received: true });
    } catch (error) {
      // A 500 makes Stripe retry, which is what we want for a database blip.
      log.error('webhook failed', { type: event.type, error: errorMessage(error) });
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  });

  app.use(express.json({ limit: '100kb' }));

  const admins = new Set((deps.adminEmails ?? []).map((email) => email.trim().toLowerCase()));
  // Fails closed: with no ADMIN_EMAILS configured, nobody is an admin.
  const isAdmin = (user: AuthedUser): boolean =>
    Boolean(user.email) && admins.has(user.email!.trim().toLowerCase());

  const authed = (handler: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    let user: AuthedUser;
    try {
      if (!token) throw new Error('missing token');
      user = await deps.verifyToken(token);
    } catch {
      res.status(401).json({ error: 'Sign in again' });
      return;
    }
    try {
      await handler(req, res, user);
    } catch (error) {
      next(error);
    }
  };

  app.post(
    '/api/session/start',
    authed(async (req, res, user) => {
      // No subscription needed to link. An unsubscribed account runs as a
      // preview: the worker records who it would have saved and writes
      // nothing, which is a far better demonstration than any screenshot
      // because it is the customer's own chats. decide() is what enforces
      // that, so setting `armed` without paying achieves nothing.
      //
      // The cost of this is real — a free account holds a WhatsApp socket —
      // and FREE_WATCH_DAYS is the lever that bounds it.
      // The user's own number, with country code: "+1 (555) 123-4567" -> "15551234567".
      const raw = (req.body as { phone?: unknown } | undefined)?.phone;
      const phone = typeof raw === 'string' ? raw.replace(/\D/g, '').replace(/^00/, '') : '';
      const valid = /^[1-9]\d{7,14}$/.test(phone);
      // Without a number we can only resume a login that is already stored.
      if (!valid && !(await deps.store.hasAuth(user.id))) {
        throw new HttpError(400, 'Enter your WhatsApp number with the country code, for example +1 555 123 4567');
      }
      await deps.sessions.start(user.id, valid ? phone : undefined);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/session/logout',
    authed(async (_req, res, user) => {
      await deps.sessions.logout(user.id);
      res.json({ ok: true });
    }),
  );

  // Save the people from existing chats that were found when WhatsApp was linked.
  app.post(
    '/api/contacts/backfill',
    authed(async (_req, res, user) => {
      const saver = deps.sessions.connectedSaver(user.id);
      if (!saver) throw new HttpError(409, 'Connect WhatsApp first');
      res.json({ queued: await saver.backfill() });
    }),
  );

  // Try one failed contact again.
  app.post(
    '/api/contacts/retry',
    authed(async (req, res, user) => {
      const phone = (req.body as { phone?: unknown } | undefined)?.phone;
      if (typeof phone !== 'string' || !/^\d{5,20}$/.test(phone)) throw new HttpError(400, 'Unknown contact');
      const saver = deps.sessions.connectedSaver(user.id);
      if (!saver) throw new HttpError(409, 'Connect WhatsApp first');
      if (!(await saver.retry(phone))) throw new HttpError(404, 'Nothing to retry for that contact');
      res.json({ ok: true });
    }),
  );

  /**
   * Is the signed-in user an operator?
   *
   * Answers 200 with a boolean rather than 403, because the dashboard calls it
   * on every page load just to decide whether to show a nav link, and a 403 on
   * an ordinary customer's normal navigation is noise in the logs that looks
   * like an attack. The real refusal is on the overview below.
   */
  app.post(
    '/api/admin/check',
    authed(async (_req, res, user) => {
      res.json({ admin: isAdmin(user) });
    }),
  );

  app.post(
    '/api/admin/overview',
    authed(async (req, res, user) => {
      // Checked against the email in the verified Supabase JWT, so this is not
      // something a client can assert about itself.
      if (!isAdmin(user)) throw new HttpError(403, 'Not an admin');
      const raw = (req.body as { limit?: unknown } | undefined)?.limit;
      const limit = Math.min(Math.max(Number(raw) || 200, 1), 1000);
      const customers = await deps.store.adminOverview(limit);
      res.json({
        customers,
        totals: {
          customers: customers.length,
          subscribed: customers.filter((c) => maySave(c.subscription_status, c.grace_until)).length,
          connected: customers.filter((c) => c.session_status === 'connected').length,
          armed: customers.filter((c) => c.armed === true).length,
          saved: customers.reduce((sum, c) => sum + c.saved_count, 0),
          failed: customers.reduce((sum, c) => sum + c.failed_count, 0),
        },
        sockets: deps.sessions.count(),
      });
    }),
  );

  app.post(
    '/api/billing/checkout',
    authed(async (_req, res, user) => {
      res.json({ url: await deps.billing.checkoutUrl(user.id, user.email) });
    }),
  );

  app.post(
    '/api/billing/portal',
    authed(async (_req, res, user) => {
      res.json({ url: await deps.billing.portalUrl(user.id) });
    }),
  );

  app.post(
    '/api/account/delete',
    authed(async (_req, res, user) => {
      await deps.sessions.logout(user.id);
      await deps.billing.cancelAll(user.id);
      await deps.store.deleteUser(user.id); // cascades to every table
      res.json({ ok: true });
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express recognises an error handler by its four parameters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    log.error('request failed', { error: errorMessage(error) });
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
