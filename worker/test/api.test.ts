import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import Stripe from 'stripe';
import { createApp } from '../src/app.js';
import { Billing } from '../src/billing.js';
import { PolicyCache } from '../src/store.js';
import { MemoryStore, USER } from './helpers.js';

const WEB = 'https://app.example.com';
const SECRET = 'whsec_test';
const stripeSdk = new Stripe('sk_test_x');

/** A stand-in for Stripe's API holding one customer's subscriptions. */
function fakeStripe() {
  const state = {
    subs: [] as { id: string; status: string; created: number; items: { data: { current_period_end: number }[] } }[],
    checkout: [] as Record<string, unknown>[],
    cancelled: [] as string[],
    customers: 0,
  };
  const api = {
    customers: { create: async () => ({ id: `cus_${++state.customers}` }) },
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          state.checkout.push(params);
          return { url: 'https://checkout.stripe.test/c/1' };
        },
      },
    },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.test/p/1' }) } },
    subscriptions: {
      list: async () => ({ data: state.subs }),
      cancel: async (id: string) => {
        state.cancelled.push(id);
      },
    },
  };
  return { state, api: api as unknown as Stripe };
}

function setup(trialDays = 7) {
  const store = new MemoryStore();
  store.addUser(USER, 'none');
  store.addUser('other', 'none');
  const policy = new PolicyCache(store, 0);
  const calls: string[] = [];
  const sessions = {
    count: () => 3,
    start: async (id: string, phone?: string) => void calls.push(`start:${id}${phone ? `:${phone}` : ''}`),
    stop: async (id: string) => void calls.push(`stop:${id}`),
    logout: async (id: string) => void calls.push(`logout:${id}`),
    connectedSaver: (id: string) =>
      id === 'other'
        ? undefined
        : { backfill: async () => 4, retry: async (phone: string) => (calls.push(`retry:${phone}`), phone === '15551230001') },
  };
  const stripe = fakeStripe();
  const billing = new Billing(stripe.api, store, policy, sessions, { priceId: 'price_1', trialDays, webUrl: WEB, graceHours: 0 });
  const app = createApp({
    webUrl: WEB,
    verifyToken: async (token) => {
      if (!token.startsWith('good:')) throw new Error('bad');
      return { id: token.slice(5), email: null };
    },
    constructEvent: (body, sig) => stripeSdk.webhooks.constructEvent(body, sig, SECRET),
    store,
    billing,
    sessions,
  });
  const server = app.listen(0);
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, token?: string, body?: object) =>
    fetch(base + path, {
      method: 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const webhook = (event: object, secret = SECRET) => {
    const payload = JSON.stringify(event);
    return fetch(`${base}/api/stripe/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSdk.webhooks.generateTestHeaderString({ payload, secret }),
      },
      body: payload,
    });
  };
  return { store, calls, stripe: stripe.state, base, post, webhook };
}

const sub = (status: string, created = 1, end = 1_900_000_000) => ({
  id: `sub_${created}`,
  status,
  created,
  items: { data: [{ current_period_end: end }] },
});

test('health reports live sockets; CORS allows only WEB_URL', async () => {
  const { base } = setup();
  const res = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, sockets: 3 });
  assert.equal(res.headers.get('access-control-allow-origin'), WEB, 'never echoes another origin');
});

test('every route except the webhook needs a valid JWT', async () => {
  const { post, calls } = setup();
  for (const path of ['/api/session/start', '/api/session/logout', '/api/billing/checkout', '/api/billing/portal', '/api/account/delete']) {
    assert.equal((await post(path)).status, 401, path);
    assert.equal((await post(path, 'forged')).status, 401, path);
  }
  assert.deepEqual(calls, []);
});

test('an unsubscribed account may link, so the preview runs on their own chats', async () => {
  // This used to be a 402. Paying to find out whether the product does
  // anything useful is the wrong way round, and the worker refuses to write
  // for an unsubscribed account anyway, so linking is safe to allow.
  const { post, store, calls } = setup();
  assert.equal(store.profiles.get(USER)!.subscription_status, 'none', 'setup leaves them unsubscribed');
  assert.equal(
    (await post('/api/session/start', `good:${USER}`, { phone: '+1 (555) 000-9999' })).status,
    200,
  );
  assert.deepEqual(calls, [`start:${USER}:15550009999`]);
});

test('session start needs a phone number to pair', async () => {
  const { post, store, calls } = setup();
  store.profiles.get(USER)!.subscription_status = 'trialing';
  assert.equal((await post('/api/session/start', `good:${USER}`)).status, 400, 'no number, nothing stored');
  assert.equal((await post('/api/session/start', `good:${USER}`, { phone: '12345' })).status, 400);
  assert.deepEqual(calls, []);

  assert.equal((await post('/api/session/start', `good:${USER}`, { phone: '+1 (555) 000-9999' })).status, 200);
  assert.deepEqual(calls, [`start:${USER}:15550009999`]);

  // With a stored login the number is optional.
  await store.setAuth(USER, [['creds', { me: 1 }]]);
  assert.equal((await post('/api/session/start', `good:${USER}`)).status, 200);
  assert.equal(calls.at(-1), `start:${USER}`);
  assert.equal((await post('/api/session/logout', `good:${USER}`)).status, 200);
  assert.equal(calls.at(-1), `logout:${USER}`);
});

test('checkout creates the customer once, with the price and trial', async () => {
  const { post, store, stripe } = setup(7);
  const first = await post('/api/billing/checkout', `good:${USER}`);
  assert.deepEqual(await first.json(), { url: 'https://checkout.stripe.test/c/1' });
  await post('/api/billing/checkout', `good:${USER}`);
  assert.equal(stripe.customers, 1, 'customer reused');
  assert.equal(store.profiles.get(USER)?.stripe_customer_id, 'cus_1');
  const params = stripe.checkout[0] as { mode: string; line_items: unknown; subscription_data: { trial_period_days?: number }; client_reference_id: string };
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [{ price: 'price_1', quantity: 1 }]);
  assert.equal(params.subscription_data.trial_period_days, 7);
  assert.equal(params.client_reference_id, USER);

  store.profiles.get(USER)!.subscription_status = 'active';
  assert.equal((await post('/api/billing/checkout', `good:${USER}`)).status, 409);
});

test('no trial when TRIAL_DAYS is 0; portal needs a customer', async () => {
  const { post, stripe } = setup(0);
  assert.equal((await post('/api/billing/portal', `good:${USER}`)).status, 400);
  await post('/api/billing/checkout', `good:${USER}`);
  const params = stripe.checkout[0] as { subscription_data: object };
  assert.equal('trial_period_days' in params.subscription_data, false);
  const portal = await post('/api/billing/portal', `good:${USER}`);
  assert.deepEqual(await portal.json(), { url: 'https://billing.stripe.test/p/1' });
});

test('webhook rejects a bad signature and changes nothing', async () => {
  const { webhook, store } = setup();
  const res = await webhook({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } }, 'whsec_wrong');
  assert.equal(res.status, 400);
  assert.equal(store.profiles.get(USER)?.subscription_status, 'none');
});

test('webhook: checkout completes, subscription lapses, then comes back', async () => {
  const { webhook, store, stripe, calls } = setup();

  // 1. Paid. No WhatsApp login yet, so no socket is started.
  stripe.subs = [sub('trialing')];
  let res = await webhook({
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_9', client_reference_id: USER } },
  });
  assert.equal(res.status, 200);
  const profile = store.profiles.get(USER)!;
  assert.equal(profile.stripe_customer_id, 'cus_9');
  assert.equal(profile.subscription_status, 'trialing');
  assert.equal(store.periodEnd.get(USER), new Date(1_900_000_000_000).toISOString());
  assert.deepEqual(calls, []);
  assert.equal(store.profiles.get('other')?.subscription_status, 'none', 'nobody else is touched');

  // 2. They link WhatsApp, then the card fails / they cancel: socket closed, login kept.
  await store.setAuth(USER, [['creds', { me: 1 }]]);
  stripe.subs = [sub('past_due')];
  await webhook({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_9' } } });
  assert.equal(profile.subscription_status, 'past_due');
  stripe.subs = [sub('canceled')];
  await webhook({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_9' } } });
  assert.equal(profile.subscription_status, 'canceled');
  assert.deepEqual(calls, [`stop:${USER}`, `stop:${USER}`]);
  assert.ok(await store.hasAuth(USER), 'wa_auth survives cancellation');

  // 3. Resubscribed: a new subscription next to the cancelled one. Socket restarts, no QR.
  stripe.subs = [sub('canceled', 1), sub('active', 2)];
  await webhook({ type: 'customer.subscription.created', data: { object: { customer: 'cus_9' } } });
  assert.equal(profile.subscription_status, 'active');
  assert.equal(calls.at(-1), `start:${USER}`);

  // An event type we do not handle is acknowledged and ignored.
  stripe.subs = [];
  res = await webhook({ type: 'customer.updated', data: { object: { customer: 'cus_9' } } });
  assert.equal(res.status, 200);
  assert.equal(profile.subscription_status, 'active');
});

test('account delete logs out, cancels the subscription and deletes the user', async () => {
  const { post, store, stripe, calls } = setup();
  store.profiles.get(USER)!.stripe_customer_id = 'cus_1';
  stripe.subs = [sub('active', 5), sub('canceled', 1)];
  assert.equal((await post('/api/account/delete', `good:${USER}`)).status, 200);
  assert.deepEqual(calls, [`logout:${USER}`]);
  assert.deepEqual(stripe.cancelled, ['sub_5']);
  assert.deepEqual(store.deletedUsers, [USER]);
});

test('backfill and retry need a JWT and a connected WhatsApp', async () => {
  const { post, calls } = setup();
  assert.equal((await post('/api/contacts/backfill')).status, 401);
  assert.equal((await post('/api/contacts/retry')).status, 401);
  assert.equal((await post('/api/contacts/backfill', 'good:other')).status, 409);
  assert.equal((await post('/api/contacts/retry', 'good:other', { phone: '15551230001' })).status, 409);

  const res = await post('/api/contacts/backfill', `good:${USER}`);
  assert.deepEqual(await res.json(), { queued: 4 });
  assert.equal((await post('/api/contacts/retry', `good:${USER}`, { phone: '15551230001' })).status, 200);
  assert.equal((await post('/api/contacts/retry', `good:${USER}`, { phone: '15559999999' })).status, 404);
  assert.equal((await post('/api/contacts/retry', `good:${USER}`, { phone: "1; drop" })).status, 400);
  assert.equal((await post('/api/contacts/retry', `good:${USER}`)).status, 400);
  assert.deepEqual(calls, ['retry:15551230001', 'retry:15559999999']);
});
