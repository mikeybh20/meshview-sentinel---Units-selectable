import React from 'react';

import { RadioEvent } from '../../types';
import { cn } from '../../lib/utils';

interface LogsViewProps {
  events: RadioEvent[];
}

const RETENTION_OPTIONS = [6, 24, 36, 48, 72] as const;
const API_BASE = import.meta.env.VITE_API_URL || '';

export function LogsView({ events }: LogsViewProps) {
  const [retentionHours, setRetentionHours] = React.useState<number>(24);
  const [retentionLoaded, setRetentionLoaded] = React.useState(false);
  const [retentionError, setRetentionError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch(`${API_BASE}/api/mesh/log-retention`)
      .then(r => r.ok ? r.json() : null)
      .then(body => {
        if (body && typeof body.hours === 'number') setRetentionHours(body.hours);
        setRetentionLoaded(true);
      })
      .catch(() => setRetentionLoaded(true)); // server may not be running (simulator mode); fall back to 24
  }, []);

  const handleRetentionChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = parseInt(e.target.value, 10);
    setRetentionError(null);
    setRetentionHours(next); // optimistic
    try {
      const res = await fetch(`${API_BASE}/api/mesh/log-retention`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRetentionError(body.error || `HTTP ${res.status}`);
      }
    } catch (err: any) {
      setRetentionError(err.message || 'Network error');
    }
  };

  return (
    <div className="technical-panel flex-1 flex flex-col">
      <div className="p-4 border-b border-brand-line flex items-center justify-between sticky top-0 bg-brand-bg z-10">
        <h3 className="font-bold flex items-center gap-2 text-xs uppercase tracking-widest text-brand-muted">
          Packet & Event Stream
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted tracking-widest" title="How long to keep events in the log">
              Keep
            </label>
            <select
              value={retentionHours}
              onChange={handleRetentionChange}
              disabled={!retentionLoaded}
              className="bg-brand-line text-[10px] mono-text rounded px-2 py-1 border border-transparent hover:border-brand-muted/30 focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
            >
              {RETENTION_OPTIONS.map(h => (
                <option key={h} value={h}>{h}h</option>
              ))}
            </select>
          </div>
          <button className="px-3 py-1 bg-brand-line text-[10px] rounded hover:bg-brand-muted/20 transition-colors uppercase font-bold tracking-tighter">Export CSV</button>
          <button className="px-3 py-1 bg-brand-line text-[10px] rounded hover:bg-brand-muted/20 transition-colors uppercase font-bold tracking-tighter">Clear Console</button>
        </div>
      </div>
      {retentionError && (
        <div className="px-4 py-1 text-[10px] text-brand-error bg-brand-error/10 border-b border-brand-error/20">
          Retention update failed: {retentionError}
        </div>
      )}
      <div className="flex-1 overflow-y-auto font-mono text-[11px] p-2 space-y-0.5 bg-brand-bg/40">
         {events.map(event => (
           <div key={event.id} className="group hover:bg-brand-line/40 flex gap-4 px-2 py-1 rounded transition-colors">
              <span className="text-brand-muted shrink-0">[{new Date(event.timestamp).toLocaleTimeString()}]</span>
              <span className={cn(
                "font-bold shrink-0 w-28",
                event.type === 'MESSAGE' ? "text-brand-info" :
                event.type === 'TELEMETRY' ? "text-brand-accent" :
                event.type === 'NODE_JOINED' ? "text-brand-warning" :
                event.type === 'OUTAGE' ? "text-brand-error" :
                event.type === 'WEATHER_ALERT' ? "text-brand-error" :
                event.type === 'WEATHER_DELIVERY' ? "text-sky-300" : "text-brand-muted"
              )}>{event.type}</span>
              <span className="text-brand-ink truncate">{event.details}</span>
              <span className="ml-auto opacity-0 group-hover:opacity-100 text-brand-muted text-[10px] shrink-0">{event.nodeId}</span>
           </div>
         ))}
         {events.length === 0 && (
           <div className="h-full flex items-center justify-center text-brand-muted italic">No network activity recorded...</div>
         )}
      </div>
    </div>
  );
}
