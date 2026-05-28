/**
 * v2.0 — Top-level Radios view.
 *
 * Moved out of Settings → Radios in Beta 2. Multi-radio operations
 * (connect / disconnect / add / edit / LoRa config write) deserve a
 * first-class nav item rather than being buried in the Settings modal.
 *
 * The "default" indicator (star + the SERIAL RADIO badge in the sidebar)
 * tracks the LIVE singleton — whichever radio Sentinel auto-discovered
 * on boot and currently holds the meshBridge connection. The old "Set
 * Default" button was removed: it updated a DB column that doesn't
 * actually influence which radio becomes the singleton (that's still
 * determined by USB enumeration order), so the button created the
 * illusion of an action that didn't really change anything.
 */
import React from 'react';
import {
  Star, Plus, Trash2, AlertCircle, Loader2, RefreshCw, HelpCircle, X,
} from 'lucide-react';

import { meshDataService } from '../../services/meshDataService';
import { RADIO_COLOR_PALETTE } from '../../lib/radioColors';
import { cn } from '../../lib/utils';
import type { RadioRow, LoRaConfigLive } from '../../types';

const API_BASE = import.meta.env.VITE_API_URL || '';

const REGION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0,  label: 'UNSET' },
  { value: 1,  label: 'US' },
  { value: 2,  label: 'EU_433' },
  { value: 3,  label: 'EU_868' },
  { value: 4,  label: 'CN' },
  { value: 5,  label: 'JP' },
  { value: 6,  label: 'ANZ' },
  { value: 7,  label: 'KR' },
  { value: 8,  label: 'TW' },
  { value: 9,  label: 'RU' },
  { value: 10, label: 'IN' },
  { value: 11, label: 'NZ_865' },
  { value: 12, label: 'TH' },
  { value: 13, label: 'LORA_24' },
  { value: 14, label: 'UA_433' },
  { value: 15, label: 'UA_868' },
  { value: 16, label: 'MY_433' },
  { value: 17, label: 'MY_919' },
  { value: 18, label: 'SG_923' },
];

const MODEM_PRESET_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'LONG_FAST' },
  { value: 1, label: 'LONG_SLOW' },
  { value: 3, label: 'MEDIUM_SLOW' },
  { value: 4, label: 'MEDIUM_FAST' },
  { value: 5, label: 'SHORT_SLOW' },
  { value: 6, label: 'SHORT_FAST' },
  { value: 7, label: 'LONG_MODERATE' },
  { value: 8, label: 'SHORT_TURBO' },
];

interface SystemInfo {
  memTotalGB: number;
  memFreeGB: number;
  cpuCount: number;
  isJetson: boolean;
  platform: string;
  arch: string;
}

function RamAdvisory({ info, radios, connected }: {
  info: SystemInfo;
  radios: RadioRow[];
  connected: Record<string, { connected: boolean; transport: string | null }>;
}) {
  const connectedCount = Object.values(connected).filter(s => s.connected).length;
  const baselineMB = 350 + connectedCount * 200 + 400;
  const headroomMB = info.memTotalGB * 1024 - baselineMB;
  const tight  = headroomMB < 600;
  const veryTight = headroomMB < 200;

  if (!tight && !info.isJetson && info.memTotalGB > 4) return null;

  const tone = veryTight ? 'red' : (tight ? 'amber' : 'muted');
  const borderClass =
    tone === 'red'   ? 'border-red-500/40 bg-red-500/10 text-red-300' :
    tone === 'amber' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' :
                       'border-brand-line bg-brand-line/20 text-brand-muted';

  return (
    <div className={cn('flex items-start gap-2 rounded px-3 py-2 text-[11px] border', borderClass)}>
      <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
      <div className="space-y-1">
        <p className="font-bold uppercase tracking-widest text-[10px]">
          Memory advisory
          {info.isJetson && ' · Jetson host detected'}
        </p>
        <p>
          Total RAM: <span className="mono-text font-bold">{info.memTotalGB.toFixed(1)} GB</span>
          {' · '}Free: <span className="mono-text">{info.memFreeGB.toFixed(1)} GB</span>
          {' · '}Estimated baseline (Sentinel + {connectedCount} connected radio{connectedCount === 1 ? '' : 's'} + GPU sidecar):
          {' '}<span className="mono-text font-bold">{(baselineMB / 1024).toFixed(1)} GB</span>
          {' · '}Headroom: <span className="mono-text font-bold">{(headroomMB / 1024).toFixed(1)} GB</span>
        </p>
        {veryTight && (
          <p>
            <span className="font-bold">Very tight.</span> Adding more radios or connecting the GPU sidecar will likely OOM-kill the container. Consider commenting out <span className="mono-text">meshview-gpu</span> in <span className="mono-text">docker-compose.yml</span> to free ~400 MB.
          </p>
        )}
        {!veryTight && tight && (
          <p>
            Headroom is tight for adding additional radios. {radios.length > 1 && 'Disconnecting unused secondary radios via the panel below recovers ~200 MB each.'}
            {info.isJetson && ' On a Jetson Nano 2GB, the GPU sidecar can usually be disabled (its workloads fall back to CPU automatically).'}
          </p>
        )}
      </div>
    </div>
  );
}

function RadiosHelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-brand-bg/80 backdrop-blur-md p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-brand-accent/30 bg-brand-bg flex flex-col max-h-[85vh] overflow-hidden"
        style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.7)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-brand-line flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <HelpCircle size={16} className="text-brand-accent" />
            <h3 className="text-sm font-bold tracking-tight uppercase text-brand-ink">Connecting a second radio</h3>
          </div>
          <button onClick={onClose} className="p-1 text-brand-muted hover:text-brand-ink hover:bg-brand-line rounded" aria-label="Close help">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-[12px] text-brand-ink leading-relaxed">
          <section className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-widest text-brand-accent">1. Find the new device's port path</h4>
            <p className="text-brand-muted">On the <em>host</em> (not inside the container), check what device appeared when you plugged the radio in:</p>
            <pre className="bg-brand-line/30 border border-brand-line rounded p-3 text-[11px] mono-text text-brand-ink overflow-x-auto">{`# Most-recent USB events — your new radio is the last entry
dmesg | tail -20 | grep -i 'tty\\|usb'

# Or just list serial devices — the second one is your new radio
ls -l /dev/ttyUSB* /dev/ttyACM*`}</pre>
            <p className="text-brand-muted">
              You'll see something like <span className="mono-text text-brand-ink">ch341-uart converter now attached to ttyUSB1</span> — your new radio is <span className="mono-text text-brand-ink">/dev/ttyUSB1</span>.
              The first radio is usually <span className="mono-text text-brand-ink">/dev/ttyUSB0</span>.
            </p>
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-widest text-brand-accent">2. Add it via Radios → + Add Radio</h4>
            <ol className="list-decimal list-inside space-y-1 text-brand-muted">
              <li>Click <span className="text-brand-ink font-bold">+ Add Radio</span> in the top-right of this view.</li>
              <li>Set <span className="mono-text text-brand-ink">Transport</span> to <span className="mono-text text-brand-ink">serial</span>.</li>
              <li>Enter the device path from step 1 (e.g. <span className="mono-text text-brand-ink">/dev/ttyUSB1</span>) in <span className="mono-text text-brand-ink">Target</span>.</li>
              <li>Click <span className="text-brand-ink font-bold">Detect Identity</span> — Sentinel opens a 5-second transient connection, reads the radio's <span className="mono-text">short_name</span> + <span className="mono-text">long_name</span> + LoRa config, then disconnects and pre-fills the form.</li>
              <li>Optional: set a <span className="text-brand-ink font-bold">Network Label</span> like <span className="mono-text">"NOVA Mesh"</span> and pick a distinct palette color.</li>
              <li>Click <span className="text-brand-ink font-bold">Add Radio</span>. The row appears with a <span className="text-brand-muted">○ disconnected</span> chip.</li>
            </ol>
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-widest text-brand-accent">3. Connect it</h4>
            <p className="text-brand-muted">
              Click <span className="text-brand-ink font-bold">Connect</span> on the new row. The chip flips to <span className="text-emerald-400">● connected</span> and packets start flowing. The RadioBar pill below the header lights up, and any nodes the second radio hears get "Heard By" badges with that radio's color.
            </p>
          </section>

          <section className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-widest text-amber-300">Troubleshooting</h4>

            <div className="space-y-1">
              <p className="text-brand-ink font-bold text-[11px]">"Detect Identity" returns <span className="mono-text">permission denied</span></p>
              <p className="text-brand-muted text-[11px]">The Sentinel process needs read access to the port. In Docker the existing <span className="mono-text">device_cgroup_rules: c 188:* rmw</span> covers it. Running natively, run <span className="mono-text">sudo usermod -aG dialout $USER</span> then log out / back in.</p>
            </div>

            <div className="space-y-1">
              <p className="text-brand-ink font-bold text-[11px]">Connects but reports <span className="mono-text">radio did not report its identity within 5000ms</span></p>
              <p className="text-brand-muted text-[11px]">The device is at that path but isn't a Meshtastic radio (or its firmware is stuck). Power-cycle the radio and try again.</p>
            </div>

            <div className="space-y-1">
              <p className="text-brand-ink font-bold text-[11px]"><span className="mono-text">/dev/ttyUSB1</span> doesn't exist inside the container</p>
              <p className="text-brand-muted text-[11px]">Happens if you started the container before plugging the radio in AND your Docker doesn't pick up dynamic device additions. Run <span className="mono-text">docker compose restart meshview</span> to reinitialize the <span className="mono-text">/dev</span> view.</p>
            </div>

            <div className="space-y-1">
              <p className="text-brand-ink font-bold text-[11px]">Both radios show the same <span className="mono-text">radio_id</span></p>
              <p className="text-brand-muted text-[11px]">Each Meshtastic radio's <span className="mono-text">short_name</span> defaults to the last 4 hex chars of its node ID, so collisions are rare. If they happen, edit one radio's <span className="mono-text">short_name</span> in its Meshtastic phone/desktop app first, then re-detect here.</p>
            </div>
          </section>

          <section className="space-y-2 border-t border-brand-line pt-4">
            <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted">Same flow works for TCP radios</h4>
            <p className="text-brand-muted">
              Use <span className="mono-text text-brand-ink">tcp</span> transport with target <span className="mono-text text-brand-ink">{`<host>:<port>`}</span> (e.g. <span className="mono-text text-brand-ink">192.168.1.50:4403</span>) — same Detect Identity → Add → Connect sequence.
            </p>
          </section>

          <section className="space-y-2 border-t border-brand-line pt-4">
            <h4 className="text-xs font-bold uppercase tracking-widest text-brand-muted">About the "default" star</h4>
            <p className="text-brand-muted">
              The star marks the <strong>primary radio</strong> — whichever radio Sentinel auto-discovered on boot, currently holding the main bridge. On a fresh boot this is decided by USB enumeration order; you can hot-swap which radio is primary at any time via the <strong>Make Primary</strong> button on a secondary's row.
            </p>
          </section>
        </div>

        <div className="px-5 py-2 border-t border-brand-line flex justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="bg-brand-accent/10 hover:bg-brand-accent/20 border border-brand-accent/40 text-brand-accent text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export function RadiosView() {
  const [radios, setRadios] = React.useState<RadioRow[]>([]);
  const [defaultRadioId, setDefaultRadioId] = React.useState<string | null>(null);
  const [connectionStates, setConnectionStates] = React.useState<Record<string, {
    connected: boolean;
    transport: string | null;
    firmwareVersion?: string | null;
    rebootCount?: number | null;
    battery?: number | null;
    voltage?: number | null;
    localNodeId?: string | null;
  }>>({});
  const [sysInfo, setSysInfo] = React.useState<SystemInfo | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [showAdd, setShowAdd] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [busyRadioId, setBusyRadioId] = React.useState<string | null>(null);
  const [showHelp, setShowHelp] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    const data = await meshDataService.listRadios();
    if (data) {
      setRadios(data.radios);
      setDefaultRadioId(data.defaultRadioId);
    }
    const conns = await meshDataService.getRadioConnections();
    if (conns) setConnectionStates(conns.states);
    if (!sysInfo) {
      const info = await meshDataService.getSystemInfo();
      if (info) setSysInfo({
        memTotalGB: info.memTotalGB,
        memFreeGB:  info.memFreeGB,
        cpuCount:   info.cpuCount,
        isJetson:   info.isJetson,
        platform:   info.platform,
        arch:       info.arch,
      });
    }
    setLoading(false);
  }, [sysInfo]);

  React.useEffect(() => { reload(); }, [reload]);

  React.useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/mesh/stream`);
    const handler = () => { reload(); };
    es.addEventListener('loraConfig', handler);
    es.addEventListener('node', handler);
    return () => {
      es.removeEventListener('loraConfig', handler);
      es.removeEventListener('node', handler);
      es.close();
    };
  }, [reload]);

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete radio "${id}"? This only removes the metadata row; the firmware on the radio itself is not touched.`)) return;
    const r = await meshDataService.deleteRadio(id);
    if (!r.ok) { setError(r.error || 'delete failed'); return; }
    reload();
  };

  const handleConnect = async (id: string) => {
    setError(null);
    setBusyRadioId(id);
    const r = await meshDataService.connectRadio(id);
    setBusyRadioId(null);
    if (!r.ok) { setError(r.error || 'connect failed'); return; }
    reload();
  };

  const handleDisconnect = async (id: string) => {
    setError(null);
    setBusyRadioId(id);
    const r = await meshDataService.disconnectRadio(id);
    setBusyRadioId(null);
    if (!r.ok) { setError(r.error || 'disconnect failed'); return; }
    reload();
  };

  const handlePromote = async (id: string) => {
    const target = radios.find(r => r.radio_id === id);
    const current = radios.find(r => r.radio_id === defaultRadioId);
    const msg = current
      ? `Make "${id}" the primary radio?\n\nThis disconnects "${current.radio_id}" from the primary slot and re-opens the bridge on "${id}"'s transport (${target?.target ?? '?'}). After the swap, "${current.radio_id}" is left disconnected — you can re-attach it as a secondary via its Connect button.\n\nContinue?`
      : `Make "${id}" the primary radio?\n\nThis opens "${id}"'s transport (${target?.target ?? '?'}) as the primary. Continue?`;
    if (!confirm(msg)) return;
    setError(null);
    setBusyRadioId(id);
    const r = await meshDataService.promoteRadioToSingleton(id);
    setBusyRadioId(null);
    if (!r.ok) { setError(r.error || 'promote failed'); return; }
    reload();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-tight text-brand-ink">Radios</h2>
            <p className="text-[11px] text-brand-muted mt-0.5 max-w-2xl">
              Each configured radio appears here with its 4-char short name. The <strong>primary radio</strong> (marked with the star) handles the main bridge — by default the one Sentinel auto-discovers on boot. Secondary radios connect on demand via the buttons below. Use <strong>Make Primary</strong> to hot-swap which radio is primary.
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={() => setShowHelp(true)}
              className="flex items-center gap-1 border border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-accent/40 text-[10px] font-bold uppercase tracking-widest rounded px-2.5 py-1.5 transition-colors"
              title="How do I connect a second radio?"
            >
              <HelpCircle size={12} /> Help
            </button>
            <button
              onClick={() => { setError(null); setShowAdd(true); }}
              className="flex items-center gap-1 bg-brand-accent/10 hover:bg-brand-accent/20 border border-brand-accent/40 text-brand-accent text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors"
            >
              <Plus size={12} /> Add Radio
            </button>
          </div>
        </div>

        {showHelp && <RadiosHelpOverlay onClose={() => setShowHelp(false)} />}

        {error && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-[11px] text-red-300">
            <AlertCircle size={12} />
            <span>{error}</span>
          </div>
        )}

        {sysInfo && <RamAdvisory info={sysInfo} radios={radios} connected={connectionStates} />}

        {loading ? (
          <div className="flex items-center gap-2 text-brand-muted text-xs">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : radios.length === 0 ? (
          <div className="border border-brand-line rounded p-4 text-center text-xs text-brand-muted">
            No radios registered yet. The first radio that connects will be auto-registered as the primary.
          </div>
        ) : (
          <div className="space-y-2">
            {radios.map(r => (
              <RadioRowCard
                key={r.radio_id}
                row={r}
                // Beta 2: single "default" concept = the runtime singleton.
                // The DB column is_default is kept in sync by BridgeManager
                // but no longer surfaced as a separately-settable preference.
                isSingleton={r.radio_id === defaultRadioId}
                isConnected={!!connectionStates[r.radio_id]?.connected}
                health={connectionStates[r.radio_id]}
                isEditing={editingId === r.radio_id}
                busy={busyRadioId === r.radio_id}
                onEdit={() => setEditingId(editingId === r.radio_id ? null : r.radio_id)}
                onDelete={() => handleDelete(r.radio_id)}
                onConnect={() => handleConnect(r.radio_id)}
                onDisconnect={() => handleDisconnect(r.radio_id)}
                onPromote={() => handlePromote(r.radio_id)}
                onChanged={reload}
              />
            ))}
          </div>
        )}

        {showAdd && (
          <AddRadioForm
            existing={radios}
            onCancel={() => setShowAdd(false)}
            onCreated={() => { setShowAdd(false); reload(); }}
          />
        )}
      </div>
    </div>
  );
}

