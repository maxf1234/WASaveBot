import { supabase } from './supabase';

const base = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '');

/** POST to the worker with the user's Supabase JWT. Throws with the worker's message. */
export async function api<T = { ok: true }>(path: string): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  let res: Response;
  try {
    res = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error('Could not reach the server. Try again in a moment.');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}
