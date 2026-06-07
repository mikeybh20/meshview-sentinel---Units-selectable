/**
 * v2.0 multi-radio — shared client-side state for the configured radio list,
 * the currently-selected filter (radio_id or null = "all"), per-radio
 * connection state, and the LoRa config readback per radio.
 *
 * The list auto-refreshes on SSE `loraConfig` events (a readback completed
 * for one of the radios) and on `node` events (which can mean a secondary
 * bridge just came online and started ingesting). Components subscribe via
 * the `useRadios()` hook.
 */
import React from 'react';
import { meshDataService } from '../services/meshDataService';
import { useWorkspaces } from './useWorkspaces';
import type { RadioRow } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface RadioConnState {
  connected: boolean;
  transport: string | null;
  /** v2.0 Beta 2: radio health fields, surfaced in the Radios view. */
  firmwareVersion?: string | null;
  rebootCount?: number | null;
  battery?: number | null;
  voltage?: number | null;
  localNodeId?: string | null;
}

interface RadiosState {
  radios: RadioRow[];
  defaultRadioId: string | null;
  /** Per-radio connection state from BridgeManager. Key = radio_id. */
  connectionStates: Record<string, RadioConnState>;
  /** null = "all radios". Otherwise filters node/message/event views to this radio. */
  selectedRadioId: string | null;
  setSelectedRadioId: (id: string | null) => void;
  reload: () => void;
}

const RadiosContext = React.createContext<RadiosState | null>(null);

export function RadiosProvider({ children }: { children: React.ReactNode }) {
  const [radios, setRadios] = React.useState<RadioRow[]>([]);
  const [defaultRadioId, setDefaultRadioId] = React.useState<string | null>(null);
  const [connectionStates, setConnectionStates] = React.useState<Record<string, RadioConnState>>({});
  const [selectedRadioId, setSelectedRadioIdState] = React.useState<string | null>(() => {
    try { return localStorage.getItem('mesh.selectedRadioId') || null; } catch { return null; }
  });

  const reload = React.useCallback(async () => {
    const data = await meshDataService.listRadios();
    if (data) {
      setRadios(data.radios);
      setDefaultRadioId(data.defaultRadioId);
      // If the selected radio was removed, fall back to "all".
      if (selectedRadioId && !data.radios.find(r => r.radio_id === selectedRadioId)) {
        setSelectedRadioIdState(null);
        try { localStorage.removeItem('mesh.selectedRadioId'); } catch {}
      }
    }
    const conns = await meshDataService.getRadioConnections();
    if (conns) setConnectionStates(conns.states);
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
    es.addEventListener('node', onChange);
    return () => {
      es.removeEventListener('loraConfig', onChange);
      es.removeEventListener('radios', onChange);
      es.removeEventListener('node', onChange);
      es.close();
    };
  }, [reload]);

  // v2.0 Beta 5 Workspaces (fix): refire the radios reload whenever the
  // current workspace changes. The /api/mesh/radios response is
  // workspace-filtered (see visibleRadioIdsForUser); without this
  // listener, the RadioBar kept showing the prior workspace's pills
  // until an unrelated SSE event ('node', 'radios', or 'loraConfig')
  // happened to fire and trigger a reload as a side effect. Symptom:
  // switch Household → Mike's, RadioBar still shows 3bec until you
  // wait for a node update. Now the switch itself drives the refresh.
  const { currentWorkspaceId } = useWorkspaces();
  React.useEffect(() => {
    if (currentWorkspaceId == null) return;
    reload();
  }, [currentWorkspaceId, reload]);

  const value: RadiosState = {
    radios, defaultRadioId, connectionStates, selectedRadioId, setSelectedRadioId, reload,
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
      connectionStates: {},
      selectedRadioId: null,
      setSelectedRadioId: () => {},
      reload: () => {},
    };
  }
  return ctx;
}
