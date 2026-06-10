/**
 * v2.1 — DiskSection + SummaryTile + DiskTableRow types + format helpers
 * extracted from SettingsModal.tsx.
 *
 * Per-table inventory + on-disk file size + VACUUM trigger. Lazy-loaded
 * so the table-render code + format helpers only enter the bundle when
 * Settings → Disk is opened.
 */
import React from 'react';
import { Check, Database, HardDrive, RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

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

interface DiskTableRow {
  table: string;
  rows: number;
  oldest: number | null;
  newest: number | null;
  retention: string;
}

interface DiskStats {
  dbPath: string;
  onDisk: { main: number; wal: number; shm: number; total: number };
  logicalBytes: number;
  tables: DiskTableRow[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatTs(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' });
}

function DiskSection() {
  const [stats, setStats] = React.useState<DiskStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [vacuuming, setVacuuming] = React.useState(false);
  const [vacuumResult, setVacuumResult] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/mesh/db/disk`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: DiskStats = await res.json();
      setStats(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load disk stats');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
    // Auto-refresh every 30s so the panel stays current while open without
    // hammering the endpoint.
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleVacuum = async () => {
    if (!confirm(
      'VACUUM rewrites the entire database to reclaim space from deleted rows.\n\n'
      + 'This can take several seconds on a large DB and pauses all reads/writes '
      + 'during execution. Continue?'
    )) return;
    setVacuuming(true);
    setVacuumResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/mesh/db/vacuum`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json() as { freedBytes: number; finalBytes: number };
      setVacuumResult(`Reclaimed ${formatBytes(r.freedBytes)} — DB now ${formatBytes(r.finalBytes)}`);
      await refresh();
    } catch (err: any) {
      setVacuumResult(`VACUUM failed: ${err?.message || 'unknown error'}`);
    } finally {
      setVacuuming(false);
    }
  };

  if (loading && !stats) {
    return (
      <div className="flex items-center gap-2 text-sm text-brand-muted">
        <Loader2 size={14} className="animate-spin" /> Loading disk stats…
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="text-sm text-brand-error">
        Failed to load disk stats{error ? `: ${error}` : '.'}
        <button onClick={refresh} className="ml-2 underline text-brand-accent">Retry</button>
      </div>
    );
  }

  const totalRows = stats.tables.reduce((s, t) => s + t.rows, 0);

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold tracking-tight uppercase flex items-center gap-2">
            <HardDrive size={16} className="text-brand-accent" />
            Disk Usage
          </h3>
          <p className="text-xs text-brand-muted leading-snug mt-1">
            Per-table row counts, retention policies, and on-disk footprint for{' '}
            <code className="text-brand-accent">{stats.dbPath}</code>.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-accent border border-brand-line hover:border-brand-accent/50 rounded transition-colors"
        >
          <RefreshCw size={11} className={cn(loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* On-disk summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SummaryTile label="On-disk total" value={formatBytes(stats.onDisk.total)} hint="mesh.sqlite + WAL + shm" />
        <SummaryTile label="Logical size"  value={formatBytes(stats.logicalBytes)} hint="After VACUUM" />
        <SummaryTile label="Total rows"    value={totalRows.toLocaleString()} hint="Across all tables" />
        <SummaryTile label="Tables"        value={String(stats.tables.length)} hint="Tracked persistently" />
      </div>

      {/* File-level breakdown */}
      <div className="technical-panel p-3 space-y-1.5 text-xs">
        <div className="flex items-baseline justify-between">
          <span className="text-brand-muted mono-text">mesh.sqlite (main file)</span>
          <span className="mono-text">{formatBytes(stats.onDisk.main)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-brand-muted mono-text">mesh.sqlite-wal (write-ahead log)</span>
          <span className="mono-text">{formatBytes(stats.onDisk.wal)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-brand-muted mono-text">mesh.sqlite-shm (shared memory)</span>
          <span className="mono-text">{formatBytes(stats.onDisk.shm)}</span>
        </div>
      </div>

      {/* Per-table inventory */}
      <div className="space-y-2">
        <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted flex items-center gap-2">
          <Database size={11} /> Tables
        </h4>
        <div className="technical-panel overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[1.4fr_auto_1.2fr_1.4fr] gap-3 px-3 py-2 border-b border-brand-line bg-brand-line/30 text-[10px] uppercase font-bold tracking-widest text-brand-muted">
            <span>Table</span>
            <span className="text-right w-16">Rows</span>
            <span>Oldest → Newest</span>
            <span>Retention</span>
          </div>
          {stats.tables.map(t => (
            <div
              key={t.table}
              className="grid grid-cols-[1.4fr_auto_1.2fr_1.4fr] gap-3 px-3 py-1.5 border-b border-brand-line/40 last:border-b-0 text-[11px] hover:bg-brand-line/20 transition-colors"
            >
              <span className="mono-text font-bold text-brand-ink truncate">{t.table}</span>
              <span className={cn(
                'text-right w-16 mono-text',
                t.rows === 0 ? 'text-brand-muted' : 'text-brand-ink'
              )}>
                {t.rows.toLocaleString()}
              </span>
              <span className="text-brand-muted mono-text text-[10px] truncate">
                {t.oldest && t.newest
                  ? `${formatTs(t.oldest)} → ${formatTs(t.newest)}`
                  : t.newest ? formatTs(t.newest) : '—'}
              </span>
              <span className="text-brand-muted text-[10px] leading-snug">
                {t.retention}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Maintenance: VACUUM */}
      <div className="technical-panel p-4 space-y-2">
        <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted">Maintenance</h4>
        <p className="text-[11px] text-brand-muted leading-snug">
          SQLite reuses freed pages automatically but doesn't shrink the file. When the on-disk
          total is much larger than the logical size, a VACUUM rewrites the database compactly to
          reclaim the difference. Safe to run; expect a brief pause (seconds on a normal-sized DB).
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={handleVacuum}
            disabled={vacuuming}
            className="flex items-center gap-2 bg-brand-accent text-black px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-widest hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {vacuuming ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />}
            {vacuuming ? 'Vacuuming…' : 'VACUUM Now'}
          </button>
          {vacuumResult && (
            <span className="text-[11px] text-brand-accent flex items-center gap-1.5">
              <Check size={12} /> {vacuumResult}
            </span>
          )}
        </div>
      </div>

      <p className="text-[10px] text-brand-muted leading-snug">
        The Disk panel polls every 30 seconds while open. All listed tables are auto-pruned by the
        5-minute retention loop (see the Recipe Guide → Disk retention section for the full policy).
        Docker stdout logs aren't shown here — they're capped separately by the{' '}
        <code className="text-brand-accent">logging:</code> block in <code className="text-brand-accent">docker-compose.yml</code>.
      </p>
    </div>
  );
}

function SummaryTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="technical-panel p-3">
      <p className="text-[9px] uppercase font-bold tracking-widest text-brand-muted">{label}</p>
      <p className="text-base font-bold mono-text text-brand-ink mt-1">{value}</p>
      {hint && <p className="text-[9px] text-brand-muted mt-0.5">{hint}</p>}
    </div>
  );
}

export default DiskSection;
