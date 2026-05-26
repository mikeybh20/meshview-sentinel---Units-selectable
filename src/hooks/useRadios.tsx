/**
 * v2.0 multi-radio — shared client-side state for the configured radio list,
 * the currently-selected filter (radio_id or null = "all"), and the LoRa
 * config readback per radio.
 *
 * The list auto-refreshes on SSE `loraConfig` events (the readback completed
 * for one of the radios) and on `radios` events (a CRUD operation completed
 * somewhere). Components subscribe via the `useRadios()` hook.
 */
import React from 'react';
import { meshDataService } from '../services/meshDataService';
import type { RadioRow } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || '';

interface RadiosState {
  radios: RadioRow[];
  defaultRadioId: string | null;
  /** null = "all radios". Otherwise filters node/message/event views to this radio. */
  selectedRadioId: string | null;
  setSelectedRadioId: (id: string | null) => void;
  reload: () => void;
}

const RadiosContext = React.createContext<RadiosState | null>(null);

export function RadiosProvider({ children }: { children: React.ReactNode }) {
  const [radios, setRadios] = React.useState<RadioRow[]>([]);
  const [defaultRadioId, setDefaultRadioId] = React.useState<string | null>(null);
  const [selectedRadioId, setSelectedRadioIdState] = React.useState<string | null>(() => {
    try { return localStorage.getItem('mesh.selectedRadioId') || null; } catch { return null; }
  });

  const reload = React.useCallback(async () => {
    const data = await meshDataService.listRadios();
    if (!data) return;
    setRadios(data.radios);
    setDefaultRadioId(data.defaultRadioId);
    // If the selected radio was removed, fall back to "all".
    if (selectedRadioId && !data.radios.find(r => r.radio_id === selectedRadioId)) {
      setSelectedRadioIdState(null);
      try { localStorage.removeItem('mesh.selectedRadioId'); } catch {}
    }
  }, [selectedRadioId]);

  const setSelectedRadioId = React.useCallback((id: string | null) => {
    setSelectedRadioIdState(id);
    try {
      if (id) localStorage.setItem('mesh.selectedRadioId', id);
      else localStorage.removeItem('mesh.selectedRadioId');
    } catch {}
  }, []);

  // Initial load + SSE-driven refresh
  React.useEffect(() => {
    reload();
    const es = new EventSource(`${API_BASE}/api/mesh/stream`);
    const onChange = () => { reload(); };
    es.addEventListener('loraConfig', onChange);
    es.addEventListener('radios', onChange);
    return () => {
      es.removeEventListener('loraConfig', onChange);
      es.removeEventListener('radios', onChange);
      es.close();
    };
  }, [reload]);

  const value: RadiosState = {
    radios, defaultRadioId, selectedRadioId, setSelectedRadioId, reload,
  };

  return <RadiosContext.Provider value={value}>{children}</RadiosContext.Provider>;
}

export function useRadios(): RadiosState {
  const ctx = React.useContext(RadiosContext);
  if (!ctx) {
    // Allow components to call useRadios() outside the provider (returns
    // empty state). Useful for tests and incremental rollout.
    return {
      radios: [],
      defaultRadioId: null,
      selectedRadioId: null,
      setSelectedRadioId: () => {},
      reload: () => {},
    };
  }
  return ctx;
}
