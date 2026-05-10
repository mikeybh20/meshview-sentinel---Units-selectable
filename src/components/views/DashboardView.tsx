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
} from 'lucide-react';
import { Map, Marker } from "pigeon-maps";

import { Node, Message, WidgetConfig, UnitSystem, Group } from '../../types';
import { cn } from '../../lib/utils';
import { StatCard } from '../ui/StatCard';
import { TelemetryItem } from '../ui/TelemetryItem';
import { SensorWidget } from '../SensorWidget';
import { simulator } from '../../services/meshtasticSimulator';
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

function DashboardMapWidget({ nodes }: { nodes: Node[] }) {
  const positioned = nodes.filter(n => n.position);

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

  return (
    <div className="technical-panel h-[360px] overflow-hidden relative">
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
          {positioned.map(node => (
            <Marker
              key={node.id}
              width={20}
              anchor={[node.position!.lat, node.position!.lng]}
              color="var(--color-brand-accent)"
            />
          ))}
        </Map>
      </div>
      <div className="absolute top-2 left-2 px-2 py-1 bg-brand-bg/80 backdrop-blur-md rounded text-[10px] font-bold uppercase tracking-widest border border-brand-line">
        Mesh Coverage
      </div>
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {dashboardWidgets.filter(w => w.visible).sort((a, b) => a.order - b.order).map(widget => {
          const colSpan = {
            full: 'lg:col-span-12',
            large: 'lg:col-span-8',
            medium: 'lg:col-span-6',
            small: 'lg:col-span-4'
          }[widget.width];

          return (
            <div key={widget.id} className={colSpan}>
              {widget.type === 'STATS' && (
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard label="Nodes Online" value={`${stats.offline + stats.online}`} subValue={`${stats.online} Active`} icon={<Wifi size={20} className="text-brand-accent"/>} />
                  <StatCard label="Total Messages" value={`${messages.length}`} subValue="Last hour" icon={<MessageSquare size={20} className="text-blue-400"/>} />
                  <StatCard label="Favorites" value={`${stats.favorites}`} subValue="Prioritized" icon={<Star size={20} className="text-yellow-400"/>} />
                  <StatCard 
                    label="Environment" 
                    value={nodes.some(n => n.sensors?.temperature) 
                      ? unitSystem === 'METRIC' 
                        ? `${(nodes.filter(n => n.sensors?.temperature).reduce((acc, n) => acc + n.sensors!.temperature!, 0) / nodes.filter(n => n.sensors?.temperature).length).toFixed(1)}°C`
                        : `${((nodes.filter(n => n.sensors?.temperature).reduce((acc, n) => acc + n.sensors!.temperature!, 0) / nodes.filter(n => n.sensors?.temperature).length) * 9/5 + 32).toFixed(1)}°F` 
                      : "N/A"} 
                    subValue={nodes.some(n => n.sensors?.humidity)
                      ? `Humidity ${(nodes.filter(n => n.sensors?.humidity).reduce((acc, n) => acc + n.sensors!.humidity!, 0) / nodes.filter(n => n.sensors?.humidity).length).toFixed(0)}%`
                      : "No Data"} 
                    icon={<Activity size={20} className="text-purple-400"/>} 
                  />
                </div>
              )}

              {widget.type === 'NODE_LIST' && (
                <div className="technical-panel h-full flex flex-col min-h-0 max-h-[70vh] relative">
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
                <div className="technical-panel p-4 h-full">
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
                        <div className="grid grid-cols-2 gap-4">
                          <TelemetryItem icon={<Signal size={14}/>} label="RSSI" value={`${selectedNode.telemetry?.rssi} dBm`} />
                          <TelemetryItem icon={<Activity size={14}/>} label="SNR" value={`${selectedNode.telemetry?.snr} dB`} />
                          {selectedNode.telemetry?.distance && (
                            <TelemetryItem 
                              icon={<ArrowsUpFromLine size={14}/>} 
                              label="Distance" 
                              value={unitSystem === 'METRIC' 
                                ? `${selectedNode.telemetry.distance.toFixed(2)} km` 
                                : `${(selectedNode.telemetry.distance * 0.621371).toFixed(2)} mi`
                              } 
                            />
                          )}
                          {selectedNode.position?.alt && (
                            <TelemetryItem 
                              icon={<Compass size={14}/>} 
                              label="Altitude" 
                              value={unitSystem === 'METRIC' 
                                ? `${selectedNode.position.alt.toFixed(0)} m` 
                                : `${(selectedNode.position.alt * 3.28084).toFixed(0)} ft`
                              } 
                            />
                          )}
                        </div>
                      <div className="space-y-2">
                        <p className="text-[10px] text-brand-muted uppercase font-bold tracking-widest">Location Data</p>
                        <div className="p-3 bg-brand-line/30 rounded border border-brand-line mono-text space-y-1 text-[10px]">
                          <p className="flex justify-between"><span>LAT:</span> <span className="text-brand-ink">{selectedNode.position?.lat.toFixed(6)}</span></p>
                          <p className="flex justify-between"><span>LNG:</span> <span className="text-brand-ink">{selectedNode.position?.lng.toFixed(6)}</span></p>
                        </div>
                      </div>

                      {/* Time-series telemetry chart — battery, signal, environment.
                          Lazy-loaded; recharts is heavy. */}
                      <React.Suspense fallback={
                        <div className="h-44 bg-brand-bg/40 rounded border border-brand-line/50 flex items-center justify-center">
                          <Loader2 size={16} className="animate-spin text-brand-muted" />
                        </div>
                      }>
                        <TelemetryChart nodeId={selectedNode.id} />
                      </React.Suspense>

                      {/* Per-node uptime / availability stats sourced from the
                          `node_sessions` table. Not all nodes have enough history
                          to show meaningful peak hours yet — the widget gracefully
                          degrades when we have no observations in the window. */}
                      <NodeUptimeWidget
                        nodeId={selectedNode.id}
                        currentlyOnline={selectedNode.online}
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
              )}

              {widget.type === 'MESSAGES' && (
                <div className="technical-panel h-[360px] flex flex-col">
                  <div className="p-4 border-b border-brand-line">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-brand-muted flex items-center gap-2">
                      <MessageSquare size={14} /> Recent Network Traffic
                    </h3>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {messages.slice(-10).reverse().map(m => (
                      <div key={m.id} className="text-[10px]">
                        <div className="flex justify-between text-brand-muted mb-0.5">
                          <span className="font-bold">{nodes.find(n => n.id === m.from)?.name || m.from}</span>
                          <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div className="p-2 bg-brand-line/20 rounded border border-brand-line italic">
                          {m.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {widget.type === 'MAP' && (
                <DashboardMapWidget nodes={nodes} />
              )}

              {widget.type === 'SENSOR_DATA' && (
                <div className="technical-panel p-4 h-full">
                  <SensorWidget node={selectedNode || null} allNodes={nodes} unitSystem={unitSystem} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
