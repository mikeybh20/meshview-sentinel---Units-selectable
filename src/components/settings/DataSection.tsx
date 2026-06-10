/**
 * v2.1 — DataSection + ConfigBackupSection extracted from SettingsModal.tsx.
 *
 * Two sections in one chunk because ConfigBackupSection is rendered
 * INSIDE DataSection (lower half of the same tab). Lazy-loaded so the
 * AES-256-GCM backup code only enters the bundle when Settings → Data
 * is opened.
 */
import React from 'react';
import {
  AlertCircle, Check, Download, FileDown, FileUp, Undo2,
} from 'lucide-react';
import { meshDataService } from '../../services/meshDataService';
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

/** Subset of SettingsModalProps we actually read here. Threaded through
 *  SettingsModal as a prop pass to keep the lazy chunk decoupled from
 *  the parent's full prop shape. */
interface DataSectionProps {
  onOpenExport: () => void;
  onClose: () => void;
}

function DataSection({ onOpenExport, onClose }: DataSectionProps) {
  return (
    <div className="space-y-5">
      <SectionHeader title="Data" subtitle="Export mesh data as CSV. Full encrypted backup below." />

      <div className="grid grid-cols-1 gap-3">
        <button
          onClick={() => { onOpenExport(); onClose(); }}
          className="flex flex-col items-start gap-1.5 bg-brand-line/40 hover:bg-brand-line border border-brand-line hover:border-brand-accent/50 rounded-lg p-4 text-left transition-colors"
        >
          <FileDown size={16} className="text-brand-accent" />
          <p className="text-xs font-bold text-brand-ink uppercase tracking-wide">Export</p>
          <p className="text-[10px] text-brand-muted leading-snug">Download messages, events, or telemetry as CSV with date and node filters. BBS mail + weather subscribers have their own CSV export buttons in those tabs.</p>
        </button>
      </div>

      {/* v2.0 Beta 4 (Item 6): CSV Import button removed — was a stub that
          parsed the file and discarded the result. Operators got success
          toasts for a no-op. Migration is now covered by the encrypted
          Full Backup below (which round-trips actual DB state). If a
          plaintext CSV import becomes needed later, add it back with a
          real implementation. */}

      {/* v2.0 Beta 2: encrypted config backup/restore. Separate from the CSV
          export above — this captures the radios registry + channels (with
          PSKs) + BBS config so a fresh install can be bootstrapped. */}
      <ConfigBackupSection />
    </div>
  );
}

/** Sections an operator can opt out of when restoring. Each key matches the
 *  server's `sections` field; default-true means "include in restore" (no
 *  toggle change = restore everything, same as before this feature shipped). */
const RESTORE_SECTIONS = [
  { key: 'radios',                label: 'Radios + transports' },
  { key: 'channels',              label: 'Channels (incl. PSKs)' },
  { key: 'bbsConfig',             label: 'BBS config' },
  { key: 'groups',                label: 'Node groups' },
  { key: 'waypoints',             label: 'Waypoints' },
  { key: 'blockedNodes',          label: 'Block list' },
  { key: 'bbsMail',               label: 'BBS mail history' },
  { key: 'bbsWeatherSubscribers', label: 'Weather subscribers' },
  // v2.0 Beta 5: per-user accounts. Restore brings password hashes +
  // roles across; you also need to copy data/auth-secret to the new
  // host or the operator can re-bootstrap from scratch.
  { key: 'users',                 label: 'User accounts (username + scrypt hash + role)' },
  { key: 'tcpEndpoint',           label: 'TCP auto-reconnect endpoint' },
  { key: 'history',               label: 'History (messages, events, telemetry, …)' },
] as const;

