import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Card, Field, inputClass, Notice, Switch } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isSubscribed, supabase } from '../lib/supabase';
import type { Profile, Settings as SettingsRow } from '../lib/supabase';

const SAMPLE_NAME = 'Dana Levi';
const SAMPLE_PHONE = '15551234821';

export function Settings() {
  const { user } = useAuth();
  const userId = user!.id;
  const [form, setForm] = useState<SettingsRow | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void (async () => {
      const [settings, profileRow] = await Promise.all([
        supabase.from('settings').select('*').eq('user_id', userId).maybeSingle(),
        supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      ]);
      setForm(settings.data as SettingsRow | null);
      setProfile(profileRow.data as Profile | null);
    })();
  }, [userId]);

  if (!form) return <p className="text-slate-500">Loading…</p>;

  const set = <K extends keyof SettingsRow>(key: K, value: SettingsRow[K]) => {
    setForm({ ...form, [key]: value });
    setMessage(null);
  };

  const templateOk = form.name_template.includes('{name}');
  const prefix = form.fallback_prefix.trim();
  const capOk = Number.isInteger(form.daily_cap) && form.daily_cap >= 1 && form.daily_cap <= 1000;
  const savePhrase = form.save_phrase.trim();
  const removePhrase = form.remove_phrase.trim();
  const phrasesOk =
    savePhrase.length >= 3 && savePhrase.length <= 64 &&
    removePhrase.length >= 3 && removePhrase.length <= 64 &&
    savePhrase.toLowerCase() !== removePhrase.toLowerCase();
  const valid = templateOk && prefix.length > 0 && capOk && phrasesOk;
  // The real gate is in the worker, which refuses to write for an unsubscribed
  // account however `armed` is set. This only keeps the screen honest.
  const subscribed = isSubscribed(profile);

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
        save_groups: form.save_groups,
        daily_cap: form.daily_cap,
        save_mode: form.save_mode,
        save_phrase: savePhrase,
        remove_phrase: removePhrase,
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

  async function setArmed(next: boolean) {
    if (
      next &&
      !window.confirm(
        'Start saving contacts for real?\n\n' +
          'From now on people who message you are written into your WhatsApp contacts, ' +
          "and to your phone's address book if that is on above.\n\n" +
          'You can switch this off at any time. Contacts already saved stay saved.',
      )
    ) {
      return;
    }
    setForm({ ...form!, armed: next });
    const { error } = await supabase.from('settings').update({ armed: next }).eq('user_id', userId);
    if (error) {
      setForm({ ...form!, armed: !next });
      setMessage({ kind: 'error', text: 'Could not change that. Try again.' });
    }
  }

  return (
    <>
      <Card title="Saving">
        <div className="space-y-5">
          {!subscribed ? (
            <Notice>
              <strong>Free preview.</strong> Everyone who messages you is listed on the Activity page
              with what would have happened, and nothing is written to your contacts. Subscribe to
              start saving them for real.
            </Notice>
          ) : (
            !form.armed && (
              <Notice>
                <strong>Watch-only.</strong> Everyone who messages you is recorded on the Activity
                page and nothing is written to your contacts. Turn this on once the list looks right.
              </Notice>
            )
          )}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Save contacts for real</div>
              <div className="text-sm text-slate-500">
                {subscribed
                  ? 'Off records what would have happened without touching your address book.'
                  : 'Needs a subscription. Until then every message is recorded and nothing is saved.'}
              </div>
            </div>
            <Switch
              label="Save contacts for real"
              large
              checked={form.armed && subscribed}
              disabled={!subscribed}
              onChange={(n) => void setArmed(n)}
            />
          </div>
        </div>
      </Card>

      <Card title="Who gets saved">
        <form onSubmit={save} className="space-y-5">
          <Field
            label="Save"
            hint={
              form.save_mode === 'everyone'
                ? 'Every new person who messages you privately.'
                : 'Only people who start their message with your phrase. Everyone else is left alone.'
            }
          >
            <select
              className={inputClass}
              value={form.save_mode}
              onChange={(e) => set('save_mode', e.target.value as SettingsRow['save_mode'])}
            >
              <option value="everyone">Everyone who messages me</option>
              <option value="phrase">Only people who ask</option>
            </select>
          </Field>

          {form.save_mode === 'phrase' && (
            <Field
              label="Phrase to be saved"
              hint="It has to start their message, so “don’t save my number” does not count as asking."
            >
              <input
                className={inputClass}
                maxLength={64}
                value={form.save_phrase}
                onChange={(e) => set('save_phrase', e.target.value)}
              />
            </Field>
          )}

          <Field
            label="Phrase to be removed"
            hint="Works whatever the mode: anyone you have saved can send this and the contact is deleted."
          >
            <input
              className={inputClass}
              maxLength={64}
              value={form.remove_phrase}
              onChange={(e) => set('remove_phrase', e.target.value)}
            />
          </Field>

          {!phrasesOk && (
            <Notice kind="error">
              Each phrase needs 3 to 64 characters, and the two must be different.
            </Notice>
          )}

          {message && <Notice kind={message.kind}>{message.text}</Notice>}
          <Button type="submit" disabled={saving || !valid}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </form>
      </Card>

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

          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Also save everyone in my groups</div>
              <div className="text-sm text-slate-500">
                Saves the members of every WhatsApp group you are in, up to your daily cap each day, so a big group fills
                in over a few days. Your rules and opt-outs still apply. Members whose number WhatsApp hides are listed
                but cannot be saved.
              </div>
            </div>
            <Switch
              label="Also save everyone in my groups"
              checked={form.save_groups ?? false}
              onChange={(next) => set('save_groups', next)}
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
