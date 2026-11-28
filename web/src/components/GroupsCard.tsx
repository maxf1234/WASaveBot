import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Button, Card, Notice } from './ui';

/**
 * Everyone in the customer's WhatsApp groups: scan, see the counts, download.
 *
 * The members live in group_members, readable by the customer under RLS. The
 * scan itself is done by the worker that holds their socket; this card writes
 * the request and watches groups_scanned_at move.
 */

interface Member {
  group_name: string | null;
  name: string | null;
  phone: string | null;
  is_admin: boolean;
}

function csvCell(value: string): string {
  // Leading = + - @ would run as a formula in a spreadsheet; names come from strangers.
  const safe = /^[=+\-@\t\r]/.test(value) && !/^\+\d+$/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function GroupsCard({ userId, connected }: { userId: string; connected: boolean }) {
  const [counts, setCounts] = useState({ members: 0, hidden: 0, groups: 0 });
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [saveGroups, setSaveGroups] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const count = () => supabase.from('group_members').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    const [members, hidden, session, settings, groups] = await Promise.all([
      count(),
      count().is('phone', null),
      supabase.from('wa_sessions').select('groups_scanned_at').eq('user_id', userId).maybeSingle(),
      supabase.from('settings').select('save_groups').eq('user_id', userId).maybeSingle(),
      supabase.from('group_members').select('group_jid').eq('user_id', userId).limit(5000),
    ]);
    setCounts({
      members: members.count ?? 0,
      hidden: hidden.count ?? 0,
      groups: new Set((groups.data ?? []).map((g) => g.group_jid as string)).size,
    });
    setScannedAt((session.data?.groups_scanned_at as string | null) ?? null);
    setSaveGroups(Boolean(settings.data?.save_groups));
    return (session.data?.groups_scanned_at as string | null) ?? null;
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function scan() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const before = scannedAt;
      await api('/api/groups/scan');
      // The worker picks it up within seconds; a large account takes longer.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const after = await load();
        if (after && after !== before) {
          setNotice('Groups scanned.');
          break;
        }
        if (i === 39) setNotice('Still scanning. Check back in a minute.');
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function download() {
    setError('');
    const all: Member[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error: err } = await supabase
        .from('group_members')
        .select('group_name, name, phone, is_admin')
        .eq('user_id', userId)
        .order('group_name')
        .order('id')
        .range(from, from + 999);
      if (err) {
        setError('Could not load the group members. Try again.');
        return;
      }
      all.push(...((data as Member[] | null) ?? []));
      if ((data?.length ?? 0) < 1000) break;
    }
    const lines = [
      'group,name,phone,group_admin',
      ...all.map((m) =>
        [m.group_name ?? '', m.name ?? '', m.phone ? `+${m.phone}` : 'hidden by WhatsApp', m.is_admin ? 'yes' : 'no']
          .map(csvCell)
          .join(','),
      ),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'group-members.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card title="Groups">
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      <p className="mb-3 text-sm text-slate-600">
        {scannedAt
          ? `${counts.members} members found in ${counts.groups} groups${
              counts.hidden ? `, ${counts.hidden} with numbers WhatsApp keeps hidden` : ''
            }. Last scanned ${new Date(scannedAt).toLocaleString()}.`
          : 'Find everyone in your WhatsApp groups, with their names and numbers. Nobody in the group is told.'}
      </p>
      <p className="mb-4 text-sm text-slate-600">
        {saveGroups ? (
          <>Group members are being saved as contacts, up to your daily cap each day. </>
        ) : (
          <>Group members are listed, not saved. </>
        )}
        <Link to="/settings" className="font-medium text-accent-dark underline">
          {saveGroups ? 'Change' : 'Save them as contacts'}
        </Link>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !connected} onClick={() => void scan()}>
          {busy ? 'Scanning…' : scannedAt ? 'Scan again' : 'Scan my groups'}
        </Button>
        <Button variant="secondary" disabled={counts.members === 0} onClick={() => void download()}>
          Download group members
        </Button>
      </div>
      {!connected && <p className="mt-2 text-xs text-slate-500">Connect WhatsApp to scan.</p>}
    </Card>
  );
}
