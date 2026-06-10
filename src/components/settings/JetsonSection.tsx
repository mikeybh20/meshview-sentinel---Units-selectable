/**
 * v2.1 — JetsonGuideSection + JetsonLiveStatsPanel + StatBar extracted
 * from SettingsModal.tsx.
 *
 * Live Jetson Nano / Orin stats panel + setup help link, lazy-loaded so
 * the live-poll SSE wiring + chart components only enter the bundle when
 * Settings → Jetson Nano is opened.
 */
import React from 'react';
import { AlertCircle, Cpu, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { MarkdownGuide } from './MarkdownGuide';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Local section header. Inline-duplicated per section. */
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h4 className="text-sm font-bold uppercase tracking-tight text-brand-ink">{title}</h4>
      <p className="text-[11px] text-brand-muted mt-0.5">{subtitle}</p>
    </div>
  );
}

function JetsonGuideSection() {
  return (
    <div className="space-y-6">
      <JetsonLiveStatsPanel />
      <MarkdownGuide
        title="Jetson Nano Deployment"
        description="Considerations for running Sentinel on a Jetson Nano 2GB — RAM budget, microSD wear vs. SSD recommendations, pre-deployment checklist, and common gotchas specific to the Jetson platform."
        icon={<Cpu size={16} className="text-brand-accent" />}
        loadContent={async () => {
          const m = await import('../../constants/jetsonNanoGuide');
          return m.JETSON_NANO_GUIDE;
        }}
        downloadFilename="MeshView-Sentinel-Jetson-Nano-Guide.md"
        displayFilename="jetson-nano.md"
      />
    </div>
  );
}

/**
 * v2.0 Beta 5 — Live tegrastats-equivalent panel.
 *
 * Polls /api/system/jetson-stats every POLL_MS when the panel is mounted
 * AND auto-refresh is on. Manual refresh button for one-off snapshots.
 * Server caches results for 2s so multiple tabs don't each fire their
 * own /proc/stat sample.
 *
 * Renders on any Linux host (RAM / CPU / thermal work everywhere) but
 * labels itself "Jetson stats" only when the device-tree compatible
 * string identifies as Tegra/Jetson. Non-Jetson hosts get the generic
 * "System stats" header so the panel still feels useful.
 */
interface JetsonStatsSnapshot {
  capturedAt: number;
  isJetson: boolean;
  jetsonModel: string | null;
  uptimeSecs: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  ramTotalMb: number;
  ramUsedMb: number;
  ramFreeMb: number;
  ramCachedMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  cpuCount: number;
  cpuUtilPercent: number;
  cpuPerCore: Array<{ id: number; utilPercent: number; freqKhz: number | null }>;
  thermal: Array<{ zone: string; tempC: number }>;
  gpuLoadPercent: number | null;
  gpuFreqMhz: number | null;
}

