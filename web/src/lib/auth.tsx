import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Profile } from './supabase';

interface AuthState {
  user: User | null;
  loading: boolean;
  profile: Profile | null;
  refreshProfile: () => Promise<Profile | null>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  profile: null,
  refreshProfile: async () => null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const userId = user?.id;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!userId) return null;
    const { data } = await supabase
      .from('profiles')
      .select('id, email, subscription_status, current_period_end, pro_granted')
      .eq('id', userId)
      .maybeSingle();
    setProfile((data as Profile | null) ?? null);
    return (data as Profile | null) ?? null;
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    void refreshProfile();
    // Subscription changes arrive through Stripe, not this tab: pick them up
    // when the user comes back to it.
    const onFocus = () => void refreshProfile();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [userId, refreshProfile]);

  return (
    <AuthContext.Provider value={{ user, loading, profile, refreshProfile }}>{children}</AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
