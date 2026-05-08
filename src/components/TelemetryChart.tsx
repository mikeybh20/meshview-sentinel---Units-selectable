import React from 'react';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  CartesianGrid,
} from 'recharts';

import { meshDataService } from '../services/meshDataService';

interface TelemetrySample {
  timestamp: number;
  battery?: number;
  voltage?: number;
  chUtil?: number;
  airUtilTx?: number;
  snr?: number;
  rssi?: number;
  temperature?: number;
  humidity?: number;
  pressure?: number;
}

interface TelemetryChartProps {
  nodeId: string;
  /** How many samples to pull (server cap is 2000). Default 200. */
  limit?: number;
}

type Tab = 'signal' | 'power' | 'environment';

interface TabDef {
  key: Tab;
  label: string;
  /** Returns null if none of the relevant metrics have any data → we'll grey out the tab. */
  hasData: (samples: TelemetrySample[]) => boolean;
  /** Series shown on this tab. */
  series: Array<{
    key: keyof TelemetrySample;
    label: string;
    color: string;
    yAxisId: 'left' | 'right';
    unit: string;
  }>;
  /** Axis labels for left/right. */
  axes: {
    left: { label: string; domain?: [number | 'auto' | 'dataMin', number | 'auto' | 'dataMax'] };
    right?: { label: string; domain?: [number | 'auto' | 'dataMin', number | 'auto' | 'dataMax'] };
  };
}

