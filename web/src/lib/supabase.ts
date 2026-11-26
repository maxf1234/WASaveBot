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
  /** Watch-only until true: decisions are recorded and no contact is written. */
  armed: boolean;
  save_mode: 'everyone' | 'phrase';
  save_phrase: string;
  remove_phrase: string;
  default_policy: 'allow' | 'block';
}

export interface Rule {
  id: number;
  kind: 'block' | 'allow';
  prefix: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
}

export interface DialPrefix {
  prefix: string;
  kind: 'country' | 'nanp_area';
  name: string;
  region: string | null;
}

export type Decision =
  | 'saved' | 'would_save' | 'already_known' | 'removed' | 'not_found'
  | 'blocked_prefix' | 'no_trigger' | 'capped' | 'disabled' | 'unsubscribed'
  | 'unresolved' | 'failed';

export interface SaveEvent {
  id: number;
  occurred_at: string;
  phone: string | null;
  push_name: string | null;
  saved_name: string | null;
  decision: Decision;
  matched_prefix: string | null;
  detail: string | null;
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
  status: 'saved' | 'existing' | 'failed' | 'unresolved' | 'pending' | 'removed';
  error: string | null;
  created_at: string;
}

export const isSubscribed = (profile: Profile | null | undefined): boolean =>
  profile?.subscription_status === 'active' || profile?.subscription_status === 'trialing';

/**
 * Turn what somebody types into the digits a rule is stored as.
 *
 * Mirrors the worker's rules.ts, because rules are written straight to Supabase
 * under RLS rather than through the worker — rules touch neither WhatsApp nor
 * Stripe, so routing them through an extra hop would buy nothing. The database
 * has the same shape as a CHECK constraint, so a mistake here is refused rather
 * than stored.
 *
 * A bare three-digit NANP area code is the one input that cannot be taken at
 * face value: '917' means the New York area code to a person, and "anything
 * starting 917" to a matcher. `areaCode` says which the caller meant.
 */
export function normalizePrefix(input: string, areaCode = false): string | null {
  let digits = input.replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (areaCode && digits.length === 3) digits = `1${digits}`;
  return /^[1-9][0-9]{0,14}$/.test(digits) ? digits : null;
}

/** What the activity log calls each decision, in the customer's words. */
export const DECISION_TEXT: Record<Decision, string> = {
  saved: 'saved',
  would_save: 'would have been saved',
  already_known: 'already in your contacts',
  removed: 'removed on request',
  not_found: 'asked to be removed, was not saved',
  blocked_prefix: 'refused by one of your rules',
  no_trigger: 'did not use your phrase',
  capped: 'held — daily limit reached',
  disabled: 'saving was switched off',
  unsubscribed: 'would have been saved — subscribe to save them',
  unresolved: 'WhatsApp gave no number',
  failed: 'could not be saved',
};
