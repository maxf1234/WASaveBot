import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && anonKey && import.meta.env.VITE_API_URL);

// Placeholders keep the import from throwing when the env is missing; App
// shows a setup message instead of rendering anything that would use them.
export const supabase = createClient(url || 'http://localhost', anonKey || 'missing');

export interface Profile {
  id: string;
  email: string | null;
  subscription_status: string;
  current_period_end: string | null;
}

export interface Settings {
  user_id: string;
  enabled: boolean;
  save_to_phone: boolean;
  name_template: string;
  fallback_prefix: string;
  daily_cap: number;
}

export interface WaSession {
  user_id: string;
  status: 'disconnected' | 'pairing' | 'connecting' | 'connected' | 'logged_out';
  pairing_code: string | null;
  phone: string | null;
  last_connected_at: string | null;
}

export interface SavedContact {
  id: number;
  phone: string;
  push_name: string | null;
  saved_name: string | null;
  status: 'saved' | 'existing' | 'failed' | 'unresolved' | 'pending';
  error: string | null;
  created_at: string;
}

export const isSubscribed = (profile: Profile | null | undefined): boolean =>
  profile?.subscription_status === 'active' || profile?.subscription_status === 'trialing';
