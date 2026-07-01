import React from 'react';

import { RadioEvent } from '../../types';
import { cn } from '../../lib/utils';

interface LogsViewProps {
  events: RadioEvent[];
}

interface ConsoleLine {
  id: number;
  ts: number;
  level: 'log' | 'warn' | 'error';
  text: string;
}

const RETENTION_OPTIONS = [6, 24, 36, 48, 72] as const;
const API_BASE = import.meta.env.VITE_API_URL || '';

export function LogsView({ events }: LogsViewProps) {
  const [retentionHours, setRetentionHours] = React.useState<number>(24);
  const [retentionLoaded, setRetentionLoaded] = React.useState(false);
  const [retentionError, setRetentionError] = React.useState<string | null>(null);
  // v2.1: two subviews on the same page. 'events' keeps the curated
  // event log (NODE_JOINED, MESSAGE, WEATHER_DELIVERY, etc.).
  // 'console' opens a live tail of the raw process stdout so the
  // operator can see what the bridge is actually doing — every
  // `[MeshtasticSerial] pkt …`, every admin readback, every
  // structured `[Radios]` / `[Backup]` / `[WeatherPoller]` line.
  // The Console SSE buffer + clear endpoint lives in
  // server/consoleCapture.ts.
  const [view, setView] = React.useState<'events' | 'console'>('events');

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
        <div className="flex items-center gap-2">
          {/* v2.1: subview toggle. Pill-button tab strip lives in
              place of the old "Packet & Event Stream" h3 so it's
              one consistent header surface for both views. */}
          <button
            onClick={() => setView('events')}
            className={cn(
              'px-3 py-1 text-[10px] uppercase font-bold tracking-widest rounded border transition-colors',
              view === 'events'
                ? 'bg-brand-accent/15 border-brand-accent/50 text-brand-accent'
                : 'bg-brand-line/40 border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-muted/30',
            )}
          >
            Event Log
          </button>
          <button
            onClick={() => setView('console')}
            className={cn(
              'px-3 py-1 text-[10px] uppercase font-bold tracking-widest rounded border transition-colors',
              view === 'console'
                ? 'bg-brand-accent/15 border-brand-accent/50 text-brand-accent'
                : 'bg-brand-line/40 border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-muted/30',
            )}
            title="Live raw process console — every console.log the bridge emits"
          >
            Console
          </button>
        </div>
        <div className="flex items-center gap-2">
          {view === 'events' && (
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
          )}
          <button className="px-3 py-1 bg-brand-line text-[10px] rounded hover:bg-brand-muted/20 transition-colors uppercase font-bold tracking-tighter">Export CSV</button>
          <button className="px-3 py-1 bg-brand-line text-[10px] rounded hover:bg-brand-muted/20 transition-colors uppercase font-bold tracking-tighter">Clear Console</button>
        </div>
      </div>
      {retentionError && (
        <div className="px-4 py-1 text-[10px] text-brand-error bg-brand-error/10 border-b border-brand-error/20">
          Retention update failed: {retentionError}
        </div>
      )}
      {view === 'events' ? (
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
                  event.type === 'WEATHER_DELIVERY' ? "text-sky-300" :
                  event.type === 'STORM_REPORT' ? "text-orange-400" : "text-brand-muted"
                )}>{event.type}</span>
                <span className="text-brand-ink truncate">{event.details}</span>
                <span className="ml-auto opacity-0 group-hover:opacity-100 text-brand-muted text-[10px] shrink-0">{event.nodeId}</span>
             </div>
           ))}
           {events.length === 0 && (
             <div className="h-full flex items-center justify-center text-brand-muted italic">No network activity recorded...</div>
           )}
        </div>
      ) : (
        <ConsolePanel />
      )}
    </div>
  );
}

/**
 * Live raw-console subview. Subscribes to /api/mesh/console/tail (SSE),
 * appends each line, auto-scrolls when the operator is anchored to
 * the tail, and pauses auto-scroll the moment they scroll up to
 * inspect history.
 */
function ConsolePanel() {
  const [lines, setLines] = React.useState<ConsoleLine[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/mesh/console/tail`, { withCredentials: true });
    es.onopen = () => { setConnected(true); setError(null); };
    es.onerror = () => {
      setConnected(false);
      setError('Console stream disconnected — retrying…');
      // EventSource auto-reconnects; we just surface the state.
    };
    es.addEventListener('line', evt => {
      try {
        const line = JSON.parse((evt as MessageEvent).data) as ConsoleLine;
        setLines(prev => {
          const next = [...prev, line];
          // Cap at 5000 client-side so a tab left open for hours
          // doesn't pile DOM nodes indefinitely.
          if (next.length > 5000) next.splice(0, next.length - 5000);
          return next;
        });
      } catch { /* malformed line — ignore */ }
    });
    return () => { es.close(); };
  }, []);

  // Auto-scroll to bottom whenever new lines land AND the operator
  // hasn't scrolled away. The scroll-position detector below sets
  // autoScroll=false the moment they scroll up more than 50px from
  // the bottom edge.
  React.useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setAutoScroll(distanceFromBottom < 50);
  };

  const handleClear = async () => {
    try {
      await fetch(`${API_BASE}/api/mesh/console/clear`, {
        method: 'POST',
        credentials: 'include',
      });
      setLines([]);
    } catch (err: any) {
      setError(err?.message ?? 'Clear failed');
    }
  };

  return (
    <>
      <div className="px-3 py-1 flex items-center gap-3 border-b border-brand-line/40 text-[10px] mono-text text-brand-muted">
        <span className={cn('w-2 h-2 rounded-full', connected ? 'bg-brand-accent' : 'bg-brand-muted')} />
        <span>{connected ? 'Live tail' : 'Reconnecting…'}</span>
        <span className="ml-2">{lines.length} lines buffered (cap 5000)</span>
        <span className="ml-auto flex items-center gap-2">
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                const el = containerRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
              className="px-2 py-0.5 rounded bg-brand-accent/15 border border-brand-accent/40 text-brand-accent uppercase font-bold tracking-widest"
            >
              Jump to bottom
            </button>
          )}
          <button
            onClick={handleClear}
            className="px-2 py-0.5 rounded bg-brand-line/60 border border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-muted/30 uppercase font-bold tracking-widest"
            title="Wipe the server-side ring buffer + this view"
          >
            Clear buffer
          </button>
        </span>
      </div>
      {error && (
        <div className="px-4 py-1 text-[10px] text-brand-error bg-brand-error/10 border-b border-brand-error/20">
          {error}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto font-mono text-[10.5px] leading-tight p-2 bg-brand-bg/40"
      >
        {lines.length === 0 && (
          <div className="h-full flex items-center justify-center text-brand-muted italic">Waiting for output…</div>
        )}
        {lines.map(line => (
          <div key={line.id} className="flex gap-2 px-2 py-px hover:bg-brand-line/30 rounded">
            <span className="text-brand-muted shrink-0 tabular-nums">
              {new Date(line.ts).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className={cn(
              'shrink-0 w-12 font-bold uppercase tracking-widest text-[9px] mt-0.5',
              line.level === 'error' ? 'text-brand-error'
              : line.level === 'warn' ? 'text-brand-warning'
              : 'text-brand-muted/60',
            )}>
              {line.level}
            </span>
            <span className={cn(
              'whitespace-pre-wrap break-all',
              line.level === 'error' ? 'text-brand-error'
              : line.level === 'warn' ? 'text-brand-warning'
              : 'text-brand-ink',
            )}>
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
