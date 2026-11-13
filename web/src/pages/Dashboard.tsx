import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, inputClass, Notice, Switch } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isSubscribed, supabase } from '../lib/supabase';
import type { SavedContact, WaSession } from '../lib/supabase';

const STATUS: Record<WaSession['status'], { label: string; style: string }> = {
  connected: { label: 'Connected', style: 'bg-emerald-100 text-emerald-800' },
  pairing: { label: 'Enter the code', style: 'bg-amber-100 text-amber-800' },
  connecting: { label: 'Connecting…', style: 'bg-amber-100 text-amber-800' },
  disconnected: { label: 'Not connected', style: 'bg-slate-100 text-slate-700' },
  logged_out: { label: 'Logged out', style: 'bg-red-100 text-red-800' },
};

const CONTACT_STATUS: Record<SavedContact['status'], { label: string; style: string }> = {
  saved: { label: 'Saved', style: 'bg-emerald-100 text-emerald-800' },
  existing: { label: 'Already a contact', style: 'bg-slate-100 text-slate-700' },
  failed: { label: 'Failed', style: 'bg-red-100 text-red-800' },
  unresolved: { label: 'Number unknown', style: 'bg-amber-100 text-amber-800' },
  pending: { label: 'Not saved yet', style: 'bg-slate-100 text-slate-700' },
};

const COLUMNS = 'id, phone, push_name, saved_name, status, error, created_at';
const displayName = (c: SavedContact) => c.saved_name || c.push_name || '—';
const displayPhone = (c: SavedContact) => (c.status === 'unresolved' ? '—' : `+${c.phone}`);

