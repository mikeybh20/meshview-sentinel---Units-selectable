import React from 'react';
import { ArrowRight, X } from 'lucide-react';

import { Channel, Message, Node } from '../../types';
import { cn } from '../../lib/utils';

interface MatrixViewProps {
  nodes: Node[];
  messages: Message[];
  channels: Channel[];
}

type TimeRange = '1h' | '6h' | '24h' | 'all';
type ColorMode = 'count' | 'success';
type DestKind = 'channel' | 'dm';

interface CellStats {
  count: number;
  acked: number;
  sent: number;          // sent to radio but no ack yet
  errored: number;
  pending: number;       // 'sending' status
}

interface DestKey {
  /** 'chan:<index>' or 'dm:<nodeId>' */
  key: string;
  kind: DestKind;
  label: string;
  /** For DMs: the node id. For channels: the channel name. */
  raw: string;
}

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string; ms: number | null }[] = [
  { value: '1h',  label: 'Last 1h',  ms: 3600_000 },
  { value: '6h',  label: 'Last 6h',  ms: 6 * 3600_000 },
  { value: '24h', label: 'Last 24h', ms: 24 * 3600_000 },
  { value: 'all', label: 'All',      ms: null },
];

const TOP_N_OPTIONS = [10, 15, 25, 50];

function emptyStats(): CellStats {
  return { count: 0, acked: 0, sent: 0, errored: 0, pending: 0 };
}

/** Resolve a message's destination to a stable key + label pair. */
function destKeyForMessage(m: Message, channels: Channel[]): DestKey {
  // DM (specific recipient)
  if (m.to && m.to !== '!ffffffff') {
    return { key: `dm:${m.to}`, kind: 'dm', label: '', raw: m.to };
  }
  // Channel broadcast — match by name
  const ch = channels.find(c =>
    c.name === m.channel ||
    (c.role === 'PRIMARY' && (m.channel === 'LongFast' || m.channel === 'Broadcast' || m.channel === ''))
  );
  if (ch) {
    return {
      key: `chan:${ch.index}`,
      kind: 'channel',
      label: ch.name || (ch.role === 'PRIMARY' ? 'LongFast' : `Channel ${ch.index}`),
      raw: ch.name || `Channel ${ch.index}`,
    };
  }
  // Fall back: use raw channel string as the key
  return { key: `chan:${m.channel || 'broadcast'}`, kind: 'channel', label: m.channel || 'Broadcast', raw: m.channel || 'Broadcast' };
}

function destLabelFromKey(d: DestKey, nodes: Node[]): string {
  if (d.kind === 'channel') return `#${d.label || d.raw}`;
  const n = nodes.find(x => x.id === d.raw);
  if (!n) return d.raw;
  return `@${n.shortName || n.name || d.raw}`;
}

interface PairDetail {
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  totalMessages: number;
  successful: number;
  failed: number;
  pending: number;
  successRate: number | null;
  avgDeliveryMs: number | null;
  bestRoute: string[];
  relays: Array<{
    nodeId: string;
    nodeName: string;
    relayPercent: number;
    successRate: number;
    avgDeliveryMs: number | null;
    count: number;
  }>;
  windowMs: number;
}

