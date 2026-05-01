import React from 'react';
import { Node } from '../../types';
import { cn } from '../../lib/utils';
import { 
  RouteAnalyticsService, 
  PairAnalysis, 
  NodeUptimeStats, 
  SendWindow 
} from '../../services/routeAnalytics';
import { simulator } from '../../services/meshtasticSimulator';
import { 
  ArrowRight, 
  Clock, 
  Radio, 
  Shield, 
  TrendingUp, 
  Zap,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface RouteIntelViewProps {
  nodes: Node[];
}

export function RouteIntelView({ nodes }: RouteIntelViewProps) {
  const [pairAnalyses, setPairAnalyses] = React.useState<PairAnalysis[]>([]);
  const [uptimeStats, setUptimeStats] = React.useState<NodeUptimeStats[]>([]);
  const [selectedPairIdx, setSelectedPairIdx] = React.useState<number | null>(null);
  const [sendWindows, setSendWindows] = React.useState<SendWindow[]>([]);
  const [expandedUptime, setExpandedUptime] = React.useState<string | null>(null);

  // Refresh analytics every 5 seconds
  React.useEffect(() => {
    const refresh = () => {
      const routes = simulator.getRouteHistory();
      const uptime = simulator.getUptimeHistory();
      setPairAnalyses(RouteAnalyticsService.analyzePairs(routes, nodes));
      setUptimeStats(RouteAnalyticsService.analyzeUptime(uptime, nodes));
    };

    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [nodes]);

  // Compute send windows when a pair is selected
  React.useEffect(() => {
    if (selectedPairIdx !== null && pairAnalyses[selectedPairIdx]) {
      const windows = RouteAnalyticsService.computeSendWindows(
        pairAnalyses[selectedPairIdx],
        uptimeStats
      );
      setSendWindows(windows);
    } else {
      setSendWindows([]);
    }
  }, [selectedPairIdx, pairAnalyses, uptimeStats]);

  const selectedPair = selectedPairIdx !== null ? pairAnalyses[selectedPairIdx] : null;

  return (
    <div className="h-full flex flex-col gap-6 overflow-hidden">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold tracking-tight text-white">ROUTE INTELLIGENCE</h2>
        <p className="text-xs text-brand-muted mono-text uppercase">Relay analysis &middot; Uptime patterns &middot; Send-time optimization</p>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 overflow-hidden min-h-0">
        {/* Left Column: Pair List + Uptime */}
        <div className="lg:col-span-4 flex flex-col gap-4 overflow-hidden">
          {/* Communication Pairs */}
          <div className="technical-panel flex-1 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-brand-line">
              <h3 className="text-xs font-bold uppercase tracking-widest text-brand-muted flex items-center gap-2">
                <Radio size={14} className="text-brand-accent" /> Communication Pairs
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto">
              {pairAnalyses.length === 0 ? (
                <div className="p-8 text-center text-brand-muted text-xs italic opacity-50">
                  Collecting route data... Messages will appear here.
                </div>
              ) : (
                pairAnalyses.map((pair, idx) => (
                  <button
                    key={`${pair.from}-${pair.to}`}
                    onClick={() => setSelectedPairIdx(idx === selectedPairIdx ? null : idx)}
                    className={cn(
                      "w-full text-left p-3 border-b border-brand-line/30 transition-all hover:bg-brand-line/20",
                      selectedPairIdx === idx && "bg-brand-accent/10 border-l-2 border-l-brand-accent"
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] font-bold truncate">{pair.fromName}</span>
                      <ArrowRight size={10} className="text-brand-accent shrink-0" />
                      <span className="text-[11px] font-bold truncate">{pair.toName}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[9px] mono-text text-brand-muted">
                      <span>{pair.totalMessages} msgs</span>
                      <span className={pair.successRate > 80 ? "text-emerald-400" : pair.successRate > 50 ? "text-amber-400" : "text-red-400"}>
                        {pair.successRate.toFixed(0)}% delivered
                      </span>
                      <span>{pair.relays.length} relay(s)</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Node Uptime */}
          <div className="technical-panel flex-1 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-brand-line">
              <h3 className="text-xs font-bold uppercase tracking-widest text-brand-muted flex items-center gap-2">
                <Clock size={14} className="text-brand-accent" /> Node Uptime
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto">
              {uptimeStats.map(stat => (
                <div key={stat.nodeId} className="border-b border-brand-line/30">
                  <button
                    onClick={() => setExpandedUptime(expandedUptime === stat.nodeId ? null : stat.nodeId)}
                    className="w-full text-left p-3 hover:bg-brand-line/20 transition-all"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <div className={cn("w-1.5 h-1.5 rounded-full", stat.online ? "bg-brand-accent" : "bg-red-500")} />
                        <span className="text-[11px] font-bold">{stat.nodeName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "text-[10px] mono-text font-bold",
                          stat.uptimePercent > 80 ? "text-emerald-400" : stat.uptimePercent > 50 ? "text-amber-400" : "text-red-400"
                        )}>
                          {stat.uptimePercent.toFixed(0)}%
                        </span>
                        {expandedUptime === stat.nodeId ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </div>
                    </div>
                    {/* Uptime bar */}
                    <div className="w-full h-1.5 bg-brand-line/30 rounded-full overflow-hidden">
                      <div 
                        className={cn(
                          "h-full rounded-full transition-all",
                          stat.uptimePercent > 80 ? "bg-emerald-500" : stat.uptimePercent > 50 ? "bg-amber-500" : "bg-red-500"
                        )}
                        style={{ width: `${stat.uptimePercent}%` }}
                      />
                    </div>
                  </button>
                  {expandedUptime === stat.nodeId && (
                    <div className="px-3 pb-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-[9px]">
                        <div className="p-2 bg-brand-line/20 rounded border border-brand-line">
                          <p className="text-brand-muted uppercase font-bold tracking-widest mb-0.5">Sessions</p>
                          <p className="mono-text font-bold text-sm">{stat.sessions.length}</p>
                        </div>
                        <div className="p-2 bg-brand-line/20 rounded border border-brand-line">
                          <p className="text-brand-muted uppercase font-bold tracking-widest mb-0.5">Avg Session</p>
                          <p className="mono-text font-bold text-sm">{formatDuration(stat.avgSessionMs)}</p>
                        </div>
                      </div>
                      {stat.peakHours.length > 0 && (
                        <div className="p-2 bg-brand-line/10 rounded border border-brand-line">
                          <p className="text-[9px] text-brand-muted uppercase font-bold tracking-widest mb-1">Peak Hours</p>
                          <div className="flex flex-wrap gap-1">
                            {stat.peakHours.map(h => (
                              <span key={h} className="px-1.5 py-0.5 bg-brand-accent/20 text-brand-accent rounded text-[8px] mono-text font-bold">
                                {h.toString().padStart(2, '0')}:00
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Detail Panel */}
        <div className="lg:col-span-8 flex flex-col gap-4 overflow-hidden">
          {selectedPair ? (
            <>
              {/* Relay Analysis */}
              <div className="technical-panel flex-none">
                <div className="p-4 border-b border-brand-line">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-brand-muted flex items-center gap-2">
                    <Shield size={14} className="text-brand-accent" />
                    Relay Analysis: {selectedPair.fromName} → {selectedPair.toName}
                  </h3>
                </div>
                <div className="p-4">
                  {/* Best route visualization */}
                  <div className="mb-4">
                    <p className="text-[10px] text-brand-muted uppercase font-bold tracking-widest mb-2">Most Common Route</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-1 bg-brand-accent/20 text-brand-accent rounded text-[10px] font-bold mono-text">
                        {selectedPair.fromName}
                      </span>
                      {selectedPair.bestRoute.map((hopId, i) => {
                        const hopName = nodes.find(n => n.id === hopId)?.name || hopId;
                        return (
                          <React.Fragment key={i}>
                            <ArrowRight size={12} className="text-brand-muted" />
                            <span className="px-2 py-1 bg-blue-500/20 text-blue-400 rounded text-[10px] font-bold mono-text">
                              {hopName}
                            </span>
                          </React.Fragment>
                        );
                      })}
                      <ArrowRight size={12} className="text-brand-muted" />
                      <span className="px-2 py-1 bg-brand-accent/20 text-brand-accent rounded text-[10px] font-bold mono-text">
                        {selectedPair.toName}
                      </span>
                    </div>
                  </div>

                  {/* Stats row */}
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="p-3 bg-brand-line/20 rounded border border-brand-line text-center">
                      <p className="text-[9px] text-brand-muted uppercase font-bold tracking-widest mb-1">Delivery Rate</p>
                      <p className={cn(
                        "text-lg font-bold mono-text",
                        selectedPair.successRate > 80 ? "text-emerald-400" : selectedPair.successRate > 50 ? "text-amber-400" : "text-red-400"
                      )}>
                        {selectedPair.successRate.toFixed(0)}%
                      </p>
                    </div>
                    <div className="p-3 bg-brand-line/20 rounded border border-brand-line text-center">
                      <p className="text-[9px] text-brand-muted uppercase font-bold tracking-widest mb-1">Avg Latency</p>
                      <p className="text-lg font-bold mono-text text-brand-ink">{selectedPair.avgDeliveryMs.toFixed(0)}ms</p>
                    </div>
                    <div className="p-3 bg-brand-line/20 rounded border border-brand-line text-center">
                      <p className="text-[9px] text-brand-muted uppercase font-bold tracking-widest mb-1">Total Messages</p>
                      <p className="text-lg font-bold mono-text text-brand-ink">{selectedPair.totalMessages}</p>
                    </div>
                  </div>

                  {/* Relay table */}
                  {selectedPair.relays.length > 0 && (
                    <div>
                      <p className="text-[10px] text-brand-muted uppercase font-bold tracking-widest mb-2">Relay Node Frequency</p>
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-brand-line bg-brand-line/20">
                            <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-brand-muted">Node</th>
                            <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-brand-muted text-right">Relay %</th>
                            <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-brand-muted text-right">Success</th>
                            <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-brand-muted text-right">Avg Latency</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedPair.relays.map(relay => (
                            <tr key={relay.nodeId} className="border-b border-brand-line/30 hover:bg-brand-line/10 transition-colors">
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <div className={cn(
                                    "w-1.5 h-1.5 rounded-full",
                                    nodes.find(n => n.id === relay.nodeId)?.online ? "bg-brand-accent" : "bg-red-500"
                                  )} />
                                  <span className="text-[11px] font-bold">{relay.nodeName}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-16 h-1.5 bg-brand-line/30 rounded-full overflow-hidden">
                                    <div className="h-full bg-brand-accent rounded-full" style={{ width: `${relay.relayPercent}%` }} />
                                  </div>
                                  <span className="text-[10px] mono-text font-bold w-10 text-right">{relay.relayPercent.toFixed(0)}%</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <span className={cn(
                                  "text-[10px] mono-text font-bold",
                                  relay.successRate > 80 ? "text-emerald-400" : relay.successRate > 50 ? "text-amber-400" : "text-red-400"
                                )}>
                                  {relay.successRate.toFixed(0)}%
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right text-[10px] mono-text">{relay.avgDeliveryMs.toFixed(0)}ms</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* Send Window Heatmap */}
              <div className="technical-panel flex-1 flex flex-col overflow-hidden">
                <div className="p-4 border-b border-brand-line">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-brand-muted flex items-center gap-2">
                    <Zap size={14} className="text-brand-accent" />
                    Optimal Send Windows (24h)
                  </h3>
                  <p className="text-[9px] mono-text text-brand-muted mt-1">
                    Score based on relay node availability — higher = more relays expected online
                  </p>
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="grid grid-cols-12 gap-1">
                    {sendWindows.map(w => {
                      const bg = w.score >= 80 ? 'bg-emerald-500' : w.score >= 50 ? 'bg-amber-500' : w.score >= 20 ? 'bg-red-500' : 'bg-brand-line/30';
                      return (
                        <div key={w.hour} className="flex flex-col items-center gap-1 group relative">
                          <div
                            className={cn("w-full rounded transition-all", bg)}
                            style={{ height: `${Math.max(8, w.score * 0.6)}px`, opacity: 0.3 + w.score / 150 }}
                          />
                          <span className="text-[8px] mono-text text-brand-muted">{w.hour.toString().padStart(2, '0')}</span>
                          {/* Tooltip */}
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-36 bg-brand-bg border border-brand-accent p-2 rounded shadow-xl hidden group-hover:block z-50 pointer-events-none">
                            <p className="text-[9px] font-bold text-brand-accent mb-1">{w.hour.toString().padStart(2, '0')}:00 — Score: {w.score}</p>
                            <p className="text-[8px] mono-text text-brand-muted">
                              {w.onlineRelays.length}/{w.totalRelays} relays online
                            </p>
                            {w.onlineRelays.length > 0 && (
                              <p className="text-[8px] mono-text text-brand-ink mt-0.5">{w.onlineRelays.join(', ')}</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Legend */}
                  <div className="mt-4 flex items-center gap-4">
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-emerald-500 rounded opacity-80" />
                      <span className="text-[9px] mono-text uppercase">Optimal (80%+)</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-amber-500 rounded opacity-80" />
                      <span className="text-[9px] mono-text uppercase">Fair (50-79%)</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-red-500 rounded opacity-80" />
                      <span className="text-[9px] mono-text uppercase">Poor (&lt;50%)</span>
                    </div>
                  </div>

                  {/* Best time callout */}
                  {sendWindows.length > 0 && (
                    <BestTimeCallout windows={sendWindows} />
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="technical-panel flex-1 flex flex-col items-center justify-center text-center p-8 opacity-50">
              <TrendingUp size={40} className="mb-4 text-brand-muted" />
              <p className="text-sm font-bold uppercase tracking-widest text-brand-muted mb-2">Select a Communication Pair</p>
              <p className="text-xs text-brand-muted max-w-sm">
                Choose a source → destination pair from the left panel to view relay analysis, 
                delivery statistics, and optimal send windows.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BestTimeCallout({ windows }: { windows: SendWindow[] }) {
  const best = [...windows].sort((a, b) => b.score - a.score)[0];
  if (!best || best.score === 0) return null;

  // Find contiguous block of best hours
  const goodHours = windows.filter(w => w.score >= 80).map(w => w.hour).sort((a, b) => a - b);
  let rangeStr = '';
  if (goodHours.length > 1) {
    rangeStr = `${goodHours[0].toString().padStart(2, '0')}:00 – ${goodHours[goodHours.length - 1].toString().padStart(2, '0')}:59`;
  } else if (goodHours.length === 1) {
    rangeStr = `${goodHours[0].toString().padStart(2, '0')}:00`;
  }

  return (
    <div className="mt-4 p-3 bg-brand-accent/5 border border-brand-accent/20 rounded-lg">
      <div className="flex items-center gap-2 mb-1">
        <Zap size={14} className="text-brand-accent" />
        <p className="text-[10px] font-bold uppercase tracking-widest text-brand-accent">Recommended Send Time</p>
      </div>
      <p className="text-xs text-brand-ink">
        {goodHours.length > 0 
          ? `Best window: ${rangeStr} — ${best.onlineRelays.length}/${best.totalRelays} critical relays expected online (score: ${best.score})`
          : `Peak score at ${best.hour.toString().padStart(2, '0')}:00 with ${best.onlineRelays.length}/${best.totalRelays} relays (score: ${best.score})`
        }
      </p>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}
