import React from 'react';
import {
  MessageSquare,
  Settings,
  Activity,
  Signal,
  Star,
  ArrowRight,
  Wifi,
  AlertCircle,
  LayoutTemplate,
  Compass,
  ArrowsUpFromLine,
  Check,
  X,
  Loader2,
  Cpu,
  Key,
  Copy,
  Clock,
  History,
} from 'lucide-react';
import { Map, Marker } from "pigeon-maps";

import { Node, Message, WidgetConfig, UnitSystem, Group } from '../../types';
import { cn } from '../../lib/utils';
import { StatCard } from '../ui/StatCard';
import { TelemetryItem } from '../ui/TelemetryItem';
import { SensorWidget } from '../SensorWidget';
import { simulator } from '../../services/meshtasticSimulator';
import { meshDataService } from '../../services/meshDataService';
import { useRadios } from '../../hooks/useRadios';
import {
  hardwareLabel,
  roleLabel,
  messagingStatus,
  hexToNodeNum,
  relativeTimeLong,
} from '../../lib/meshEnums';
// TelemetryChart pulls in `recharts` (~120 KB). Lazy-load so the chart only
// gets fetched when a node detail panel actually surfaces it.
const TelemetryChart = React.lazy(() =>
  import('../TelemetryChart').then(m => ({ default: m.TelemetryChart }))
);

const API_BASE = import.meta.env.VITE_API_URL || '';

interface NodeUptimeStats {
  nodeId: string;
  nodeName: string;
  sessions: number;
  onlineMs: number;
  avgSessionMs: number | null;
  uptimePercent: number;
  lastOnlineAt: number | null;
  peakHourCounts: number[];
  currentlyOnline: boolean;
}

