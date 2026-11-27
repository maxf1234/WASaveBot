import { apiUrl as base } from './config';
import { supabase } from './supabase';

/** POST to the worker with the user's Supabase JWT. Throws with the worker's message. */
export async function api<T = { ok: true }>(path: string, body?: object): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach the server. Try again in a moment.');
  }
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `Request failed (${res.status})`);
  return payload as T;
}

/** POST to the worker and save the response as a file. */
export async function download(path: string, filename: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
