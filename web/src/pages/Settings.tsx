import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Card, Field, inputClass, Notice, Switch } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import type { Settings as SettingsRow } from '../lib/supabase';

const SAMPLE_NAME = 'Dana Levi';
const SAMPLE_PHONE = '15551234821';

export function Settings() {
  const { user } = useAuth();
  const userId = user!.id;
  const [form, setForm] = useState<SettingsRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    supabase
      .from('settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => setForm(data as SettingsRow | null));
  }, [userId]);

  if (!form) return <p className="text-slate-500">Loading…</p>;

  const set = <K extends keyof SettingsRow>(key: K, value: SettingsRow[K]) => {
    setForm({ ...form, [key]: value });
    setMessage(null);
  };

  const templateOk = form.name_template.includes('{name}');
  const prefix = form.fallback_prefix.trim();
  const capOk = Number.isInteger(form.daily_cap) && form.daily_cap >= 1 && form.daily_cap <= 1000;
  const valid = templateOk && prefix.length > 0 && capOk;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || !valid) return;
    setSaving(true);
    const { error } = await supabase
      .from('settings')
      .update({
        name_template: form.name_template.trim(),
        fallback_prefix: prefix,
        save_to_phone: form.save_to_phone,
        daily_cap: form.daily_cap,
      })
      .eq('user_id', userId);
    setSaving(false);
    setMessage(
      error
        ? { kind: 'error', text: 'Could not save your settings. Try again.' }
        : { kind: 'success', text: 'Saved. New contacts use these settings within a few seconds.' },
    );
  }

  async function deleteAccount() {
    setDeleting(true);
    try {
      await api('/api/account/delete');
      await supabase.auth.signOut();
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
      setDeleting(false);
    }
  }

  return (
    <>
      <Card title="Contact names">
        <form onSubmit={save} className="space-y-5">
          <Field
            label="Name template"
            hint={
              templateOk ? (
                <>
                  <code>{'{name}'}</code> is the sender's WhatsApp name. Preview:{' '}
                  <strong className="text-slate-800">{form.name_template.replaceAll('{name}', SAMPLE_NAME).trim()}</strong>
                </>
              ) : (
                <span className="text-red-700">
                  The template must contain <code>{'{name}'}</code>.
                </span>
              )
            }
          >
            <input
              className={inputClass}
              maxLength={80}
              value={form.name_template}
              onChange={(e) => set('name_template', e.target.value)}
            />
          </Field>

          <Field
            label="Fallback prefix"
            hint={
              <>
                Used when the sender has no usable name. Preview:{' '}
                <strong className="text-slate-800">
                  {prefix || '…'} {SAMPLE_PHONE.slice(-4)}
                </strong>
              </>
            }
          >
            <input
              className={inputClass}
              maxLength={20}
              value={form.fallback_prefix}
              onChange={(e) => set('fallback_prefix', e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Also save to my phone's address book</div>
              <div className="text-sm text-slate-500">Off keeps new contacts inside WhatsApp only.</div>
            </div>
            <Switch
              label="Also save to my phone's address book"
              checked={form.save_to_phone}
              onChange={(next) => set('save_to_phone', next)}
            />
          </div>

          <Field
            label="Daily cap"
            hint={capOk ? 'The most contacts saved in one day (1 to 1000). The count resets at midnight UTC.' : <span className="text-red-700">Enter a whole number from 1 to 1000.</span>}
          >
            <input
              className={`${inputClass} sm:max-w-40`}
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={Number.isNaN(form.daily_cap) ? '' : form.daily_cap}
              onChange={(e) => set('daily_cap', e.target.value === '' ? NaN : Number(e.target.value))}
            />
          </Field>

          {message && <Notice kind={message.kind}>{message.text}</Notice>}
          <Button type="submit" disabled={saving || !valid}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </form>
      </Card>

      <Card title="Delete account">
        <p className="mb-3 text-sm text-slate-600">
          This unlinks your WhatsApp, cancels your subscription and permanently deletes your account and the list of saved
          contacts kept here. Contacts already saved in WhatsApp and on your phone stay there.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className={`${inputClass} sm:max-w-56`}
            placeholder="Type DELETE to confirm"
            aria-label="Type DELETE to confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <Button variant="danger" disabled={confirm !== 'DELETE' || deleting} onClick={() => void deleteAccount()}>
            {deleting ? 'Deleting…' : 'Delete my account'}
          </Button>
        </div>
      </Card>
    </>
  );
}
