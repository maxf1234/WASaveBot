import { useCallback, useEffect, useState } from 'react';
import { Button, Card, inputClass, Notice } from '../components/ui';
import { useAuth } from '../lib/auth';
import { DECISION_TEXT, supabase } from '../lib/supabase';
import type { Decision, SaveEvent } from '../lib/supabase';

/**
 * Why each person was, or was not, saved.
 *
 * This is the page that answers "my friend messaged me and never got saved".
 * Before it existed there was no answer: somebody skipped because the daily
 * limit was spent, or because saving was off, or because a rule refused them,
 * left no trace at all — only the people who made it through had a row.
 *
 * It holds no message content. The only things taken from a message are the
 * trigger phrase, which the customer already chose, and the name the sender
 * attached to it.
 */

const STYLES: Record<Decision, string> = {
  saved: 'bg-emerald-50 text-emerald-700',
  removed: 'bg-slate-100 text-slate-600',
  would_save: 'bg-amber-50 text-amber-700',
  capped: 'bg-amber-50 text-amber-700',
  blocked_prefix: 'bg-red-50 text-red-700',
  failed: 'bg-red-50 text-red-700',
  unresolved: 'bg-slate-100 text-slate-600',
  disabled: 'bg-slate-100 text-slate-600',
  unsubscribed: 'bg-red-50 text-red-700',
  no_trigger: 'bg-slate-100 text-slate-600',
  not_found: 'bg-slate-100 text-slate-600',
  already_known: 'bg-slate-100 text-slate-600',
};

const FILTERS: { value: '' | Decision; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'saved', label: 'Saved' },
  { value: 'would_save', label: 'Would have saved' },
  { value: 'blocked_prefix', label: 'Refused by a rule' },
  { value: 'capped', label: 'Held by the limit' },
  { value: 'removed', label: 'Removed on request' },
  { value: 'failed', label: 'Failed' },
];

function when(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function Activity() {
  const { user } = useAuth();
  const userId = user!.id;
  const [events, setEvents] = useState<SaveEvent[] | null>(null);
  const [filter, setFilter] = useState<'' | Decision>('');

  const load = useCallback(async () => {
    let q = supabase
      .from('save_events')
      .select('*')
      .eq('user_id', userId)
      .order('occurred_at', { ascending: false })
      .limit(200);
    if (filter) q = q.eq('decision', filter);
    const { data } = await q;
    setEvents((data ?? []) as SaveEvent[]);
  }, [userId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live, so a backfill or a busy day can be watched as it happens.
  useEffect(() => {
    const channel = supabase
      .channel('save_events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'save_events', filter: `user_id=eq.${userId}` },
        () => void load(),
      )
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [userId, load]);

  if (!events) return <p className="text-slate-500">Loading…</p>;

  return (
    <Card
      title="Activity"
      action={
        <select
          className={`${inputClass} !min-h-9 !w-auto !text-sm`}
          value={filter}
          onChange={(e) => setFilter(e.target.value as '' | Decision)}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      }
    >
      {events.length === 0 ? (
        <Notice>
          Nothing yet. Every person who messages you will appear here with what happened to them.
        </Notice>
      ) : (
        <ul className="divide-y divide-slate-100">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 text-sm">
              <time className="w-20 shrink-0 text-xs tabular-nums text-slate-500" dateTime={event.occurred_at}>
                {when(event.occurred_at)}
              </time>
              <code className="font-mono">{event.phone ? `+${event.phone}` : 'unknown'}</code>
              {(event.saved_name ?? event.push_name) && (
                <span className="truncate text-slate-600">{event.saved_name ?? event.push_name}</span>
              )}
              <span className="flex-1" />
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[event.decision] ?? 'bg-slate-100 text-slate-600'}`}
              >
                {DECISION_TEXT[event.decision] ?? event.decision}
              </span>
              {event.detail && <span className="w-full text-xs text-slate-400">{event.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
    </Card>
  );
}
