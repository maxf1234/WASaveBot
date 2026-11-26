import { Link, NavLink, Outlet } from 'react-router-dom';
import { APP_NAME } from '../brand';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

export function Footer() {
  return (
    <footer className="mx-auto flex max-w-3xl flex-wrap gap-x-4 gap-y-1 px-4 py-8 text-sm text-slate-500">
      <span>{APP_NAME} is not affiliated with WhatsApp.</span>
      <Link className="underline" to="/terms">
        Terms
      </Link>
      <Link className="underline" to="/privacy">
        Privacy
      </Link>
    </footer>
  );
}

export function Layout() {
  const { user } = useAuth();
  const tab = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-accent/10 text-accent-dark' : 'text-slate-600 hover:bg-slate-100'}`;
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/" className="text-lg font-semibold text-accent-dark">
            {APP_NAME}
          </Link>
          {user && (
            <nav className="flex flex-wrap items-center gap-1">
              <NavLink to="/dashboard" className={tab}>
                Dashboard
              </NavLink>
              <NavLink to="/activity" className={tab}>
                Activity
              </NavLink>
              <NavLink to="/rules" className={tab}>
                Rules
              </NavLink>
              <NavLink to="/settings" className={tab}>
                Settings
              </NavLink>
              <NavLink to="/billing" className={tab}>
                Billing
              </NavLink>
              <button
                type="button"
                onClick={() => void supabase.auth.signOut()}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Sign out
              </button>
            </nav>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