function RadioRowCard({
  row, isSingleton, isConnected, health, isEditing, busy, onEdit, onDelete, onConnect, onDisconnect, onPromote, onChanged,
}: {
  row: RadioRow;
  /** This radio is held by the auto-discovered singleton bridge. Gates the star + suppresses Connect/Disconnect/Delete since the singleton can't be torn down from this panel. */
  isSingleton: boolean;
  isConnected: boolean;
  /** v2.0 Beta 2: per-radio health snapshot from BridgeManager. Optional —
   *  absent for radios not currently in the runtime registry. */
  health?: {
    firmwareVersion?: string | null;
    rebootCount?: number | null;
    battery?: number | null;
    voltage?: number | null;
    localNodeId?: string | null;
  };
  isEditing: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Hot-swap this radio into the singleton role. */
  onPromote: () => void;
  onChanged: () => void;
}) {
  return (
    <div className="border border-brand-line rounded">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ background: row.color_hex ?? '#666' }}
            title={row.color_hex ?? 'no color'}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold mono-text text-brand-ink">{row.radio_id}</span>
              {isSingleton && (
                <Star
                  size={10}
                  className="text-amber-400 fill-amber-400"
                  aria-label="Primary radio"
                />
              )}
              <span className="text-[10px] uppercase tracking-widest text-brand-muted">{row.transport}</span>
              <span
                className={cn(
                  "text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border",
                  isConnected
                    ? "text-emerald-400 border-emerald-400/40 bg-emerald-400/10"
                    : "text-brand-muted border-brand-line"
                )}
              >
                {isConnected ? '● connected' : '○ disconnected'}
              </span>
            </div>
            <p className="text-[11px] text-brand-muted truncate">
              {row.long_name}
              {row.network_label ? ` · ${row.network_label}` : ''}
            </p>
            <p className="text-[10px] text-brand-muted mono-text truncate">
              {row.target} · {row.region ?? '?region'} · {row.modem_preset ?? '?preset'} · slot {row.frequency_slot ?? '?'} · {row.num_hops ?? '?'} hops
            </p>
            {/* v2.0 Beta 2: radio health line. Surfaces firmware version,
                reboot count, battery, voltage so the operator can spot a
                brownout / low-battery / out-of-date gateway at a glance.
                Renders only when at least one health field is known. */}
            {health && (health.firmwareVersion || health.rebootCount != null || health.battery != null || health.voltage != null) && (
              <p className="text-[10px] mono-text truncate flex items-center gap-2 mt-0.5">
                {health.firmwareVersion && (
                  <span
                    className="text-brand-muted"
                    title="Firmware version reported by the radio's DeviceMetadata. Update via the Meshtastic Android/iOS app."
                  >
                    fw <span className="text-brand-ink">{health.firmwareVersion}</span>
                  </span>
                )}
                {health.rebootCount != null && (
                  <span
                    className={cn(
                      'cursor-help',
                      health.rebootCount > 50 ? 'text-amber-400' : 'text-brand-muted'
                    )}
                    title={
                      health.rebootCount > 50
                        ? `${health.rebootCount} reboots since last factory reset — high count, possible power instability.`
                        : `${health.rebootCount} reboots since last factory reset.`
                    }
                  >
                    {health.rebootCount} reboots
                  </span>
                )}
                {health.battery != null && (
                  <span
                    className={cn(
                      'cursor-help',
                      health.battery < 20 ? 'text-red-400' :
                      health.battery < 50 ? 'text-amber-400' :
                                            'text-emerald-400'
                    )}
                    title={
                      health.battery < 20
                        ? `Battery critical (${health.battery}%) — gateway may go offline soon.`
                        : `Battery: ${health.battery}%${health.voltage ? ` (${health.voltage.toFixed(2)} V)` : ''}`
                    }
                  >
                    🔋 {health.battery}%
                    {health.voltage != null && (
                      <span className="text-brand-muted"> · {health.voltage.toFixed(2)}V</span>
                    )}
                  </span>
                )}
                {/* Boards without battery monitoring report null; show
                    "wall power" so the operator knows we're not silently
                    losing data. */}
                {health.battery == null && health.voltage == null && (health.firmwareVersion || health.rebootCount != null) && (
                  <span className="text-brand-muted/60" title="No battery telemetry reported — likely wall-powered or board lacks a battery monitor pin.">
                    ⚡ wall
                  </span>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!isSingleton && (
            isConnected ? (
              <button
                onClick={onDisconnect}
                disabled={busy}
                className="text-[10px] font-bold uppercase tracking-widest text-amber-300 hover:bg-amber-500/15 disabled:opacity-40 px-2 py-1 rounded"
                title="Disconnect this radio"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : 'Disconnect'}
              </button>
            ) : (
              <button
                onClick={onConnect}
                disabled={busy}
                className="text-[10px] font-bold uppercase tracking-widest text-emerald-400 hover:bg-emerald-400/15 disabled:opacity-40 px-2 py-1 rounded"
                title="Open this radio's transport and start ingesting packets"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : 'Connect'}
              </button>
            )
          )}
          {/* Promote to Singleton: hot-swaps which radio holds the live
              singleton bridge. The current singleton gets disconnected and
              left available for the operator to manually reconnect as a
              secondary. Only shown for non-singleton rows. */}
          {!isSingleton && (
            <button
              onClick={onPromote}
              disabled={busy}
              className="text-[10px] font-bold uppercase tracking-widest text-amber-400 hover:bg-amber-400/15 disabled:opacity-40 px-2 py-1 rounded"
              title="Make this the primary radio — disconnects the current primary and re-opens the bridge on this radio's transport"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : 'Make Primary'}
            </button>
          )}
          <button
            onClick={onEdit}
            className={cn(
              "text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded transition-colors",
              isEditing
                ? "bg-brand-accent/15 text-brand-accent"
                : "text-brand-muted hover:text-brand-ink hover:bg-brand-line/40"
            )}
          >
            {isEditing ? 'Done' : 'Edit'}
          </button>
          {!isSingleton && (
            <button
              onClick={onDelete}
              className="p-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded"
              title="Delete radio"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {isEditing && (
        <RadioEditor row={row} onChanged={onChanged} />
      )}
    </div>
  );
}

