import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PRICE_LABEL } from '../brand';
import { Button, Card, Notice } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isSubscribed } from '../lib/supabase';
import { billingEnabled } from '../lib/config';

const LABELS: Record<string, string> = {
  none: 'No subscription',
  active: 'Active',
  trialing: 'Free trial',
  past_due: 'Payment failed',
  unpaid: 'Payment failed',
  canceled: 'Cancelled',
  incomplete: 'Payment not completed',
  incomplete_expired: 'Payment not completed',
  paused: 'Paused',
};

export function Billing() {
  const { profile, refreshProfile } = useAuth();
  const [params] = useSearchParams();
  const checkout = params.get('checkout');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const status = profile?.subscription_status ?? 'none';
  const subscribed = isSubscribed(profile);
  // Anyone who has been through Checkout has something to manage in the portal.
  const hasBilling = status !== 'none';

  // Stripe tells the server a moment after sending the customer back here.
  useEffect(() => {
    if (checkout !== 'success' || subscribed) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      void refreshProfile();
      if (tries >= 15) clearInterval(timer);
    }, 2000);
    return () => clearInterval(timer);
  }, [checkout, subscribed, refreshProfile]);

  async function go(path: string) {
    setBusy(true);
    setError('');
    try {
      const { url } = await api<{ url: string }>(path);
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const renews = profile?.current_period_end
    ? new Date(profile.current_period_end).toLocaleDateString(undefined, { dateStyle: 'long' })
    : null;

  return (
    <>
      {checkout === 'success' && (
        <Notice kind="success">
          {subscribed ? 'You are subscribed. Go to the dashboard to connect WhatsApp.' : 'Payment received. Activating your subscription…'}
        </Notice>
      )}
      {checkout === 'cancelled' && <Notice>Checkout was cancelled. You have not been charged.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <Card title="Your plan">
        {!billingEnabled ? (
          <p className="text-sm text-slate-600">
            Billing isn't set up yet. You can connect WhatsApp and use the free preview, which shows who would be
            saved without saving anyone.
          </p>
        ) : !profile ? (
          <p className="text-slate-500">Loading…</p>
        ) : (
          <>
            <dl className="mb-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-slate-500">Plan</dt>
              <dd className="font-medium">{PRICE_LABEL}</dd>
              <dt className="text-slate-500">Status</dt>
              <dd className="font-medium">{LABELS[status] ?? status}</dd>
              {renews && subscribed && (
                <>
                  <dt className="text-slate-500">{status === 'trialing' ? 'Trial ends' : 'Renews'}</dt>
                  <dd className="font-medium">{renews}</dd>
                </>
              )}
            </dl>
            {(status === 'past_due' || status === 'unpaid') && (
              <p className="mb-4 text-sm text-slate-600">
                Your last payment did not go through, so saving is paused. Update your card in billing to resume.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {!subscribed && status !== 'past_due' && status !== 'unpaid' && (
                <Button disabled={busy} onClick={() => void go('/api/billing/checkout')}>
                  Subscribe
                </Button>
              )}
              {hasBilling && (
                <Button variant={subscribed ? 'primary' : 'secondary'} disabled={busy} onClick={() => void go('/api/billing/portal')}>
                  Manage billing
                </Button>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
