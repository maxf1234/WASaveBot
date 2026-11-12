import Stripe from 'stripe';
import { createApp } from './app.js';
import { createTokenVerifier } from './auth.js';
import { Billing } from './billing.js';
import { loadEnv } from './env.js';
import { errorMessage, log } from './log.js';
import { SessionManager } from './sessions.js';
import { createSupabaseStore, PolicyCache } from './store.js';

const env = loadEnv();
const store = createSupabaseStore(env.supabaseUrl, env.supabaseServiceRoleKey);
const policy = new PolicyCache(store);
const sessions = new SessionManager(store, policy);
const stripe = new Stripe(env.stripeSecretKey);
const billing = new Billing(stripe, store, policy, sessions, {
  priceId: env.stripePriceId,
  trialDays: env.trialDays,
  webUrl: env.webUrl,
});

const app = createApp({
  webUrl: env.webUrl,
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
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    // Close sockets without logging out: the stored logins are reused on the next boot.
    void sessions.stopAll().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

// One user's socket misbehaving must not take everyone else down.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: errorMessage(reason) });
});
