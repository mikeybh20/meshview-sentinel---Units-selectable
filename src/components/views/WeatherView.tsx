/**
 * BBS Weather view — operator-side surface for the alert-push subscriber list.
 *
 * Subscriptions are created when a remote node sends `:weather subscribe ZIP`
 * over DM (server/bbs.ts) and stored in the bbs_weather_subscribers table
 * (radio_id stamped so a multi-radio operator can see WHICH radio each
 * subscriber opted in through). This view lists the current set with
 * subscribed-at + last-alert-at timestamps and provides operator-side
 * unsubscribe — useful when a subscriber has gone silent and you don't want
 * to keep burning airtime trying to push them alerts.
 *
 * Subscriber-initiated unsubscribe still works as before via `:weather
 * unsubscribe`; this is just the dashboard-side mirror.
 */

import React from 'react';
import { CloudRain, Trash2, RefreshCw, Download } from 'lucide-react';
import { Node } from '../../types';
import { cn } from '../../lib/utils';
import { meshDataService } from '../../services/meshDataService';
import { useRadios } from '../../hooks/useRadios';

interface WeatherViewProps {
  nodes: Node[];
}

interface SubscriberRow {
  nodeId: string;
  subscribedAt: number;
  channelIndex: number;
  lastAlertAt: number | null;
  radioId: string | null;
  /** v2.0 Beta 4: subscriber's requested ZIP (5 digits), or null to follow
   *  the operator's home ZIP. Displayed in the Zip column; the CSV export
   *  also carries it. */
  zip: string | null;
}

function relTime(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function absTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export function WeatherView({ nodes }: WeatherViewProps) {
  const { selectedRadioId, radios } = useRadios();
  const [subs, setSubs] = React.useState<SubscriberRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [removingId, setRemovingId] = React.useState<string | null>(null);

  const radioColors = React.useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const r of radios) if (r.color_hex) m[r.radio_id] = r.color_hex;
    return m;
  }, [radios]);

  const nodeLabel = (id: string) => {
    const n = nodes.find(nn => nn.id === id);
    if (!n) return id;
    return n.shortName ? `${n.shortName} · ${n.name || id}` : (n.name || id);
  };

  const reload = React.useCallback(async () => {
    setLoading(true);
    const r = await meshDataService.listWeatherSubscribers(selectedRadioId);
    setLoading(false);
    setSubs(r?.subscribers ?? []);
  }, [selectedRadioId]);

  React.useEffect(() => { reload(); }, [reload]);

  // SSE-driven refresh — the server emits bbsSubscriber on subscribe /
  // unsubscribe / alert-push so the list stays live without polling.
  React.useEffect(() => {
    return meshDataService.onBbsSubscriber(reload);
  }, [reload]);

  const handleRemove = async (nodeId: string) => {
    setRemovingId(nodeId);
    const r = await meshDataService.removeWeatherSubscriber(nodeId);
    setRemovingId(null);
    if (!r.ok) {
      // Surface the error to operator. In practice 404 (already gone) is the
      // only realistic failure — collapse to a soft re-fetch.
      console.error('removeWeatherSubscriber failed:', r.error);
    }
    reload();
  };

  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CloudRain size={20} className="text-brand-accent" />
          <div>
            <h2 className="text-base font-bold uppercase tracking-tight">Weather Subscribers</h2>
            <p className="text-[10px] text-brand-muted mt-0.5">
              Nodes opted in to BBS weather-alert push via <span className="mono-text">:weather subscribe ZIP</span>
              {selectedRadioId && <span> · scoped to <span className="mono-text">{selectedRadioId}</span></span>}
              {' · '}
              {subs.length} total
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/mesh/bbs/weather/subscribers/export.csv${selectedRadioId ? `?radio_id=${encodeURIComponent(selectedRadioId)}` : ''}`}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-brand-line hover:bg-brand-line/40 transition-colors"
            title="Download subscribers as CSV"
            download
          >
            <Download size={11} />
            EXPORT CSV
          </a>
          <button
            onClick={reload}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-brand-line hover:bg-brand-line/40 disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={cn(loading && 'animate-spin')} />
            REFRESH
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto technical-panel">
        {subs.length === 0 && !loading && (
          <div className="h-full flex items-center justify-center text-center max-w-md mx-auto p-8 opacity-70">
            <div className="space-y-2">
              <CloudRain size={36} className="mx-auto text-brand-muted" />
              <h3 className="text-base font-bold uppercase tracking-tight">No subscribers</h3>
              <p className="text-xs text-brand-muted">
                When a remote node sends <span className="mono-text">:weather subscribe ZIP</span> over
                DM, they show up here. Configure home ZIP + alert pollers in Settings → BBS.
              </p>
            </div>
          </div>
        )}
        {subs.length > 0 && (
          <table className="w-full text-xs">
            <thead className="border-b border-brand-line sticky top-0 bg-brand-bg/95 backdrop-blur z-10">
              <tr className="text-brand-muted">
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Node</th>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Radio</th>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]" title="Subscriber's requested ZIP. Empty = follow operator's home ZIP.">Zip</th>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Channel</th>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Subscribed</th>
                <th className="text-left py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Last alert</th>
                <th className="text-right py-2 px-3 font-bold uppercase tracking-widest text-[10px]">Action</th>
              </tr>
            </thead>
            <tbody>
              {subs.map(s => (
                <tr key={s.nodeId} className="border-b border-brand-line/40 hover:bg-brand-line/20 transition-colors">
                  <td className="py-2 px-3">
                    <div className="font-bold text-brand-ink">{nodeLabel(s.nodeId)}</div>
                    <div className="mono-text text-[10px] text-brand-muted">{s.nodeId}</div>
                  </td>
                  <td className="py-2 px-3">
                    {s.radioId ? (
                      <span
                        className="text-[10px] font-bold mono-text px-1.5 py-0.5 rounded border"
                        style={{
                          color: radioColors[s.radioId] ?? '#888',
                          borderColor: `${radioColors[s.radioId] ?? '#888'}55`,
                          background: `${radioColors[s.radioId] ?? '#888'}15`,
                        }}
                      >
                        {s.radioId}
                      </span>
                    ) : <span className="text-brand-muted text-[10px]">—</span>}
                  </td>
                  <td className="py-2 px-3 mono-text text-[10px]" title={s.zip ? 'Subscriber requested this ZIP' : 'Following operator home ZIP'}>
                    {s.zip
                      ? <span className="text-brand-ink">{s.zip}</span>
                      : <span className="text-brand-muted italic">home</span>}
                  </td>
                  <td className="py-2 px-3 mono-text text-[10px] text-brand-muted">
                    {s.channelIndex}
                  </td>
                  <td className="py-2 px-3" title={absTime(s.subscribedAt)}>
                    <span className="text-brand-ink">{relTime(s.subscribedAt)}</span>
                  </td>
                  <td className="py-2 px-3" title={s.lastAlertAt ? absTime(s.lastAlertAt) : 'No alert pushed yet'}>
                    <span className={s.lastAlertAt ? 'text-brand-ink' : 'text-brand-muted'}>
                      {relTime(s.lastAlertAt)}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right">
                    <button
                      onClick={() => handleRemove(s.nodeId)}
                      disabled={removingId === s.nodeId}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase font-bold tracking-tight rounded border border-brand-error/40 text-brand-error hover:bg-brand-error/10 disabled:opacity-50 transition-colors"
                      title="Operator-side unsubscribe (their device will silently stop receiving alerts)"
                    >
                      <Trash2 size={10} />
                      {removingId === s.nodeId ? '…' : 'REMOVE'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
