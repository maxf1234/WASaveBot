import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Card, Field, inputClass, Notice, Switch } from '../components/ui';
import { useAuth } from '../lib/auth';
import { normalizePrefix, supabase } from '../lib/supabase';
import type { DialPrefix, Rule, Settings as SettingsRow } from '../lib/supabase';

/**
 * Who may end up in your contacts.
 *
 * A rule is leading digits of the full international number. One shape covers
 * both a country code and an area code, because a US number is 1 + area code +
 * 7 digits — so an area code is just a longer country prefix. Longest match
 * wins, which is what makes "refuse all of +234, except this one Lagos number"
 * work with no second concept.
 *
 * Rules are written straight to Supabase under RLS, the same way settings are.
 * They touch neither WhatsApp nor Stripe, so there is nothing for the worker to
 * do with them beyond noticing the change, which its policy cache does within
 * a few seconds.
 */
export function Rules() {
  const { user } = useAuth();
  const userId = user!.id;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [policy, setPolicy] = useState<SettingsRow['default_policy']>('allow');
  const [input, setInput] = useState('');
  const [areaCode, setAreaCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picker, setPicker] = useState<DialPrefix[] | null>(null);
  const [search, setSearch] = useState('');
  const [pickerKind, setPickerKind] = useState<'country' | 'nanp_area'>('country');

  const load = useCallback(async () => {
    const [{ data: ruleRows }, { data: settings }] = await Promise.all([
      supabase.from('rules').select('*').eq('user_id', userId).order('prefix'),
      supabase.from('settings').select('default_policy').eq('user_id', userId).maybeSingle(),
    ]);
    setRules((ruleRows ?? []) as Rule[]);
    setPolicy(((settings as { default_policy?: SettingsRow['default_policy'] } | null)?.default_policy) ?? 'allow');
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The picker's list, re-queried as the search is typed.
  useEffect(() => {
    if (picker === null) return;
    const timer = setTimeout(() => {
      void (async () => {
        let q = supabase.from('dial_prefixes').select('*').eq('kind', pickerKind);
        if (search.trim()) q = q.ilike('name', `%${search.trim()}%`);
        const { data } = await q.order('name').limit(300);
        setPicker((data ?? []) as DialPrefix[]);
      })();
    }, 200);
    return () => clearTimeout(timer);
    // `picker` is intentionally not a dependency: including it would re-run
    // this effect on its own result and loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, pickerKind, picker === null]);

  if (!rules) return <p className="text-slate-500">Loading…</p>;

  async function add(prefix: string, label: string | null) {
    setBusy(true);
    setError('');
    const { error: insertError } = await supabase
      .from('rules')
      .insert({ user_id: userId, prefix, kind: 'block', label });
    setBusy(false);
    // 23505 is the unique index: one verdict per prefix.
    if (insertError) {
      setError(
        insertError.code === '23505'
          ? `You already have a rule for +${prefix}.`
          : 'Could not add that rule. Try again.',
      );
      return;
    }
    setInput('');
    await load();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const prefix = normalizePrefix(input, areaCode);
    if (!prefix) {
      setError('Enter a country code like +234, or an area code like 917.');
      return;
    }
    const { data } = await supabase.from('dial_prefixes').select('name').eq('prefix', prefix).maybeSingle();
    await add(prefix, ((data as { name?: string } | null)?.name) ?? null);
  }

  async function toggle(rule: Rule) {
    await supabase.from('rules').update({ enabled: !rule.enabled }).eq('id', rule.id);
    await load();
  }

  async function flip(rule: Rule) {
    await supabase
      .from('rules')
      .update({ kind: rule.kind === 'block' ? 'allow' : 'block' })
      .eq('id', rule.id);
    await load();
  }

  async function remove(rule: Rule) {
    await supabase.from('rules').delete().eq('id', rule.id);
    await load();
  }

  async function setDefaultPolicy(next: SettingsRow['default_policy']) {
    setPolicy(next);
    await supabase.from('settings').update({ default_policy: next }).eq('user_id', userId);
  }

  const allowlist = policy === 'block';

  return (
    <div className="space-y-4">
      <Card title="Who can be saved">
        <div className="space-y-4">
          <Field
            label="Numbers no rule covers"
            hint={
              allowlist
                ? 'Only the prefixes you allow below are saved. Everyone else is refused.'
                : 'Anyone is saved except the prefixes you refuse below.'
            }
          >
            <select
              className={inputClass}
              value={policy}
              onChange={(e) => void setDefaultPolicy(e.target.value as SettingsRow['default_policy'])}
            >
              <option value="allow">Save them</option>
              <option value="block">Refuse them</option>
            </select>
          </Field>

          {allowlist && rules.filter((r) => r.kind === 'allow' && r.enabled).length === 0 && (
            <Notice kind="error">
              Nothing is allowed, so nobody will be saved. Add at least one &ldquo;allow&rdquo; rule.
            </Notice>
          )}

          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[12rem]">
              <Field label="Add a prefix">
                <input
                  className={inputClass}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={areaCode ? '917' : '+234'}
                  inputMode="tel"
                />
              </Field>
            </div>
            <Button type="submit" disabled={busy}>
              Add
            </Button>
            <Button type="button" variant="secondary" onClick={() => setPicker([])}>
              Pick from a list
            </Button>
          </form>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={areaCode} onChange={(e) => setAreaCode(e.target.checked)} />
            This is a US or Canadian area code, not a country code
          </label>

          {error && <Notice kind="error">{error}</Notice>}
        </div>
      </Card>

      <Card title={`Your rules (${rules.length})`}>
        {rules.length === 0 ? (
          <p className="text-sm text-slate-500">
            No rules. {allowlist ? 'Nobody is being saved.' : 'Everyone who messages you can be saved.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-3 py-3">
                <code className="font-mono text-sm font-semibold">+{rule.prefix}</code>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${
                    rule.kind === 'block' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
                  }`}
                >
                  {rule.kind === 'block' ? 'refuse' : 'allow'}
                </span>
                <span className="flex-1 truncate text-sm text-slate-600">{rule.label ?? ''}</span>
                {!rule.enabled && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">off</span>
                )}
                <Switch
                  checked={rule.enabled}
                  onChange={() => void toggle(rule)}
                  label={`Turn the rule for +${rule.prefix} ${rule.enabled ? 'off' : 'on'}`}
                />
                <Button variant="secondary" className="!min-h-9 !px-3" onClick={() => void flip(rule)}>
                  {rule.kind === 'block' ? 'Allow instead' : 'Refuse instead'}
                </Button>
                <Button variant="secondary" className="!min-h-9 !px-3" onClick={() => void remove(rule)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-sm text-slate-500">
          The longest matching prefix wins. Refuse <code className="font-mono">+234</code> and allow{' '}
          <code className="font-mono">+234803</code>, and only that narrower range gets through.
        </p>
      </Card>

      {picker !== null && (
        <Card
          title="Pick prefixes"
          action={
            <Button variant="secondary" onClick={() => setPicker(null)}>
              Close
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                variant={pickerKind === 'country' ? 'primary' : 'secondary'}
                onClick={() => setPickerKind('country')}
              >
                Countries
              </Button>
              <Button
                variant={pickerKind === 'nanp_area' ? 'primary' : 'secondary'}
                onClick={() => setPickerKind('nanp_area')}
              >
                US &amp; Canada area codes
              </Button>
            </div>
            <input
              className={inputClass}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
            />
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
              {picker.map((entry) => {
                const already = rules.some((r) => r.prefix === entry.prefix);
                return (
                  <li key={entry.prefix} className="flex items-center gap-3 py-2">
                    <span className="flex-1 truncate text-sm">{entry.name}</span>
                    <code className="font-mono text-sm">+{entry.prefix}</code>
                    <Button
                      variant="secondary"
                      className="!min-h-9 !px-3"
                      disabled={already || busy}
                      onClick={() => void add(entry.prefix, entry.name)}
                    >
                      {already ? 'Added' : 'Refuse'}
                    </Button>
                  </li>
                );
              })}
              {picker.length === 0 && <li className="py-3 text-sm text-slate-500">Nothing matches.</li>}
            </ul>
          </div>
        </Card>
      )}
    </div>
  );
}
