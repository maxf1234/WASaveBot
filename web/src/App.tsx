import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AuthProvider, useAuth } from './lib/auth';
import { configured } from './lib/supabase';
import { Activity } from './pages/Activity';
import { Admin } from './pages/Admin';
import { Billing } from './pages/Billing';
import { Dashboard } from './pages/Dashboard';
import { Privacy, Terms } from './pages/Legal';
import { Login } from './pages/Login';
import { Rules } from './pages/Rules';
import { Settings } from './pages/Settings';

function RequireUser() {
  const { user, loading } = useAuth();
  if (loading) return <p className="text-slate-500">Loading…</p>;
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

function LoginRoute() {
  const { user, loading } = useAuth();
  if (loading) return <p className="text-slate-500">Loading…</p>;
  return user ? <Navigate to="/dashboard" replace /> : <Login />;
}

export function App() {
  if (!configured) {
    return (
      <p className="mx-auto max-w-md p-6 text-slate-700">
        This site is not set up yet: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and VITE_API_URL must be set.
      </p>
    );
  }
  return (
    <AuthProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route element={<RequireUser />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/billing" element={<Billing />} />
            {/* The worker refuses this to anyone not in ADMIN_EMAILS, so the
                route being reachable is not the gate; the server is. */}
            <Route path="/admin" element={<Admin />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
