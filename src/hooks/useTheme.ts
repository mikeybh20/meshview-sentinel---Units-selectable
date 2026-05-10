import { useEffect, useState } from 'react';

export type ThemePreference = 'auto' | 'light' | 'dark';
export type AppliedTheme = 'light' | 'dark';

const STORAGE_KEY = 'mesh.themePreference';

function readStoredPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch { /* ignore (SSR / disabled storage) */ }
  return 'dark'; // default for existing users — current behavior
}

function osPrefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

function resolveApplied(pref: ThemePreference): AppliedTheme {
  if (pref === 'auto') return osPrefersLight() ? 'light' : 'dark';
  return pref;
}

function applyTheme(applied: AppliedTheme) {
  const root = document.documentElement;
  if (applied === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    root.removeAttribute('data-theme');
  }
}

/**
 * Theme controller. Reads preference from localStorage, applies it to
 * `<html data-theme="…">`, and (in `auto` mode) keeps it in sync with the OS
 * `prefers-color-scheme` media query.
 *
 * Returns `{ preference, applied, setPreference }`:
 *   - preference: the user's chosen mode ('auto' | 'light' | 'dark')
 *   - applied:    the actual rendered theme ('light' | 'dark') after resolving auto
 *   - setPreference(p): persist + apply a new preference
 */
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [applied, setApplied] = useState<AppliedTheme>(() => resolveApplied(readStoredPreference()));

  // Apply on mount + whenever preference changes.
  useEffect(() => {
    const next = resolveApplied(preference);
    setApplied(next);
    applyTheme(next);
  }, [preference]);

  // While in auto mode, follow the OS preference live.
  useEffect(() => {
    if (preference !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      const next = mq.matches ? 'light' : 'dark';
      setApplied(next);
      applyTheme(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = (p: ThemePreference) => {
    setPreferenceState(p);
    try { localStorage.setItem(STORAGE_KEY, p); } catch { /* ignore */ }
  };

  return { preference, applied, setPreference };
}