function RadioEditor({ row, onChanged }: { row: RadioRow; onChanged: () => void }) {
  const [longName, setLongName] = React.useState(row.long_name);
  const [networkLabel, setNetworkLabel] = React.useState(row.network_label ?? '');
  const [colorHex, setColorHex] = React.useState(row.color_hex ?? RADIO_COLOR_PALETTE[0]);
  const [enabled, setEnabled] = React.useState(!!row.enabled);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testMsg, setTestMsg] = React.useState<string | null>(null);

  const [live, setLive] = React.useState<LoRaConfigLive | null>(null);
  const [region, setRegion] = React.useState<number>(1);
  const [preset, setPreset] = React.useState<number>(0);
  const [slot, setSlot] = React.useState<number>(0);
  const [hops, setHops] = React.useState<number>(3);
  const [txEnabled, setTxEnabled] = React.useState(true);
  const [loraSaving, setLoraSaving] = React.useState(false);
  const [loraMsg, setLoraMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioLora(row.radio_id).then(data => {
      if (cancelled || !data) return;
      if (data.live) {
        setLive(data.live);
        setRegion(data.live.region);
        setPreset(data.live.modemPreset);
        setSlot(data.live.frequencySlot);
        setHops(data.live.hopLimit);
        setTxEnabled(data.live.txEnabled);
      }
    });
    return () => { cancelled = true; };
  }, [row.radio_id]);

  const saveMeta = async () => {
    setSaving(true);
    const r = await meshDataService.updateRadio(row.radio_id, {
      long_name: longName,
      network_label: networkLabel || null,
      color_hex: colorHex,
      enabled,
    });
    setSaving(false);
    if (r.ok) onChanged();
  };

  const testConnection = async () => {
    if (row.transport === 'ble') { setTestMsg('BLE not supported yet'); return; }
    setTesting(true);
    setTestMsg('Connecting…');
    const r = await meshDataService.testRadioConnection({
      transport: row.transport,
      target: row.target,
      timeout_ms: 5000,
    });
    setTesting(false);
    if (r.ok) {
      const id = r.identity;
      const lora = r.lora;
      const parts: string[] = [
        r.alreadyConnectedAs
          ? `✓ already connected as ${r.alreadyConnectedAs} (live state shown)`
          : '✓ reached radio',
      ];
      if (id) parts.push(`${id.shortName} (${id.longName || id.nodeId})`);
      if (lora) parts.push(`slot ${lora.frequencySlot}, ${lora.hopLimit} hops`);
      setTestMsg(parts.join(' · '));
    } else {
      setTestMsg(`✗ ${(r as { ok: false; error: string }).error}`);
    }
    setTimeout(() => setTestMsg(null), 8000);
  };

  const refreshLora = async () => {
    setLoraMsg('Requesting readback…');
    const r = await meshDataService.refreshRadioLora(row.radio_id);
    setLoraMsg(r.ok ? 'Readback requested — values update on arrival.' : `Refresh failed: ${r.error}`);
    setTimeout(() => setLoraMsg(null), 3000);
    setTimeout(async () => {
      const data = await meshDataService.getRadioLora(row.radio_id);
      if (data?.live) {
        setLive(data.live);
        setRegion(data.live.region);
        setPreset(data.live.modemPreset);
        setSlot(data.live.frequencySlot);
        setHops(data.live.hopLimit);
        setTxEnabled(data.live.txEnabled);
      }
    }, 1200);
  };

  const saveLora = async () => {
    const confirmMsg = `Write LoRa config to ${row.radio_id}?\n\nRegion: ${REGION_OPTIONS.find(o => o.value === region)?.label}\nPreset: ${MODEM_PRESET_OPTIONS.find(o => o.value === preset)?.label}\nFrequency Slot: ${slot}\nHops: ${hops}\nTx Enabled: ${txEnabled}\n\nChanging region / preset / slot reconfigures the radio's RF channel — peers on the old configuration disappear immediately.`;
    if (!confirm(confirmMsg)) return;
    setLoraSaving(true);
    setLoraMsg(null);
    const r = await meshDataService.setRadioLora(row.radio_id, {
      region, modemPreset: preset, frequencySlot: slot, hopLimit: hops, txEnabled,
    });
    setLoraSaving(false);
    if (r.ok) {
      setLoraMsg('Write sent. Awaiting firmware readback…');
      setTimeout(() => setLoraMsg(null), 3000);
      onChanged();
    } else {
      setLoraMsg(`Write failed: ${r.error}`);
    }
  };

  return (
    <div className="border-t border-brand-line bg-brand-bg/40 p-3 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Long Name</label>
          <input
            type="text"
            value={longName}
            onChange={e => setLongName(e.target.value)}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Network Label</label>
          <input
            type="text"
            value={networkLabel}
            onChange={e => setNetworkLabel(e.target.value)}
            placeholder="DC Mesh, NOVA Mesh, …"
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Color</label>
          <div className="flex items-center gap-1.5">
            {RADIO_COLOR_PALETTE.map(c => (
              <button
                key={c}
                onClick={() => setColorHex(c)}
                className={cn(
                  "w-6 h-6 rounded-full border-2 transition-all",
                  colorHex === c ? "border-brand-ink scale-110" : "border-transparent opacity-70 hover:opacity-100"
                )}
                style={{ background: c }}
                title={c}
              />
            ))}
          </div>
        </div>
        <label className="sm:col-span-2 flex items-center gap-2 text-xs text-brand-ink select-none cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
          <span className="text-[10px] text-brand-muted normal-case font-normal">
            — disabled radios stay in the registry but are skipped by Refresh and won't auto-connect
          </span>
        </label>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={saveMeta}
          disabled={saving}
          className="bg-brand-accent/10 hover:bg-brand-accent/20 disabled:opacity-40 border border-brand-accent/40 text-brand-accent text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
        >
          {saving ? 'Saving…' : 'Save Metadata'}
        </button>
        <button
          onClick={testConnection}
          disabled={testing}
          className="bg-brand-line hover:bg-brand-line/70 disabled:opacity-40 border border-brand-line text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          title="Open a temporary connection, read the radio's identity, then disconnect"
        >
          {testing ? <Loader2 size={11} className="animate-spin inline" /> : 'Test Connection'}
        </button>
        {testMsg && <span className="text-[11px] text-brand-muted">{testMsg}</span>}
      </div>

      <div className="pt-3 border-t border-brand-line">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">LoRa Config</h5>
          <button
            onClick={refreshLora}
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded"
          >
            <RefreshCw size={10} /> Refresh
          </button>
        </div>
        {!live && (
          <div className="text-[11px] text-brand-muted mb-2">
            No LoRa config readback yet. Click Refresh once the radio is connected.
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Region</label>
            <select
              value={region}
              onChange={e => setRegion(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
            >
              {REGION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Modem Preset</label>
            <select
              value={preset}
              onChange={e => setPreset(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
            >
              {MODEM_PRESET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">
              Frequency Slot
              <span className="ml-1 text-brand-muted normal-case font-normal">(0 = auto from primary channel name)</span>
            </label>
            <input
              type="number"
              min={0}
              max={104}
              value={slot}
              onChange={e => setSlot(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Number of Hops (1–7)</label>
            <input
              type="number"
              min={1}
              max={7}
              value={hops}
              onChange={e => setHops(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
            />
          </div>
          <label className="col-span-2 flex items-center gap-2 text-xs text-brand-ink">
            <input type="checkbox" checked={txEnabled} onChange={e => setTxEnabled(e.target.checked)} />
            Transmit Enabled
          </label>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={saveLora}
            disabled={loraSaving || !live}
            className="bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 border border-amber-500/40 text-amber-300 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          >
            {loraSaving ? 'Writing…' : 'Write LoRa Config to Radio'}
          </button>
          {loraMsg && <span className="text-[11px] text-brand-muted">{loraMsg}</span>}
        </div>
      </div>

      <NetworkConfigSection radioId={row.radio_id} />
      <PowerConfigSection radioId={row.radio_id} />
    </div>
  );
}

/**
 * v2.0 Beta 2 — Read-only Network config surface.
 *
 * Shows whether the radio is using WiFi or Ethernet plus the SSID + NTP
 * server when reported. Sentinel doesn't edit network config here today —
 * fiddly WiFi PSK + DHCP/static IP belong in the Meshtastic phone app where
 * they can be entered out-of-band of the LoRa link. Surfacing the state
 * gives operators "is my backup WebUI reachable?" info at a glance.
 */
function NetworkConfigSection({ radioId }: { radioId: string }) {
  const [live, setLive] = React.useState<{
    wifiEnabled: boolean; wifiSsid: string; ethEnabled: boolean; ntpServer: string;
  } | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioNetwork(radioId).then(data => {
      if (cancelled || !data) return;
      setLive(data.live);
    });
    return () => { cancelled = true; };
  }, [radioId]);

  const refresh = async () => {
    setRefreshing(true);
    await meshDataService.refreshRadioNetwork(radioId);
    setTimeout(async () => {
      const data = await meshDataService.getRadioNetwork(radioId);
      if (data) setLive(data.live);
      setRefreshing(false);
    }, 1200);
  };

  return (
    <div className="pt-3 border-t border-brand-line">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Network</h5>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {!live ? (
        <div className="text-[11px] text-brand-muted">
          No Network config readback yet. Click Refresh once the radio is connected.
        </div>
      ) : (
        <div className="text-[11px] text-brand-muted space-y-1">
          <div>
            WiFi:{' '}
            <span className={live.wifiEnabled ? 'text-emerald-400 font-bold' : 'text-brand-muted'}>
              {live.wifiEnabled ? 'ON' : 'off'}
            </span>
            {live.wifiSsid && (
              <span className="ml-1 mono-text text-brand-ink">· SSID: {live.wifiSsid}</span>
            )}
          </div>
          <div>
            Ethernet:{' '}
            <span className={live.ethEnabled ? 'text-emerald-400 font-bold' : 'text-brand-muted'}>
              {live.ethEnabled ? 'ON' : 'off'}
            </span>
          </div>
          {live.ntpServer && (
            <div className="mono-text">NTP: <span className="text-brand-ink">{live.ntpServer}</span></div>
          )}
          {live.wifiEnabled && live.wifiSsid && (
            <p className="text-[10px] text-brand-muted/80 italic mt-1">
              When WiFi is on, the radio hosts its own captive UI. Point a browser at the radio's IP on your LAN.
              (Edit WiFi credentials via the Meshtastic phone app — Sentinel deliberately doesn't transit PSKs over LoRa.)
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * v2.0 Beta 2 — Power module config (sleep behaviour, battery shutdown).
 *
 * Critical for field deployments. Controls how aggressively the radio sleeps
 * between LoRa wakeups (trading responsiveness for runtime) and how long it
 * waits for BLE before going to sleep. Defaults are typically 0/300/10/60
 * which is fine for wall-powered gateways but bad for battery operations.
 */
function PowerConfigSection({ radioId }: { radioId: string }) {
  const [live, setLive] = React.useState<{
    isPowerSaving: boolean; onBatteryShutdownAfterSecs: number;
    waitBluetoothSecs: number; sdsSecs: number; lsSecs: number; minWakeSecs: number;
  } | null>(null);
  const [powerSaving, setPowerSaving] = React.useState(false);
  const [batShutdown, setBatShutdown] = React.useState(0);
  const [waitBt, setWaitBt] = React.useState(60);
  const [sds, setSds] = React.useState(0);
  const [ls, setLs] = React.useState(300);
  const [minWake, setMinWake] = React.useState(10);
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const applyLive = (snap: NonNullable<typeof live>) => {
    setLive(snap);
    setPowerSaving(snap.isPowerSaving);
    setBatShutdown(snap.onBatteryShutdownAfterSecs);
    setWaitBt(snap.waitBluetoothSecs);
    setSds(snap.sdsSecs);
    setLs(snap.lsSecs);
    setMinWake(snap.minWakeSecs);
  };

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioPower(radioId).then(data => {
      if (cancelled || !data || !data.live) return;
      applyLive(data.live);
    });
    return () => { cancelled = true; };
  }, [radioId]);

  const refresh = async () => {
    setRefreshing(true);
    await meshDataService.refreshRadioPower(radioId);
    setTimeout(async () => {
      const data = await meshDataService.getRadioPower(radioId);
      if (data?.live) applyLive(data.live);
      setRefreshing(false);
    }, 1200);
  };

  const save = async () => {
    if (!confirm(`Write Power config to ${radioId}?\n\nPower saving: ${powerSaving}\nBattery shutdown after: ${batShutdown}s (0=never)\nWait Bluetooth: ${waitBt}s\nSuper-deep-sleep: ${sds}s (0=disabled)\nLight sleep: ${ls}s\nMin wake: ${minWake}s\n\nAggressive sleep settings will reduce responsiveness but extend battery life.`)) return;
    setSaving(true);
    setMsg(null);
    const r = await meshDataService.setRadioPower(radioId, {
      isPowerSaving: powerSaving,
      onBatteryShutdownAfterSecs: batShutdown,
      waitBluetoothSecs: waitBt,
      sdsSecs: sds,
      lsSecs: ls,
      minWakeSecs: minWake,
    });
    setSaving(false);
    if (r.ok) {
      setMsg('Write sent. Awaiting firmware readback…');
      setTimeout(() => setMsg(null), 3000);
    } else {
      setMsg(`Write failed: ${r.error}`);
    }
  };

  return (
    <div className="pt-3 border-t border-brand-line">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Power Management</h5>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {!live && (
        <div className="text-[11px] text-brand-muted mb-2">
          No Power config readback yet. Click Refresh once the radio is connected.
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-brand-ink mb-3 select-none cursor-pointer">
        <input
          type="checkbox"
          checked={powerSaving}
          onChange={e => setPowerSaving(e.target.checked)}
        />
        <span>Power saving mode</span>
        <span className="text-[10px] text-brand-muted normal-case font-normal">
          — aggressive sleeps when on battery; ignored on wall power
        </span>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">
            On-battery shutdown
            <span className="ml-1 normal-case font-normal">(secs; 0 = never)</span>
          </label>
          <input
            type="number" min={0} value={batShutdown}
            onChange={e => setBatShutdown(Number(e.target.value))}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">
            Wait Bluetooth
            <span className="ml-1 normal-case font-normal">(secs before sleep)</span>
          </label>
          <input
            type="number" min={0} value={waitBt}
            onChange={e => setWaitBt(Number(e.target.value))}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">
            Super deep sleep
            <span className="ml-1 normal-case font-normal">(secs; 0 = disabled)</span>
          </label>
          <input
            type="number" min={0} value={sds}
            onChange={e => setSds(Number(e.target.value))}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">
            Light sleep
            <span className="ml-1 normal-case font-normal">(secs between)</span>
          </label>
          <input
            type="number" min={0} value={ls}
            onChange={e => setLs(Number(e.target.value))}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">
            Minimum wake
            <span className="ml-1 normal-case font-normal">(secs)</span>
          </label>
          <input
            type="number" min={0} value={minWake}
            onChange={e => setMinWake(Number(e.target.value))}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
          />
        </div>
      </div>
      <p className="text-[10px] text-brand-muted/80 italic mt-2">
        Wall-powered gateways: leave power saving off + all sleep timers at 0. Battery operations: set
        power saving on, light sleep ~300s, min wake ~10s. Super deep sleep is the most aggressive — node
        becomes effectively offline between cycles.
      </p>
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={save}
          disabled={saving || !live}
          className="bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 border border-amber-500/40 text-amber-300 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
        >
          {saving ? 'Writing…' : 'Write Power Config to Radio'}
        </button>
        {msg && <span className="text-[11px] text-brand-muted">{msg}</span>}
      </div>
    </div>
  );
}

function AddRadioForm({ existing, onCancel, onCreated }: {
  existing: RadioRow[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [radioId, setRadioId] = React.useState('');
  const [longName, setLongName] = React.useState('');
  const [transport, setTransport] = React.useState<'serial' | 'tcp' | 'ble'>('tcp');
  const [target, setTarget] = React.useState('');
  const [networkLabel, setNetworkLabel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [detecting, setDetecting] = React.useState(false);
  const [detectMsg, setDetectMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await meshDataService.addRadio({
      radio_id: radioId.trim(),
      long_name: longName.trim(),
      transport,
      target: target.trim(),
      network_label: networkLabel.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error || 'add failed'); return; }
    onCreated();
  };

  const detectIdentity = async () => {
    setDetectMsg(null); setErr(null);
    if (!target.trim()) { setDetectMsg('Enter a target first.'); return; }
    if (transport === 'ble') { setDetectMsg('BLE detection not implemented yet.'); return; }
    setDetecting(true);
    const r = await meshDataService.testRadioConnection({
      transport: transport as 'serial' | 'tcp',
      target: target.trim(),
      timeout_ms: 5000,
    });
    setDetecting(false);
    if (!r.ok) { setDetectMsg(`✗ ${(r as { ok: false; error: string }).error}`); return; }
    if (!r.identity) { setDetectMsg('Connected but radio did not report identity in time.'); return; }
    if (!radioId.trim()) setRadioId(r.identity.shortName);
    if (!longName.trim()) setLongName(r.identity.longName || r.identity.shortName);
    const loraStr = r.lora ? ` · slot ${r.lora.frequencySlot}, ${r.lora.hopLimit} hops` : '';
    const prefix = r.alreadyConnectedAs
      ? `⚠ already connected as ${r.alreadyConnectedAs} — live state below`
      : `✓ ${r.identity.shortName} (${r.identity.longName || r.identity.nodeId})`;
    setDetectMsg(`${prefix}${r.alreadyConnectedAs ? ` (${r.identity.shortName})` : ''}${loraStr}`);
  };

  const used = existing.map(r => r.radio_id);
  const collides = radioId.trim() && used.includes(radioId.trim());

  return (
    <div className="border border-brand-accent/30 rounded p-3 bg-brand-accent/5 space-y-3">
      <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Add Radio</h5>
      <p className="text-[11px] text-brand-muted">
        Enter the transport + target, then click <b>Detect Identity</b> to auto-fill the radio's short name + long name from its firmware. You can also fill the fields by hand.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Short Name (1–4 chars)</label>
          <input
            type="text"
            maxLength={4}
            value={radioId}
            onChange={e => setRadioId(e.target.value)}
            placeholder="NOVA"
            className={cn(
              "w-full bg-brand-bg border rounded px-2 py-1 text-xs mono-text text-brand-ink",
              collides ? "border-red-500/60" : "border-brand-line"
            )}
          />
          {collides && <p className="text-[10px] text-red-400 mt-0.5">already in use</p>}
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Long Name</label>
          <input
            type="text"
            value={longName}
            onChange={e => setLongName(e.target.value)}
            placeholder="NOVA Mesh Gateway"
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Transport</label>
          <select
            value={transport}
            onChange={e => setTransport(e.target.value as any)}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
          >
            <option value="tcp">tcp</option>
            <option value="serial">serial</option>
            <option value="ble" disabled>ble (Phase 5)</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Target</label>
          <input
            type="text"
            value={target}
            onChange={e => setTarget(e.target.value)}
            placeholder={transport === 'tcp' ? '192.168.1.50:4403' : '/dev/ttyUSB1'}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Network Label (optional)</label>
          <input
            type="text"
            value={networkLabel}
            onChange={e => setNetworkLabel(e.target.value)}
            placeholder="NOVA Mesh"
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
          />
        </div>
      </div>
      {err && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-[11px] text-red-300">
          <AlertCircle size={12} /> {err}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={detectIdentity}
          disabled={detecting || !target.trim()}
          className="bg-brand-line hover:bg-brand-line/70 disabled:opacity-40 border border-brand-line text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
          title="Open a temporary connection and read the radio's short name + long name + LoRa config"
        >
          {detecting ? <Loader2 size={11} className="animate-spin inline" /> : 'Detect Identity'}
        </button>
        <button
          onClick={submit}
          disabled={busy || !radioId.trim() || !longName.trim() || !target.trim() || !!collides}
          className="bg-brand-accent/10 hover:bg-brand-accent/20 disabled:opacity-40 border border-brand-accent/40 text-brand-accent text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
        >
          {busy ? 'Adding…' : 'Add Radio'}
        </button>
        <button
          onClick={onCancel}
          className="text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-3 py-1.5 rounded"
        >
          Cancel
        </button>
        {detectMsg && <span className="text-[11px] text-brand-muted">{detectMsg}</span>}
      </div>
    </div>
  );
}
