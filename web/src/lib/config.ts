/**
 * Where the dashboard finds Supabase and the worker.
 *
 * In production the worker serves this site itself, and tells it the Supabase
 * settings at load time through /config.js — so the same build works anywhere,
 * nothing has to be baked in, and changing a key is a Railway variable rather
 * than a rebuild. The API is then the same origin, so its URL is empty and
 * requests are relative.
 *
 * In development the Vite server has no /config.js of its own and proxies the
 * worker's instead (vite.config.ts); the VITE_ variables remain as a fallback
 * for anyone running the site on its own against a worker elsewhere.
 */

interface RuntimeConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

const runtime: RuntimeConfig =
  (globalThis as { __SAVEBOT__?: RuntimeConfig }).__SAVEBOT__ ?? {};

const env = import.meta.env as Record<string, string | undefined>;

export const supabaseUrl = runtime.supabaseUrl || env.VITE_SUPABASE_URL || '';
export const supabaseAnonKey = runtime.supabaseAnonKey || env.VITE_SUPABASE_ANON_KEY || '';

/** Empty means "same origin as this page", which is the normal case. */
export const apiUrl = (env.VITE_API_URL ?? '').replace(/\/+$/, '');
