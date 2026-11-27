# SaveBot

A customer signs up, subscribes, links their own WhatsApp by typing a pairing code into it, and from then on new people who message them privately are saved as contacts in WhatsApp (and, optionally, in their phone's address book). The bot never sends anything from the linked account.

Who counts as "new people" is theirs to choose: everyone who messages, or only those who ask with a phrase. Either way they can refuse whole country or area codes, watch it run before it writes anything, see why each person was or was not saved, and anyone saved can ask to be removed.

## What was reused, and from where

| Reused | From |
| --- | --- |
| Auth state in Postgres with `BufferJSON`, including the `app-state-sync-key` protobuf fix-up | `contact-saver` and `whatsapp-filter`, `api/src/worker/dbAuthState.ts` |
| One supervised socket per account: silent logger, `makeCacheableSignalKeyStore`, `Browsers.ubuntu('Chrome')`, `fetchLatestBaileysVersion`, `markOnlineOnConnect: false`, `syncFullHistory: false`, reading the disconnect code structurally, ignoring events from a replaced socket | `contact-saver`, `api/src/worker/sessionManager.ts` |
| Pairing-code login shown on the page (`requestPairingCode`), and logged-out handling (wipe the login, ask the user to relink) | `nba-whatsapp-poster`, `whatsapp.js` (the DealsPulse pattern) and `contact-saver` |
| `railway.json`: Dockerfile builder, health check path, `ON_FAILURE` restarts, `numReplicas: 1` | `contact-saver` and `whatsapp-auto-poster` |
| `node:22-slim` Dockerfile layout | `whatsapp-auto-poster` and `nba-whatsapp-poster` |
| Stripe env var names (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`), `client_reference_id` on Checkout, raw-body signature check, tolerance of out-of-order subscription events | `whatsapp-auto-poster`, `lib/billing.js` |
| AES-256-GCM encryption of the stored WhatsApp login keys | `contact-saver`, `api/src/lib/crypto.ts` (same idea, key in `WA_AUTH_ENCRYPTION_KEY`) |
| Phone masking in logs | `contact-saver`, `api/src/lib/logging.ts` |
| The trigger parser and its name handling, the prefix matcher, the pure decision, the watch-only catch and the activity log | `contact-saver`, `api/src/domain/` |

Where those repos differ from the build document, the document won: Supabase instead of a direct Postgres connection, Express instead of Fastify, the Stripe SDK instead of hand-rolled `fetch`, `baileys@7.0.0-rc14` instead of `@whiskeysockets/baileys@6.x`. None of my repos used Supabase, so the Supabase client setup is new. One later change overrides the document: linking uses a pairing code, not a QR code, so `wa_sessions` has `pairing_code` and status `pairing` where the document had `qr`.

## Layout

```
worker/     Node + TypeScript + Express + Baileys. One always-on Railway instance.
web/        React + Vite + TypeScript + Tailwind. Built into the worker's image and served by it.
supabase/   The migrations, and an RLS test that runs on a throwaway Postgres.
```

The worker's decision is a pure function, `worker/src/decide.ts`: it takes the
message, the settings, the rules and four facts, and returns a verdict. It
touches no socket and no database. `saver.ts` gathers the facts, carries out
the verdict and writes down what happened. That split is what makes the
product's riskiest property — an unarmed account never writes to an address
book — provable over every combination of settings rather than hoped for.

The web app reads its own rows straight from Supabase under RLS. Anything touching WhatsApp or Stripe goes through the worker with the user's Supabase JWT. Both are served from the same Railway service and the same origin.

## Setup

### 1. Supabase

1. Create a project.
2. SQL Editor: run every file in `supabase/migrations/` in order (or `supabase db push` with the CLI).
3. Authentication → Providers: Email on. For quick testing turn "Confirm email" off; with it on, set Authentication → URL Configuration → Site URL to the Railway URL.
4. Collect: Project URL, anon key, service-role key, JWT secret (Settings → API). The worker needs all four.

### 2. Stripe (test mode, optional)

You can skip this step and come back to it. Without Stripe keys the worker runs with billing off: everyone stays in the free preview, the Billing page says billing isn't set up yet, and the webhook answers 503 so Stripe retries once you add it. Placeholder values count as unset; a value only counts with Stripe's real prefix (`sk_`/`rk_`, `whsec_`, `price_`).

1. Create a product with a monthly recurring price of $9.99. Copy the price ID (`price_...`).
2. Settings → Billing → Customer portal: activate it and allow cancelling subscriptions.
3. After the worker is deployed, add a webhook endpoint at `https://<worker>/api/stripe/webhook` for these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Copy its signing secret (`whsec_...`).

### 3. Run locally

```bash
cd worker && cp .env.example .env && npm install && npm run dev
```

```bash
cd web && npm install && npm run dev
```

Fill in `worker/.env` first, with `WEB_URL=http://localhost:5173`. The site needs
no `.env` of its own: Vite proxies `/api` and `/config.js` to the worker on port
3000, so it is the same origin in development exactly as it is in production.
To receive webhooks locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

## Deploy

**One Railway service runs the whole product.** The dashboard is built into the
same image as the worker and served by it, so there is one deploy and one URL,
and no second host to keep in step. The root `Dockerfile` builds both.

1. New project → **Deploy from GitHub repo** → this repo. Leave **Root
   Directory** empty: the build needs both `web/` and `worker/`. Set the
   **Branch** to `main`. `railway.json` does the rest.
2. **Settings → Networking → Generate Domain.** `WEB_URL` defaults to this
   domain, so you do not need to set it — only if you later add a custom domain.
3. Add the variables from `worker/.env.example`, plus `SUPABASE_ANON_KEY`. Leave
   `PORT` unset; Railway provides it.
   - `SUPABASE_ANON_KEY` is not a secret — it is in every browser that opens the
     site, and RLS is what protects the data — but the worker hands it to the
     dashboard at load time through `/config.js`, so it lives here. Nothing is
     baked into the build, so changing a key is a variable and a restart.
   - `WA_AUTH_ENCRYPTION_KEY` is required. Generate it once and keep a copy somewhere safe; if it is lost, every customer has to link WhatsApp again. It can now be *rotated* without that — see the key rotation note under Behaviour worth knowing.

     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - `RESEND_API_KEY` and `EMAIL_FROM` are optional. With both set, a customer is emailed when WhatsApp logs them out. `EMAIL_FROM` must be on a domain verified at resend.com. Without them the worker runs normally and sends no email.
4. Keep `numReplicas` at **1** — see [Scaling past one worker](#scaling-past-one-worker) for how to run more than one.
5. Open the domain. `/` is the dashboard and `/health` returns `{"ok":true,"sockets":N}`.

The site can still be hosted elsewhere if you ever want to: build `web/`, point
it at the worker with `VITE_API_URL`, `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`, and set the worker's `WEB_URL` to its address so CORS
allows it.

## Scaling past one worker

Every customer's WhatsApp socket used to live in one Node process, because two
workers holding a socket for the same login knock each other offline —
WhatsApp treats a second connection from the same credentials as a
replacement. Sessions are now **sharded**: each worker owns the customers whose
id hashes into its slot, and ignores everyone else.

**Run more services, not more replicas.** This is the part that is easy to get
wrong, and getting it wrong causes exactly the failure sharding prevents.
Replicas of one Railway service share their environment variables, so
`numReplicas: 2` would give both copies `REPLICA_INDEX=0`. Both would own every
customer and fight over every login. `railway.json` therefore stays at
`numReplicas: 1`, and scaling means:

1. Create N services from this repo, each with Root Directory `worker`.
2. Give all of them the same variables, plus `REPLICA_COUNT=N`.
3. Give each its own `REPLICA_INDEX`: `0`, `1`, … `N-1`.

The worker refuses to boot with an index outside `0 … N-1`, because a replica
outside the range would own nobody and those customers would silently stop
being served.

**Point everything at any one of them.** The HTTP API no longer opens or closes
sockets. Linking, unlinking, backfill and retry write *intent* rows and return,
and the worker that owns the customer reconciles them within a few seconds. So
any service can take any request: `VITE_API_URL` and the Stripe webhook can
both point at service 0. Billing writes intent the same way, which matters
because a webhook lands wherever the load balancer sends it.

**Change the count with a full stop, not a rolling deploy.** While services
are running with different values of `REPLICA_COUNT`, they disagree about who
owns whom, and for that window some customers have two owners. Stop every
worker, change the count everywhere, start them again. Changing the count also
moves most customers to a new owner, so each of those reconnects once with its
stored login and no new pairing code.

**The hash is pinned by a test.** If `shard.ts` ever changed how it hashes,
every customer would move at the next deploy and every socket would reconnect
at once. That might be acceptable, but it should be a decision rather than a
side effect of an edit, so `shard.test.ts` fails if the value moves.

`test/shard.test.ts` checks the property that makes all of this safe: with two
real managers reconciling the same intent, no customer is held twice and none
is held by nobody.

## Upgrading an existing deployment

`0002` to `0007` are additive. Two of them backfill existing rows so that nobody
notices the upgrade, and both were checked against a database that already had
customers in it:

- `0002` sets `armed = true` for every existing settings row (below).
- `0006` sets `desired = 'on'` for every session with a stored login. Without
  it, every connected customer would be disconnected by the first reconcile,
  because the new column defaults to `'off'`.

Apply all of them before deploying the worker.

The ordering matters for one column in `0002`.

`settings.armed` defaults to **false**, because a new account should record what
it would do before it touches a real address book. Every customer who already
exists is saving today with `enabled` as their only switch, so the migration
**backfills `armed = true` for every existing row**. Run it as one statement —
which is what `supabase db push` and the SQL Editor both do — and no live
customer stops saving for even a moment. Deploy the worker after the migration:
the old worker ignores the new columns, and the new worker treats a missing
settings row as unarmed rather than armed.

One small, deliberate effect on the day you upgrade: the daily cap now counts
from `save_events` rather than from `saved_contacts`, because the activity log
is append-only and a contact that is later removed cannot quietly hand back a
slot that was already spent. `save_events` starts empty, so on the first day a
customer can save up to their cap again. Nothing else changes.

## What came from contact-saver, and what deliberately did not

`contact-saver` replies to whoever asked, and that is the one thing not brought
across. This product's whole claim is that it is invisible to the other person:
the only WhatsApp writes are to the customer's own contact list, and a build
test enforces it. Replying would be the single largest change to the ban risk
that customers are taking with their own numbers, so the guard stayed and the
replies did not. An opt-out is therefore silent — the contact is deleted and the
sender is not told, which is the best available trade here.

Google Contacts sync is not here either. WhatsApp's own `saveOnPrimaryAddressbook`
already puts contacts in the phone's address book, so a second destination would
add a Google OAuth consent screen and a sensitive-scope verification review for
a mostly duplicate result. The save path is shaped so one could be added later
without a rewrite: `decide()` returns a verdict, and `saver.ts` is the only thing
that carries it out.

## Renaming the product

Change `APP_NAME` in `web/src/brand.ts`. That is the only place the name appears in the app (page title, header, login, footer, Terms, Privacy). The worker uses the name in one place, the disconnect email, and reads it from its `APP_NAME` variable on Railway. The `<title>` in `web/index.html` is overwritten at startup; change it too if you care about the first few milliseconds. The npm package names (`savebot-worker`, `savebot-web`) are internal.

The accent colour is the one `--color-accent` pair in `web/src/index.css`.

## Changing the price

Prices live in Stripe, not in code.

1. Stripe → the product → add a new price.
2. Set the worker's `STRIPE_PRICE_ID` to the new price ID and redeploy.
3. Change `PRICE_LABEL` in `web/src/brand.ts` (the text on the Billing page; currently `$9.99 / month`) and redeploy the web app.

New subscribers get the new price. Existing subscribers stay on their old price until you migrate them in Stripe. The trial length is `TRIAL_DAYS` (0 means no trial).

## Tests

```bash
cd worker && npm test
```

```bash
./supabase/tests/run.sh
```

111 worker tests, against in-memory fakes: the save rules, the trigger parsing,
the prefix matching, the queue, sessions and reconnects, the HTTP API and the
Stripe webhook. Two are worth knowing about:

- `decide.test.ts` sweeps 640 combinations of mode, policy, rules, subscription,
  cap and opt-out state asserting that an unarmed account never produces a save.
- `sessions.test.ts` holds both no-send guards, and the allowlist one is itself
  checked: adding a method to the socket interface makes it fail.

The second command needs local Postgres server binaries. It applies every
migration in order — so it also proves they apply to each other — and checks,
with two users, that neither can read or change the other's rows, that the
WhatsApp logins are unreachable, that rules are fully editable by their owner
and invisible to anyone else, and that the activity log cannot be rewritten.

## The free preview

Signing up and linking WhatsApp needs no subscription. An unlinked account that
has paid nothing runs as a **preview**: every person who messages appears on the
Activity page with what *would* have happened, and nothing is written to their
contacts. Subscribing is what turns it into real saving.

That is deliberate as a funnel — the demonstration is the customer's own chats
rather than a screenshot — and it is also the safest shape, because the preview
exercises every code path except the one write.

Three things make it honest rather than a tease:

- The subscription check sits **below** the rules, so a number the customer's
  own rule refuses is reported as refused, not as "subscribe to save them".
  Promising to save somebody we would have turned away anyway would be a lie in
  the exact place they are deciding whether to pay.
- It sits **above** the daily cap, because a preview writes nothing and so has
  no write budget to spend.
- Arming without paying does nothing. The web app writes settings straight to
  Supabase, so `armed` is not a trusted input; the worker is the only thing that
  writes contacts and it refuses for an unsubscribed account whatever the column
  says. The switch is disabled on screen as well, but that is courtesy, not the
  gate.

The cost is real: a free account holds a WhatsApp socket, which is the actual
per-customer cost and the whole reason for `numReplicas: 1`. `FREE_PREVIEW_DAYS`
bounds it — after that many days the socket closes while the settings, rules and
activity stay, so subscribing later picks up where they left off. It defaults to
0, meaning no limit, because an expiring preview is a worse demonstration; raise
it off zero when free sockets start to cost more than they earn.

## The admin page

`ADMIN_EMAILS` (comma separated) decides who sees `/admin`. It is matched
against the email in the verified Supabase JWT, so it is not something a
browser can assert about itself, and it is empty by default: with nothing
configured, nobody is an admin.

The page exists because the per-customer failures are otherwise invisible. It
leads with the cases worth acting on, worst first:

- **paying, not connected** — being charged for nothing
- **paying, not armed** — paid, then never switched it on
- **payment failing** — inside the grace window, about to stop
- **logged out of WhatsApp** — needs to re-link and does not know it

None of those produces an event anybody sees. It also shows how many WhatsApp
sockets this worker is holding, which is the number that matters for the
single-replica ceiling.

This is the only page that reads across tenants, so it does not go through
Supabase like the rest of the dashboard — RLS would correctly return one row. It
goes through the worker, which holds the service-role key. The aggregation is a
view, `admin_overview`, and the view is locked down twice over: `revoke` so
`authenticated` cannot read it at all, and `security_invoker = true` so the
underlying policies would still apply if the grants were ever loosened. A view
in Postgres runs with its owner's rights by default, which would have been a way
straight past every policy in `0002`. `supabase/tests/rls.sql` checks a customer
is refused and the worker is not.

### Downloading every contact

**Download all contacts** on the admin page gives one CSV of every contact saved for every customer: customer email, name, number, status and when it was saved. It reads `saved_contacts` directly, so there is no second copy to keep in sync. Opted-out people stay in the file with status `removed`. Contacts that were never saved (`pending`) are left out, and so are contacts saved by admin accounts (anyone in `ADMIN_EMAILS`). The file holds other people's phone numbers, so keep it private and delete copies you no longer need.

### Giving someone Pro

Each customer row has a **Give Pro** / **Remove Pro** button. Pro given this way works without Stripe and is stored separately from the Stripe subscription, so no webhook can undo it. It takes effect within about 15 seconds; giving Pro also reconnects a socket an expired free preview had closed. Removing it drops the customer to the free preview.

## Behaviour worth knowing

- **Save modes**: `everyone` saves each new person who messages privately, which is what every existing account does. `phrase` saves only people whose message *starts with* the customer's phrase — anchored deliberately, because "don't save my number" and "did you save my number?" both contain it and neither is a request. In phrase mode the name the sender gives beats their WhatsApp name, and politeness is stripped, so "save my number please" does not file a contact called "please".
- **Watch-only**: a new account starts unarmed. Everyone who messages appears on the Activity page with "would have been saved" and nothing is written. This matters more here than it would in a read-only tool — a wrong rule writes strangers into an address book that has already synced to a phone, and undoing that is manual. Arming asks for confirmation.
- **Rules**: a rule is leading digits of the full international number, so `234` is all of Nigeria and `1917` is the 917 area code — one mechanism, because a NANP number is 1 + area code + 7 digits. Longest match wins, which gives exceptions for free: refuse `234`, allow `234803`. `default_policy` decides what happens to numbers no rule covers; set it to refuse and the allow rules become an allowlist, which is the only way to express "only these countries".
- **Opt-out**: anyone saved can send the removal phrase, in either mode. The contact is deleted with `removeContact` and the row is kept as `removed` — the row is the record that they objected, and deleting it would let their next message save them again. In `everyone` mode an ordinary message is *not* a request to be re-added, so the opt-out holds; only the save phrase revives them, because that is them asking.
- **Activity log**: every decision is a row, including the refusals. This is the page that answers "my friend messaged me and never got saved" — the row says `refused by one of your rules`, `held — daily limit reached`, `saving was switched off`, `no active subscription` or `WhatsApp gave no number`. Ongoing traffic from somebody already saved is not recorded, because it would bury everything else.
- **Daily cap** counts real writes per UTC day, from the activity log. When it is hit the rest are **held** as pending rather than dropped, and the customer saves them from the dashboard with the same button the backfill uses. The old behaviour discarded them, which lost anybody who never messaged again.
- **Names**: the sender's WhatsApp name is trimmed, stripped of control and invisible characters and cut to 60 characters. A name with no letter or digit left (empty, emoji only) gets `<fallback prefix> <last 4 digits>`.
- **Unresolved senders**: when a sender arrives as `@lid` and WhatsApp gives no phone number, a row is stored with status `unresolved` and `phone` set to `lid:<id>` (the column is `not null` and unique per user). It is replaced by a normal row once the number resolves.
- **Existing contacts**: any contact WhatsApp reports with a saved name is recorded as `existing` and never touched. The list WhatsApp sends right after linking (`messaging-history.set`) is read for this too, in addition to `contacts.upsert` and `contacts.update`.
- **Failed saves** are retried once, then recorded as `failed`. They are not attempted again unless the customer presses Retry on that row in the dashboard. A failed save still holds the claim on that number, so a later message cannot create a second contact for somebody whose first save is merely broken.
- **Backfill**: when WhatsApp is linked it sends the recent chat list. A private chat with no saved name is stored as `pending` and nothing is done with it until the customer presses "Save them" on the dashboard; then they go through the same queue, pacing and daily cap. Ones the cap cuts off stay `pending`. A pending person who messages is saved straight away.
- **Encrypted logins**: every value in `wa_auth` is AES-256-GCM encrypted with `WA_AUTH_ENCRYPTION_KEY`. The database alone cannot log in to anyone's WhatsApp.
- **Disconnect email**: when WhatsApp logs a customer out (not when they press Disconnect, and not when their subscription lapses) they get one email with a link back to the dashboard.
- **Payment grace**: a `past_due` or `unpaid` subscription keeps saving for `PAYMENT_GRACE_HOURS` (72 by default) while Stripe retries the card, so an expiring card does not quietly cost the customer every person who messaged in the meantime. The window starts once per lapse and is not extended by further failures, so a card that keeps failing cannot buy an unbounded free ride; it is cleared the moment the subscription recovers. `canceled` and `incomplete` get no grace — they are over, not retrying. Set the hours to 0 for the old behaviour of stopping instantly.
- **Activity retention**: `save_events` rows older than `EVENT_RETENTION_DAYS` (90) are swept nightly. There are no rollups underneath, so the raw rows are the whole story, which is why the window is generous. Set it to 0 to keep everything and accept unbounded growth.
- **Rotating the encryption key** no longer logs everybody out. Put the current key in `WA_AUTH_ENCRYPTION_KEY_PREVIOUS`, the new one in `WA_AUTH_ENCRYPTION_KEY`, and deploy: writes use the new key, reads fall back to the old one, and every session moves across on its own as Baileys saves credentials. Remove the previous key once they have. A session that never reconnects in that window keeps its old ciphertext and has to re-link — the same outcome it would have had before, now limited to the sessions that were idle rather than all of them.
- **Intent, not calls**: the dashboard's Connect, Disconnect, Save them and Retry buttons write what the customer wants (`wa_sessions.desired`, `logout_requested_at`, `saved_contacts.queue_requested_at`) and return at once. The owning worker reconciles within seconds — each request nudges it — and every `RECONCILE_SECONDS` as a fallback. Nothing in a request waits on WhatsApp, so a slow WhatsApp is a spinner rather than a timed-out request. Backfill and Retry are one mechanism: both put somebody back in the save queue, and the row itself, not the worker's memory, decides whether they are still eligible.
- **Linking**: the user enters their own WhatsApp number, the worker asks WhatsApp for an 8-character code, and the user types it under Linked devices → Link a device → Link with phone number instead. If nobody enters it before WhatsApp gives up, the session goes back to "Not connected" instead of retrying forever. Pressing Connect again with a different number starts over.
- **Subscription changes**: every Stripe event triggers a fresh lookup of the customer's subscriptions, so events arriving out of order cannot leave a wrong status.
- **Invisible to the other person**: the only calls made to WhatsApp are `addOrEditContact` and `removeContact`, both changes to the customer's own contact list. Two tests guard this. One is a blocklist over the source for `sendMessage`, read receipts and presence. The other is an allowlist over the socket interfaces the worker declares — TypeScript only permits calls to what those declare, so auditing them audits every call site, and a new Baileys method cannot slip in just because nobody thought to add it to a blocklist.
- **Dedupe**: `unique (user_id, phone)` on `saved_contacts` is the authority, claimed in one insert-or-nothing statement. The in-memory set this replaced was correct only because the worker is pinned to one replica; the claim is correct regardless, and survives a restart mid-save.
