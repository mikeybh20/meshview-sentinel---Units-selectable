/**
 * v3.0 Mesh Ops Intelligence — operator dashboard tab.
 *
 * First panel (this slice): per-channel traffic analytics.
 * Additional panels land in follow-up slices:
 *   - Connectivity matrix ("who can hear whom" — RF adjacency)
 *   - Firmware & health (per-node firmware version vs. current
 *     stable, config-drift flags)
 *
 * The traffic panel shows:
 *   1. Time range picker (1h / 6h / 24h / 7d) + radio scope from
 *      useRadios() (matches WeatherView / StormReportsView).
 *   2. Summary tiles — per-channel packet totals across the range,
 *      colored by the messaging-vs-position-vs-telemetry breakdown.
 *   3. Time-series area chart — stacked packet counts per channel
 *      by hour bucket, so the operator can see when the mesh
 *      "wakes up" (rush hour, weather events, weekly drills).
 *
 * Data source: /api/mesh/ops/channel-traffic and
 * /api/mesh/ops/channel-traffic/totals (server-side rollup, no
 * per-packet queries).
 */
import React from 'react';
import { Activity, RefreshCw, Signal, BarChart3 } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Legend, CartesianGrid,
} from 'recharts';
import { ChannelTrafficRow, ChannelTrafficTotal, Node, NeighborInfoSnapshot } from '../../types';
import { cn } from '../../lib/utils';
import { meshDataService } from '../../services/meshDataService';
import { useRadios } from '../../hooks/useRadios';

interface MeshOpsViewProps {
  nodes: Node[];
  neighborInfo: NeighborInfoSnapshot[];
}

type OpsSubTab = 'analytics' | 'connectivity';

type TimeRange = '1h' | '6h' | '24h' | '7d';

const TIME_RANGE_OPTIONS: Array<{ value: TimeRange; label: string; ms: number }> = [
  { value: '1h',  label: 'Last 1h',  ms: 3600_000 },
  { value: '6h',  label: 'Last 6h',  ms: 6 * 3600_000 },
  { value: '24h', label: 'Last 24h', ms: 24 * 3600_000 },
  { value: '7d',  label: 'Last 7d',  ms: 7 * 24 * 3600_000 },
];

/** Channel color palette — matches Meshtastic's convention where
 *  PRIMARY (index 0) is the "default long-fast" everyone sees. */
const CHANNEL_COLORS: readonly string[] = [
  '#10b981', // 0 — emerald (PRIMARY / LongFast)
  '#f59e0b', // 1 — amber
  '#8b5cf6', // 2 — violet
  '#ec4899', // 3 — pink
  '#06b6d4', // 4 — cyan
  '#f43f5e', // 5 — rose
  '#84cc16', // 6 — lime
  '#a855f7', // 7 — purple
];

function channelColor(idx: number): string {
  return CHANNEL_COLORS[idx % CHANNEL_COLORS.length];
}

/** Human-friendly channel label. Meshtastic doesn't expose channel
 *  names in the traffic rollup (we only capture the index), so we
 *  fall back to "CH N" — the operator's Channels config panel
 *  is where the real name-to-index mapping lives. */
function channelLabel(idx: number): string {
  if (idx === 0) return 'CH0 (Primary)';
  return `CH${idx}`;
}

