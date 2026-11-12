import { useState } from 'react';
import type { FormEvent } from 'react';
import { APP_NAME } from '../brand';
import { Button, Card, Field, inputClass, Notice } from '../components/ui';
import { supabase } from '../lib/supabase';

export function Login() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSent(false);
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      // With email confirmation on, there is no session until the link is clicked.
      else if (!data.session) setSent(true);
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-1 text-2xl font-semibold">{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
      <p className="mb-4 text-slate-600">
        {APP_NAME} saves everyone who messages you on WhatsApp as a contact, automatically.
      </p>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 6 characters.' : undefined}>
            <input
              className={inputClass}
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <Notice kind="error">{error}</Notice>}
          {sent && <Notice kind="success">Check your email for a link to confirm your account, then sign in.</Notice>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
          </Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-slate-600">
        {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
        <button
          type="button"
          className="font-medium text-accent-dark underline"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError('');
            setSent(false);
          }}
        >
          {mode === 'signin' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </div>
  );
}