const UPTIME_WINDOW_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 24 * 3600_000,      label: '24h' },
  { value: 7 * 24 * 3600_000,  label: '7d' },
  { value: 30 * 24 * 3600_000, label: '30d' },
];

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)} s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)} min`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

/**
 * Compute per-node uptime stats from a list of `{ onlineAt, offlineAt }`
 * sessions. Same shape the server-side `/api/mesh/route-intel/uptime` endpoint
 * returns, so the widget can render either source uniformly. Used in
 * simulator mode where there's no server table to query.
 */
function computeUptimeFromSessions(
  nodeId: string,
  sessions: Array<{ onlineAt: number; offlineAt: number | null }>,
  windowMs: number,
  nowMs = Date.now(),
): Omit<NodeUptimeStats, 'nodeName' | 'currentlyOnline'> {
  const sinceMs = nowMs - windowMs;
  const peak = new Array(24).fill(0);
  let onlineMs = 0;
  let sessionCount = 0;
  let sumMs = 0;
  let lastOnlineAt: number | null = null;
  for (const s of sessions) {
    if (s.offlineAt != null && s.offlineAt < sinceMs) continue;
    if (s.onlineAt > nowMs) continue;
    const start = Math.max(s.onlineAt, sinceMs);
    const end = Math.min(s.offlineAt ?? nowMs, nowMs);
    if (end <= start) continue;
    const dur = end - start;
    sessionCount += 1;
    onlineMs += dur;
    sumMs += dur;
    if (end > (lastOnlineAt ?? 0)) lastOnlineAt = end;

    const minutes = Math.ceil(dur / 60_000);
    for (let i = 0; i < minutes; i++) {
      const t = start + i * 60_000;
      if (t >= end) break;
      peak[new Date(t).getUTCHours()] += Math.min(60_000, end - t);
    }
  }
  return {
    nodeId,
    sessions: sessionCount,
    onlineMs,
    avgSessionMs: sessionCount ? sumMs / sessionCount : null,
    peakHourCounts: peak,
    lastOnlineAt,
    uptimePercent: windowMs > 0 ? Math.min(100, (onlineMs / windowMs) * 100) : 0,
  };
}

/**
 * Per-node uptime panel. In live mode fetches `/api/mesh/route-intel/uptime`
 * (server-side `node_sessions` table). In simulator mode reads the
 * simulator's in-memory session history directly. Either way, displays
 * uptime % over the chosen window, session count, avg session length,
 * last-online timestamp, and a 24-hour peak-hours histogram (UTC).
 */
function NodeUptimeWidget({ nodeId, currentlyOnline, dataSource }: {
  nodeId: string;
  currentlyOnline: boolean;
  dataSource: 'live' | 'simulator';
}) {
  const [windowMs, setWindowMs] = React.useState<number>(24 * 3600_000);
  const [stats, setStats] = React.useState<NodeUptimeStats | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    // Simulator mode — compute from the in-memory session list. Re-run on a
    // 5 s tick so the widget updates as the simulator generates more data.
    if (dataSource === 'simulator') {
      const refresh = () => {
        const all = simulator.getUptimeHistory();
        const ours = all.filter(s => s.nodeId === nodeId);
        const computed = computeUptimeFromSessions(nodeId, ours, windowMs);
        if (!cancelled) {
          setStats({ ...computed, nodeName: nodeId, currentlyOnline });
          setLoading(false);
          setError(null);
        }
      };
      refresh();
      const t = setInterval(refresh, 5000);
      return () => { cancelled = true; clearInterval(t); };
    }

    // Live mode — server-backed.
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/mesh/route-intel/uptime?nodeId=${encodeURIComponent(nodeId)}&windowMs=${windowMs}`)
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ results: NodeUptimeStats[] }>;
      })
      .then(body => {
        if (cancelled) return;
        setStats(body.results[0] ?? null);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err.message || 'Uptime fetch failed');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [nodeId, windowMs, dataSource, currentlyOnline]);

  // Find the peak hour for the highlighted callout
  const peakHour = stats && stats.peakHourCounts.length === 24
    ? stats.peakHourCounts.reduce((bestIdx, v, i, arr) => v > arr[bestIdx] ? i : bestIdx, 0)
    : null;
  const maxHourMs = stats ? Math.max(1, ...stats.peakHourCounts) : 1;

  return (
    <div className="bg-brand-bg/40 rounded border border-brand-line/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={cn('w-1.5 h-1.5 rounded-full', currentlyOnline ? 'bg-brand-accent animate-pulse' : 'bg-brand-muted')} />
          <span className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Uptime &amp; availability</span>
        </div>
        <div className="flex bg-brand-line/40 rounded overflow-hidden border border-brand-line">
          {UPTIME_WINDOW_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setWindowMs(opt.value)}
              className={cn(
                'text-[9px] font-bold uppercase px-2 py-0.5 transition-colors',
                windowMs === opt.value ? 'bg-brand-accent text-black' : 'text-brand-muted hover:text-brand-ink',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !stats ? (
        <div className="flex items-center gap-2 text-[10px] text-brand-muted py-2">
          <Loader2 size={12} className="animate-spin" /> Loading session history…
        </div>
      ) : error ? (
        <div className="text-[10px] text-brand-error">Uptime fetch failed: {error}</div>
      ) : !stats ? (
        <div className="text-[10px] text-brand-muted italic py-2">
          No session history yet for this window. Sessions are recorded every time a node transitions online or offline; new nodes need at least one such transition before stats appear.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-2">
            <div className="text-center">
              <div className={cn(
                'text-base font-bold mono-text',
                stats.uptimePercent >= 80 ? 'text-brand-accent'
                : stats.uptimePercent >= 50 ? 'text-brand-warning'
                : 'text-brand-error',
              )}>
                {stats.uptimePercent.toFixed(0)}%
              </div>
              <div className="text-[8px] uppercase tracking-widest text-brand-muted mt-0.5">Uptime</div>
            </div>
            <div className="text-center">
              <div className="text-base font-bold mono-text text-brand-ink">{stats.sessions}</div>
              <div className="text-[8px] uppercase tracking-widest text-brand-muted mt-0.5">Sessions</div>
            </div>
            <div className="text-center">
              <div className="text-base font-bold mono-text text-brand-ink">
                {stats.avgSessionMs != null ? formatDuration(stats.avgSessionMs) : '—'}
              </div>
              <div className="text-[8px] uppercase tracking-widest text-brand-muted mt-0.5">Avg session</div>
            </div>
            <div className="text-center">
              <div className="text-base font-bold mono-text text-brand-ink">
                {stats.lastOnlineAt ? formatTimeAgo(stats.lastOnlineAt) : '—'}
              </div>
              <div className="text-[8px] uppercase tracking-widest text-brand-muted mt-0.5">Last online</div>
            </div>
          </div>

          {/* Peak-hours histogram */}
          {stats.peakHourCounts.some(v => v > 0) && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] uppercase font-bold tracking-widest text-brand-muted">Peak hours (UTC)</span>
                {peakHour !== null && (
                  <span className="text-[9px] mono-text text-brand-accent font-bold">
                    Peak {peakHour.toString().padStart(2, '0')}:00
                  </span>
                )}
              </div>
              <div className="flex items-end gap-px h-10">
                {stats.peakHourCounts.map((ms, hr) => {
                  const fraction = maxHourMs > 0 ? ms / maxHourMs : 0;
                  return (
                    <div
                      key={hr}
                      className="flex-1 bg-brand-accent/30 hover:bg-brand-accent/60 transition-colors rounded-sm relative group"
                      style={{ height: `${Math.max(2, fraction * 100)}%` }}
                      title={`${hr.toString().padStart(2, '0')}:00 — ${formatDuration(ms)} online`}
                    />
                  );
                })}
              </div>
              <div className="flex justify-between text-[8px] mono-text text-brand-muted mt-0.5">
                <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Maryland home base — same fallback as the main MapView so a fresh DB with
// no positioned nodes lands on the operator's actual region instead of the
// previously-hardcoded Portland coordinates.
const FALLBACK_CENTER: [number, number] = [39.0, -76.7];
const FALLBACK_ZOOM = 9;

/**
 * Sectioned node-detail panel modeled on the official iOS app's layout:
 *   Hardware  → model name, role, public key + copy
 *   Signal    → RSSI / SNR / distance / altitude tiles
 *   Identity  → node number (decimal), user id (hex), messaging status
 *   Timing    → first heard, last heard
 *   Location  → lat / lng (when present)
 *   Logs      → per-node history sections (P2 — separate component below)
 *
 * Each section is a labeled block; missing data renders as "—" rather than
 * an absent row so the panel stays visually consistent across nodes.
 */
function NodeDetailSections({
  node,
  unitSystem,
  dataSource,
}: {
  node: Node;
  unitSystem: UnitSystem;
  dataSource: 'live' | 'simulator';
}) {
  const [keyCopied, setKeyCopied] = React.useState(false);
  const nodeNum = hexToNodeNum(node.id);
  const hw = hardwareLabel(node.hwModel);
  const role = roleLabel(node.role);
  const msgStatus = messagingStatus(node.role);

  const copyKey = async () => {
    if (!node.publicKey) return;
    try {
      await navigator.clipboard.writeText(node.publicKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="space-y-5">
      {/* Hardware */}
      <Section label="Hardware" icon={<Cpu size={11} />}>
        <Row label="Model" value={hw ?? '—'} />
        <Row label="Role" value={role ?? '—'} />
        <Row label="Licensed" value={node.isLicensed ? 'Yes' : 'No'} />
      </Section>

      {/* Signal */}
      <Section label="Signal" icon={<Signal size={11} />}>
        <div className="grid grid-cols-2 gap-3">
          <TelemetryItem
            icon={<Signal size={14}/>}
            label="RSSI"
            value={typeof node.telemetry?.rssi === 'number' && node.telemetry.rssi !== 0
              ? `${Math.round(node.telemetry.rssi)} dBm`
              : '—'}
          />
          <TelemetryItem
            icon={<Activity size={14}/>}
            label="SNR"
            value={typeof node.telemetry?.snr === 'number' && node.telemetry.snr !== 0
              ? `${node.telemetry.snr.toFixed(2)} dB`
              : '—'}
          />
          {typeof node.telemetry?.distance === 'number' && node.telemetry.distance > 0 && (
            <TelemetryItem
              icon={<ArrowsUpFromLine size={14}/>}
              label="Distance"
              value={unitSystem === 'METRIC'
                ? `${node.telemetry.distance.toFixed(2)} km`
                : `${(node.telemetry.distance * 0.621371).toFixed(2)} mi`}
            />
          )}
          {typeof node.position?.alt === 'number' && node.position.alt !== 0 && (
            <TelemetryItem
              icon={<Compass size={14}/>}
              label="Altitude"
              value={unitSystem === 'METRIC'
                ? `${node.position.alt.toFixed(0)} m`
                : `${(node.position.alt * 3.28084).toFixed(0)} ft`}
            />
          )}
        </div>
      </Section>

      {/* Identity */}
      <Section label="Identity">
        <Row label="Node Number" mono value={nodeNum !== null ? String(nodeNum) : '—'} />
        <Row label="User ID" mono value={node.id} />
        <Row label="Messaging" value={msgStatus} />
        {/* Public key with copy. Truncated to fit; full value goes via clipboard. */}
        {node.publicKey ? (
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-brand-muted shrink-0 flex items-center gap-1.5">
              <Key size={11} /> Public Key
            </span>
            <button
              onClick={copyKey}
              className="flex items-center gap-1.5 mono-text text-brand-accent hover:underline truncate text-right"
              title="Click to copy full public key"
            >
              <span className="truncate">{node.publicKey.slice(0, 16)}…</span>
              {keyCopied ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        ) : (
          <Row label="Public Key" value="—" />
        )}
      </Section>

      {/* Timing */}
      <Section label="Timing" icon={<Clock size={11} />}>
        <Row label="First heard" value={relativeTimeLong(node.firstSeen)} />
        <Row label="Last heard"  value={relativeTimeLong(node.lastSeen)} />
      </Section>

      {/* Location (only when present) */}
      {node.position && (
        <Section label="Location">
          <div className="p-2.5 bg-brand-line/30 rounded border border-brand-line mono-text space-y-1 text-[10px]">
            <p className="flex justify-between"><span>LAT:</span> <span className="text-brand-ink">{node.position.lat.toFixed(6)}</span></p>
            <p className="flex justify-between"><span>LNG:</span> <span className="text-brand-ink">{node.position.lng.toFixed(6)}</span></p>
            {node.positionSource && (
              <p className="flex justify-between">
                <span>SOURCE:</span>
                <span className="text-brand-ink uppercase">{node.positionSource}</span>
              </p>
            )}
          </div>
        </Section>
      )}

      {/* Time-series telemetry chart — battery, signal, environment.
          Lazy-loaded; recharts is heavy. */}
      <Section label="Telemetry History" icon={<History size={11} />}>
        <React.Suspense fallback={
          <div className="h-44 bg-brand-bg/40 rounded border border-brand-line/50 flex items-center justify-center">
            <Loader2 size={16} className="animate-spin text-brand-muted" />
          </div>
        }>
          <TelemetryChart nodeId={node.id} />
        </React.Suspense>
      </Section>

      {/* Per-node uptime / availability sourced from node_sessions. */}
      <NodeUptimeWidget
        nodeId={node.id}
        currentlyOnline={node.online}
        dataSource={dataSource}
      />

      {/* Per-node history logs (P2 — Position / Trace Route / Power / Environment) */}
      <NodeLogsSection nodeId={node.id} dataSource={dataSource} />
    </div>
  );
}

/** Section wrapper for the node detail panel — labeled block with consistent
 *  spacing. Tiny helper so the body of NodeDetailSections stays scannable. */
function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-brand-muted uppercase font-bold tracking-widest flex items-center gap-1.5">
        {icon} {label}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/** Single label / value row inside a Section. */
function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-brand-muted shrink-0">{label}</span>
      <span className={cn(
        'text-right text-brand-ink truncate',
        mono && 'mono-text'
      )}>
        {value}
      </span>
    </div>
  );
}

/**
 * Per-node history logs. Each subsection is collapsible and fetches its data
 * on expand so we don't pay API cost for nodes whose detail panel is opened
 * but never drilled into.
 */
function NodeLogsSection({ nodeId, dataSource }: { nodeId: string; dataSource: 'live' | 'simulator' }) {
  return (
    <Section label="Logs" icon={<History size={11} />}>
      <div className="space-y-1">
        <CollapsibleLog
          label="Position Log"
          subtitle="Lat/lng samples over time"
          dataSource={dataSource}
        >
          <PositionLog nodeId={nodeId} />
        </CollapsibleLog>
        <CollapsibleLog
          label="Trace Route Log"
          subtitle="Path discovery attempts"
          dataSource={dataSource}
        >
          <TraceLog nodeId={nodeId} />
        </CollapsibleLog>
        {/* The Telemetry History block above already covers device metrics,
            power, and environment time-series — we deliberately don't
            re-render those here as separate log sections. */}
      </div>
    </Section>
  );
}

function CollapsibleLog({
  label,
  subtitle,
  dataSource,
  children,
}: {
  label: string;
  subtitle?: string;
  dataSource: 'live' | 'simulator';
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border border-brand-line/40 rounded">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 hover:bg-brand-line/30 transition-colors text-left"
      >
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-tight text-brand-ink">{label}</div>
          {subtitle && <div className="text-[9px] text-brand-muted truncate">{subtitle}</div>}
        </div>
        <ArrowRight
          size={12}
          className={cn(
            'text-brand-muted shrink-0 transition-transform',
            open && 'rotate-90'
          )}
        />
      </button>
      {open && (
        <div className="px-2.5 py-2 border-t border-brand-line/40 bg-brand-bg/30">
          {dataSource === 'simulator' ? (
            <div className="text-[10px] text-brand-muted italic">
              Switch to live mode to populate this log with real radio data.
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

function PositionLog({ nodeId }: { nodeId: string }) {
  const [rows, setRows] = React.useState<Array<{
    id: number;
    timestamp: number;
    lat: number;
    lng: number;
    alt: number | null;
    source: 'manual' | 'gps' | null;
  }> | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getNodePositionHistory(nodeId, 100).then(r => {
      if (!cancelled) setRows(r);
    });
    return () => { cancelled = true; };
  }, [nodeId]);

  if (rows === null) {
    return (
      <div className="text-[10px] text-brand-muted flex items-center gap-2">
        <Loader2 size={11} className="animate-spin" /> Loading…
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="text-[10px] text-brand-muted italic">No position history recorded yet.</div>;
  }
  return (
    <div className="space-y-0.5 max-h-48 overflow-y-auto text-[10px] mono-text">
      <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 px-1 pb-1 text-brand-muted uppercase tracking-widest text-[9px] border-b border-brand-line/40">
        <span>When</span>
        <span>Lat</span>
        <span>Lng</span>
        <span className="text-right">Src</span>
      </div>
      {rows.map(r => (
        <div key={r.id} className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 px-1 py-0.5 hover:bg-brand-line/20 rounded">
          <span className="text-brand-muted">{relativeTimeLong(r.timestamp)}</span>
          <span className="text-brand-ink truncate">{r.lat.toFixed(5)}</span>
          <span className="text-brand-ink truncate">{r.lng.toFixed(5)}</span>
          <span className="text-brand-muted text-right uppercase">{r.source || '—'}</span>
        </div>
      ))}
    </div>
  );
}

function TraceLog({ nodeId }: { nodeId: string }) {
  const [rows, setRows] = React.useState<Array<{
    id: string;
    targetId: string;
    startedAt: number;
    completedAt: number | null;
    status: string;
    route: string[];
    routeBack: string[];
    errorMessage: string | null;
  }> | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getNodeTraces(nodeId, 30).then(r => {
      if (!cancelled) setRows(r as any);
    });
    return () => { cancelled = true; };
  }, [nodeId]);

  if (rows === null) {
    return (
      <div className="text-[10px] text-brand-muted flex items-center gap-2">
        <Loader2 size={11} className="animate-spin" /> Loading…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="text-[10px] text-brand-muted italic">
        No trace routes recorded yet. Use the trace button on a message from this node to record one.
      </div>
    );
  }
  return (
    <div className="space-y-1 max-h-48 overflow-y-auto text-[10px]">
      {rows.map(r => (
        <div key={r.id} className="px-1.5 py-1 rounded border border-brand-line/30 hover:bg-brand-line/20">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-brand-muted mono-text">{relativeTimeLong(r.startedAt)}</span>
            <span className={cn(
              'mono-text uppercase text-[9px] tracking-widest',
              r.status === 'response' ? 'text-brand-accent'
                : r.status === 'timeout' ? 'text-brand-warning'
                : 'text-brand-muted'
            )}>{r.status}</span>
          </div>
          {r.route.length > 0 && (
            <div className="text-brand-ink mono-text truncate">
              → {r.route.map(h => h.slice(-4)).join(' → ')}
            </div>
          )}
          {r.routeBack.length > 0 && (
            <div className="text-brand-muted mono-text truncate">
              ← {r.routeBack.map(h => h.slice(-4)).join(' ← ')}
            </div>
          )}
          {r.errorMessage && (
            <div className="text-brand-warning text-[9px] mt-0.5">{r.errorMessage}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// Pigeon-maps meters-per-pixel at a given latitude + zoom (Web Mercator).
// Used to convert a "pixel collision radius" into a real-world DBSCAN eps.
function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

// We want pins to merge when they sit within ~24 px of each other on screen.
// Smaller eps at high zoom (pins resolve individually); larger at low zoom
// (pins collapse aggressively).
const PIN_COLLISION_PIXELS = 24;

function DashboardMapWidget({ nodes }: { nodes: Node[] }) {
  const positioned = nodes.filter(n => n.position);
  const { radios } = useRadios();
  // v2.0: map a radio_id to its assigned color for pin tinting.
  const radioColors = React.useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of radios) if (r.color_hex) m[r.radio_id] = r.color_hex;
    return m;
  }, [radios]);

  const derivedCenter = React.useMemo<[number, number]>(() => {
    if (positioned.length === 0) return FALLBACK_CENTER;
    const lats = positioned.map(n => n.position!.lat);
    const lngs = positioned.map(n => n.position!.lng);
    return [
      (Math.min(...lats) + Math.max(...lats)) / 2,
      (Math.min(...lngs) + Math.max(...lngs)) / 2,
    ];
  }, [positioned.length]);

  const derivedZoom = React.useMemo(() => {
    if (positioned.length === 0) return FALLBACK_ZOOM;
    if (positioned.length === 1) return 12;
    const lats = positioned.map(n => n.position!.lat);
    const lngs = positioned.map(n => n.position!.lng);
    const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs));
    if (span < 0.05) return 12;
    if (span < 0.2)  return 10;
    if (span < 1)    return 9;
    if (span < 5)    return 7;
    return 5;
  }, [positioned.length]);

  // Track whether the user has manually panned/zoomed. Until they do, we keep
  // re-snapping to the derived center as the node set evolves — that way an
  // initial fallback / simulator-seeded view is overwritten as soon as the
  // live nodes arrive. Once the user interacts, we stop overriding their view.
  const [center, setCenter] = React.useState(derivedCenter);
  const [zoom, setZoom] = React.useState(derivedZoom);
  const userInteractedRef = React.useRef(false);
  React.useEffect(() => {
    if (userInteractedRef.current) return;
    setCenter(derivedCenter);
    setZoom(derivedZoom);
  }, [derivedCenter, derivedZoom]);

  // v2.0 Phase 3c: GPU-accelerated spatial clustering. Eps is derived from
  // current zoom so pins merge once their screen distance falls below
  // PIN_COLLISION_PIXELS. Debounced so pan-jitter doesn't hammer the sidecar.
  type ClusterMarker = {
    id: number;
    lat: number;
    lng: number;
    count: number;
    nodeIds: string[];
    radioIds: string[];
  };
  const [clusters, setClusters] = React.useState<ClusterMarker[]>([]);
  const [backend, setBackend] = React.useState<'cuml' | 'cpu' | 'cpu_ts' | 'noop' | null>(null);

  // v2.0 Phase 5: signal coverage heatmap state.
  const [showHeatmap, setShowHeatmap] = React.useState(false);
  const [heatmap, setHeatmap] = React.useState<{
    grid: (number | null)[][];
    bbox: [number, number, number, number];
    stats: { min: number; max: number; samples: number } | null;
    backend: string;
  } | null>(null);
  // v2.0 Phase 5: click-to-expand. Stores the cluster id currently popped out
  // with its node list. Clicking the pin / +N badge toggles the popover.
  const [expandedClusterId, setExpandedClusterId] = React.useState<number | null>(null);
  // Fast lookup: nodeId → Node so the popover can render names + status.
  // We use a plain object instead of `Map<>` because `Map` is the pigeon-maps
  // component imported above and the name shadows the built-in.
  const nodeById = React.useMemo<Record<string, Node>>(() => {
    const m: Record<string, Node> = {};
    for (const n of nodes) m[n.id] = n;
    return m;
  }, [nodes]);

  React.useEffect(() => {
    if (positioned.length === 0) { setClusters([]); return; }
    const epsM = metersPerPixel(center[0], zoom) * PIN_COLLISION_PIXELS;
    const points = positioned.map(n => ({
      lat: n.position!.lat,
      lng: n.position!.lng,
      node_id: n.id,
      radio_id: n.heardByRadios?.[0] ?? null,
    }));
    const timer = setTimeout(async () => {
      const res = await meshDataService.clusterMapPoints({ points, eps_meters: epsM, min_samples: 2 });
      if (!res) return;
      setBackend(res.backend);
      setClusters(res.clusters.map(c => ({
        id: c.id, lat: c.lat, lng: c.lng, count: c.count, nodeIds: c.node_ids, radioIds: c.radio_ids,
      })));
    }, 200);
    return () => clearTimeout(timer);
  }, [positioned, center, zoom]);

  // v2.0 Phase 5: signal coverage heatmap fetcher. Re-runs when the operator
  // toggles the overlay on or pans/zooms; debounced like clustering so we
  // don't hammer the sidecar mid-drag.
  React.useEffect(() => {
    if (!showHeatmap || positioned.length === 0) { setHeatmap(null); return; }
    // Approximate map bbox from center + zoom + viewport size. Pigeon-maps
    // doesn't surface bounds directly so we estimate from the rendered
    // pixel size (the map widget is 720px tall; assume ~1080px wide for the
    // default Dashboard layout — actual width doesn't materially affect the
    // heatmap because we sample at a fixed grid resolution either way).
    const mpp = metersPerPixel(center[0], zoom);
    const halfHeightM = 720 / 2 * mpp;
    const halfWidthM  = 1080 / 2 * mpp;
    const latDelta = halfHeightM / 111000;             // 1° lat ≈ 111 km
    const lngDelta = halfWidthM / (111000 * Math.cos(center[0] * Math.PI / 180));
    const bbox: [number, number, number, number] = [
      center[0] - latDelta,
      center[1] - lngDelta,
      center[0] + latDelta,
      center[1] + lngDelta,
    ];

    const timer = setTimeout(async () => {
      const res = await meshDataService.buildHeatmap({
        bbox,
        grid_width: 96,
        grid_height: 64,
        max_radius_m: Math.max(2000, halfHeightM * 0.4),
      });
      if (!res) return;
      setHeatmap({ grid: res.grid, bbox: res.bbox, stats: res.stats, backend: res.backend });
    }, 300);
    return () => clearTimeout(timer);
  }, [showHeatmap, positioned.length, center, zoom]);

  // Render the heatmap onto a hidden canvas, then position it absolutely on
  // top of the map widget. The canvas dimensions match the grid; CSS scales
  // it to fill the widget so we get free anti-aliasing.
  const heatmapCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  React.useEffect(() => {
    const canvas = heatmapCanvasRef.current;
    if (!canvas || !heatmap || !heatmap.stats) return;
    const { grid, stats } = heatmap;
    const h = grid.length;
    const w = grid[0]?.length ?? 0;
    if (h === 0 || w === 0) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const range = Math.max(1, stats.max - stats.min);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = grid[y][x];
        const idx = (y * w + x) * 4;
        if (v == null) {
          img.data[idx + 3] = 0; // transparent
          continue;
        }
        const t = Math.max(0, Math.min(1, (v - stats.min) / range));
        // Red (weak) → Yellow (mid) → Green (strong)
        const r = t < 0.5 ? 255 : Math.round(255 * (1 - (t - 0.5) * 2));
        const g = t < 0.5 ? Math.round(255 * (t * 2)) : 255;
        img.data[idx]     = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = 0;
        img.data[idx + 3] = 130; // semi-transparent so map shows through
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [heatmap]);

  return (
    <div className="technical-panel h-[720px] overflow-hidden relative">
      {/* v2.0 Phase 5: heatmap canvas sits between the map tiles and the
          markers. It's stretched to fill the widget so the IDW grid (96×64
          cells) gets free CSS-scaling smoothing — looks blurry-but-good
          rather than pixelated. */}
      {showHeatmap && heatmap && (
        <canvas
          ref={heatmapCanvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none z-[1]"
          style={{ imageRendering: 'auto', opacity: 0.7 }}
        />
      )}
      <div className="absolute inset-0 z-0">
        <Map
          center={center}
          zoom={zoom}
          onBoundsChanged={({ center: c, zoom: z, initial }) => {
            // pigeon-maps fires onBoundsChanged once on mount with `initial: true`;
            // only treat user-driven changes (drag/zoom) as real interaction.
            if (!initial) userInteractedRef.current = true;
            setCenter(c);
            setZoom(z);
          }}
        >
          {clusters.map(cl => {
            // v2.0 Phase 3c + 5: one marker per spatial cluster. The pin's
            // primary color comes from the first hearing radio; clusters
            // touched by multiple radios get a horizontal multi-color strip
            // below the pin so the operator can see attribution at a glance.
            // Click toggles the expand popover.
            const pinColor = (cl.radioIds[0] && radioColors[cl.radioIds[0]])
              || 'var(--color-brand-accent)';
            const multiRadio = cl.radioIds.length > 1;
            const isExpanded = expandedClusterId === cl.id;
            return (
              <Marker
                key={cl.id}
                width={cl.count > 1 ? 28 : 20}
                anchor={[cl.lat, cl.lng]}
                color={pinColor}
                onClick={() => setExpandedClusterId(prev => prev === cl.id ? null : cl.id)}
              >
                {cl.count > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setExpandedClusterId(prev => prev === cl.id ? null : cl.id); }}
                    title={`${cl.count} nodes clustered — click to expand`}
                    className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-brand-bg border border-brand-accent text-brand-accent text-[9px] font-bold flex items-center justify-center cursor-pointer hover:bg-brand-accent hover:text-black transition-colors"
                  >
                    +{cl.count}
                  </button>
                )}
                {multiRadio && (
                  <div
                    title={`Heard by: ${cl.radioIds.join(', ')}`}
                    className="absolute left-1/2 -translate-x-1/2 top-full mt-0.5 flex gap-0.5 pointer-events-none"
                  >
                    {cl.radioIds.map(rid => (
                      <span
                        key={rid}
                        className="block w-1.5 h-1.5 rounded-full border border-brand-bg"
                        style={{ background: radioColors[rid] ?? '#888' }}
                      />
                    ))}
                  </div>
                )}
              </Marker>
            );
          })}
        </Map>
      </div>
      <div className="absolute top-2 left-2 flex items-center gap-2 z-[2]">
        <div className="px-2 py-1 bg-brand-bg/80 backdrop-blur-md rounded text-[10px] font-bold uppercase tracking-widest border border-brand-line">
          Mesh Coverage
        </div>
        {backend && backend !== 'noop' && (
          <div
            title={
              backend === 'cuml' ? 'GPU sidecar (cuML DBSCAN)' :
              backend === 'cpu' ? 'Python sidecar (CPU DBSCAN)' :
              'TS CPU fallback (sidecar unreachable)'
            }
            className="px-2 py-1 bg-brand-bg/80 backdrop-blur-md rounded text-[9px] mono-text uppercase tracking-widest border border-brand-line text-brand-muted"
          >
            {backend === 'cuml' ? 'GPU' : backend === 'cpu' ? 'SIDECAR' : 'CPU'}
          </div>
        )}
        {/* v2.0 Phase 5: heatmap toggle. The badge next to it surfaces the
            sample count + min/max RSSI so the operator knows what the heatmap
            is actually showing. */}
        <button
          onClick={() => setShowHeatmap(s => !s)}
          className={cn(
            "px-2 py-1 rounded text-[10px] font-bold uppercase tracking-widest border transition-colors backdrop-blur-md",
            showHeatmap
              ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
              : "bg-brand-bg/80 border-brand-line text-brand-muted hover:text-brand-ink"
          )}
          title="Toggle signal coverage heatmap (IDW interpolation over RSSI samples)"
        >
          {showHeatmap ? '● Coverage' : '○ Coverage'}
        </button>
        {showHeatmap && heatmap?.stats && (
          <div className="px-2 py-1 bg-brand-bg/80 backdrop-blur-md rounded text-[9px] mono-text border border-brand-line text-brand-muted">
            {heatmap.stats.samples} samples · {Math.round(heatmap.stats.min)} → {Math.round(heatmap.stats.max)} dBm
          </div>
        )}
      </div>

      {/* v2.0 Phase 5: cluster expand popover. Anchored to the upper-right
          corner of the map so it doesn't fight the cluster's actual marker
          for screen space (pigeon-maps' Overlay would re-anchor on every pan
          which makes the popover feel like it's chasing the cursor). */}
      {(() => {
        const cl = clusters.find(c => c.id === expandedClusterId);
        if (!cl) return null;
        return (
          <div className="absolute top-2 right-2 z-10 w-56 bg-brand-bg/95 backdrop-blur-md border border-brand-line rounded shadow-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-brand-line flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand-ink">
                Cluster · {cl.count} node{cl.count === 1 ? '' : 's'}
              </span>
              <button
                onClick={() => setExpandedClusterId(null)}
                className="text-brand-muted hover:text-brand-ink"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {cl.nodeIds.map(id => {
                const n = nodeById[id];
                return (
                  <button
                    key={id}
                    onClick={() => { /* would deep-link to NODE_DETAILS in a follow-up */ }}
                    className="w-full text-left px-3 py-1.5 hover:bg-brand-line/50 transition-colors flex items-center gap-2"
                  >
                    <span className={cn(
                      "w-1.5 h-1.5 rounded-full flex-shrink-0",
                      n?.online ? "bg-brand-accent" : "bg-red-500/50"
                    )} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-bold text-brand-ink truncate">
                        {n?.shortName || id.slice(-4)} · {n?.name || id}
                      </div>
                      <div className="text-[9px] mono-text text-brand-muted flex items-center gap-1 flex-wrap">
                        {(n?.heardByRadios ?? []).map(rid => (
                          <span
                            key={rid}
                            className="px-1 rounded border text-[8px]"
                            style={{
                              color: radioColors[rid] ?? '#888',
                              borderColor: `${radioColors[rid] ?? '#888'}66`,
                            }}
                          >
                            {rid}
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

interface DashboardViewProps {
  nodes: Node[];
  messages: Message[];
  filteredNodes: Node[];
  selectedNode: Node | undefined;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string) => void;
  setConfiguringNodeId: (id: string) => void;
  setIsEditingDashboard: (v: boolean) => void;
  dashboardWidgets: WidgetConfig[];
  stats: { total: number; online: number; offline: number; favorites: number };
  unitSystem: UnitSystem;
  onToggleFavorite: (nodeId: string, favorite: boolean) => void;
  groups: Group[];
  onAssignGroup: (nodeId: string, groupId: string | undefined) => void;
  /**
   * 'live' = the bridge is reading from a real radio (uptime stats fetched
   * from /api/mesh/route-intel/uptime). 'simulator' = the in-browser simulator
   * is generating data, and the uptime widget should source its session
   * history from the simulator instead.
   */
  dataSource: 'live' | 'simulator';
}

export function DashboardView({
  nodes,
  messages,
  filteredNodes,
  selectedNode,
  selectedNodeId,
  setSelectedNodeId,
  setConfiguringNodeId,
  setIsEditingDashboard,
  dashboardWidgets,
  stats,
  unitSystem,
  onToggleFavorite,
  groups,
  onAssignGroup,
  dataSource,
}: DashboardViewProps) {
  // Bulk-selection state for the NODE_LIST table. Lives here as transient UI
  // state — no need to lift to App.tsx since other views don't use it.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = React.useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [showGroupMenu, setShowGroupMenu] = React.useState(false);

  // Drop selections that no longer exist in the filtered list (e.g. node
  // disappeared, search filter narrowed).
  React.useEffect(() => {
    if (selectedIds.size === 0) return;
    const visibleIds = new Set(filteredNodes.map(n => n.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (visibleIds.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelectedIds(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredNodes]);

  const toggleSelection = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const isShiftRange = e.shiftKey && lastCheckedId && lastCheckedId !== nodeId;
    const next = new Set(selectedIds);

    if (isShiftRange) {
      // Range select: from lastCheckedId to nodeId, both inclusive.
      // The new state of every row in the range matches the destination row's new state.
      const rowIds = filteredNodes.map(n => n.id);
      const a = rowIds.indexOf(lastCheckedId!);
      const b = rowIds.indexOf(nodeId);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const wantSelected = !selectedIds.has(nodeId);
        for (let i = lo; i <= hi; i++) {
          if (wantSelected) next.add(rowIds[i]);
          else next.delete(rowIds[i]);
        }
      }
    } else {
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
    }

    setSelectedIds(next);
    setLastCheckedId(nodeId);
  };

  const selectAll = () => {
    setSelectedIds(new Set(filteredNodes.map(n => n.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setLastCheckedId(null);
    setShowGroupMenu(false);
  };

  const bulkAssignGroup = async (groupId: string | undefined) => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    setShowGroupMenu(false);
    try {
      await Promise.all(Array.from(selectedIds).map(id => Promise.resolve(onAssignGroup(id, groupId))));
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkSetFavorite = async (favorite: boolean) => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(Array.from(selectedIds).map(id => Promise.resolve(onToggleFavorite(id, favorite))));
    } finally {
      setBulkBusy(false);
    }
  };

  const allSelected = selectedIds.size > 0 && selectedIds.size === filteredNodes.length;
  const someSelected = selectedIds.size > 0;

  return (
    <>
      <div className="flex items-center justify-between mb-6">
         <div>
           <h2 className="text-xl font-bold tracking-tight text-brand-ink">NETWORK OVERVIEW</h2>
           <p className="text-xs text-brand-muted mono-text uppercase">Real-time mesh diagnostics</p>
         </div>
         <button 
           onClick={() => setIsEditingDashboard(true)}
           className="flex items-center gap-2 px-3 py-1.5 rounded bg-brand-line/50 border border-brand-line hover:border-brand-accent transition-all text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink"
         >
           <LayoutTemplate size={14} />
           Customize Dashboard
         </button>
      </div>

      {/*
        Row sizing matters here because NODE_DETAILS spans 2 rows via row-span-2.
        Without an explicit grid-template-rows, CSS Grid's auto-row algorithm
        distributes the row-spanning item's height across the rows it spans —
        which inflated row 1 (where STATS lives) to half of NODE_DETAILS's
        full height, leaving a big visual gap between STATS and NODE_LIST.
        Pinning row 1 to min-content keeps STATS at its natural height; row 2
        takes "1fr" so it absorbs the remaining height NODE_DETAILS needs.
        Row 3 (MAP) is min-content again.
      */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:grid-rows-[min-content_1fr_min-content]">
        {dashboardWidgets.filter(w => w.visible).sort((a, b) => a.order - b.order).map(widget => {
          const colSpan = {
            full: 'lg:col-span-12',
            large: 'lg:col-span-8',
            medium: 'lg:col-span-6',
            small: 'lg:col-span-4'
          }[widget.width];

          // Per-widget grid-cell modifiers:
          //  NODE_LIST    — height-matching trick (min-h-0 + overflow-hidden +
          //                 h-full) so NODE_DETAILS drives the row height and
          //                 the list scrolls internally. lg:max-h-screen is a
          //                 safety net for pathologically tall details panels.
          //  NODE_DETAILS — row-span-2 so it spans both the STATS row above
          //                 and the NODE_LIST row below, sitting flush with
          //                 the top of the overview cards.
          const cellModifiers = (() => {
            if (widget.type === 'NODE_LIST') return 'min-h-0 overflow-hidden h-full lg:max-h-screen';
            if (widget.type === 'NODE_DETAILS') return 'lg:row-span-2';
            return '';
          })();

          return (
            <div key={widget.id} className={cn(colSpan, cellModifiers)}>
              {widget.type === 'STATS' && (
                // Three overview cards (Nodes Online / Total Messages /
                // Favorites). The Environment card was retired — average
                // temperature across the mesh wasn't actionable and the live
                // env data already surfaces on the Node Info panel per node.
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <StatCard label="Nodes Online" value={`${stats.offline + stats.online}`} subValue={`${stats.online} Active`} icon={<Wifi size={20} className="text-brand-accent"/>} />
                  <StatCard label="Total Messages" value={`${messages.length}`} subValue="Last hour" icon={<MessageSquare size={20} className="text-blue-400"/>} />
                  <StatCard label="Favorites" value={`${stats.favorites}`} subValue="Prioritized" icon={<Star size={20} className="text-yellow-400"/>} />
                </div>
              )}

              {widget.type === 'NODE_LIST' && (
                // h-full + flex-col so the panel fills the grid cell whose
                // height comes from NODE_DETAILS. The min-h-0 + overflow-hidden
                // on the OUTER grid cell (set up above via nodeListClasses)
                // is what actually makes this work — the cell can shrink
                // below its content height, so NODE_DETAILS drives the row.
                <div className="technical-panel h-full flex flex-col min-h-0">
                  <div className="p-4 border-b border-brand-line flex items-center justify-between flex-shrink-0">
                    <h3 className="font-bold flex items-center gap-2 text-xs uppercase tracking-widest text-brand-muted">
                      Active Network Peers
                      <span className="text-brand-muted/60 mono-text">({filteredNodes.length})</span>
                    </h3>
                    {someSelected && (
                      <span className="text-[10px] mono-text text-brand-accent">
                        {selectedIds.size} selected
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto">
                    <table className="w-full text-left">
                      <thead className="sticky top-0 z-10 bg-brand-bg">
                        <tr className="border-b border-brand-line bg-brand-line/20">
                          <th className="pl-4 py-2 w-8">
                            <button
                              onClick={() => allSelected ? clearSelection() : selectAll()}
                              title={allSelected ? 'Clear selection' : 'Select all'}
                              className={cn(
                                "w-4 h-4 rounded border flex items-center justify-center transition-colors",
                                allSelected
                                  ? "bg-brand-accent border-brand-accent text-black"
                                  : someSelected
                                  ? "bg-brand-accent/40 border-brand-accent/60 text-brand-accent"
                                  : "border-brand-muted/40 hover:border-brand-accent text-transparent hover:text-brand-accent/40"
                              )}
                            >
                              {(allSelected || someSelected) && <Check size={10} strokeWidth={3} />}
                            </button>
                          </th>
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted">Status</th>
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted">Node ID</th>
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted">Name</th>
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted hidden md:table-cell">Heard By</th>
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredNodes.map(node => {
                          const isChecked = selectedIds.has(node.id);
                          return (
                          <tr
                            key={node.id}
                            onClick={() => setSelectedNodeId(node.id)}
                            className={cn(
                              "group border-b border-brand-line/50 transition-all cursor-pointer",
                              isChecked
                                ? "bg-brand-accent/10 hover:bg-brand-accent/15"
                                : "hover:bg-brand-ink hover:text-brand-bg",
                              selectedNodeId === node.id && !isChecked && "bg-brand-line/30"
                            )}
                          >
                            <td className="pl-4 py-4 w-8">
                              <button
                                onClick={(e) => toggleSelection(node.id, e)}
                                title={isChecked ? 'Deselect' : 'Select (shift-click for range)'}
                                className={cn(
                                  "w-4 h-4 rounded border flex items-center justify-center transition-all",
                                  isChecked
                                    ? "bg-brand-accent border-brand-accent text-black"
                                    : "border-brand-muted/30 opacity-30 group-hover:opacity-100 hover:border-brand-accent text-transparent hover:text-brand-accent/40"
                                )}
                              >
                                {isChecked && <Check size={10} strokeWidth={3} />}
                              </button>
                            </td>
                            <td className="px-4 py-4">
                              <div className={cn(
                                "w-2 h-2 rounded-full",
                                node.online ? "bg-brand-accent status-glow-green" : "bg-red-500 status-glow-amber opacity-50"
                              )} />
                            </td>
                            <td className="px-4 py-4 data-value text-xs">{node.id}</td>
                            <td className="px-4 py-4">
                              <div className="flex items-center gap-2">
                                {node.shortName && (
                                  <span className="text-[10px] font-bold mono-text text-brand-accent bg-brand-accent/10 border border-brand-accent/30 px-1.5 py-0.5 rounded flex-shrink-0">
                                    {node.shortName}
                                  </span>
                                )}
                                <span className="font-medium">{node.name}</span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); onToggleFavorite(node.id, !node.favorite); }}
                                  title={node.favorite ? 'Unfavorite' : 'Favorite'}
                                  className={cn(
                                    "transition-colors",
                                    node.favorite
                                      ? "text-brand-warning hover:text-brand-warning/70"
                                      : "text-brand-muted/40 opacity-0 group-hover:opacity-100 hover:text-brand-warning"
                                  )}
                                >
                                  <Star size={12} fill={node.favorite ? 'currentColor' : 'none'} />
                                </button>
                                {node.sensors && <Activity size={12} className="text-brand-accent animate-pulse" />}
                              </div>
                            </td>
                            <td className="px-4 py-4 hidden md:table-cell">
                              <HeardByBadges nodeId={node.id} heardBy={node.heardByRadios ?? []} />
                            </td>
                            <td className="px-4 py-4 text-right">
                              <ArrowRight size={16} className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Floating bulk action bar — appears when ≥1 row selected */}
                  {someSelected && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 bg-brand-bg/95 backdrop-blur-md border border-brand-accent/40 rounded-lg shadow-2xl p-2 flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-brand-muted px-2">
                        {selectedIds.size} selected
                      </span>

                      {/* Move to group */}
                      <div className="relative">
                        <button
                          onClick={() => setShowGroupMenu(p => !p)}
                          disabled={bulkBusy}
                          className="flex items-center gap-1 bg-brand-line hover:bg-brand-line/70 border border-brand-line text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded px-2 py-1 transition-colors disabled:opacity-50"
                        >
                          {bulkBusy ? <Loader2 size={11} className="animate-spin" /> : null}
                          Move to group ▾
                        </button>
                        {showGroupMenu && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setShowGroupMenu(false)} />
                            <div className="absolute bottom-full mb-1 left-0 z-20 bg-brand-bg border border-brand-line rounded-lg shadow-xl min-w-[180px] overflow-hidden">
                              <button
                                onClick={() => bulkAssignGroup(undefined)}
                                className="w-full text-left px-3 py-2 text-[11px] hover:bg-brand-line/40 transition-colors flex items-center gap-2"
                              >
                                <span className="w-2 h-2 rounded-full border border-brand-muted/50" />
                                <span className="italic text-brand-muted">— Unassigned —</span>
                              </button>
                              {groups.map(g => (
                                <button
                                  key={g.id}
                                  onClick={() => bulkAssignGroup(g.id)}
                                  className="w-full text-left px-3 py-2 text-[11px] hover:bg-brand-line/40 transition-colors flex items-center gap-2"
                                >
                                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: g.color }} />
                                  <span>{g.name}</span>
                                </button>
                              ))}
                              {groups.length === 0 && (
                                <p className="px-3 py-2 text-[10px] text-brand-muted italic">No groups defined yet</p>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      {/* Star all / Unstar all */}
                      <button
                        onClick={() => bulkSetFavorite(true)}
                        disabled={bulkBusy}
                        title="Mark all selected as favorite"
                        className="flex items-center gap-1 bg-brand-line hover:bg-brand-warning/15 hover:border-brand-warning/40 border border-brand-line text-brand-ink hover:text-brand-warning text-[10px] font-bold uppercase tracking-widest rounded px-2 py-1 transition-colors disabled:opacity-50"
                      >
                        <Star size={11} />
                        Star
                      </button>
                      <button
                        onClick={() => bulkSetFavorite(false)}
                        disabled={bulkBusy}
                        title="Unfavorite all selected"
                        className="flex items-center gap-1 bg-brand-line hover:bg-brand-line/70 border border-brand-line text-brand-muted hover:text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded px-2 py-1 transition-colors disabled:opacity-50"
                      >
                        <Star size={11} className="opacity-60" />
                        Unstar
                      </button>

                      {/* Clear selection */}
                      <button
                        onClick={clearSelection}
                        title="Clear selection"
                        className="text-brand-muted hover:text-brand-ink p-1 rounded transition-colors"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {widget.type === 'NODE_DETAILS' && (
                <div className="technical-panel h-full flex flex-col">
                  {/* "NODE INFO" label — matches the typographic treatment of
                      "NETWORK OVERVIEW" / "ACTIVE NETWORK PEERS" so the panel
                      reads as a peer to the two stacked panels on its left. */}
                  <div className="px-4 pt-4 pb-2 border-b border-brand-line">
                    <h3 className="text-base font-bold tracking-tight uppercase">Node Info</h3>
                    <p className="text-[10px] text-brand-muted mono-text uppercase tracking-widest mt-0.5">
                      {selectedNode ? 'Selected node detail' : 'Select a node from the list'}
                    </p>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4">
                  {selectedNode ? (
                    <div className="space-y-6">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {selectedNode.shortName && (
                              <span className="text-xs font-bold mono-text text-brand-accent bg-brand-accent/10 border border-brand-accent/30 px-2 py-1 rounded flex-shrink-0">
                                {selectedNode.shortName}
                              </span>
                            )}
                            <h2 className="text-xl font-bold tracking-tighter truncate">{selectedNode.name}</h2>
                          </div>
                          <p className="mono-text text-brand-muted uppercase mt-1">{selectedNode.id}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => onToggleFavorite(selectedNode.id, !selectedNode.favorite)}
                            title={selectedNode.favorite ? 'Remove from favorites' : 'Mark as favorite'}
                            className={cn(
                              "p-2 rounded-lg transition-all border",
                              selectedNode.favorite
                                ? "bg-brand-warning/15 text-brand-warning border-brand-warning/40 hover:bg-brand-warning/25"
                                : "bg-brand-line text-brand-muted border-transparent hover:text-brand-warning hover:border-brand-warning/40"
                            )}
                          >
                            <Star size={14} fill={selectedNode.favorite ? 'currentColor' : 'none'} />
                          </button>
                          <button
                            onClick={() => setConfiguringNodeId(selectedNode.id)}
                            className="p-2 bg-brand-line hover:bg-brand-accent hover:text-black rounded-lg transition-all"
                          >
                            <Settings size={14} />
                          </button>
                        </div>
                      </div>

                      {/* Group assignment */}
                      {groups.length > 0 && (
                        <div className="flex items-center gap-2 -mt-2">
                          <span className="text-[10px] uppercase font-bold text-brand-muted">Group</span>
                          <select
                            value={selectedNode.groupId ?? ''}
                            onChange={(e) => onAssignGroup(selectedNode.id, e.target.value || undefined)}
                            className="flex-1 bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-xs mono-text focus:outline-none focus:border-brand-accent"
                          >
                            <option value="">— Unassigned —</option>
                            {groups.map(g => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                          </select>
                          {selectedNode.groupId && (
                            <span
                              className="w-3 h-3 rounded-full flex-shrink-0"
                              style={{ backgroundColor: groups.find(g => g.id === selectedNode.groupId)?.color ?? 'transparent' }}
                            />
                          )}
                        </div>
                      )}
                      <NodeDetailSections
                        node={selectedNode}
                        unitSystem={unitSystem}
                        dataSource={dataSource}
                      />
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-50">
                      <AlertCircle size={32} />
                      <p className="text-xs">Select node to view data</p>
                    </div>
                  )}
                  </div>
                </div>
              )}

              {widget.type === 'MAP' && (
                <DashboardMapWidget nodes={nodes} />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// v2.0 multi-radio: "Heard by" badge cluster shown in the node-list row.
// Each badge is the radio's 4-char short_name in its assigned color. Most
// recently heard is leftmost (matches the bridge's MRU ordering).
function HeardByBadges({ nodeId: _nodeId, heardBy }: { nodeId: string; heardBy: string[] }) {
  const { radios } = useRadios();
  if (heardBy.length === 0) {
    return <span className="text-[10px] text-brand-muted/50 mono-text">—</span>;
  }
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {heardBy.map(rid => {
        const row = radios.find(r => r.radio_id === rid);
        const color = row?.color_hex ?? '#888';
        return (
          <span
            key={rid}
            title={row?.long_name ?? rid}
            className="text-[9px] font-bold mono-text px-1.5 py-0.5 rounded border"
            style={{ color, borderColor: `${color}66`, background: `${color}1a` }}
          >
            {rid}
          </span>
        );
      })}
    </div>
  );
}
