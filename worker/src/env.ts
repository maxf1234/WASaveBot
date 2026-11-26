/** Environment, read once. Missing required values stop the boot with a clear message. */

/** A whole number of at least zero, or the fallback. A bad value fails the boot. */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a whole number of zero or more`);
  }
  return parsed;
}

/**
 * A Stripe value, or undefined if it is absent or plainly not one.
 *
 * Every Stripe credential carries a fixed prefix, so anything without it — an
 * empty value, `x`, a `<sk_test_…>` left over from a template — is treated as
 * "not set" rather than handed to Stripe to fail on later, deep inside a
 * customer's checkout. That lets a deployment leave placeholders in place until
 * it is ready to take payments.
 */
function stripeValue(name: string, prefixes: string[]): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  return prefixes.some((prefix) => value.startsWith(prefix)) ? value : undefined;
}

/** Billing works only with both of these. The webhook secret is checked separately. */
export const billingConfigured = (env: Pick<Env, 'stripeSecretKey' | 'stripePriceId'>): boolean =>
  Boolean(env.stripeSecretKey && env.stripePriceId);

function webUrl(): string {
  const explicit = process.env.WEB_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway}`;
  throw new Error(
    'Missing environment variable WEB_URL (and no RAILWAY_PUBLIC_DOMAIN to fall back on: ' +
      'generate a domain for the service under Settings → Networking)',
  );
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export interface Env {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseJwtSecret: string;
  /**
   * Stripe is optional. Without a secret key and a price the worker runs with
   * billing switched off: nobody can subscribe, so every account stays in the
   * free preview, and the Billing page says billing is not set up yet.
   */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceId?: string;
  trialDays: number;
  webUrl: string;
  port: number;
  /**
   * The public anon key, handed to the dashboard at load time via /config.js.
   * Not a secret — it is in every browser that opens the site, and RLS is what
   * protects the data — but it has to come from somewhere now the site is
   * served by the worker rather than built with it baked in.
   */
  supabaseAnonKey?: string;
  /** Where the built dashboard is. Unset or missing means the worker serves the API only. */
  webRoot?: string;
  /** 32-byte key (64 hex chars) that encrypts the WhatsApp logins in wa_auth. */
  waAuthEncryptionKey: string;
  /**
   * Optional older key, accepted for decryption only, so the key above can be
   * rotated without logging every customer out. See crypto.ts.
   */
  waAuthEncryptionKeyPrevious?: string;
  /**
   * Activity rows older than this are swept nightly. Nothing downstream
   * depends on them, so this is the whole retention story.
   */
  eventRetentionDays: number;
  /**
   * How long a socket stays open after Stripe stops reporting a good status,
   * so a card that is merely expiring does not silently cost the customer
   * contacts while Stripe retries it. 0 restores the old behaviour of stopping
   * the moment the status goes bad.
   */
  paymentGraceHours: number;
  /**
   * How many days an unsubscribed account may run the free preview before its
   * socket is closed. 0 means no limit, which is the default because a preview
   * that expires is a worse demonstration — but every free account holds a
   * WhatsApp socket, which is the real per-customer cost, so this is the lever
   * to reach for when that starts to matter.
   */
  freePreviewDays: number;
  /** Optional: without these two the disconnect email is simply not sent. */
  resendApiKey?: string;
  emailFrom?: string;
  appName: string;
  /**
   * Who may see the admin page, as email addresses. Empty means nobody, which
   * is the right default: an admin page that is open by accident is worse than
   * no admin page.
   */
  adminEmails: string[];
  /** Which slice of the customers this replica owns. See shard.ts. */
  replicaIndex: number;
  replicaCount: number;
  /** How often a replica brings its sockets in line with what customers asked for. */
  reconcileSeconds: number;
}

export function loadEnv(): Env {
  const trialDays = Number(process.env.TRIAL_DAYS ?? 0);
  return {
    supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseJwtSecret: required('SUPABASE_JWT_SECRET'),
    stripeSecretKey: stripeValue('STRIPE_SECRET_KEY', ['sk_', 'rk_']),
    stripeWebhookSecret: stripeValue('STRIPE_WEBHOOK_SECRET', ['whsec_']),
    stripePriceId: stripeValue('STRIPE_PRICE_ID', ['price_']),
    trialDays: Number.isFinite(trialDays) && trialDays > 0 ? Math.floor(trialDays) : 0,
    // No trailing slash: it is compared against the browser's Origin header,
    // and it is the base of Stripe's return links. With the site served by
    // the worker it is just this service's own address, so Railway's
    // RAILWAY_PUBLIC_DOMAIN fills it in and there is one fewer thing to set.
    webUrl: webUrl(),
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY?.trim() || undefined,
    webRoot: process.env.WEB_ROOT?.trim() || undefined,
    port: Number(process.env.PORT) || 3000,
    waAuthEncryptionKey: required('WA_AUTH_ENCRYPTION_KEY'),
    waAuthEncryptionKeyPrevious: process.env.WA_AUTH_ENCRYPTION_KEY_PREVIOUS?.trim() || undefined,
    eventRetentionDays: positiveInt('EVENT_RETENTION_DAYS', 90),
    paymentGraceHours: positiveInt('PAYMENT_GRACE_HOURS', 72),
    freePreviewDays: positiveInt('FREE_PREVIEW_DAYS', 0),
    resendApiKey: process.env.RESEND_API_KEY?.trim() || undefined,
    emailFrom: process.env.EMAIL_FROM?.trim() || undefined,
    appName: process.env.APP_NAME?.trim() || 'SaveBot',
    replicaIndex: positiveInt('REPLICA_INDEX', 0),
    replicaCount: positiveInt('REPLICA_COUNT', 1),
    reconcileSeconds: positiveInt('RECONCILE_SECONDS', 15),
    adminEmails: (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  };
}