function JetsonLiveStatsPanel() {
  const [snap, setSnap] = React.useState<JetsonStatsSnapshot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = React.useState(true);

  // 5s polling cadence. Server caches for 2s anyway so this is gentle.
  const POLL_MS = 5_000;

  const fetchNow = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/api/system/jetson-stats`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error || `HTTP ${res.status}`);
      } else {
        setSnap(await res.json());
      }
    } catch (e: any) {
      setErr(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  React.useEffect(() => { fetchNow(); }, [fetchNow]);

  // Polling
  React.useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchNow, POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, fetchNow]);

  const titleLabel = snap?.isJetson ? 'Jetson Live Stats' : 'System Live Stats';
  const subLabel = snap?.isJetson
    ? `${snap.jetsonModel ?? 'Jetson'} — tegrastats-equivalent, sampled via /proc + /sys (no sudo, no host shell). Refreshes every ${POLL_MS / 1000}s when auto-refresh is on.`
    : `Reading /proc + /sys for CPU / RAM / thermal. Same panel works on non-Jetson hosts; Jetson-specific GPU stats are absent here. Refreshes every ${POLL_MS / 1000}s when auto-refresh is on.`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-widest text-brand-ink">{titleLabel}</h4>
          <p className="text-[10px] text-brand-muted mt-0.5">{subLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] text-brand-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="accent-brand-accent"
            />
            <span className="uppercase font-bold tracking-widest">Auto</span>
          </label>
          <button
            onClick={fetchNow}
            disabled={loading}
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {err && (
        <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 text-red-300 text-[11px] px-3 py-2">
          <AlertCircle size={12} className="mt-0.5" />
          <span>{err}</span>
        </div>
      )}

      {snap && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* CPU + load */}
          <div className="rounded border border-brand-line bg-brand-bg/40 p-3 space-y-2">
            <h5 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">CPU</h5>
            <StatBar label={`Overall · ${snap.cpuCount} cores`} percent={snap.cpuUtilPercent} unit="%" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1">
              {snap.cpuPerCore.map(c => (
                <div key={c.id} className="rounded border border-brand-line/60 bg-brand-bg/30 p-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] mono-text text-brand-muted">cpu{c.id}</span>
                    <span className="text-[10px] font-bold mono-text text-brand-ink">{c.utilPercent}%</span>
                  </div>
                  {c.freqKhz != null && (
                    <div className="text-[9px] mono-text text-brand-muted/80 mt-0.5">
                      {Math.round(c.freqKhz / 1000)}MHz
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="pt-1 text-[10px] mono-text text-brand-muted/80">
              Load: {snap.loadAvg1.toFixed(2)} · {snap.loadAvg5.toFixed(2)} · {snap.loadAvg15.toFixed(2)}
              <span className="text-brand-muted/60"> (1m / 5m / 15m)</span>
            </div>
          </div>

          {/* RAM + swap */}
          <div className="rounded border border-brand-line bg-brand-bg/40 p-3 space-y-2">
            <h5 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Memory</h5>
            <StatBar
              label={`RAM ${snap.ramUsedMb} / ${snap.ramTotalMb} MB`}
              percent={snap.ramTotalMb > 0 ? Math.round((snap.ramUsedMb / snap.ramTotalMb) * 100) : 0}
              unit="%"
            />
            <div className="text-[10px] mono-text text-brand-muted/80">
              Free: {snap.ramFreeMb} MB · Cached: {snap.ramCachedMb} MB
            </div>
            {snap.swapTotalMb > 0 && (
              <>
                <StatBar
                  label={`Swap ${snap.swapUsedMb} / ${snap.swapTotalMb} MB`}
                  percent={Math.round((snap.swapUsedMb / snap.swapTotalMb) * 100)}
                  unit="%"
                  tone="warning"
                />
              </>
            )}
            <div className="pt-1 text-[10px] mono-text text-brand-muted/80">
              Uptime: {formatUptime(snap.uptimeSecs)}
            </div>
          </div>

          {/* GPU — only when readable. Jetson without permissions skips
              this card silently. */}
          {(snap.gpuLoadPercent != null || snap.gpuFreqMhz != null) && (
            <div className="rounded border border-brand-line bg-brand-bg/40 p-3 space-y-2">
              <h5 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">GPU</h5>
              {snap.gpuLoadPercent != null && (
                <StatBar label="Load" percent={snap.gpuLoadPercent} unit="%" />
              )}
              {snap.gpuFreqMhz != null && (
                <div className="text-[10px] mono-text text-brand-muted/80">
                  Clock: {snap.gpuFreqMhz} MHz
                </div>
              )}
            </div>
          )}

          {/* Thermal */}
          {snap.thermal.length > 0 && (
            <div className="rounded border border-brand-line bg-brand-bg/40 p-3 space-y-2">
              <h5 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Thermal</h5>
              <div className="grid grid-cols-2 gap-1">
                {snap.thermal.map(t => {
                  const hot = t.tempC >= 75;
                  const warm = t.tempC >= 60;
                  return (
                    <div key={t.zone} className="flex items-center justify-between text-[10px] mono-text py-0.5">
                      <span className="text-brand-muted truncate max-w-[60%]" title={t.zone}>{t.zone}</span>
                      <span className={cn(
                        'font-bold',
                        hot ? 'text-brand-error' : warm ? 'text-brand-warning' : 'text-brand-ink',
                      )}>
                        {t.tempC.toFixed(1)}°C
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {snap && (
        <p className="text-[10px] text-brand-muted/60 italic mt-1">
          Captured {new Date(snap.capturedAt).toLocaleTimeString()} · sampled from /proc + /sys
        </p>
      )}
    </div>
  );
}

/** Small horizontal usage bar. Visual only — the numeric label is in
 *  the `label` prop so the bar is supplementary. */
function StatBar({ label, percent, unit, tone }: {
  label: string;
  percent: number;
  unit?: string;
  /** Affects the fill color when the bar is high. Default = accent;
   *  warning = swap-style yellow. Bars over 85% always go red. */
  tone?: 'accent' | 'warning';
}) {
  const p = Math.max(0, Math.min(100, percent));
  const hot = p >= 85;
  const elevated = p >= 70;
  const fillTone = hot
    ? 'bg-brand-error'
    : elevated
      ? 'bg-brand-warning'
      : tone === 'warning' ? 'bg-brand-warning/60' : 'bg-brand-accent';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] mono-text">
        <span className="text-brand-muted">{label}</span>
        <span className={cn('font-bold', hot ? 'text-brand-error' : 'text-brand-ink')}>
          {p}{unit ?? ''}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-brand-line/40 overflow-hidden">
        <div className={cn('h-full transition-all duration-500', fillTone)} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${rh}h`;
}

export default JetsonGuideSection;