function ConfigBackupSection() {
  const [exportPass, setExportPass] = React.useState('');
  const [restorePass, setRestorePass] = React.useState('');
  const [includeHistory, setIncludeHistory] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [pendingEnvelope, setPendingEnvelope] = React.useState<any>(null);
  // Sections to RESTORE (default everything on). Used to drive the
  // selective-restore checkboxes. Stays in sync with the keys the server
  // recognizes in /api/mesh/restore's `sections` body field.
  const [restoreSections, setRestoreSections] = React.useState<Record<string, boolean>>(
    () => Object.fromEntries(RESTORE_SECTIONS.map(s => [s.key, true]))
  );
  const allOn = RESTORE_SECTIONS.every(s => restoreSections[s.key]);

  const doExport = async () => {
    setMsg(null);
    if (exportPass.length < 6) { setMsg({ tone: 'err', text: 'Passphrase must be at least 6 characters.' }); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/mesh/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: exportPass, includeHistory }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setMsg({ tone: 'err', text: b.error || `HTTP ${res.status}` });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sentinel-backup-${new Date().toISOString().slice(0, 10)}${includeHistory ? '-full' : ''}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg({ tone: 'ok', text: includeHistory ? 'Full backup downloaded (config + history).' : 'Config backup downloaded.' });
      setExportPass('');
    } finally {
      setBusy(false);
    }
  };

  const onFilePicked = async (file: File) => {
    setMsg(null);
    try {
      const text = await file.text();
      const env = JSON.parse(text);
      if (env?.alg !== 'aes-256-gcm') { setMsg({ tone: 'err', text: 'Not a Sentinel backup file.' }); return; }
      setPendingEnvelope(env);
      setMsg({ tone: 'ok', text: 'Backup loaded. Enter its passphrase and click Restore.' });
    } catch {
      setMsg({ tone: 'err', text: 'Could not read that file as JSON.' });
    }
  };

  const doRestore = async () => {
    setMsg(null);
    if (!pendingEnvelope) { setMsg({ tone: 'err', text: 'Pick a backup file first.' }); return; }
    if (!restorePass) { setMsg({ tone: 'err', text: 'Enter the backup passphrase.' }); return; }
    if (!confirm(
      'Restore will overwrite your local Sentinel state from the backup:\n\n' +
      '  • Radios registry, channels (with PSKs), BBS config\n' +
      '  • Groups, waypoints, block list\n' +
      '  • BBS mail + weather subscribers\n' +
      '  • TCP endpoint config\n' +
      '  • Message/event/telemetry history (if included in the backup)\n\n' +
      'Radio firmware is not touched. Continue?'
    )) return;
    setBusy(true);
    try {
      // Send the `sections` body only when the operator changed at least
      // one toggle (selective restore). All-on collapses to undefined so
      // the server takes its default-everything path and the existing
      // back-compat behavior is preserved exactly.
      const sections = allOn ? undefined : restoreSections;
      const res = await fetch(`${API_BASE}/api/mesh/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: restorePass, envelope: pendingEnvelope, sections }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ tone: 'err', text: b.error || `HTTP ${res.status}` }); return; }
      // Build a per-section summary line. Skip zeroes so a config-only
      // restore doesn't carry noisy "0 history" tails.
      const parts: string[] = [];
      const r = b.restored ?? {};
      if (r.radios)               parts.push(`${r.radios} radios`);
      if (r.channels)             parts.push(`${r.channels} channels`);
      if (r.bbsConfig)            parts.push('BBS config');
      if (r.groups)               parts.push(`${r.groups} groups`);
      if (r.waypoints)            parts.push(`${r.waypoints} waypoints`);
      if (r.blockedNodes)         parts.push(`${r.blockedNodes} blocked`);
      if (r.bbsMail)              parts.push(`${r.bbsMail} mail`);
      if (r.bbsWeatherSubscribers) parts.push(`${r.bbsWeatherSubscribers} subs`);
      if (r.users)                parts.push(`${r.users} users`);
      if (r.tcpEndpoint)          parts.push('TCP endpoint');
      if (r.history)              parts.push(`${r.history} history rows`);
      const summary = parts.length ? parts.join(', ') : 'nothing applied';
      setMsg({ tone: 'ok', text: `Restored (v${b.version ?? 1}): ${summary}. Reconnect radios to resync device state.` });
      setRestorePass('');
      setPendingEnvelope(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-brand-line pt-4 space-y-3">
      <SectionHeader
        title="Full Backup"
        subtitle={
          'Encrypted export of everything operator-side: radios + channels (with PSKs), BBS config, ' +
          'groups, waypoints, block list, BBS mail, weather subscribers, and TCP endpoint. Optionally ' +
          'includes message / event / telemetry history (much larger). Sealed with AES-256-GCM — keep ' +
          "the passphrase safe; there's no recovery without it. Restore overwrites local state only; " +
          'radio firmware is not touched.'
        }
      />

      {msg && (
        <div className={cn(
          'flex items-center gap-2 rounded px-3 py-2 text-[11px] border',
          msg.tone === 'ok' ? 'border-brand-accent/40 bg-brand-accent/10 text-brand-accent'
                            : 'border-red-500/40 bg-red-500/10 text-red-300'
        )}>
          {msg.tone === 'ok' ? <Check size={12} /> : <AlertCircle size={12} />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Export</p>
          <input
            type="password"
            value={exportPass}
            onChange={e => setExportPass(e.target.value)}
            placeholder="Encryption passphrase (≥6 chars)"
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
          />
          <label className="flex items-start gap-2 text-[10px] text-brand-muted leading-snug cursor-pointer">
            <input
              type="checkbox"
              checked={includeHistory}
              onChange={e => setIncludeHistory(e.target.checked)}
              className="mt-0.5 accent-brand-accent"
            />
            <span>
              Include history (nodes, messages, events, telemetry, position log, traces, neighbor info).
              Much larger — the rebuild-on-reconnect path repopulates most of these for free, so leave
              this off unless you really want bit-exact preservation across the migration.
            </span>
          </label>
          <button
            onClick={doExport}
            disabled={busy}
            className="flex items-center gap-1 bg-brand-accent/10 hover:bg-brand-accent/20 disabled:opacity-40 border border-brand-accent/40 text-brand-accent text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          >
            <Download size={12} /> Download {includeHistory ? 'Full Backup' : 'Config Backup'}
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Restore</p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={e => { const f = e.target.files?.[0]; if (f) onFilePicked(f); }}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center gap-1 border border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-accent/40 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          >
            <FileUp size={12} /> {pendingEnvelope ? 'Backup loaded ✓' : 'Choose Backup File'}
          </button>
          <input
            type="password"
            value={restorePass}
            onChange={e => setRestorePass(e.target.value)}
            placeholder="Backup passphrase"
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
          />
          {/* Selective-restore section toggles. Default all-on (back-compat
              with the original all-or-nothing restore); turn one off to
              skip that section. */}
          {pendingEnvelope && (
            <details className="bg-brand-bg/40 border border-brand-line rounded">
              <summary className="cursor-pointer px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink">
                Sections to restore ({Object.values(restoreSections).filter(Boolean).length}/{RESTORE_SECTIONS.length})
              </summary>
              <div className="border-t border-brand-line px-2 py-2 space-y-1">
                {RESTORE_SECTIONS.map(s => (
                  <label key={s.key} className="flex items-center gap-2 text-[10px] text-brand-ink cursor-pointer hover:text-brand-accent">
                    <input
                      type="checkbox"
                      checked={!!restoreSections[s.key]}
                      onChange={e => setRestoreSections(prev => ({ ...prev, [s.key]: e.target.checked }))}
                      className="accent-brand-accent"
                    />
                    <span>{s.label}</span>
                  </label>
                ))}
                <div className="flex gap-2 pt-1 border-t border-brand-line/40">
                  <button
                    type="button"
                    onClick={() => setRestoreSections(Object.fromEntries(RESTORE_SECTIONS.map(s => [s.key, true])))}
                    className="text-[10px] text-brand-muted hover:text-brand-ink"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setRestoreSections(Object.fromEntries(RESTORE_SECTIONS.map(s => [s.key, false])))}
                    className="text-[10px] text-brand-muted hover:text-brand-ink"
                  >
                    None
                  </button>
                </div>
              </div>
            </details>
          )}
          <button
            onClick={doRestore}
            disabled={busy || !pendingEnvelope}
            className="flex items-center gap-1 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 border border-amber-500/40 text-amber-300 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          >
            <Undo2 size={12} /> Restore
          </button>
        </div>
      </div>
      <p className="text-[10px] text-brand-muted/80 italic">
        Restore rewrites Sentinel's own DB + config only — it does not push anything to radio firmware.
        Reconnect each radio afterward to resync the device's live state.
      </p>
    </div>
  );
}

export default DataSection;
