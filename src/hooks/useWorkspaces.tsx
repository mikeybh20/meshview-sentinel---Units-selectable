/**
 * v2.0 Beta 5 Workspaces — frontend workspace state.
 *
 * Provides the list of workspaces the current user is a member of plus
 * the currently-active workspace id, and a `switchWorkspace(id)` action
 * that:
 *   1. PUTs the new id to /api/auth/prefs/mesh.currentWorkspaceId
 *      synchronously (NOT debounced via useUserPref) so the next
 *      snapshot fetch hits the server with the new context.
 *   2. Updates local state immediately so the UI flips instantly.
 *   3. Forces meshDataService to re-poll so the dashboard re-renders
 *      with the new workspace's radios + messages + nodes.
 *
 * Mounted INSIDE the AuthGate so it only runs once auth is settled —
 * means we never hit /api/workspaces with no session.
 */
import React from 'react';
import { useAuth } from './useAuth';
import { meshDataService } from '../services/meshDataService';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface Workspace {
  id: number;
  name: string;
  slug: string;
  ownerUserId: number | null;
  createdAt: number;
  memberCount: number;
  radioCount: number;
  isMember?: boolean;
}

interface WorkspaceState {
  workspaces: Workspace[];
  currentWorkspaceId: number | null;
  loading: boolean;
  /** Re-fetch the workspace list. Use after creating / deleting one. */
  refresh: () => Promise<void>;
  /** Switch the active workspace. Persists to user_prefs + forces a
   *  fresh data poll so the UI flips immediately. */
  switchWorkspace: (id: number) => Promise<void>;
}

const WorkspaceContext = React.createContext<WorkspaceState | null>(null);

export function WorkspacesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!user) {
      setWorkspaces([]);
      setCurrentWorkspaceId(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/workspaces`, { credentials: 'include' });
      if (!res.ok) {
        setWorkspaces([]);
        setCurrentWorkspaceId(null);
        return;
      }
      const body = await res.json();
      setWorkspaces(Array.isArray(body.workspaces) ? body.workspaces : []);
      setCurrentWorkspaceId(typeof body.currentWorkspaceId === 'number' ? body.currentWorkspaceId : null);
    } catch {
      setWorkspaces([]);
      setCurrentWorkspaceId(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const switchWorkspace = React.useCallback(async (id: number) => {
    // Push to user_prefs FIRST so the next API request sees the new
    // workspace context. Wait for the round-trip so the data refresh
    // below doesn't race against the prefs write.
    try {
      await fetch(`${API_BASE}/api/auth/prefs/mesh.currentWorkspaceId`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ value: id }),
      });
    } catch {
      // If the PUT fails, we still update local state — next request
      // will resolve via the user_prefs fallback chain. The actual
      // pref write may have succeeded; the network error could be
      // a transient hiccup.
    }
    setCurrentWorkspaceId(id);
    // Force the dashboard's main data poll to re-fetch with the new
    // workspace context so radios / messages / nodes update without
    // waiting for the next scheduled poll.
    try { meshDataService.forceRefresh(); } catch { /* method may not exist on simulator */ }
  }, []);

  const value: WorkspaceState = {
    workspaces,
    currentWorkspaceId,
    loading,
    refresh,
    switchWorkspace,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaces(): WorkspaceState {
  const ctx = React.useContext(WorkspaceContext);
  if (!ctx) {
    // Allow components outside the provider to render — they just see
    // empty state. Useful for components that may render in test /
    // simulator contexts before WorkspacesProvider mounts.
    return {
      workspaces: [],
      currentWorkspaceId: null,
      loading: false,
      refresh: async () => {},
      switchWorkspace: async () => {},
    };
  }
  return ctx;
}
