/**
 * v2.0 Beta 5 — frontend auth state.
 *
 * Single source of truth for "who is logged in." Wraps the React tree so
 * every component reads the same auth state without re-fetching.
 *
 * Flow on first paint:
 *   1. Call /api/auth/me to ask "do I have a session?"
 *   2. If 401, fall back to /api/auth/bootstrap to ask "does any user
 *      exist yet?" If not → render <BootstrapScreen>. If yes →
 *      render <LoginScreen>.
 *   3. If 200, stash the user and render the main App.
 *
 * Login / logout flip the same internal state so views re-render in
 * the right mode without a full reload.
 *
 * Note on session expiry: sliding-expiry on the server keeps the cookie
 * fresh, but if a request comes back 401 mid-session (admin locked the
 * account, server pruned the session, etc.), components should treat
 * that as "logged out" and the layout should remount the login screen.
 * Right now we just let the request fail; a future polish item could
 * intercept fetch responses to auto-flip back to <LoginScreen>.
 */
import React from 'react';

export type UserRole = 'admin' | 'viewer';

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
}

interface AuthState {
  /** null = anonymous (login screen needed). undefined = still loading. */
  user: AuthUser | null | undefined;
  /** true when the server reports zero users — show bootstrap UI. */
  needsBootstrap: boolean;
  /** Trigger a fresh /api/auth/me round-trip. Useful after login or when a
   *  401 fires from somewhere else and we need to re-sync. */
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  /** Create the first admin (only valid when needsBootstrap is true). */
  bootstrap: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
}

const AuthContext = React.createContext<AuthState | null>(null);

const API_BASE = import.meta.env.VITE_API_URL || '';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AuthUser | null | undefined>(undefined);
  const [needsBootstrap, setNeedsBootstrap] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const meRes = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' });
      if (meRes.ok) {
        const body = await meRes.json();
        setUser(body.user);
        setNeedsBootstrap(false);
        return;
      }
      // 401 → no session. Check if we need bootstrap.
      const bsRes = await fetch(`${API_BASE}/api/auth/bootstrap`, { credentials: 'include' });
      if (bsRes.ok) {
        const body = await bsRes.json();
        setNeedsBootstrap(!!body.needsBootstrap);
      } else {
        setNeedsBootstrap(false);
      }
      setUser(null);
    } catch {
      // Network failure — treat as logged out so we can at least render
      // the login screen with a retry button.
      setUser(null);
      setNeedsBootstrap(false);
    }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  const login = React.useCallback(async (username: string, password: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      setUser(body.user);
      setNeedsBootstrap(false);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch { /* network failure on logout is harmless */ }
    setUser(null);
    // Re-check bootstrap state in case we're the last user being deleted
    // and someone needs to re-bootstrap.
    refresh();
  }, [refresh]);

  const bootstrap = React.useCallback(async (username: string, password: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      setUser(body.user);
      setNeedsBootstrap(false);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Network error' };
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, needsBootstrap, refresh, login, logout, bootstrap }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() called outside <AuthProvider>');
  return ctx;
}

/** Quick role check helper for gating UI elements. Returns false for
 *  loading / anonymous users so admin-only controls don't flash visible
 *  during the initial /api/auth/me round-trip. */
export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return !!user && user.role === 'admin';
}
