/**
 * v2.0 Beta 5 — auth gate.
 *
 * Renders one of three screens based on auth state:
 *   - loading splash while /api/auth/me round-trips
 *   - <BootstrapScreen> when the server reports zero users
 *   - <LoginScreen> when there are users but no session
 *   - children (the main app) when logged in
 */
import React from 'react';
import { Lock, AlertCircle, Activity, UserPlus } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { cn } from '../lib/utils';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, needsBootstrap } = useAuth();

  if (user === undefined) {
    // /api/auth/me hasn't returned yet. Show a quiet splash, not the
    // login form — flashing an empty login on every navigation is jumpy.
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-brand-bg">
        <div className="flex flex-col items-center gap-3 text-brand-muted">
          <Activity size={28} className="animate-pulse text-brand-accent" />
          <p className="text-xs uppercase tracking-widest">Checking session…</p>
        </div>
      </div>
    );
  }

  if (user === null) {
    return needsBootstrap ? <BootstrapScreen /> : <LoginScreen />;
  }

  return <>{children}</>;
}

// =============================================================================
// Login
// =============================================================================

function LoginScreen() {
  const { login } = useAuth();
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const r = await login(username, password);
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Login failed');
  };

  return (
    <AuthShell title="Sign in" subtitle="MeshView Sentinel — local account">
      <form onSubmit={handle} className="space-y-4">
        <Field label="Username">
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm mono-text focus:outline-none focus:border-brand-accent"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm mono-text focus:outline-none focus:border-brand-accent"
          />
        </Field>

        {error && <ErrorBanner text={error} />}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className={cn(
            'w-full flex items-center justify-center gap-2 bg-brand-accent text-black px-4 py-2.5 rounded text-sm font-bold uppercase tracking-widest hover:brightness-110 transition-all',
            (busy || !username || !password) && 'opacity-40 cursor-not-allowed',
          )}
        >
          <Lock size={14} />
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}

// =============================================================================
// Bootstrap (first admin creation)
// =============================================================================

function BootstrapScreen() {
  const { bootstrap } = useAuth();
  const [username, setUsername] = React.useState('admin');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Match the server-side rules so the UI doesn't accept things the API
  // will reject. Keep the messages close to the server's so feedback is
  // consistent if either side fires the error.
  const userErr = username.length === 0
    ? null
    : username.length < 2 || username.length > 32
      ? 'Username must be 2..32 characters'
      : !/^[a-zA-Z0-9._-]+$/.test(username)
        ? 'Letters, digits, dot, underscore, hyphen only'
        : /^[.-]/.test(username)
          ? 'Cannot start with "." or "-"'
          : null;
  const pwErr = password.length === 0
    ? null
    : password.length < 8
      ? 'Password must be at least 8 characters'
      : null;
  const confirmErr = confirm.length === 0
    ? null
    : confirm !== password
      ? 'Passwords do not match'
      : null;
  const canSubmit = !userErr && !pwErr && !confirmErr && username && password && confirm;

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    const r = await bootstrap(username, password);
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Bootstrap failed');
  };

  return (
    <AuthShell
      title="Create the first admin"
      subtitle="No accounts exist yet — set up the operator who owns this install."
      icon={<UserPlus size={20} />}
    >
      <form onSubmit={handle} className="space-y-4">
        <Field label="Username" hint="Default suggestion: 'admin' — change as you like.">
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            className={cn(
              'w-full bg-brand-line/50 border rounded px-3 py-2 text-sm mono-text focus:outline-none',
              userErr ? 'border-brand-error' : 'border-brand-line focus:border-brand-accent',
            )}
          />
          {userErr && <div className="text-[10px] text-brand-error mt-1">{userErr}</div>}
        </Field>

        <Field label="Password" hint="At least 8 characters. Stored as a scrypt hash; recovery means deleting the data volume.">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            className={cn(
              'w-full bg-brand-line/50 border rounded px-3 py-2 text-sm mono-text focus:outline-none',
              pwErr ? 'border-brand-error' : 'border-brand-line focus:border-brand-accent',
            )}
          />
          {pwErr && <div className="text-[10px] text-brand-error mt-1">{pwErr}</div>}
        </Field>

        <Field label="Confirm password">
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
            className={cn(
              'w-full bg-brand-line/50 border rounded px-3 py-2 text-sm mono-text focus:outline-none',
              confirmErr ? 'border-brand-error' : 'border-brand-line focus:border-brand-accent',
            )}
          />
          {confirmErr && <div className="text-[10px] text-brand-error mt-1">{confirmErr}</div>}
        </Field>

        {error && <ErrorBanner text={error} />}

        <button
          type="submit"
          disabled={busy || !canSubmit}
          className={cn(
            'w-full flex items-center justify-center gap-2 bg-brand-accent text-black px-4 py-2.5 rounded text-sm font-bold uppercase tracking-widest hover:brightness-110 transition-all',
            (busy || !canSubmit) && 'opacity-40 cursor-not-allowed',
          )}
        >
          {busy ? 'Creating…' : 'Create admin & sign in'}
        </button>
      </form>
    </AuthShell>
  );
}

// =============================================================================
// Shared chrome
// =============================================================================

function AuthShell({ title, subtitle, icon, children }: {
  title: string;
  subtitle: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-brand-bg p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-brand-accent/10 text-brand-accent mb-3">
            {icon ?? <Lock size={20} />}
          </div>
          <h1 className="text-lg font-bold tracking-tight uppercase">{title}</h1>
          <p className="text-[11px] text-brand-muted mt-1">{subtitle}</p>
        </div>
        <div className="technical-panel p-6">
          {children}
        </div>
        <p className="text-center text-[10px] text-brand-muted/60 mt-4">
          MeshView Sentinel · {import.meta.env.MODE === 'production' ? 'prod' : 'dev'}
        </p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted">
        {label}
      </label>
      {children}
      {hint && <div className="text-[10px] text-brand-muted/80 italic">{hint}</div>}
    </div>
  );
}

function ErrorBanner({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[11px] rounded border border-red-500/40 bg-red-500/10 text-red-300 px-2 py-1.5">
      <AlertCircle size={11} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}