const TABS: TabDef[] = [
  {
    key: 'signal',
    label: 'Signal',
    hasData: (s) => s.some(r => r.snr !== null && r.snr !== undefined) || s.some(r => r.rssi !== null && r.rssi !== undefined),
    series: [
      { key: 'snr',  label: 'SNR',  color: '#10b981', yAxisId: 'left',  unit: 'dB' },
      { key: 'rssi', label: 'RSSI', color: '#f59e0b', yAxisId: 'right', unit: 'dBm' },
    ],
    axes: {
      left:  { label: 'SNR (dB)',   domain: ['dataMin', 'dataMax'] },
      right: { label: 'RSSI (dBm)', domain: ['dataMin', 'dataMax'] },
    },
  },
  {
    key: 'power',
    label: 'Power',
    hasData: (s) => s.some(r => r.battery !== null && r.battery !== undefined) || s.some(r => r.voltage !== null && r.voltage !== undefined),
    series: [
      { key: 'battery', label: 'Battery', color: '#10b981', yAxisId: 'left',  unit: '%' },
      { key: 'voltage', label: 'Voltage', color: '#60a5fa', yAxisId: 'right', unit: 'V' },
    ],
    axes: {
      left:  { label: 'Battery (%)', domain: [0, 100] },
      right: { label: 'Voltage (V)', domain: ['dataMin', 'dataMax'] },
    },
  },
  {
    key: 'environment',
    label: 'Environment',
    hasData: (s) =>
      s.some(r => r.temperature !== null && r.temperature !== undefined) ||
      s.some(r => r.humidity !== null && r.humidity !== undefined) ||
      s.some(r => r.pressure !== null && r.pressure !== undefined),
    series: [
      { key: 'temperature', label: 'Temp',     color: '#f59e0b', yAxisId: 'left',  unit: '°C' },
      { key: 'humidity',    label: 'Humidity', color: '#60a5fa', yAxisId: 'left',  unit: '%' },
      { key: 'pressure',    label: 'Pressure', color: '#a78bfa', yAxisId: 'right', unit: 'hPa' },
    ],
    axes: {
      left:  { label: '°C / %',      domain: ['dataMin', 'dataMax'] },
      right: { label: 'Pressure',    domain: ['dataMin', 'dataMax'] },
    },
  },
];

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const ageMs = now - ts;
  // < 24h → time only; otherwise short date + time
  if (ageMs < 24 * 3600_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function TelemetryChart({ nodeId, limit = 200 }: TelemetryChartProps) {
  const [samples, setSamples] = React.useState<TelemetrySample[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [activeTab, setActiveTab] = React.useState<Tab>('signal');

  const reload = React.useCallback(async () => {
    setLoading(true);
    const rows = await meshDataService.fetchTelemetryHistory(nodeId, limit);
    // Server returns newest-first; recharts wants oldest-first for left-to-right flow
    setSamples(rows.slice().reverse());
    setLoading(false);
  }, [nodeId, limit]);

  React.useEffect(() => { reload(); }, [reload]);

  // Auto-refresh every 30s while mounted — telemetry typically ticks every few minutes.
  React.useEffect(() => {
    const t = setInterval(() => { reload(); }, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  const tab = TABS.find(t => t.key === activeTab) ?? TABS[0];
  const tabHasData = tab.hasData(samples);

  // Fall back to whichever tab has data if the active one is empty (only on first load)
  React.useEffect(() => {
    if (samples.length === 0) return;
    if (!tab.hasData(samples)) {
      const next = TABS.find(t => t.hasData(samples));
      if (next) setActiveTab(next.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples.length]);

  // Recharts data shape — array of objects with timestamp + each metric key
  const chartData = samples.map(s => ({
    ts: s.timestamp,
    label: formatTimestamp(s.timestamp),
    battery: s.battery ?? null,
    voltage: s.voltage ?? null,
    snr: s.snr ?? null,
    rssi: s.rssi ?? null,
    temperature: s.temperature ?? null,
    humidity: s.humidity ?? null,
    pressure: s.pressure ?? null,
  }));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={12} className="text-brand-accent" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Telemetry History</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] mono-text text-brand-muted">
            {loading ? '...' : `${samples.length} sample${samples.length === 1 ? '' : 's'}`}
          </span>
          <button
            onClick={reload}
            disabled={loading}
            title="Refresh now"
            className="p-1 text-brand-muted hover:text-brand-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex items-center gap-1 border-b border-brand-line">
        {TABS.map(t => {
          const enabled = t.hasData(samples);
          return (
            <button
              key={t.key}
              onClick={() => enabled && setActiveTab(t.key)}
              disabled={!enabled}
              className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 transition-colors border-b-2 -mb-px ${
                activeTab === t.key
                  ? 'text-brand-accent border-brand-accent'
                  : enabled
                    ? 'text-brand-muted border-transparent hover:text-brand-ink'
                    : 'text-brand-muted/30 border-transparent cursor-not-allowed'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Chart body */}
      <div className="h-44 bg-black/40 rounded border border-brand-line/50 p-2">
        {loading && samples.length === 0 ? (
          <div className="h-full flex items-center justify-center text-brand-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : !tabHasData ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-[10px] text-brand-muted italic">No {tab.label.toLowerCase()} samples recorded yet</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                interval="preserveStartEnd"
                minTickGap={40}
                axisLine={{ stroke: '#1e293b' }}
                tickLine={false}
              />
              <YAxis
                yAxisId="left"
                tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                axisLine={{ stroke: '#1e293b' }}
                tickLine={false}
                domain={tab.axes.left.domain ?? ['auto', 'auto']}
                width={36}
              />
              {tab.axes.right && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  axisLine={{ stroke: '#1e293b' }}
                  tickLine={false}
                  domain={tab.axes.right.domain ?? ['auto', 'auto']}
                  width={42}
                />
              )}
              <Tooltip
                contentStyle={{
                  background: '#020617',
                  border: '1px solid #1e293b',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
                labelStyle={{ color: '#94a3b8', fontSize: '10px' }}
                itemStyle={{ padding: '0 0' }}
                formatter={(value: any, _name: any, props: any) => {
                  if (value === null || value === undefined) return ['—', props.dataKey];
                  const series = tab.series.find(s => s.key === props.dataKey);
                  return [`${typeof value === 'number' ? value.toFixed(1) : value} ${series?.unit ?? ''}`, series?.label ?? props.dataKey];
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '9px', fontFamily: 'JetBrains Mono, monospace' }}
                iconSize={8}
              />
              {tab.series.map(s => (
                <Line
                  key={String(s.key)}
                  yAxisId={s.yAxisId}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                  name={s.label}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
