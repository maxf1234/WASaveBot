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

function setup(trialDays = 7, adminEmails: string[] = []) {
  const store = new MemoryStore();
  store.addUser(USER, 'none');
  store.addUser('other', 'none');
  const policy = new PolicyCache(store, 0);
  // The HTTP layer no longer touches sockets, so all it needs is a count and a
  // nudge. `nudges` stands in for "a reconcile was asked for".
  const nudges: string[] = [];
  const sessions = { count: () => 3, nudge: () => void nudges.push('nudge') };
  const stripe = fakeStripe();
  const billing = new Billing(stripe.api, store, policy, sessions, { priceId: 'price_1', trialDays, webUrl: WEB, graceHours: 0 });
  const app = createApp({
    webUrl: WEB,
    verifyToken: async (token) => {
      if (!token.startsWith('good:')) throw new Error('bad');
      const id = token.slice(5);
      return { id, email: `${id}@example.com` };
    },
    constructEvent: (body, sig) => stripeSdk.webhooks.constructEvent(body, sig, SECRET),
    store,
    billing,
    sessions,
    adminEmails,
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
  return { store, nudges, stripe: stripe.state, base, post, webhook };
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
  const { post, store, nudges } = setup();
  for (const path of ['/api/session/start', '/api/session/logout', '/api/billing/checkout', '/api/billing/portal', '/api/account/delete']) {
    assert.equal((await post(path)).status, 401, path);
    assert.equal((await post(path, 'forged')).status, 401, path);
  }
  assert.deepEqual(nudges, [], 'no reconcile was asked for');
  assert.equal(store.sessions.get(USER)?.desired, undefined, 'and no intent was written');
});

test('an unsubscribed account may link, so the preview runs on their own chats', async () => {
  // This used to be a 402. Paying to find out whether the product does
  // anything useful is the wrong way round, and the worker refuses to write
  // for an unsubscribed account anyway, so linking is safe to allow.
  const { post, store } = setup();
  assert.equal(store.profiles.get(USER)!.subscription_status, 'none', 'setup leaves them unsubscribed');
  assert.equal(
    (await post('/api/session/start', `good:${USER}`, { phone: '+1 (555) 000-9999' })).status,
    200,
  );
  assert.equal(store.sessions.get(USER)?.desired, 'on');
  assert.equal(store.sessions.get(USER)?.pair_phone, '15550009999');
});

test('session start needs a phone number to pair', async () => {
  const { post, store, nudges } = setup();
  store.profiles.get(USER)!.subscription_status = 'trialing';
  assert.equal((await post('/api/session/start', `good:${USER}`)).status, 400, 'no number, nothing stored');
  assert.equal((await post('/api/session/start', `good:${USER}`, { phone: '12345' })).status, 400);
  assert.equal(store.sessions.get(USER)?.desired, undefined, 'a refused request writes no intent');

  // The request writes what the customer wants and returns. It does not open
  // a socket: the replica that owns this user does that on its next tick.
  assert.equal((await post('/api/session/start', `good:${USER}`, { phone: '+1 (555) 000-9999' })).status, 200);
  assert.equal(store.sessions.get(USER)?.desired, 'on');
  assert.equal(store.sessions.get(USER)?.pair_phone, '15550009999');
  assert.equal(nudges.length, 1, 'and asks for a reconcile so the code arrives in seconds');

  // With a stored login the number is optional.
  await store.setAuth(USER, [['creds', { me: 1 }]]);
  assert.equal((await post('/api/session/start', `good:${USER}`)).status, 200);
  assert.equal(store.sessions.get(USER)?.desired, 'on');
  assert.equal((await post('/api/session/logout', `good:${USER}`)).status, 200);
  assert.equal(store.sessions.get(USER)?.desired, 'off');
  assert.ok(store.sessions.get(USER)?.logout_requested_at, 'logout is asked for, not performed here');
  assert.equal(store.sessions.get(USER)?.pair_phone, null, 'and the number is not kept');
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
  const { webhook, store, stripe } = setup();

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
  assert.equal(store.sessions.get(USER)?.desired, undefined, 'no stored login, so nothing to start');
  assert.equal(store.profiles.get('other')?.subscription_status, 'none', 'nobody else is touched');

  // 2. They link WhatsApp, then the card fails / they cancel. The socket is no
  // longer closed by billing: an unsubscribed account runs the preview, and
  // decide() is what stops it writing. The login is kept.
  await store.setAuth(USER, [['creds', { me: 1 }]]);
  stripe.subs = [sub('past_due')];
  await webhook({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_9' } } });
  assert.equal(profile.subscription_status, 'past_due');
  stripe.subs = [sub('canceled')];
  await webhook({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_9' } } });
  assert.equal(profile.subscription_status, 'canceled');
  assert.notEqual(store.sessions.get(USER)?.desired, 'off', 'cancelling does not unlink them');
  assert.ok(await store.hasAuth(USER), 'wa_auth survives cancellation');

  // 3. Resubscribed: a new subscription next to the cancelled one. Socket restarts, no QR.
  stripe.subs = [sub('canceled', 1), sub('active', 2)];
  await webhook({ type: 'customer.subscription.created', data: { object: { customer: 'cus_9' } } });
  assert.equal(profile.subscription_status, 'active');
  assert.equal(store.sessions.get(USER)?.desired, 'on', 'resubscribing asks for the socket, no new code');

  // An event type we do not handle is acknowledged and ignored.
  stripe.subs = [];
  res = await webhook({ type: 'customer.updated', data: { object: { customer: 'cus_9' } } });
  assert.equal(res.status, 200);
  assert.equal(profile.subscription_status, 'active');
});

test('account delete logs out, cancels the subscription and deletes the user', async () => {
  const { post, store, stripe } = setup();
  store.profiles.get(USER)!.stripe_customer_id = 'cus_1';
  stripe.subs = [sub('active', 5), sub('canceled', 1)];
  assert.equal((await post('/api/account/delete', `good:${USER}`)).status, 200);
  assert.ok(store.sessions.get(USER)?.logout_requested_at, 'the device unlink is asked for');
  assert.deepEqual(stripe.cancelled, ['sub_5']);
  assert.deepEqual(store.deletedUsers, [USER]);
});

test('backfill and retry write a queue request for the owning replica', async () => {
  const { post, store, nudges } = setup();
  assert.equal((await post('/api/contacts/backfill')).status, 401);
  assert.equal((await post('/api/contacts/retry')).status, 401);

  // Not connected: refused, rather than flagging rows nobody will pick up.
  assert.equal((await post('/api/contacts/backfill', `good:${USER}`)).status, 409);
  assert.equal((await post('/api/contacts/retry', `good:${USER}`, { phone: '15551230001' })).status, 409);
  store.sessions.get(USER)!.status = 'connected';

  // Two waiting people and one failure, which is what backfill and retry act on.
  await store.claimContact(USER, { phone: '15551230001', status: 'failed' });
  await store.claimContact(USER, { phone: '15551230002', status: 'pending' });
  await store.claimContact(USER, { phone: '15551230003', status: 'pending' });

  // Backfill flags every pending row. It no longer needs a connected WhatsApp
  // on *this* replica: the flag waits until the owning one picks it up.
  const res = await post('/api/contacts/backfill', `good:${USER}`);
  assert.deepEqual(await res.json(), { queued: 2 });

  // Retry puts a failed row back to pending and flags it.
  assert.equal((await post('/api/contacts/retry', `good:${USER}`, { phone: '15551230001' })).status, 200);
  const failed = store.rows().find((r) => r.phone === '15551230001')!;
  assert.equal(failed.status, 'pending');
  assert.ok(failed.queue_requested_at);

  // Nothing to flag is a 404, which is where the old "unknown number" and
  // "already saved" guards now live.
  assert.equal((await post('/api/contacts/retry', `good:${USER}`, { phone: '15559999999' })).status, 404);
  assert.equal((await post('/api/contacts/retry', `good:${USER}`, { phone: "1; drop" })).status, 400);
  assert.equal((await post('/api/contacts/retry', `good:${USER}`)).status, 400);
  assert.equal(nudges.length, 2, 'one nudge per request that wrote something');
});


// ---------------------------------------------------------------- admin

test('the admin page is closed to everyone when no admins are configured', async () => {
  // Fails closed: an admin page open by accident is worse than none at all.
  const { post } = setup(7, []);
  assert.equal((await post('/api/admin/overview', `good:${USER}`)).status, 403);
  assert.deepEqual(await (await post('/api/admin/check', `good:${USER}`)).json(), { admin: false });
});

test('a customer who is not an admin is refused the overview', async () => {
  const { post } = setup(7, ['boss@example.com']);
  assert.equal((await post('/api/admin/overview', `good:${USER}`)).status, 403);
  assert.deepEqual(await (await post('/api/admin/check', `good:${USER}`)).json(), { admin: false });
});

test('an admin sees every customer and the totals', async () => {
  const { post, store } = setup(7, ['boss@example.com']);
  store.addUser('boss', 'active');
  store.profiles.get('boss')!.email = 'boss@example.com';
  store.profiles.get(USER)!.subscription_status = 'active';
  await store.claimContact(USER, { phone: '15550000001', status: 'saved' });
  await store.claimContact(USER, { phone: '15550000002', status: 'failed' });

  assert.deepEqual(await (await post('/api/admin/check', 'good:boss')).json(), { admin: true });

  const res = await post('/api/admin/overview', 'good:boss');
  assert.equal(res.status, 200);
  const overview = (await res.json()) as {
    customers: { user_id: string; saved_count: number; failed_count: number }[];
    totals: { customers: number; subscribed: number; saved: number; failed: number };
    sockets: number;
  };
  assert.equal(overview.totals.customers, 3, 'every customer, not just their own row');
  assert.equal(overview.totals.saved, 1);
  assert.equal(overview.totals.failed, 1);
  assert.equal(overview.sockets, 3, 'and the live socket count');
  assert.ok(overview.customers.some((c) => c.user_id === USER));
});

test('an admin can grant and take away Pro, and Stripe cannot undo it', async () => {
  const { post, store, nudges } = setup(7, ['boss@example.com']);
  store.addUser('boss', 'active');
  store.profiles.get('boss')!.email = 'boss@example.com';
  assert.equal((await store.getPolicy(USER)).subscribed, false);

  const grant = await post('/api/admin/pro', 'good:boss', { userId: USER, pro: true });
  assert.equal(grant.status, 200);
  assert.equal((await store.getPolicy(USER)).subscribed, true, 'Pro without Stripe');
  assert.ok(nudges.length > 0, 'the owning replica is told');

  // A Stripe sync only ever writes subscription_status.
  await store.setSubscription(USER, 'canceled', null);
  assert.equal((await store.getPolicy(USER)).subscribed, true, 'a webhook does not take it away');

  const overview = (await (await post('/api/admin/overview', 'good:boss')).json()) as {
    customers: { user_id: string; pro_granted: boolean }[];
  };
  assert.equal(overview.customers.find((c) => c.user_id === USER)?.pro_granted, true);

  assert.equal((await post('/api/admin/pro', 'good:boss', { userId: USER, pro: false })).status, 200);
  assert.equal((await store.getPolicy(USER)).subscribed, false);
});

test('granting Pro brings back a socket an expired preview closed', async () => {
  const { post, store } = setup(7, ['boss@example.com']);
  store.addUser('boss', 'active');
  store.profiles.get('boss')!.email = 'boss@example.com';
  store.auth.set(USER, new Map([['creds', '{}']]));
  store.sessions.set(USER, { status: 'disconnected', desired: 'off' });

  await post('/api/admin/pro', 'good:boss', { userId: USER, pro: true });
  assert.equal(store.sessions.get(USER)?.desired, 'on');
});

test('only an admin can change Pro, and bad requests are refused', async () => {
  const { post, store } = setup(7, ['boss@example.com']);
  store.addUser('boss', 'active');
  store.profiles.get('boss')!.email = 'boss@example.com';

  assert.equal((await post('/api/admin/pro', `good:${USER}`, { userId: USER, pro: true })).status, 403);
  assert.equal(store.profiles.get(USER)?.pro_granted ?? false, false, 'a customer cannot grant themselves Pro');
  assert.equal((await post('/api/admin/pro', 'good:boss', { userId: USER, pro: 'yes' })).status, 400);
  assert.equal((await post('/api/admin/pro', 'good:boss', { userId: 'nobody', pro: true })).status, 404);
});

test('an admin can download every customer\'s contacts as CSV', async () => {
  const { post, store } = setup(7, ['boss@example.com']);
  store.addUser('boss', 'active');
  store.profiles.get('boss')!.email = 'boss@example.com';
  await store.claimContact(USER, { phone: '15550000001', status: 'saved', saved_name: 'Ana' });
  await store.claimContact('other', { phone: '15550000002', status: 'saved', saved_name: '=HYPERLINK("x")' });
  await store.claimContact('other', { phone: '15550000003', status: 'pending' });
  await store.claimContact('other', { phone: '15550000004', status: 'removed', saved_name: 'Opted Out' });

  assert.equal((await post('/api/admin/contacts.csv', `good:${USER}`)).status, 403, 'customers cannot');

  const res = await post('/api/admin/contacts.csv', 'good:boss');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
  const text = await res.text();
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'customer,name,phone,status,saved_at');
  assert.equal(lines.length, 4, 'pending rows were never saved, so they are left out');
  assert.ok(lines.some((l) => l.startsWith(`"${USER}@example.com","Ana","+15550000001","saved"`)), text);
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`)), 'a formula in a name is defused');
  assert.ok(lines.some((l) => l.includes('"Opted Out","+15550000004","removed"')), 'opt-outs are kept and marked');
});

test('the admin email match ignores case and surrounding space', async () => {
  const { post } = setup(7, ['  BOSS@Example.com ']);
  assert.deepEqual(await (await post('/api/admin/check', 'good:boss')).json(), { admin: true });
});

test('a verified token with no email is never an admin', async () => {
  // Some Supabase providers can leave the claim out; the check must not then
  // match an empty configured entry.
  const store = new MemoryStore();
  store.addUser(USER, 'active');
  const app = createApp({
    webUrl: WEB,
    verifyToken: async () => ({ id: USER, email: null }),
    constructEvent: () => {
      throw new Error('unused');
    },
    store,
    billing: {
      checkoutUrl: async () => 'x',
      portalUrl: async () => 'x',
      cancelAll: async () => {},
      handleEvent: async () => {},
    },
    sessions: { count: () => 0 },
    adminEmails: ['', 'boss@example.com'],
  });
  const server = app.listen(0);
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/admin/check`, {
    method: 'POST',
    headers: { Authorization: 'Bearer good:x' },
  });
  assert.deepEqual(await res.json(), { admin: false });
});
