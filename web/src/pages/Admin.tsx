import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Notice } from '../components/ui';
import { api } from '../lib/api';

/**
 * The operator's view: every customer, their session, and what the product has
 * actually done for them.
 *
 * This is the only page that reads across tenants, so it does not go through
 * Supabase like the rest of the dashboard — RLS would (correctly) return one
 * row. It goes through the worker, which holds the service-role key and checks
 * the signed-in email against ADMIN_EMAILS before answering.
 *
 * It exists because the per-customer failures are invisible otherwise. A
 * socket stuck reconnecting, a customer who linked and never armed, a card that
 * lapsed last week — none of those produce an event anybody sees.
 */

interface Customer {
  user_id: string;
  email: string | null;
  subscription_status: string;
  grace_until: string | null;
  pro_granted: boolean;
  created_at: string;
  session_status: string | null;
  session_phone: string | null;
  last_connected_at: string | null;
  armed: boolean | null;
  enabled: boolean | null;
  save_mode: string | null;
  saved_count: number;
  failed_count: number;
  pending_count: number;
  removed_count: number;
  last_event_at: string | null;
}

interface Overview {
  customers: Customer[];
  totals: {
    customers: number;
    subscribed: number;
    connected: number;
    armed: number;
    saved: number;
    failed: number;
  };
  sockets: number;
}

const ACTIVE = ['active', 'trialing'];

/** Shortened the same way the worker's logs do: a screen left open is a leak too. */
const maskPhone = (phone: string | null): string => (phone ? `…${phone.slice(-4)}` : '—');

function when(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function Pill({ text, tone }: { text: string; tone: 'good' | 'warn' | 'bad' | 'flat' }) {
  const styles = {
    good: 'bg-emerald-50 text-emerald-700',
    warn: 'bg-amber-50 text-amber-700',
    bad: 'bg-red-50 text-red-700',
    flat: 'bg-slate-100 text-slate-600',
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{text}</span>;
}

/**
 * The one line that says whether this customer is actually being served.
 *
 * Ordered by what to worry about: paying but not connected is the worst case,
 * because they are being charged for nothing.
 */
function health(c: Customer): { text: string; tone: 'good' | 'warn' | 'bad' | 'flat' } {
  const paying = c.pro_granted || ACTIVE.includes(c.subscription_status);
  const inGrace = Boolean(c.grace_until && new Date(c.grace_until) > new Date());

  if (paying && c.session_status !== 'connected') return { text: 'paying, not connected', tone: 'bad' };
  if (paying && c.armed === false) return { text: 'paying, not armed', tone: 'bad' };
  if (inGrace) return { text: 'payment failing', tone: 'warn' };
  if (c.session_status === 'logged_out') return { text: 'logged out of WhatsApp', tone: 'warn' };
  if (c.failed_count > 0) return { text: `${c.failed_count} failed saves`, tone: 'warn' };
  if (paying && c.armed) return { text: 'saving', tone: 'good' };
  if (c.session_status === 'connected') return { text: 'previewing', tone: 'flat' };
  return { text: 'not connected', tone: 'flat' };
}

export function Admin() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState('');

  const setPro = async (c: Customer, pro: boolean) => {
    if (!pro && !window.confirm(`Take Pro away from ${c.email ?? c.user_id}? They drop to the free preview.`)) return;
    setChanging(c.user_id);
    try {
      await api('/api/admin/pro', { userId: c.user_id, pro });
      setData((d) =>
        d && { ...d, customers: d.customers.map((x) => (x.user_id === c.user_id ? { ...x, pro_granted: pro } : x)) },
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging('');
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<Overview>('/api/admin/overview'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <p className="text-slate-500">Loading…</p>;
  if (error && !data) return <Notice kind="error">{error}</Notice>;
  if (!data) return null;

  const { totals } = data;
  // Worst first: this page is read when something is wrong.
  const sorted = [...data.customers].sort((a, b) => {
    const rank = { bad: 0, warn: 1, flat: 2, good: 3 } as const;
    return rank[health(a).tone] - rank[health(b).tone];
  });

  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <Card title="Everyone" action={<Button variant="secondary" onClick={() => void load()}>Refresh</Button>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Customers', totals.customers],
            ['Subscribed', totals.subscribed],
            ['Connected', totals.connected],
            ['Saving', totals.armed],
            ['Contacts saved', totals.saved],
            ['Open sockets', data.sockets],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-lg bg-slate-50 p-3">
              <div className="text-2xl font-semibold tracking-tight">{value}</div>
              <div className="text-xs text-slate-500">{label}</div>
            </div>
          ))}
        </div>
        {totals.failed > 0 && (
          <p className="mt-3 text-sm text-amber-700">{totals.failed} saves have failed across all customers.</p>
        )}
        {/* The ceiling worth knowing before hitting it: every socket is held by
            this one worker process. */}
        <p className="mt-3 text-sm text-slate-500">
          {data.sockets} WhatsApp socket{data.sockets === 1 ? '' : 's'} open on this worker.
        </p>
      </Card>

      <Card title="Customers">
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="px-4 py-2 sm:px-2">Customer</th>
                <th className="px-4 py-2 sm:px-2">State</th>
                <th className="px-4 py-2 sm:px-2">Subscription</th>
                <th className="px-4 py-2 sm:px-2">WhatsApp</th>
                <th className="px-4 py-2 text-right sm:px-2">Saved</th>
                <th className="px-4 py-2 sm:px-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const h = health(c);
                return (
                  <tr key={c.user_id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 sm:px-2">
                      <div className="truncate">{c.email ?? c.user_id}</div>
                      <div className="text-xs text-slate-400">joined {when(c.created_at)}</div>
                    </td>
                    <td className="px-4 py-2 sm:px-2">
                      <Pill text={h.text} tone={h.tone} />
                    </td>
                    <td className="px-4 py-2 text-xs sm:px-2">
                      <div className="flex items-center gap-2">
                        {c.pro_granted ? <Pill text="Pro (granted)" tone="good" /> : c.subscription_status}
                        <button
                          type="button"
                          disabled={changing === c.user_id}
                          onClick={() => void setPro(c, !c.pro_granted)}
                          className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {c.pro_granted ? 'Remove Pro' : 'Give Pro'}
                        </button>
                      </div>
                      {c.grace_until && new Date(c.grace_until) > new Date() && (
                        <div className="text-amber-700">grace until {when(c.grace_until)}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs sm:px-2">
                      {c.session_status ?? '—'}
                      <div className="text-slate-400">{maskPhone(c.session_phone)}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums sm:px-2">
                      {c.saved_count}
                      {c.pending_count > 0 && (
                        <span className="text-slate-400"> +{c.pending_count} held</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500 sm:px-2">{when(c.last_connected_at)}</td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-slate-500 sm:px-2">
                    Nobody has signed up yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