export function MatrixView({ nodes, messages, channels }: MatrixViewProps) {
  const [timeRange, setTimeRange] = React.useState<TimeRange>('24h');
  const [topN, setTopN] = React.useState<number>(15);
  const [colorMode, setColorMode] = React.useState<ColorMode>('count');

  // Drill-down state — cells are clickable, the selected one slides a detail
  // panel in below the matrix with relay analysis and delivery stats. Channels
  // (broadcast destinations) skip the relay table since "everyone relays" on a
  // broadcast and the data isn't operationally useful.
  const [selectedCell, setSelectedCell] = React.useState<{ senderId: string; dest: DestKey } | null>(null);

  /**
   * Pair detail for the selected cell, computed client-side from the same
   * `messages` array that drives the matrix itself. We dropped the dedicated
   * /api/mesh/route-intel/pair fetch because:
   *   - The matrix already has all the messages it needs (the snapshot hits
   *     the server once and feeds both views from the same data).
   *   - Doing the rollup client-side means the simulator's generated messages
   *     work without any extra plumbing — toggle to simulator mode and the
   *     drill-down lights up immediately.
   *   - It removes a redundant network call on every cell click.
   * For broadcast (channel) destinations we still skip relay attribution —
   * "everyone relays" on a broadcast and the per-relay numbers are noise.
   */
  const pairDetail = React.useMemo<PairDetail | null>(() => {
    if (!selectedCell || selectedCell.dest.kind !== 'dm') return null;
    const fromId = selectedCell.senderId;
    const toId = selectedCell.dest.raw;
    const windowOpt = TIME_RANGE_OPTIONS.find(o => o.value === timeRange);
    const sinceMs = windowOpt?.ms != null ? Date.now() - windowOpt.ms : 0;

    const subset = messages.filter(m =>
      m.from === fromId &&
      m.to === toId &&
      m.timestamp >= sinceMs &&
      !m.isReaction,
    );

    if (subset.length === 0) {
      return {
        fromId, toId,
        fromName: nodes.find(n => n.id === fromId)?.name ?? fromId,
        toName: nodes.find(n => n.id === toId)?.name ?? toId,
        totalMessages: 0, successful: 0, failed: 0, pending: 0,
        successRate: null, avgDeliveryMs: null,
        bestRoute: [], relays: [],
        windowMs: windowOpt?.ms ?? 0,
      };
    }

    let successful = 0, failed = 0, pending = 0;
    let sumLatency = 0, latencySamples = 0;
    const relayCounts = new Map<string, { count: number; success: number; sumLatency: number; latencySamples: number }>();
    const routeCounts = new Map<string, number>();

    for (const m of subset) {
      if (m.status === 'acked') successful++;
      else if (m.status === 'error') failed++;
      else if (m.status === 'sending' || m.status === 'sent') pending++;
      else successful++; // received messages have no status — treat as delivered

      if (typeof m.deliveryMs === 'number') {
        sumLatency += m.deliveryMs;
        latencySamples += 1;
      }

      const hops = Array.isArray(m.hops) ? m.hops : [];
      const relays = hops.filter(h => h !== fromId && h !== toId);
      for (const r of relays) {
        let acc = relayCounts.get(r);
        if (!acc) { acc = { count: 0, success: 0, sumLatency: 0, latencySamples: 0 }; relayCounts.set(r, acc); }
        acc.count += 1;
        if (m.status === 'acked') acc.success += 1;
        if (typeof m.deliveryMs === 'number') {
          acc.sumLatency += m.deliveryMs;
          acc.latencySamples += 1;
        }
      }
      if (relays.length > 0) {
        const key = relays.join('>');
        routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
      }
    }

    let bestRoute: string[] = [];
    let bestRouteCount = 0;
    for (const [key, n] of routeCounts) {
      if (n > bestRouteCount) { bestRoute = key.split('>'); bestRouteCount = n; }
    }

    const total = subset.length;
    const totalEnded = successful + failed;
    const aggregateRelays = Array.from(relayCounts.entries()).map(([nodeId, a]) => ({
      nodeId,
      nodeName: nodes.find(n => n.id === nodeId)?.name || nodes.find(n => n.id === nodeId)?.shortName || nodeId,
      relayPercent: total ? (a.count / total) * 100 : 0,
      successRate: a.count ? (a.success / a.count) * 100 : 0,
      avgDeliveryMs: a.latencySamples ? a.sumLatency / a.latencySamples : null,
      count: a.count,
    })).sort((a, b) => b.count - a.count);

    return {
      fromId,
      toId,
      fromName: nodes.find(n => n.id === fromId)?.name ?? fromId,
      toName: nodes.find(n => n.id === toId)?.name ?? toId,
      totalMessages: total,
      successful,
      failed,
      pending,
      successRate: totalEnded ? (successful / totalEnded) * 100 : null,
      avgDeliveryMs: latencySamples ? sumLatency / latencySamples : null,
      bestRoute,
      relays: aggregateRelays,
      windowMs: windowOpt?.ms ?? 0,
    };
  }, [selectedCell, timeRange, messages, nodes]);

  const data = React.useMemo(() => {
    const cutoff = (TIME_RANGE_OPTIONS.find(o => o.value === timeRange)?.ms ?? null);
    const cutoffTs = cutoff === null ? 0 : Date.now() - cutoff;
    const filtered = cutoff === null ? messages : messages.filter(m => m.timestamp >= cutoffTs);

    // Aggregate: senderId → destKey → CellStats
    const matrix = new Map<string, Map<string, CellStats>>();
    const senderTotals = new Map<string, number>();
    const destInfo = new Map<string, DestKey>();
    const destTotals = new Map<string, number>();

    for (const m of filtered) {
      const senderId = m.from;
      if (!senderId) continue;

      const dest = destKeyForMessage(m, channels);
      destInfo.set(dest.key, dest);

      let row = matrix.get(senderId);
      if (!row) { row = new Map(); matrix.set(senderId, row); }
      let stats = row.get(dest.key);
      if (!stats) { stats = emptyStats(); row.set(dest.key, stats); }

      stats.count++;
      if (m.status === 'acked') stats.acked++;
      else if (m.status === 'sent') stats.sent++;
      else if (m.status === 'error') stats.errored++;
      else if (m.status === 'sending') stats.pending++;
      else stats.acked++; // received messages have no status — count as delivered

      senderTotals.set(senderId, (senderTotals.get(senderId) ?? 0) + 1);
      destTotals.set(dest.key, (destTotals.get(dest.key) ?? 0) + 1);
    }

    // Pick top-N senders by total messages
    const senderIds = Array.from(senderTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([id]) => id);

    // Destinations: keep all channels (operator wants to see them all) + top-N DMs
    const allDests = Array.from(destInfo.values());
    const channelDests = allDests
      .filter(d => d.kind === 'channel')
      .sort((a, b) => (destTotals.get(b.key) ?? 0) - (destTotals.get(a.key) ?? 0));
    const dmDests = allDests
      .filter(d => d.kind === 'dm')
      .sort((a, b) => (destTotals.get(b.key) ?? 0) - (destTotals.get(a.key) ?? 0))
      .slice(0, topN);
    const destinations = [...channelDests, ...dmDests];

    return {
      senderIds,
      destinations,
      matrix,
      totalFiltered: filtered.length,
      totalUnfiltered: messages.length,
      hiddenSenders: Math.max(0, senderTotals.size - senderIds.length),
      hiddenDms: Math.max(0, dmDests.length === topN
        ? allDests.filter(d => d.kind === 'dm').length - topN
        : 0),
    };
  }, [messages, nodes, channels, timeRange, topN]);

  const senderLabel = (id: string): string => {
    const n = nodes.find(x => x.id === id);
    if (!n) return id.slice(-4);
    return n.shortName || n.name || id.slice(-4);
  };

  // Cell coloring
  const cellStyle = (stats: CellStats | undefined): React.CSSProperties => {
    if (!stats || stats.count === 0) return { backgroundColor: 'transparent' };
    if (colorMode === 'count') {
      const intensity = Math.min(0.85, 0.12 + stats.count * 0.05);
      return { backgroundColor: `rgba(16, 185, 129, ${intensity})` };
    }
    // Success-rate coloring
    const successful = stats.acked;
    const failed = stats.errored;
    const total = stats.count;
    const rate = total > 0 ? successful / total : 0;
    if (failed > 0 && rate < 0.5) {
      // mostly failures — red intensity by count
      return { backgroundColor: `rgba(239, 68, 68, ${Math.min(0.7, 0.15 + total * 0.04)})` };
    }
    if (rate >= 0.85) {
      return { backgroundColor: `rgba(16, 185, 129, ${Math.min(0.7, 0.15 + total * 0.04)})` };
    }
    return { backgroundColor: `rgba(245, 158, 11, ${Math.min(0.7, 0.15 + total * 0.04)})` };
  };

  return (
    <div className="technical-panel flex-1 flex flex-col p-6 overflow-hidden">
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-widest text-brand-muted mb-1">Communication Matrix</h3>
          <p className="text-[10px] mono-text opacity-50">
            Sender (rows) → Destination (cols) · {data.totalFiltered}/{data.totalUnfiltered} messages in range
            {data.hiddenSenders > 0 && ` · +${data.hiddenSenders} senders hidden`}
            {data.hiddenDms > 0 && ` · +${data.hiddenDms} DM peers hidden`}
          </p>
        </div>

        {/* Filter controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label className="text-[9px] uppercase font-bold text-brand-muted">Range</label>
            <select
              value={timeRange}
              onChange={e => setTimeRange(e.target.value as TimeRange)}
              className="bg-brand-line text-[10px] mono-text rounded px-2 py-1 border border-transparent hover:border-brand-muted/30 focus:outline-none focus:border-brand-accent/50"
            >
              {TIME_RANGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[9px] uppercase font-bold text-brand-muted">Top</label>
            <select
              value={topN}
              onChange={e => setTopN(parseInt(e.target.value, 10))}
              className="bg-brand-line text-[10px] mono-text rounded px-2 py-1 border border-transparent hover:border-brand-muted/30 focus:outline-none focus:border-brand-accent/50"
            >
              {TOP_N_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[9px] uppercase font-bold text-brand-muted">Color</label>
            <div className="flex bg-brand-line rounded overflow-hidden border border-transparent">
              {(['count', 'success'] as ColorMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setColorMode(m)}
                  className={cn(
                    'text-[10px] font-bold uppercase tracking-tighter px-2 py-1 transition-colors',
                    colorMode === m
                      ? 'bg-brand-accent text-black'
                      : 'text-brand-muted hover:text-brand-ink'
                  )}
                >
                  {m === 'count' ? 'Count' : 'Success'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {data.senderIds.length === 0 || data.destinations.length === 0 ? (
          <div className="h-full flex items-center justify-center text-brand-muted opacity-50 italic">
            No messages in this time range.
          </div>
        ) : (
          <table className="border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-brand-bg">
              <tr>
                <th className="sticky left-0 z-20 bg-brand-bg border-b border-r border-brand-line px-3 py-2 text-[9px] uppercase font-bold text-brand-muted">
                  Sender ↓ / Dest →
                </th>
                {data.destinations.map(d => (
                  <th
                    key={d.key}
                    className={cn(
                      'border-b border-r border-brand-line px-2 py-2 text-[9px] uppercase font-bold text-brand-muted whitespace-nowrap',
                      d.kind === 'channel' ? 'text-brand-accent' : 'text-brand-ink/80'
                    )}
                  >
                    {destLabelFromKey(d, nodes)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.senderIds.map(senderId => (
                <tr key={senderId}>
                  <td className="sticky left-0 z-10 bg-brand-bg border-b border-r border-brand-line px-3 py-1.5 text-[10px] mono-text font-bold text-brand-ink/90 whitespace-nowrap">
                    {senderLabel(senderId)}
                  </td>
                  {data.destinations.map(d => {
                    const stats = data.matrix.get(senderId)?.get(d.key);
                    const isSelected = selectedCell?.senderId === senderId && selectedCell?.dest.key === d.key;
                    const clickable = !!stats && stats.count > 0;
                    return (
                      <td
                        key={d.key}
                        onClick={clickable ? () => {
                          if (isSelected) setSelectedCell(null);
                          else setSelectedCell({ senderId, dest: d });
                        } : undefined}
                        className={cn(
                          'border-b border-r border-brand-line text-center relative group h-9 min-w-[60px]',
                          clickable && 'cursor-pointer hover:brightness-125',
                          isSelected && 'outline outline-2 outline-brand-accent outline-offset-[-2px]',
                        )}
                        style={cellStyle(stats)}
                      >
                        <span className={cn(
                          'text-[11px] mono-text font-bold',
                          stats && stats.count > 0 ? 'text-brand-ink' : 'text-brand-muted/15'
                        )}>
                          {stats?.count ?? 0}
                        </span>

                        {stats && stats.count > 0 && (
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 bg-brand-bg border border-brand-accent/50 p-2.5 rounded shadow-xl hidden group-hover:block z-50 pointer-events-none">
                            <p className="text-[10px] font-bold text-brand-accent mb-1.5 uppercase tracking-tight">
                              {senderLabel(senderId)} → {destLabelFromKey(d, nodes)}
                            </p>
                            <div className="space-y-0.5 text-[9px] mono-text">
                              <p className="flex justify-between">
                                <span className="text-brand-muted">TOTAL:</span>
                                <span className="text-brand-ink">{stats.count}</span>
                              </p>
                              {stats.acked > 0 && (
                                <p className="flex justify-between">
                                  <span className="text-brand-muted">ACKED:</span>
                                  <span className="text-brand-accent">{stats.acked}</span>
                                </p>
                              )}
                              {stats.sent > 0 && (
                                <p className="flex justify-between">
                                  <span className="text-brand-muted">SENT (no ack):</span>
                                  <span className="text-brand-warning">{stats.sent}</span>
                                </p>
                              )}
                              {stats.pending > 0 && (
                                <p className="flex justify-between">
                                  <span className="text-brand-muted">PENDING:</span>
                                  <span className="text-brand-warning">{stats.pending}</span>
                                </p>
                              )}
                              {stats.errored > 0 && (
                                <p className="flex justify-between">
                                  <span className="text-brand-muted">ERRORED:</span>
                                  <span className="text-brand-error">{stats.errored}</span>
                                </p>
                              )}
                              <p className="flex justify-between border-t border-brand-line/50 pt-1 mt-1">
                                <span className="text-brand-muted">SUCCESS:</span>
                                <span className={cn(
                                  stats.count > 0 && stats.acked / stats.count >= 0.85 && 'text-brand-accent',
                                  stats.count > 0 && stats.acked / stats.count >= 0.5 && stats.acked / stats.count < 0.85 && 'text-brand-warning',
                                  stats.count > 0 && stats.acked / stats.count < 0.5 && 'text-brand-error',
                                )}>
                                  {Math.round((stats.acked / stats.count) * 100)}%
                                </span>
                              </p>
                            </div>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4 flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-12 h-3 bg-gradient-to-r from-emerald-500/15 to-emerald-500 rounded" />
          <span className="text-[10px] mono-text uppercase">
            {colorMode === 'count' ? 'Traffic Density' : 'High Success'}
          </span>
        </div>
        {colorMode === 'success' && (
          <>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-brand-warning/60 rounded" />
              <span className="text-[10px] mono-text uppercase">Mixed (50–85%)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-brand-error/60 rounded" />
              <span className="text-[10px] mono-text uppercase">Mostly Failed (&lt;50%)</span>
            </div>
          </>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[9px] mono-text uppercase opacity-60">Hover for breakdown · click for relay drill-down</span>
        </div>
      </div>

      {/* Pair drill-down — slides in below the matrix when a cell is clicked. */}
      {selectedCell && (
        <PairDetailPanel
          senderName={senderLabel(selectedCell.senderId)}
          dest={selectedCell.dest}
          destLabel={destLabelFromKey(selectedCell.dest, nodes)}
          isChannel={selectedCell.dest.kind === 'channel'}
          stats={data.matrix.get(selectedCell.senderId)?.get(selectedCell.dest.key)}
          detail={pairDetail}
          onClose={() => setSelectedCell(null)}
        />
      )}
    </div>
  );
}

