/** Environment, read once. Missing required values stop the boot with a clear message. */

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
  /** Optional: without these two the disconnect email is simply not sent. */
  resendApiKey?: string;
  emailFrom?: string;
  appName: string;
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
    resendApiKey: process.env.RESEND_API_KEY?.trim() || undefined,
    emailFrom: process.env.EMAIL_FROM?.trim() || undefined,
    appName: process.env.APP_NAME?.trim() || 'SaveBot',
  };
}
