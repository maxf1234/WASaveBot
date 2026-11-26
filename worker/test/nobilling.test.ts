/**
 * Running without Stripe: placeholders count as unset, subscribing answers a
 * clear 503, and the webhook asks Stripe to retry rather than calling it forged.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';
import { createApp } from '../src/app.js';
import { noBilling } from '../src/billing.js';
import { billingConfigured, loadEnv } from '../src/env.js';
import { MemoryStore } from './helpers.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = { ...process.env };
  Object.assign(process.env, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    SUPABASE_JWT_SECRET: 'jwt',
    WA_AUTH_ENCRYPTION_KEY: 'ab'.repeat(32),
    WEB_URL: 'https://savebot.example',
    ...vars,
  });
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  try {
    fn();
  } finally {
    process.env = saved;
  }
}

test('placeholder Stripe values are treated as not set', () => {
  withEnv({ STRIPE_SECRET_KEY: 'x', STRIPE_WEBHOOK_SECRET: '<whsec_...>', STRIPE_PRICE_ID: 'todo' }, () => {
    const env = loadEnv();
    assert.equal(env.stripeSecretKey, undefined);
    assert.equal(env.stripeWebhookSecret, undefined);
    assert.equal(env.stripePriceId, undefined);
    assert.equal(billingConfigured(env), false);
  });
});

test('missing Stripe values do not stop the worker loading its config', () => {
  withEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined, STRIPE_PRICE_ID: undefined }, () => {
    assert.equal(billingConfigured(loadEnv()), false);
  });
});

test('real-looking Stripe values switch billing on', () => {
  withEnv({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_1', STRIPE_PRICE_ID: 'price_1' }, () => {
    const env = loadEnv();
    assert.equal(billingConfigured(env), true);
    assert.equal(env.stripeWebhookSecret, 'whsec_1');
  });
});

test('without Stripe, checkout and portal say billing is not set up', async () => {
  await assert.rejects(noBilling.checkoutUrl('u', 'e'), { status: 503, message: 'Billing is not set up yet' });
  await assert.rejects(noBilling.portalUrl('u'), { status: 503 });
  await noBilling.cancelAll('u');
});


test('without a webhook secret the webhook answers 503 so Stripe retries later', async () => {
  const app = createApp({
    webUrl: 'https://savebot.example',
    verifyToken: async () => ({ id: 'u', email: null }),
    store: new MemoryStore(),
    billing: noBilling,
    sessions: { count: () => 0 },
    billingEnabled: false,
  });
  const server = app.listen(0);
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'stripe-signature': 'x' } });
  assert.equal(res.status, 503);
  const checkout = await fetch(`${base}/api/billing/checkout`, { method: 'POST', headers: { authorization: 'Bearer t' } });
  assert.equal(checkout.status, 503);
  assert.deepEqual(await checkout.json(), { error: 'Billing is not set up yet' });
});