function Badge({ label, style }: { label: string; style: string }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${style}`}>{label}</span>;
}

/** PostgREST `or` filters are comma/paren-delimited; keep the search term from breaking out. */
const safeTerm = (term: string) => term.replace(/[,()%*\\"]/g, ' ').trim();

function csvCell(value: string): string {
  // Leading = + - @ would run as a formula in a spreadsheet; names come from strangers.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function Dashboard() {
  const { user, profile } = useAuth();
  const userId = user!.id;
  const subscribed = isSubscribed(profile);

  const [session, setSession] = useState<WaSession | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [counts, setCounts] = useState({ today: 0, total: 0, failed: 0, pending: 0 });
  const [notice, setNotice] = useState('');
  const [contacts, setContacts] = useState<SavedContact[]>([]);
  const [search, setSearch] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadSession = useCallback(async () => {
    const { data } = await supabase.from('wa_sessions').select('*').eq('user_id', userId).maybeSingle();
    if (data) setSession(data as WaSession);
  }, [userId]);

  const loadContacts = useCallback(async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const count = () => supabase.from('saved_contacts').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    let list = supabase.from('saved_contacts').select(COLUMNS).eq('user_id', userId);
    const term = safeTerm(search);
    if (term) list = list.or(`saved_name.ilike.%${term}%,push_name.ilike.%${term}%,phone.ilike.%${term.replace(/^\+/, '')}%`);
    const [rows, today, total, failed, pending] = await Promise.all([
      list.order('created_at', { ascending: false }).limit(50),
      count().eq('status', 'saved').gte('created_at', midnight.toISOString()),
      count().eq('status', 'saved'),
      count().eq('status', 'failed'),
      count().eq('status', 'pending'),
    ]);
    setContacts((rows.data as SavedContact[] | null) ?? []);
    setCounts({ today: today.count ?? 0, total: total.count ?? 0, failed: failed.count ?? 0, pending: pending.count ?? 0 });
  }, [userId, search]);

  useEffect(() => {
    void loadSession();
    supabase
      .from('settings')
      .select('enabled')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => setEnabled(data?.enabled ?? true));
  }, [userId, loadSession]);

  useEffect(() => {
    // A short delay so typing in the search box is not a query per keystroke.
    const timer = setTimeout(() => void loadContacts(), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadContacts, search]);

  // Live updates: the pairing code, the connection status and new contacts as they are saved.
  useEffect(() => {
    const channel = supabase
      .channel(`dashboard-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wa_sessions', filter: `user_id=eq.${userId}` }, (payload) => {
        if (payload.new && 'status' in payload.new) setSession(payload.new as WaSession);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'saved_contacts', filter: `user_id=eq.${userId}` }, () => {
        void loadContacts();
      })
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [userId, loadContacts]);

  // Safety net while linking, in case a Realtime message is missed.
  const linking = session?.status === 'pairing' || session?.status === 'connecting';
  useEffect(() => {
    if (!linking) return;
    const timer = setInterval(() => void loadSession(), 4000);
    return () => clearInterval(timer);
  }, [linking, loadSession]);

  async function run(path: string, body?: object) {
    setBusy(true);
    setError('');
    try {
      await api(path, body);
      await loadSession();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function backfill() {
    setBusy(true);
    setError('');
    try {
      const { queued } = await api<{ queued: number }>('/api/contacts/backfill');
      setNotice(
        queued
          ? `Saving ${queued} ${queued === 1 ? 'person' : 'people'}, a few seconds apart. They show as Saved below as each one finishes.`
          : 'Those are already being saved.',
      );
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function retry(contactPhone: string) {
    setError('');
    try {
      await api('/api/contacts/retry', { phone: contactPhone });
      setNotice('Trying that contact again.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggle(next: boolean) {
    setEnabled(next);
    const { error } = await supabase.from('settings').update({ enabled: next }).eq('user_id', userId);
    if (error) {
      setEnabled(!next);
      setError('Could not change the switch. Try again.');
    }
  }

  async function exportCsv() {
    const all: SavedContact[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from('saved_contacts')
        .select(COLUMNS)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, from + 999);
      all.push(...((data as SavedContact[] | null) ?? []));
      if (!data || data.length < 1000) break;
    }
    const lines = [
      'name,phone,status,saved_at',
      ...all
        .filter((c) => c.status !== 'pending')
        .map((c) => [displayName(c), c.status === 'unresolved' ? '' : c.phone, c.status, c.created_at].map(csvCell).join(',')),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'contacts.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  const status = session?.status ?? 'disconnected';
  const live = status === 'connected' || linking;

  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      <Card title="WhatsApp" action={<Badge {...STATUS[status]} />}>
        {status === 'pairing' && session?.pairing_code && (
          <div className="mb-4 flex flex-col items-center gap-3 text-center">
            <div
              className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4 font-mono text-3xl font-semibold tracking-[0.2em] sm:text-4xl"
              aria-label="Pairing code"
            >
              {session.pairing_code.slice(0, 4)}-{session.pairing_code.slice(4)}
            </div>
            <ol className="max-w-sm list-decimal space-y-1 pl-5 text-left text-sm text-slate-600">
              <li>On your phone open WhatsApp → Settings → Linked devices.</li>
              <li>Tap Link a device, then “Link with phone number instead”.</li>
              <li>Type the code above. It stops working after a few minutes.</li>
            </ol>
          </div>
        )}
        {status === 'connected' && (
          <p className="mb-4 text-sm text-slate-600">
            Linked to {session?.phone ? `+${session.phone}` : 'your WhatsApp'}. New people who message you privately are
            saved as contacts.
          </p>
        )}
        {status === 'logged_out' && (
          <p className="mb-4 text-sm text-slate-600">
            This device was removed from your WhatsApp linked devices. Connect again to keep saving contacts.
          </p>
        )}
        {status === 'disconnected' && (
          <p className="mb-4 text-sm text-slate-600">
            {subscribed ? 'Connect your WhatsApp to start saving contacts.' : 'Subscribe first, then connect your WhatsApp.'}
          </p>
        )}
        {!live && subscribed && (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void run('/api/session/start', { phone });
            }}
          >
            <label className="block grow">
              <span className="mb-1 block text-sm font-medium">Your WhatsApp number, with country code</span>
              <input
                className={inputClass}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+1 555 123 4567"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy} className="shrink-0">
              {busy ? 'Getting code…' : 'Connect'}
            </Button>
          </form>
        )}
        <div className="flex flex-wrap gap-2">
          {!live && !subscribed && (
            <>
              <Button disabled>Connect</Button>
              <Link
                to="/billing"
                className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-accent-dark underline"
              >
                Subscribe to connect
              </Link>
            </>
          )}
          {live && (
            <Button variant="secondary" disabled={busy} onClick={() => void run('/api/session/logout')}>
              {status === 'connected' ? 'Disconnect' : 'Cancel'}
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Auto-save new contacts</h2>
            <p className="text-sm text-slate-600">{enabled ? 'On. New senders are being saved.' : 'Off. Nothing is saved.'}</p>
          </div>
          <Switch large label="Auto-save new contacts" checked={enabled ?? true} disabled={enabled === null} onChange={toggle} />
        </div>
      </Card>

      {counts.pending > 0 && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold">
                {counts.pending} {counts.pending === 1 ? 'person' : 'people'} you already chat with {counts.pending === 1 ? "isn't" : "aren't"} saved
              </h2>
              <p className="text-sm text-slate-600">
                Found in your recent chats when you linked WhatsApp. Saving them counts towards your daily cap.
              </p>
            </div>
            <Button className="shrink-0" disabled={busy || status !== 'connected'} onClick={() => void backfill()}>
              Save them
            </Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-3 gap-3">
        {[
          ['Saved today', counts.today],
          ['Saved total', counts.total],
          ['Failed', counts.failed],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
            <div className="text-2xl font-semibold tabular-nums sm:text-3xl">{value}</div>
            <div className="text-xs text-slate-500 sm:text-sm">{label}</div>
          </div>
        ))}
      </div>

      <Card title="Latest contacts">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <input
            className={inputClass}
            type="search"
            placeholder="Search name or number"
            aria-label="Search contacts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant="secondary" className="shrink-0" onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        </div>
        {contacts.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            {search ? 'No contacts match that search.' : 'No contacts yet. They appear here as people message you.'}
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium sm:pl-0">Name</th>
                  <th className="hidden px-2 py-2 font-medium sm:table-cell">Phone</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium sm:pr-0">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td className="max-w-[9rem] px-4 py-2.5 sm:max-w-[14rem] sm:pl-0">
                      <div className="truncate font-medium">{displayName(c)}</div>
                      {/* On a phone the number sits under the name instead of in its own column. */}
                      <div className="truncate text-xs tabular-nums text-slate-500 sm:hidden">{displayPhone(c)}</div>
                    </td>
                    <td className="hidden whitespace-nowrap px-2 py-2.5 tabular-nums text-slate-600 sm:table-cell">
                      {displayPhone(c)}
                    </td>
                    <td className="px-2 py-2.5" title={c.error ?? undefined}>
                      <Badge {...CONTACT_STATUS[c.status]} />
                      {c.status === 'failed' && status === 'connected' && (
                        <button
                          type="button"
                          className="ml-2 inline-flex min-h-9 items-center text-sm font-medium text-accent-dark underline"
                          onClick={() => void retry(c.phone)}
                        >
                          Retry
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-500 sm:pr-0 sm:text-sm">
                      {new Date(c.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      <span className="block sm:inline">
                        <span className="hidden sm:inline">, </span>
                        {new Date(c.created_at).toLocaleTimeString(undefined, { timeStyle: 'short' })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
