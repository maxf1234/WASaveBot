import Stripe from 'stripe';
import { createApp } from './app.js';
import { createTokenVerifier } from './auth.js';
import { Billing } from './billing.js';
import { keyRing, parseKey } from './crypto.js';
import { createMailer } from './email.js';
import { loadEnv } from './env.js';
import { errorMessage, log } from './log.js';
import { Maintenance } from './maintenance.js';
import { SessionManager } from './sessions.js';
import { createSupabaseStore, PolicyCache } from './store.js';

const env = loadEnv();
const store = createSupabaseStore(env.supabaseUrl, env.supabaseServiceRoleKey);
const policy = new PolicyCache(store);
const mailer = createMailer({
  apiKey: env.resendApiKey,
  from: env.emailFrom,
  appName: env.appName,
  webUrl: env.webUrl,
});
if (!env.resendApiKey || !env.emailFrom) log.warn('RESEND_API_KEY / EMAIL_FROM not set: disconnect emails are off');

const sessions = new SessionManager(store, policy, undefined, undefined, {
  authRing: keyRing(
    parseKey(env.waAuthEncryptionKey),
    env.waAuthEncryptionKeyPrevious
      ? [parseKey(env.waAuthEncryptionKeyPrevious, 'WA_AUTH_ENCRYPTION_KEY_PREVIOUS')]
      : [],
  ),
  onLoggedOut: (userId) => {
    void store
      .getProfile(userId)
      .then((profile) => (profile?.email ? mailer.sendLoggedOut(profile.email) : undefined))
      .catch((error) => log.warn('could not email about logout', { error: errorMessage(error) }));
  },
});
if (env.waAuthEncryptionKeyPrevious) {
  log.warn('WA_AUTH_ENCRYPTION_KEY_PREVIOUS is set: a key rotation is in progress. ' +
    'Remove it once every session has reconnected, so the old key stops being accepted.');
}

const stripe = new Stripe(env.stripeSecretKey);
const billing = new Billing(stripe, store, policy, sessions, {
  priceId: env.stripePriceId,
  trialDays: env.trialDays,
  webUrl: env.webUrl,
  graceHours: env.paymentGraceHours,
});

const maintenance = new Maintenance(store, sessions, {
  retentionDays: env.eventRetentionDays,
  freePreviewDays: env.freePreviewDays,
});

if (env.adminEmails.length === 0) {
  log.info('ADMIN_EMAILS is not set: the admin page is closed to everyone');
}

const app = createApp({
  webUrl: env.webUrl,
  adminEmails: env.adminEmails,
  verifyToken: createTokenVerifier(env.supabaseUrl, env.supabaseJwtSecret),
  constructEvent: (body, signature) =>
    stripe.webhooks.constructEvent(body, signature, env.stripeWebhookSecret),
  store,
  billing,
  sessions,
});

const server = app.listen(env.port, () => {
  log.info('worker listening', { port: env.port });
  // After the port is open, so the health check passes while sockets come up.
  sessions.bootAll().catch((error) => log.error('boot failed', { error: errorMessage(error) }));
  maintenance.start();
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    // Close sockets without logging out: the stored logins are reused on the next boot.
    maintenance.stop();
    void sessions.stopAll().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

// One user's socket misbehaving must not take everyone else down.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: errorMessage(reason) });
});
