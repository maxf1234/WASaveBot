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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export interface Env {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseJwtSecret: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePriceId: string;
  trialDays: number;
  webUrl: string;
  port: number;
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
}

export function loadEnv(): Env {
  const trialDays = Number(process.env.TRIAL_DAYS ?? 0);
  return {
    supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseJwtSecret: required('SUPABASE_JWT_SECRET'),
    stripeSecretKey: required('STRIPE_SECRET_KEY'),
    stripeWebhookSecret: required('STRIPE_WEBHOOK_SECRET'),
    stripePriceId: required('STRIPE_PRICE_ID'),
    trialDays: Number.isFinite(trialDays) && trialDays > 0 ? Math.floor(trialDays) : 0,
    // No trailing slash: it is compared against the browser's Origin header.
    webUrl: required('WEB_URL').replace(/\/+$/, ''),
    port: Number(process.env.PORT) || 3000,
    waAuthEncryptionKey: required('WA_AUTH_ENCRYPTION_KEY'),
    waAuthEncryptionKeyPrevious: process.env.WA_AUTH_ENCRYPTION_KEY_PREVIOUS?.trim() || undefined,
    eventRetentionDays: positiveInt('EVENT_RETENTION_DAYS', 90),
    paymentGraceHours: positiveInt('PAYMENT_GRACE_HOURS', 72),
    freePreviewDays: positiveInt('FREE_PREVIEW_DAYS', 0),
    resendApiKey: process.env.RESEND_API_KEY?.trim() || undefined,
    emailFrom: process.env.EMAIL_FROM?.trim() || undefined,
    appName: process.env.APP_NAME?.trim() || 'SaveBot',
    adminEmails: (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  };
}
