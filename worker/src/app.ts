/** The worker's HTTP API. Everything except the Stripe webhook and /health needs a Supabase JWT. */

import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type Stripe from 'stripe';
import type { AuthedUser, TokenVerifier } from './auth.js';
import { HttpError } from './billing.js';
import type { BillingApi } from './billing.js';
import { errorMessage, log } from './log.js';
import { maySave } from './store.js';
import type { Store } from './store.js';

export interface AppDeps {
  webUrl: string;
  /** Served to the dashboard at load time via /config.js. */
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  /** The built dashboard. When it exists the worker serves the whole product from one origin. */
  webRoot?: string;
  /** Lower-cased emails allowed to see the admin page. Empty means nobody. */
  adminEmails?: string[];
  verifyToken: TokenVerifier;
  /**
   * Verifies the signature and parses the event; throws if it is not from
   * Stripe. Absent when no webhook secret is configured, and then the webhook
   * answers 503 rather than pretending every signature is bad.
   */
  constructEvent?: (rawBody: Buffer, signature: string) => Stripe.Event;
  /** Whether people can subscribe. Told to the dashboard through /config.js. */
  billingEnabled?: boolean;
  store: Store;
  billing: BillingApi;
  /**
   * Only what the HTTP layer still needs from the worker: a socket count for
   * /health and the admin page, and a nudge so a reconcile happens in seconds
   * rather than at the next tick. It no longer opens or closes sockets — those
   * are intent rows now, so a request landing on a replica that does not own
   * the user is harmless.
   */
  sessions: {
    count(): number;
    nudge?(): void;
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
    if (!deps.constructEvent) {
      // 503 rather than 400: Stripe retries a 5xx, so an endpoint registered
      // before the secret was set catches up once it is, instead of the events
      // being written off as forgeries.
      res.status(503).json({ error: 'Billing is not set up' });
      return;
    }
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
      // Write what they want and return. The replica that owns this customer
      // picks it up on its next tick and asks WhatsApp for a code; the
      // dashboard is already polling for it. Nothing in this request waits on
      // WhatsApp, so a slow WhatsApp is our spinner rather than a timeout.
      await deps.store.updateSession(user.id, {
        desired: 'on',
        logout_requested_at: null,
        ...(valid ? { pair_phone: phone, status: 'connecting', pairing_code: null } : {}),
      });
      deps.sessions.nudge?.();
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/session/logout',
    authed(async (_req, res, user) => {
      await deps.store.updateSession(user.id, {
        desired: 'off',
        pair_phone: null,
        logout_requested_at: new Date().toISOString(),
      });
      deps.sessions.nudge?.();
      res.json({ ok: true });
    }),
  );

  // Save the people from existing chats found when WhatsApp was linked, plus
  // anyone the daily cap held back.
  // Refused unless the owning worker reports the session connected. Without
  // this the request would flag the rows, the worker would find no socket and
  // clear them, and the button would say "queued 5" while nothing happened.
  // Read from the database rather than a socket, so any replica can answer.
  const requireConnected = async (userId: string) => {
    if ((await deps.store.getSessionStatus(userId)) !== 'connected') {
      throw new HttpError(409, 'Connect WhatsApp first');
    }
  };

  app.post(
    '/api/contacts/backfill',
    authed(async (_req, res, user) => {
      await requireConnected(user.id);
      const queued = await deps.store.requestQueue(user.id, 'all-pending');
      deps.sessions.nudge?.();
      res.json({ queued });
    }),
  );

  // Try one contact again. The same request as a backfill, for one person.
  app.post(
    '/api/contacts/retry',
    authed(async (req, res, user) => {
      const phone = (req.body as { phone?: unknown } | undefined)?.phone;
      if (typeof phone !== 'string' || !/^\d{5,20}$/.test(phone)) throw new HttpError(400, 'Unknown contact');
      await requireConnected(user.id);
      const queued = await deps.store.requestQueue(user.id, [phone]);
      if (queued === 0) throw new HttpError(404, 'Nothing to retry for that contact');
      deps.sessions.nudge?.();
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
      // Ask for the device to be unlinked before the rows go. The reconcile
      // may not have run yet when the cascade removes the session row, so the
      // credentials are deleted here too rather than relied upon.
      await deps.store.updateSession(user.id, {
        desired: 'off',
        logout_requested_at: new Date().toISOString(),
      });
      deps.sessions.nudge?.();
      await deps.billing.cancelAll(user.id);
      await deps.store.deleteUser(user.id); // cascades to every table
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- the site
  //
  // The dashboard ships inside this service: one deploy, one URL, and no
  // separate host to keep in step. Everything under /api stays an API, and
  // every other path that is not a file falls back to index.html, because the
  // dashboard routes in the browser.

  app.get('/config.js', (_req, res) => {
    const config = {
      supabaseUrl: deps.supabaseUrl ?? '',
      supabaseAnonKey: deps.supabaseAnonKey ?? '',
      // Lets the Billing page say "not set up yet" rather than offering a
      // Subscribe button that can only fail.
      billing: deps.billingEnabled ?? true,
    };
    // `<` escaped so nothing in a value could ever close a script context.
    const body = `window.__SAVEBOT__ = ${JSON.stringify(config).replace(/</g, '\\u003c')};`;
    res
      .type('application/javascript')
      // Read on every load: a changed key must not be served stale from a cache.
      .set('Cache-Control', 'no-store')
      .send(body);
  });

  const webRoot = deps.webRoot && existsSync(join(deps.webRoot, 'index.html')) ? deps.webRoot : undefined;
  if (webRoot) {
    // Hashed asset filenames change on every build, so they can be cached for
    // ever; index.html cannot, or a deploy would not reach anybody.
    app.use(
      express.static(webRoot, {
        index: false,
        setHeaders: (res, path) => {
          res.setHeader(
            'Cache-Control',
            path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.set('Cache-Control', 'no-cache').sendFile(join(webRoot, 'index.html'));
    });
  }

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