/**
 * Detail panel that renders below the matrix when a cell is selected.
 * For DM destinations: pulls aggregate detail from /api/mesh/route-intel/pair
 * (delivery rate, avg latency, best route, per-relay table).
 * For channel destinations: just surfaces the basic per-cell counts that we
 * already have from the in-memory matrix — there's no useful relay attribution
 * for broadcast traffic since every router potentially relays.
 */
function PairDetailPanel({
  senderName, dest, destLabel, isChannel, stats, detail, onClose,
}: {
  senderName: string;
  dest: DestKey;
  destLabel: string;
  isChannel: boolean;
  stats: CellStats | undefined;
  detail: PairDetail | null;
  onClose: () => void;
}) {
  return (
    <div className="mt-4 border-t border-brand-line pt-4 flex flex-col gap-3 flex-shrink-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase font-bold text-brand-muted tracking-widest shrink-0">Pair Detail:</span>
          <span className="text-xs mono-text font-bold text-brand-ink truncate">{senderName}</span>
          <ArrowRight size={12} className="text-brand-accent shrink-0" />
          <span className="text-xs mono-text font-bold text-brand-ink truncate">{destLabel}</span>
        </div>
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-[10px] uppercase font-bold tracking-widest text-brand-muted hover:text-brand-ink transition-colors"
          title="Close drill-down"
        >
          <X size={11} /> Close
        </button>
      </div>

      {/* Stats row — always shown using local counts even before the network detail arrives. */}
      <div className="grid grid-cols-4 gap-2">
        <StatTile label="Total" value={stats?.count ?? 0} tone="ink" />
        <StatTile
          label="Acked"
          value={stats?.acked ?? 0}
          tone={stats && stats.count > 0 && stats.acked / stats.count >= 0.85 ? 'accent' : 'warning'}
        />
        <StatTile
          label="Errored"
          value={stats?.errored ?? 0}
          tone={stats && stats.errored > 0 ? 'error' : 'muted'}
        />
        <StatTile
          label="Avg latency"
          value={detail?.avgDeliveryMs != null ? `${Math.round(detail.avgDeliveryMs)} ms` : '—'}
          tone="ink"
        />
      </div>

      {isChannel ? (
        <div className="text-[10px] text-brand-muted leading-snug">
          <span className="text-brand-warning font-bold">Broadcast destination:</span> per-relay attribution isn't surfaced for channel traffic — on a broadcast every routing-capable node may relay, and the data isn't operationally useful per-pair. Use Topology view to see who's actually carrying broadcasts.
        </div>
      ) : detail ? (
        <PairDetailBody detail={detail} dest={dest} />
      ) : null}
    </div>
  );
}