/** Format bytes as a compact human string. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Format a bucket timestamp as a compact chart-axis label. */
function fmtHour(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  // Include the day when spanning >24h — the chart X-axis needs
  // to disambiguate "Tue 15:00" from "Wed 15:00".
  const range = window.__meshOpsRange;
  const showDay = range === '7d';
  if (showDay) {
    const day = d.toLocaleDateString([], { weekday: 'short' });
    return `${day} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

// Global so fmtHour can access the current range without prop-drilling
// through Recharts internals. Scoped to window to avoid module state
// leaking across page navigations.
declare global {
  interface Window { __meshOpsRange?: TimeRange }
}

/** Reshape the flat row list into a chart-friendly shape:
 *  one object per hour_bucket with a `ch<N>` field per channel.
 *  Missing (bucket, channel) combinations get 0 so the area chart
 *  draws a continuous baseline instead of gaps. */
function rowsToChartData(
  rows: ChannelTrafficRow[],
  activeChannels: number[],
): Array<{ hourBucket: number; [key: `ch${number}`]: number }> {
  const byBucket = new Map<number, { hourBucket: number; [key: string]: number }>();
  for (const r of rows) {
    let bucket = byBucket.get(r.hourBucket);
    if (!bucket) {
      bucket = { hourBucket: r.hourBucket };
      for (const c of activeChannels) bucket[`ch${c}`] = 0;
      byBucket.set(r.hourBucket, bucket);
    }
    bucket[`ch${r.channelIndex}`] = (bucket[`ch${r.channelIndex}`] ?? 0) + r.packetCount;
  }
  return Array.from(byBucket.values()).sort((a, b) => a.hourBucket - b.hourBucket) as any;
}

/**
 * Top-level Mesh Ops shell. Sub-tab strip switches between:
 *   - Analytics    (per-channel traffic — this slice's headline)
 *   - Connectivity ("who can hear whom" RF adjacency matrix)
 * Future sub-tab:
 *   - Health       (firmware versions, config drift)
 */
export function MeshOpsView({ nodes, neighborInfo }: MeshOpsViewProps) {
  const [subTab, setSubTab] = React.useState<OpsSubTab>('analytics');
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-6 pt-4">
        <SubTabButton
          active={subTab === 'analytics'}
          onClick={() => setSubTab('analytics')}
          icon={<BarChart3 size={14} />}
          label="Analytics"
        />
        <SubTabButton
          active={subTab === 'connectivity'}
          onClick={() => setSubTab('connectivity')}
          icon={<Signal size={14} />}
          label="Connectivity"
        />
      </div>
      <div className="flex-1 overflow-hidden">
        {subTab === 'analytics' && <MeshOpsAnalyticsPanel />}
        {subTab === 'connectivity' && (
          <MeshOpsConnectivityPanel nodes={nodes} neighborInfo={neighborInfo} />
        )}
      </div>
    </div>
  );
}

function SubTabButton({
  active, onClick, icon, label,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase font-bold tracking-widest rounded border transition-colors',
        active
          ? 'bg-brand-accent/15 border-brand-accent/50 text-brand-accent'
          : 'bg-brand-line/40 border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-muted/30',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function MeshOpsAnalyticsPanel() {
  const { selectedRadioId } = useRadios();
  const [rows, setRows] = React.useState<ChannelTrafficRow[]>([]);
  const [totals, setTotals] = React.useState<ChannelTrafficTotal[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [range, setRange] = React.useState<TimeRange>('24h');

  // Publish range so fmtHour (called inside Recharts) can see it.
  React.useEffect(() => { window.__meshOpsRange = range; }, [range]);

  const reload = React.useCallback(async () => {
    setLoading(true);
    const rangeMs = TIME_RANGE_OPTIONS.find(o => o.value === range)?.ms ?? 24 * 3600_000;
    const since = Date.now() - rangeMs;
    const [r, t] = await Promise.all([
      meshDataService.listChannelTraffic({
        radioId: selectedRadioId ?? undefined,
        since,
        limit: 10000,
      }),
      meshDataService.channelTrafficTotals({
        radioId: selectedRadioId ?? undefined,
        since,
      }),
    ]);
    setRows(r ?? []);
    setTotals(t ?? []);
    setLoading(false);
  }, [selectedRadioId, range]);

  React.useEffect(() => { reload(); }, [reload]);

  // Auto-refresh every 60s while the tab is open. Traffic rollups are
  // hourly-bucketed so faster refresh doesn't buy anything; the 60s
  // cadence keeps the "current hour" bucket visibly incrementing as
  // packets arrive without polling wastefully.
  React.useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  // Compute active channels — the ones with any traffic in the
  // current range. Prevents an empty CH7 legend entry cluttering
  // the chart when no traffic ever crossed CH7 in the window.
  const activeChannels = React.useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) set.add(r.channelIndex);
    return Array.from(set).sort((a, b) => a - b);
  }, [rows]);

  const chartData = React.useMemo(
    () => rowsToChartData(rows, activeChannels),
    [rows, activeChannels],
  );

  // Grand totals for the top-of-page summary row.
  const grandTotal = totals.reduce(
    (acc, t) => ({
      packets: acc.packets + t.packetCount,
      bytes:   acc.bytes + t.byteCount,
      msg:     acc.msg + t.portMsg,
      pos:     acc.pos + t.portPos,
      tele:    acc.tele + t.portTele,
    }),
    { packets: 0, bytes: 0, msg: 0, pos: 0, tele: 0 },
  );

  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
      {/* Header + controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity size={20} className="text-brand-accent" />
          <div>
            <h2 className="text-base font-bold uppercase tracking-tight">Mesh Ops · Channel Traffic</h2>
            <p className="text-[10px] text-brand-muted mt-0.5">
              Per-channel packet + byte counts, hourly bucketed
              {selectedRadioId && <span> · scoped to <span className="mono-text">{selectedRadioId}</span></span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={e => setRange(e.target.value as TimeRange)}
            className="bg-brand-line/40 border border-brand-line rounded px-2 py-1 text-xs mono-text"
          >
            {TIME_RANGE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={reload}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-brand-line hover:bg-brand-line/40 disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            REFRESH
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
        <SummaryTile label="Total packets"    value={grandTotal.packets.toLocaleString()} />
        <SummaryTile label="Total bytes"      value={fmtBytes(grandTotal.bytes)} />
        <SummaryTile label="Chat packets"     value={grandTotal.msg.toLocaleString()}  sub="TEXT_MESSAGE" />
        <SummaryTile label="Position packets" value={grandTotal.pos.toLocaleString()}  sub="POSITION" />
        <SummaryTile label="Telemetry"        value={grandTotal.tele.toLocaleString()} sub="TELEMETRY" />
      </div>

      {/* Per-channel breakdown row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
        {totals.map(t => {
          const color = channelColor(t.channelIndex);
          const other = t.packetCount - t.portMsg - t.portPos - t.portTele;
          return (
            <div key={t.channelIndex} className="technical-panel p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-xs font-bold uppercase tracking-tight">{channelLabel(t.channelIndex)}</span>
                <span className="ml-auto text-xs mono-text text-brand-muted">
                  {t.packetCount.toLocaleString()} pkt
                </span>
              </div>
              {/* Stacked mini-bar for the port breakdown */}
              <div className="h-2 rounded overflow-hidden flex bg-brand-line/40 mb-2">
                {t.portMsg  > 0 && <div style={{ width: `${(t.portMsg / t.packetCount) * 100}%`,  backgroundColor: '#22d3ee' }} title={`Chat: ${t.portMsg}`} />}
                {t.portPos  > 0 && <div style={{ width: `${(t.portPos / t.packetCount) * 100}%`,  backgroundColor: '#a3e635' }} title={`Position: ${t.portPos}`} />}
                {t.portTele > 0 && <div style={{ width: `${(t.portTele / t.packetCount) * 100}%`, backgroundColor: '#fbbf24' }} title={`Telemetry: ${t.portTele}`} />}
                {other > 0 && <div style={{ width: `${(other / t.packetCount) * 100}%`, backgroundColor: '#64748b' }} title={`Other: ${other}`} />}
              </div>
              <div className="text-[10px] mono-text text-brand-muted flex justify-between">
                <span>{fmtBytes(t.byteCount)}</span>
                <span>chat {t.portMsg} · pos {t.portPos} · tel {t.portTele}</span>
              </div>
            </div>
          );
        })}
        {totals.length === 0 && !loading && (
          <div className="md:col-span-2 lg:col-span-4 technical-panel p-6 text-center text-brand-muted text-xs">
            No traffic recorded in the selected range yet.
          </div>
        )}
      </div>

      {/* Time-series chart */}
      <div className="flex-1 technical-panel p-3 min-h-[300px] overflow-hidden">
        <div className="text-[10px] uppercase font-bold tracking-widest text-brand-muted mb-2">
          Packets per hour, stacked by channel
        </div>
        {chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-brand-muted text-xs">
            {loading ? 'Loading...' : 'No hourly buckets in range.'}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="90%">
            <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
              <XAxis
                dataKey="hourBucket"
                tickFormatter={fmtHour}
                stroke="rgba(148,163,184,0.7)"
                fontSize={10}
              />
              <YAxis
                stroke="rgba(148,163,184,0.7)"
                fontSize={10}
              />
              <Tooltip
                labelFormatter={(v: number) => new Date(v).toLocaleString()}
                contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(148,163,184,0.3)', borderRadius: 4, fontSize: 11 }}
              />
              <Legend
                iconType="rect"
                wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                formatter={(value: string) => {
                  const idx = parseInt(value.replace('ch', ''), 10);
                  return channelLabel(idx);
                }}
              />
              {activeChannels.map(c => (
                <Area
                  key={c}
                  type="monotone"
                  dataKey={`ch${c}`}
                  stackId="1"
                  stroke={channelColor(c)}
                  fill={channelColor(c)}
                  fillOpacity={0.4}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/**
 * "Who can hear whom" — RF adjacency matrix.
 *
 * Data source: NeighborInfo packets each node emits, each reporting
 * a list of nodes that node has directly heard on-air. This is
 * DIRECTED — A→B means "A observed B's transmissions" — so the
 * matrix is deliberately not symmetric, and cells that ARE
 * asymmetric are a signal (usually an antenna problem at one end).
 *
 * Cell semantics:
 *   diagonal (A→A)        — muted gray dot (self)
 *   A hears B, B hears A  — solid colored dot, SNR-tinted
 *   A hears B, B silent   — solid dot with a red "!" indicator
 *   never observed        — empty cell
 *
 * SNR color scale (LoRa convention):
 *   > 10 dB   emerald (excellent)
 *   0..10 dB  amber   (usable)
 *   < 0 dB    rose    (marginal — often decoded but risky)
 *
 * Only nodes that appear as a reporter OR as a reported neighbor
 * are shown. Nodes with no observed adjacency at all are hidden so
 * a mesh of 400 nodes doesn't render 400×400 blank cells.
 */
function MeshOpsConnectivityPanel({
  nodes,
  neighborInfo,
}: {
  nodes: Node[];
  neighborInfo: NeighborInfoSnapshot[];
}) {
  const nodeLookup = React.useMemo(() => {
    const m = new Map<string, Node>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Build the adjacency graph as edges: reporter -> {heard, snr}.
  const { edges, participatingNodeIds } = React.useMemo(() => {
    const edges = new Map<string, Map<string, number>>();
    const participating = new Set<string>();
    for (const snap of neighborInfo) {
      const reporter = snap.fromNodeId;
      participating.add(reporter);
      let row = edges.get(reporter);
      if (!row) { row = new Map(); edges.set(reporter, row); }
      for (const obs of snap.neighbors ?? []) {
        row.set(obs.nodeId, obs.snr);
        participating.add(obs.nodeId);
      }
    }
    return { edges, participatingNodeIds: participating };
  }, [neighborInfo]);

  // Only nodes that participate — either as a reporter or as
  // reported neighbor. Sort by shortName so the matrix header is
  // scannable.
  const rows = React.useMemo(() => {
    const list = Array.from(participatingNodeIds).map(id => {
      const n = nodeLookup.get(id);
      return {
        id,
        label: n?.shortName || id.slice(-4),
        longName: n?.name || id,
      };
    });
    list.sort((a, b) => a.label.localeCompare(b.label));
    return list;
  }, [participatingNodeIds, nodeLookup]);

  const [hoveredCell, setHoveredCell] = React.useState<{ from: string; to: string } | null>(null);

  const total = rows.length;
  // Directed-edge count.
  const edgeCount = Array.from(edges.values()).reduce((sum, r) => sum + r.size, 0);
  // Asymmetric edge count — pairs where A→B exists but B→A doesn't.
  const asymmetricCount = React.useMemo(() => {
    let n = 0;
    for (const [a, aRow] of edges.entries()) {
      for (const b of aRow.keys()) {
        const bRow = edges.get(b);
        if (!bRow || !bRow.has(a)) n++;
      }
    }
    return n;
  }, [edges]);

  if (total === 0) {
    return (
      <div className="h-full flex flex-col p-6 gap-4">
        <div className="flex items-center gap-3">
          <Signal size={20} className="text-brand-accent" />
          <div>
            <h2 className="text-base font-bold uppercase tracking-tight">Mesh Ops · Connectivity</h2>
            <p className="text-[10px] text-brand-muted mt-0.5">RF adjacency from NeighborInfo</p>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center text-brand-muted text-xs text-center max-w-md mx-auto">
          <div>
            <Signal size={24} className="mx-auto mb-3 opacity-40" />
            No NeighborInfo observations yet. Nodes with the NeighborInfo module enabled broadcast their direct-heard neighbor list on a configurable interval (default 1 hour). Once at least one node broadcasts, its adjacency will appear here.
            <div className="mt-3 text-[10px]">
              Enable the module in Settings → Modules → NeighborInfo.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Signal size={20} className="text-brand-accent" />
          <div>
            <h2 className="text-base font-bold uppercase tracking-tight">Mesh Ops · Connectivity</h2>
            <p className="text-[10px] text-brand-muted mt-0.5">
              RF adjacency from NeighborInfo · {total} node{total === 1 ? '' : 's'} · {edgeCount} directed edge{edgeCount === 1 ? '' : 's'}
              {asymmetricCount > 0 && (
                <span className="text-brand-warning"> · {asymmetricCount} asymmetric (possible antenna issue)</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-brand-muted">
          <LegendSwatch color="#10b981" label="SNR > 10dB" />
          <LegendSwatch color="#f59e0b" label="0-10dB" />
          <LegendSwatch color="#f43f5e" label="< 0dB" />
        </div>
      </div>

      {/* Matrix grid — sticky headers for both row and column so the
          operator can scroll a large mesh without losing orientation. */}
      <div className="flex-1 technical-panel overflow-auto">
        <table className="border-collapse text-[10px] mono-text">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 bg-brand-bg border border-brand-line px-2 py-1 text-brand-muted uppercase font-bold tracking-widest text-[9px] whitespace-nowrap">
                Rep. \\ Heard →
              </th>
              {rows.map(r => (
                <th
                  key={r.id}
                  className={cn(
                    'sticky top-0 z-10 bg-brand-bg border border-brand-line px-1 py-1 text-brand-muted whitespace-nowrap',
                    hoveredCell?.to === r.id && 'text-brand-accent bg-brand-accent/10',
                  )}
                  title={r.longName}
                >
                  <span style={{ writingMode: 'vertical-rl' }} className="inline-block">
                    {r.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(from => {
              const fromRow = edges.get(from.id);
              return (
                <tr key={from.id}>
                  <th
                    className={cn(
                      'sticky left-0 z-10 bg-brand-bg border border-brand-line px-2 py-1 text-brand-muted text-left whitespace-nowrap',
                      hoveredCell?.from === from.id && 'text-brand-accent bg-brand-accent/10',
                    )}
                    title={from.longName}
                  >
                    {from.label}
                  </th>
                  {rows.map(to => {
                    if (from.id === to.id) {
                      return (
                        <td
                          key={to.id}
                          className="border border-brand-line/40 w-6 h-6 text-center align-middle"
                        >
                          <span className="text-brand-muted/40">·</span>
                        </td>
                      );
                    }
                    const snr = fromRow?.get(to.id);
                    const hasEdge = snr !== undefined;
                    // Reciprocal check for asymmetry marker.
                    const reciprocalRow = edges.get(to.id);
                    const isAsymmetric = hasEdge && (!reciprocalRow || !reciprocalRow.has(from.id));
                    return (
                      <td
                        key={to.id}
                        onMouseEnter={() => setHoveredCell({ from: from.id, to: to.id })}
                        onMouseLeave={() => setHoveredCell(null)}
                        className={cn(
                          'border border-brand-line/40 w-6 h-6 text-center align-middle relative',
                          hoveredCell?.from === from.id && hoveredCell?.to === to.id && 'ring-2 ring-brand-accent ring-inset',
                        )}
                        title={hasEdge
                          ? `${from.label} → ${to.label}: SNR ${snr!.toFixed(1)}dB${isAsymmetric ? ' (asymmetric — not heard back)' : ''}`
                          : `No observation: ${from.label} → ${to.label}`}
                      >
                        {hasEdge && (
                          <span
                            className="inline-block rounded-full"
                            style={{
                              width: 10,
                              height: 10,
                              backgroundColor: snrToColor(snr!),
                            }}
                          />
                        )}
                        {isAsymmetric && (
                          <span className="absolute top-0 right-0.5 text-brand-warning text-[8px] font-bold leading-none">!</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Reading hint — matrix conventions aren't universal. */}
      <div className="text-[10px] text-brand-muted leading-snug border-t border-brand-line pt-2">
        <strong>Reading:</strong> row R × column C shows "R observed C directly on-air".
        The <span className="text-brand-warning font-bold">!</span> marker means R heard C but
        C did NOT report hearing R back — often an antenna gain / polarization asymmetry at
        one end. Requires NeighborInfo module enabled on the observer nodes.
      </div>
    </div>
  );
}

/** Map SNR (dB) to a color per the standard LoRa link-budget bucket
 *  conventions. -20dB is roughly the demod floor for SF12; 10dB+ is
 *  a very strong link. */
function snrToColor(snrDb: number): string {
  if (snrDb >= 10) return '#10b981';  // emerald
  if (snrDb >= 0)  return '#f59e0b';  // amber
  return '#f43f5e';                    // rose
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block rounded-full" style={{ width: 8, height: 8, backgroundColor: color }} />
      {label}
    </span>
  );
}

function SummaryTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="technical-panel p-3">
      <div className="text-[10px] uppercase font-bold tracking-widest text-brand-muted">
        {label}
      </div>
      <div className="text-xl font-bold mono-text mt-0.5">{value}</div>
      {sub && <div className="text-[9px] uppercase tracking-widest text-brand-muted mt-0.5">{sub}</div>}
    </div>
  );
}
