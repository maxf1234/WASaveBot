# SaveBot

A customer signs up, subscribes, links their own WhatsApp by typing a pairing code into it, and from then on every new person who messages them privately is saved as a contact in WhatsApp (and, optionally, in their phone's address book). The bot never sends anything from the linked account.

## What was reused, and from where

| Reused | From |
| --- | --- |
| Auth state in Postgres with `BufferJSON`, including the `app-state-sync-key` protobuf fix-up | `contact-saver` and `whatsapp-filter`, `api/src/worker/dbAuthState.ts` |
| One supervised socket per account: silent logger, `makeCacheableSignalKeyStore`, `Browsers.ubuntu('Chrome')`, `fetchLatestBaileysVersion`, `markOnlineOnConnect: false`, `syncFullHistory: false`, reading the disconnect code structurally, ignoring events from a replaced socket | `contact-saver`, `api/src/worker/sessionManager.ts` |
| Pairing-code login shown on the page (`requestPairingCode`), and logged-out handling (wipe the login, ask the user to relink) | `nba-whatsapp-poster`, `whatsapp.js` (the DealsPulse pattern) and `contact-saver` |
| `railway.json`: Dockerfile builder, health check path, `ON_FAILURE` restarts, `numReplicas: 1` | `contact-saver` and `whatsapp-auto-poster` |
| `node:22-slim` Dockerfile layout | `whatsapp-auto-poster` and `nba-whatsapp-poster` |
| Stripe env var names (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`), `client_reference_id` on Checkout, raw-body signature check, tolerance of out-of-order subscription events | `whatsapp-auto-poster`, `lib/billing.js` |
| Phone masking in logs | `contact-saver`, `api/src/lib/logging.ts` |
| Vercel SPA rewrite in `vercel.json` | `affiliate-2.0` |

Where those repos differ from the build document, the document won: Supabase instead of a direct Postgres connection, Express instead of Fastify, the Stripe SDK instead of hand-rolled `fetch`, `baileys@7.0.0-rc14` instead of `@whiskeysockets/baileys@6.x`. None of my repos used Supabase, so the Supabase client setup is new. One later change overrides the document: linking uses a pairing code, not a QR code, so `wa_sessions` has `pairing_code` and status `pairing` where the document had `qr`.

## Layout

```
worker/     Node + TypeScript + Express + Baileys. One always-on Railway instance.
web/        React + Vite + TypeScript + Tailwind. Deployed on Vercel.
supabase/   The migration, and an RLS test that runs on a throwaway Postgres.
```

The web app reads its own rows straight from Supabase under RLS. Anything touching WhatsApp or Stripe goes through the worker with the user's Supabase JWT.

## Setup

### 1. Supabase

1. Create a project.
2. SQL Editor: paste and run `supabase/migrations/0001_init.sql` (or `supabase db push` with the CLI).
3. Authentication → Providers: Email on. For quick testing turn "Confirm email" off; with it on, set Authentication → URL Configuration → Site URL to the Vercel URL.
4. Collect: Project URL, anon key, service-role key, JWT secret (Settings → API).

### 2. Stripe (test mode)

1. Create a product with a monthly recurring price. Copy the price ID (`price_...`).
2. Settings → Billing → Customer portal: activate it and allow cancelling subscriptions.
3. After the worker is deployed, add a webhook endpoint at `https://<worker>/api/stripe/webhook` for these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Copy its signing secret (`whsec_...`).

### 3. Run locally

```bash
cd worker && cp .env.example .env && npm install && npm run dev
```

```bash
cd web && cp .env.example .env && npm install && npm run dev
```

Fill in both `.env` files first. Locally, `WEB_URL=http://localhost:5173` and `VITE_API_URL=http://localhost:3000`. To receive webhooks locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

## Deploy

### Worker on Railway

1. New project → Deploy from GitHub repo → this repo. In the service settings set **Root Directory** to `worker`. `railway.json` and the `Dockerfile` do the rest.
2. Add the variables from `worker/.env.example`. `WEB_URL` is the Vercel URL with no trailing slash. Leave `PORT` unset; Railway provides it.
3. Keep it at **one replica**. Two replicas would open two sockets for the same WhatsApp login and they would knock each other offline. `railway.json` pins `numReplicas: 1`.
4. Generate a public domain. `GET /health` returns `{"ok":true,"sockets":N}`.

### Web on Vercel

1. New project → import this repo → **Root Directory** `web` (framework: Vite).
2. Add the variables from `web/.env.example`. `VITE_API_URL` is the Railway URL.
3. Deploy, then put the final Vercel URL into the worker's `WEB_URL` and Supabase's Site URL.

## Renaming the product

Change `APP_NAME` in `web/src/brand.ts`. That is the only place the name appears to users (page title, header, login, footer, Terms, Privacy). The `<title>` in `web/index.html` is overwritten at startup; change it too if you care about the first few milliseconds. The npm package names (`savebot-worker`, `savebot-web`) are internal.

The accent colour is the one `--color-accent` pair in `web/src/index.css`.

## Changing the price

Prices live in Stripe, not in code.

1. Stripe → the product → add a new price.
2. Set the worker's `STRIPE_PRICE_ID` to the new price ID and redeploy.

New subscribers get the new price. Existing subscribers stay on their old price until you migrate them in Stripe. The trial length is `TRIAL_DAYS` (0 means no trial).

## Tests

```bash
cd worker && npm test
```

```bash
./supabase/tests/run.sh
```

The worker tests cover the save rules, the queue, sessions and reconnects, the HTTP API and the Stripe webhook against in-memory fakes. The second command needs local Postgres server binaries; it applies the migration and checks, with two users, that neither can read or change the other's rows.

## Behaviour worth knowing

- **Daily cap** counts successful saves per UTC day. When it is hit the rest of the queue is dropped; those people are saved the next time they message.
- **Names**: the sender's WhatsApp name is trimmed, stripped of control and invisible characters and cut to 60 characters. A name with no letter or digit left (empty, emoji only) gets `<fallback prefix> <last 4 digits>`.
- **Unresolved senders**: when a sender arrives as `@lid` and WhatsApp gives no phone number, a row is stored with status `unresolved` and `phone` set to `lid:<id>` (the column is `not null` and unique per user). It is replaced by a normal row once the number resolves.
- **Existing contacts**: any contact WhatsApp reports with a saved name is recorded as `existing` and never touched. The list WhatsApp sends right after linking (`messaging-history.set`) is read for this too, in addition to `contacts.upsert` and `contacts.update`.
- **Failed saves** are retried once, then recorded as `failed` and not attempted again.
- **Linking**: the user enters their own WhatsApp number, the worker asks WhatsApp for an 8-character code, and the user types it under Linked devices → Link a device → Link with phone number instead. If nobody enters it before WhatsApp gives up, the session goes back to "Not connected" instead of retrying forever. Pressing Connect again with a different number starts over.
- **Subscription changes**: every Stripe event triggers a fresh lookup of the customer's subscriptions, so events arriving out of order cannot leave a wrong status.
- **Invisible to the other person**: the only call made to WhatsApp is `addOrEditContact`. A test fails the build if the worker source ever calls `sendMessage`, read receipts or presence.