function PairDetailBody({ detail, dest: _dest }: { detail: PairDetail; dest: DestKey }) {
  void _dest;
  return (
    <div className="space-y-3">
      {/* Most-common route */}
      {detail.bestRoute.length > 0 ? (
        <div>
          <p className="text-[9px] uppercase font-bold tracking-widest text-brand-muted mb-1.5">Most common route</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="px-2 py-0.5 bg-brand-accent/15 border border-brand-accent/40 text-brand-accent rounded text-[10px] mono-text font-bold">
              {detail.fromName}
            </span>
            {detail.bestRoute.map((id, i) => (
              <React.Fragment key={i}>
                <ArrowRight size={10} className="text-brand-muted shrink-0" />
                <span className="px-2 py-0.5 bg-brand-info/15 border border-brand-info/40 text-brand-info rounded text-[10px] mono-text font-bold">
                  {detail.relays.find(r => r.nodeId === id)?.nodeName ?? id}
                </span>
              </React.Fragment>
            ))}
            <ArrowRight size={10} className="text-brand-muted shrink-0" />
            <span className="px-2 py-0.5 bg-brand-accent/15 border border-brand-accent/40 text-brand-accent rounded text-[10px] mono-text font-bold">
              {detail.toName}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-[10px] text-brand-muted italic">No relay path observed — direct radio link, or insufficient hop data on logged messages.</p>
      )}

      {/* Relay table */}
      {detail.relays.length > 0 && (
        <div>
          <p className="text-[9px] uppercase font-bold tracking-widest text-brand-muted mb-1.5">Relay frequency &amp; quality</p>
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr className="bg-brand-line/30">
                <th className="px-2 py-1 text-left text-[9px] uppercase tracking-widest text-brand-muted font-bold">Node</th>
                <th className="px-2 py-1 text-right text-[9px] uppercase tracking-widest text-brand-muted font-bold">Relay %</th>
                <th className="px-2 py-1 text-right text-[9px] uppercase tracking-widest text-brand-muted font-bold">Success</th>
                <th className="px-2 py-1 text-right text-[9px] uppercase tracking-widest text-brand-muted font-bold">Avg latency</th>
              </tr>
            </thead>
            <tbody>
              {detail.relays.map(relay => (
                <tr key={relay.nodeId} className="border-b border-brand-line/30 hover:bg-brand-line/10 transition-colors">
                  <td className="px-2 py-1 text-[10px] mono-text font-bold text-brand-ink">{relay.nodeName}</td>
                  <td className="px-2 py-1 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1 bg-brand-line/40 rounded-full overflow-hidden">
                        <div className="h-full bg-brand-accent rounded-full" style={{ width: `${relay.relayPercent}%` }} />
                      </div>
                      <span className="text-[10px] mono-text w-10 text-right">{relay.relayPercent.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className={cn(
                    'px-2 py-1 text-right text-[10px] mono-text font-bold',
                    relay.successRate >= 85 ? 'text-brand-accent'
                    : relay.successRate >= 50 ? 'text-brand-warning'
                    : 'text-brand-error',
                  )}>
                    {relay.successRate.toFixed(0)}%
                  </td>
                  <td className="px-2 py-1 text-right text-[10px] mono-text text-brand-ink">
                    {relay.avgDeliveryMs != null ? `${Math.round(relay.avgDeliveryMs)} ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, tone }: {
  label: string;
  value: number | string;
  tone: 'ink' | 'accent' | 'warning' | 'error' | 'muted';
}) {
  const valueClass =
    tone === 'accent'  ? 'text-brand-accent'
    : tone === 'warning' ? 'text-brand-warning'
    : tone === 'error'   ? 'text-brand-error'
    : tone === 'muted'   ? 'text-brand-muted'
    :                       'text-brand-ink';
  return (
    <div className="bg-brand-line/30 border border-brand-line rounded px-2 py-1.5 text-center">
      <div className={`text-base font-bold mono-text ${valueClass}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-widest text-brand-muted mt-0.5">{label}</div>
    </div>
  );
}
