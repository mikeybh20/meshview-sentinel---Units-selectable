/**
 * v2.0 Beta 5 Phase 4 — per-user preferences hook.
 *
 * Drop-in replacement for `useState` + `localStorage` patterns. Reads from
 * the server on mount (after auth), writes back on every change with
 * lightweight debouncing (200ms) so rapid edits don't flood the API.
 * Mirrors to localStorage on the way out so the page works without auth
 * (simulator mode, dev preview before login) and provides a fast first
 * paint when the user reloads.
 *
 * Migration: when the server returns 404 ("never set") on first load, we
 * read whatever's in localStorage under the same key and PUT it back to
 * the server. After that the server is authoritative and localStorage
 * is just a same-device cache.
 *
 * Important: the hook accepts the storage `key` once and assumes it
 * doesn't change. Don't compute keys from props that change at runtime.
 */
import React from 'react';
import { useAuth } from './useAuth';

const API_BASE = import.meta.env.VITE_API_URL || '';
const DEBOUNCE_MS = 200;

/**
 * @param key       Stable string key (server-side keyspace; use
 *                  dot-namespacing like "mesh.readStatus").
 * @param initial   Default value when neither the server nor
 *                  localStorage has anything saved.
 *
 * Returns [value, setValue] like useState. setValue accepts either a
 * value or a (prev) => next updater function.
 */
export function useUserPref<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const { user } = useAuth();
  const [value, setValueState] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : JSON.parse(raw) as T;
    } catch { return initial; }
  });
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrittenRef = React.useRef<string>(JSON.stringify(value));
  const hydratedFromServerRef = React.useRef(false);

  // Hydrate from server on auth. If the server has no value but
  // localStorage does, push localStorage UP so subsequent logins on
  // other devices see it (one-time migration per user/key).
  React.useEffect(() => {
    if (!user) {
      // Not logged in — pretend we hydrated so future writes don't try
      // to PUT to the server.
      hydratedFromServerRef.current = true;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/prefs/${encodeURIComponent(key)}`, { credentials: 'include' });
        if (cancelled) return;
        if (res.ok) {
          const body = await res.json();
          // Server-side state wins. Update React + localStorage cache.
          setValueState(body.value as T);
          lastWrittenRef.current = JSON.stringify(body.value);
          try { localStorage.setItem(key, JSON.stringify(body.value)); } catch { /* private mode */ }
        } else if (res.status === 404) {
          // Server has nothing — push local cache up (migration step).
          // Skip if local is also empty / equal to initial; nothing to
          // migrate.
          const local = (() => {
            try { const raw = localStorage.getItem(key); return raw == null ? null : JSON.parse(raw); }
            catch { return null; }
          })();
          if (local !== null) {
            try {
              await fetch(`${API_BASE}/api/auth/prefs/${encodeURIComponent(key)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ value: local }),
              });
              lastWrittenRef.current = JSON.stringify(local);
            } catch { /* network failure — try again on next write */ }
          }
        }
      } catch { /* network failure on hydrate — keep using local */ }
      hydratedFromServerRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [user, key]);

  // Write to server (debounced) whenever value changes post-hydration.
  React.useEffect(() => {
    if (!user) return;
    if (!hydratedFromServerRef.current) return;
    const serialized = JSON.stringify(value);
    if (serialized === lastWrittenRef.current) return;
    // Always mirror to localStorage immediately for fast first paint
    // on next reload.
    try { localStorage.setItem(key, serialized); } catch { /* */ }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      lastWrittenRef.current = serialized;
      fetch(`${API_BASE}/api/auth/prefs/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ value }),
      }).catch(() => { /* network failure — next change tries again */ });
    }, DEBOUNCE_MS);
  }, [user, key, value]);

  const setValue = React.useCallback((next: T | ((prev: T) => T)) => {
    setValueState(prev => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      // Mirror to localStorage in the same tick so the page reflects
      // the change immediately; debounced PUT lands shortly after.
      try { localStorage.setItem(key, JSON.stringify(resolved)); } catch { /* */ }
      return resolved;
    });
  }, [key]);

  return [value, setValue];
}
