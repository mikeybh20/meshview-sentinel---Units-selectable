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
  Star, Plus, Trash2, AlertCircle, Loader2, RefreshCw, HelpCircle, X, Check, Copy,
  Pencil, Plug, Unplug, Activity,
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

/**
 * v2.0 Beta 3: live HTTP status viewer for TCP-transport radios. Calls the
 * Sentinel server's proxy of the radio's `/json/report` endpoint (the
 * Meshtastic firmware serves this on port 80 when WiFi is on) and renders the
 * payload as a set of operator-relevant sections. The raw JSON is available
 * at the bottom for power users + bug reports.
 */
function RadioWebStatusOverlay({ radioId, radioName, onClose }: {
  radioId: string;
  radioName: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [payload, setPayload] = React.useState<any>(null);
  const [source, setSource] = React.useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = React.useState<number | null>(null);
  const [copied, setCopied] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await meshDataService.getRadioWebStatus(radioId);
    setLoading(false);
    if (!r.ok) {
      setError((r as { ok: false; error: string }).error);
      return;
    }
    setPayload(r.data);
    setSource(r.source);
    setFetchedAt(r.fetched_at);
  }, [radioId]);

  React.useEffect(() => { load(); }, [load]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const data = payload?.data ?? {};
  const power = data.power ?? {};
  const wifi = data.wifi ?? {};
  const radio = data.radio ?? {};
  const airtime = data.airtime ?? {};
  const memory = data.memory ?? {};
  const device = data.device ?? {};

  // Format uptime as Hh Mm Ss
  const fmtUptime = (s: number | undefined): string => {
    if (typeof s !== 'number' || s < 0) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return [h ? `${h}h` : '', m ? `${m}m` : '', `${sec}s`].filter(Boolean).join(' ');
  };
  const fmtBytes = (b: number | undefined): string => {
    if (typeof b !== 'number') return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  };
  const isBoolish = (v: unknown): boolean | null => {
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="bg-brand-line/30 border border-brand-line rounded p-3 space-y-1.5">
      <h5 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">{title}</h5>
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-xs">{children}</div>
    </div>
  );
  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <>
      <span className="text-brand-muted">{label}</span>
      <span className="text-brand-ink mono-text">{value ?? '—'}</span>
    </>
  );

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-brand-bg/80 backdrop-blur-md p-6"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="technical-panel w-full max-w-2xl bg-brand-bg max-h-[85vh] flex flex-col"
      >
        <div className="px-4 py-3 border-b border-brand-line flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-bold uppercase tracking-tight text-brand-ink">Radio Web Status</h3>
            <p className="text-[10px] mono-text text-brand-muted truncate">
              {radioName} · {source ?? `radio "${radioId}"`}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={load}
              disabled={loading}
              title="Refresh"
              className="text-brand-muted hover:text-brand-ink p-1 rounded transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} title="Close" className="text-brand-muted hover:text-brand-ink p-1 rounded transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-brand-muted text-[12px]">
              <Loader2 size={14} className="animate-spin" /> Fetching /json/report…
            </div>
          )}

          {!loading && error && (
            <div className="bg-red-500/10 border border-red-500/40 rounded p-3 text-[11px] text-red-300">
              <p className="font-bold mb-1">Couldn't fetch status</p>
              <p>{error}</p>
              <p className="mt-2 text-brand-muted">
                The radio's webserver only responds when WiFi is enabled, joined, and the radio's IP matches the Sentinel target. Common causes: radio just rebooted (try Refresh in ~10s), WiFi dropped, or the target host/IP is out of date.
              </p>
            </div>
          )}

          {!loading && !error && payload && (
            <>
              <Section title="Power">
                <Row label="Battery" value={typeof power.battery_percent === 'number' ? `${power.battery_percent}%` : '—'} />
                <Row label="Voltage" value={typeof power.battery_voltage_mv === 'number' ? `${(power.battery_voltage_mv / 1000).toFixed(3)} V` : '—'} />
                <Row label="Has battery" value={String(isBoolish(power.has_battery) ?? '—')} />
                <Row label="USB connected" value={String(isBoolish(power.has_usb) ?? '—')} />
                <Row label="Charging" value={String(isBoolish(power.is_charging) ?? '—')} />
              </Section>

              <Section title="WiFi">
                <Row label="IP" value={wifi.ip ?? '—'} />
                <Row label="RSSI" value={typeof wifi.rssi === 'number' ? `${wifi.rssi} dBm` : '—'} />
              </Section>

              <Section title="Radio">
                <Row label="Frequency" value={typeof radio.frequency === 'number' ? `${radio.frequency.toFixed(3)} MHz` : '—'} />
                <Row label="LoRa channel" value={radio.lora_channel ?? '—'} />
              </Section>

              <Section title="Airtime">
                <Row label="Channel util" value={typeof airtime.channel_utilization === 'number' ? `${(airtime.channel_utilization * 100).toFixed(2)}%` : '—'} />
                <Row label="TX util" value={typeof airtime.utilization_tx === 'number' ? `${(airtime.utilization_tx * 100).toFixed(3)}%` : '—'} />
                <Row label="Uptime" value={fmtUptime(airtime.seconds_since_boot)} />
                <Row label="Period length" value={typeof airtime.seconds_per_period === 'number' ? `${airtime.seconds_per_period}s` : '—'} />
                <Row label="Periods logged" value={airtime.periods_to_log ?? '—'} />
                {Array.isArray(airtime.rx_log) && (
                  <Row label="RX (last 8h)" value={<span className="text-[10px]">[{airtime.rx_log.join(', ')}]</span>} />
                )}
                {Array.isArray(airtime.tx_log) && (
                  <Row label="TX (last 8h)" value={<span className="text-[10px]">[{airtime.tx_log.join(', ')}]</span>} />
                )}
              </Section>

              <Section title="Memory">
                <Row label="Heap free" value={fmtBytes(memory.heap_free)} />
                <Row label="Heap total" value={fmtBytes(memory.heap_total)} />
                <Row label="Flash free" value={fmtBytes(memory.fs_free)} />
                <Row label="Flash total" value={fmtBytes(memory.fs_total)} />
                {typeof memory.psram_total === 'number' && memory.psram_total > 0 && (
                  <>
                    <Row label="PSRAM free" value={fmtBytes(memory.psram_free)} />
                    <Row label="PSRAM total" value={fmtBytes(memory.psram_total)} />
                  </>
                )}
              </Section>

              <Section title="Device">
                <Row label="Reboot count" value={device.reboot_counter ?? '—'} />
                <Row label="Status" value={payload.status ?? '—'} />
                <Row label="Fetched" value={fetchedAt ? new Date(fetchedAt).toLocaleString() : '—'} />
              </Section>

              <details className="bg-brand-line/30 border border-brand-line rounded">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink select-none">
                  Raw JSON
                </summary>
                <div className="px-3 pb-3 pt-1">
                  <pre className="text-[10px] mono-text text-brand-ink overflow-x-auto whitespace-pre-wrap">{JSON.stringify(payload, null, 2)}</pre>
                  <button
                    onClick={handleCopy}
                    className="mt-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors"
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied ? 'Copied' : 'Copy JSON'}
                  </button>
                </div>
              </details>
            </>
          )}
        </div>
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
  // v2.0 Beta 3: which TCP radio's HTTP /json/report overlay is open (or null).
  const [statusRadioId, setStatusRadioId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // v2.0 Beta 5 (fix): split into a "loud" reload (toggles the Loading…
  // spinner — used for first mount only) and a "quiet" reload (swaps the
  // data in place — used by SSE-driven refreshes).
  //
  // Background: the previous single-reload path called setLoading(true)
  // on every SSE event. With the radio flap loop we just fixed in
  // meshtasticSerial.ts, `node` SSE events fired many times per second,
  // each one ran reload, flipped loading to true, blanked the radio
  // list to a spinner, then back. Users opening the Add Radio form
  // couldn't focus a field for long enough to type because the page
  // was thrashing under them. The Add Radio form's state is preserved
  // across re-renders, but the visual flicker made it feel as though
  // their typing was being lost.
  //
  // The 'node' SSE event is also unrelated to the radios list — it
  // fires for every mesh node update (thousands per hour on a busy
  // network). Per-radio metadata only changes on 'loraConfig' or
  // 'radios' events, so we no longer subscribe to 'node' at all.
  const reloadCore = React.useCallback(async () => {
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
  }, [sysInfo]);

  const reload = React.useCallback(async () => {
    setLoading(true);
    await reloadCore();
    setLoading(false);
  }, [reloadCore]);

  React.useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  React.useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/mesh/stream`);
    // Quiet reload — no loading-spinner flash. Subscribes ONLY to events
    // that actually change radio metadata; 'node' updates are excluded
    // because they fire per-mesh-node-update and have nothing to do
    // with which radios are registered or their LoRa config.
    const handler = () => { reloadCore(); };
    es.addEventListener('loraConfig', handler);
    es.addEventListener('radios', handler);
    return () => {
      es.removeEventListener('loraConfig', handler);
      es.removeEventListener('radios', handler);
      es.close();
    };
  }, [reloadCore]);

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
                onShowStatus={() => setStatusRadioId(r.radio_id)}
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
      {statusRadioId && (
        <RadioWebStatusOverlay
          radioId={statusRadioId}
          radioName={radios.find(r => r.radio_id === statusRadioId)?.long_name ?? statusRadioId}
          onClose={() => setStatusRadioId(null)}
        />
      )}
    </div>
  );
}

function RadioRowCard({
  row, isSingleton, isConnected, health, isEditing, busy, onEdit, onDelete, onConnect, onDisconnect, onPromote, onShowStatus, onChanged,
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
  onShowStatus: () => void;
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
        {/* v2.0 Beta 3: icon-only action buttons — the row already shows the
            radio name, transport, IP/port, and stats; verbose text labels just
            crowded the row. Tooltips remain on hover via the `title` attribute. */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {!isSingleton && (
            isConnected ? (
              <button
                onClick={onDisconnect}
                disabled={busy}
                className="text-amber-300 hover:bg-amber-500/15 disabled:opacity-40 p-2 rounded"
                title="Disconnect this radio"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
              </button>
            ) : (
              <button
                onClick={onConnect}
                disabled={busy}
                className="text-emerald-400 hover:bg-emerald-400/15 disabled:opacity-40 p-2 rounded"
                title="Connect this radio"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              </button>
            )
          )}
          {/* HTTP /json/report viewer for TCP radios.
              Meshtastic firmware serves a status JSON on port 80 whenever
              WiFi is enabled — shows live battery / wifi RSSI / uptime /
              memory / channel airtime. Gated on transport === 'tcp' since
              serial/BLE radios have no IP. */}
          {row.transport === 'tcp' && (
            <button
              onClick={onShowStatus}
              className="text-sky-400 hover:bg-sky-400/15 p-2 rounded"
              title="Live HTTP status — battery, WiFi RSSI, uptime, memory, channel airtime"
            >
              <Activity size={14} />
            </button>
          )}
          {/* Promote to Singleton: hot-swaps which radio holds the live
              singleton bridge. The current singleton gets disconnected and
              left available for the operator to manually reconnect as a
              secondary. Only shown for non-singleton rows. */}
          {!isSingleton && (
            <button
              onClick={onPromote}
              disabled={busy}
              className="text-amber-400 hover:bg-amber-400/15 disabled:opacity-40 p-2 rounded"
              title="Make this radio the primary — hot-swaps which radio Sentinel's singleton bridge serves"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Star size={14} />}
            </button>
          )}
          <button
            onClick={onEdit}
            className={cn(
              "p-2 rounded transition-colors",
              isEditing
                ? "bg-brand-accent/15 text-brand-accent"
                : "text-brand-muted hover:text-brand-ink hover:bg-brand-line/40"
            )}
            title={isEditing ? 'Close editor' : 'Edit radio metadata, transport, and LoRa config'}
          >
            {isEditing ? <Check size={14} /> : <Pencil size={14} />}
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
  // v2.0 Beta 4: per-radio BBS-only mode. When on, this radio auto-replies
  // to non-BBS DMs with the command index. Effect is applied immediately
  // via BridgeManager.updateRadioBbsOnly on save — no reconnect needed.
  const [bbsOnly, setBbsOnly] = React.useState(!!row.bbs_only);
  // v2.0 Beta 3: transport + target are now editable from the Edit form so the
  // operator can switch a radio between serial / TCP without having to delete
  // and re-add. Common case: switching from serial → tcp once the radio has
  // been put on WiFi.
  const [transport, setTransport] = React.useState<'serial' | 'tcp' | 'ble'>(row.transport);
  const [target, setTarget] = React.useState(row.target);
  const [detecting, setDetecting] = React.useState(false);
  const [detectMsg, setDetectMsg] = React.useState<string | null>(null);
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
      transport,
      target,
      network_label: networkLabel || null,
      color_hex: colorHex,
      enabled,
      bbs_only: bbsOnly,
    });
    setSaving(false);
    if (r.ok) onChanged();
  };

  /** Open a transient connection on the entered transport+target to confirm
   *  the radio is reachable + read its identity. Useful when switching
   *  transport (e.g. serial→tcp after moving the radio to WiFi). Does NOT
   *  modify the saved radio row — operator clicks Save Metadata afterward. */
  const detectIdentity = async () => {
    if (transport === 'ble') { setDetectMsg('BLE detection not implemented yet (Phase 5)'); return; }
    if (!target.trim()) { setDetectMsg('Enter a target first.'); return; }
    setDetectMsg(null);
    setDetecting(true);
    const r = await meshDataService.testRadioConnection({
      transport: transport as 'serial' | 'tcp',
      target: target.trim(),
      timeout_ms: 5000,
    });
    setDetecting(false);
    if (!r.ok) { setDetectMsg(`✗ ${(r as { ok: false; error: string }).error}`); return; }
    if (!r.identity) { setDetectMsg('Connected but radio did not report identity in time.'); return; }
    const loraStr = r.lora ? ` · slot ${r.lora.frequencySlot}, ${r.lora.hopLimit} hops` : '';
    const prefix = r.alreadyConnectedAs
      ? `⚠ already connected as ${r.alreadyConnectedAs} — live state shown`
      : `✓ ${r.identity.shortName} (${r.identity.longName || r.identity.nodeId})`;
    setDetectMsg(`${prefix}${loraStr}`);
    setTimeout(() => setDetectMsg(null), 10_000);
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
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Transport</label>
          <select
            value={transport}
            onChange={e => setTransport(e.target.value as 'serial' | 'tcp' | 'ble')}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
          >
            <option value="serial">serial</option>
            <option value="tcp">tcp</option>
            <option value="ble" disabled>ble (Phase 5)</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Target</label>
          <input
            type="text"
            value={target}
            onChange={e => setTarget(e.target.value)}
            placeholder={transport === 'tcp' ? '192.168.1.50:4403' : '/dev/ttyUSB0'}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink"
          />
        </div>
        <div className="sm:col-span-2 flex items-center gap-2 flex-wrap">
          <button
            onClick={detectIdentity}
            disabled={detecting || !target.trim()}
            className="bg-brand-line hover:bg-brand-line/70 disabled:opacity-40 border border-brand-line text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
            title="Open a temporary connection on the entered transport+target to verify it reaches the radio. Does not save."
          >
            {detecting ? <Loader2 size={11} className="animate-spin inline" /> : 'Detect Identity'}
          </button>
          {detectMsg && <span className="text-[11px] text-brand-muted">{detectMsg}</span>}
        </div>
        {(transport !== row.transport || target !== row.target) && (
          <div className="sm:col-span-2 text-[11px] text-brand-warning bg-brand-warning/10 border border-brand-warning/30 rounded px-3 py-2">
            ⚠ Transport / target changed. After clicking Save Metadata, you'll need to disconnect + reconnect this radio for the new transport to take effect. If it's the default radio, use Make Primary on another radio first, then Make Primary back to apply the new transport.
          </div>
        )}
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
        {/* v2.0 Beta 4: BBS-only mode. Independent from the global BBS
            enable in Settings — this scopes WHICH radio acts like a BBS
            kiosk vs. a chat node. */}
        <label className="sm:col-span-2 flex items-start gap-2 text-xs text-brand-ink select-none cursor-pointer">
          <input
            type="checkbox"
            checked={bbsOnly}
            onChange={e => setBbsOnly(e.target.checked)}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="font-bold">BBS-only mode</span>
            <span className="text-[10px] text-brand-muted normal-case font-normal block mt-0.5">
              Auto-reply to any DM that isn't a BBS command with the command index (<code className="text-brand-accent">:cmd</code>).
              Lets you dedicate this radio as a BBS endpoint while another stays a general chat node.
              The original DM still gets stored so you can see who's pinging the BBS — only the auto-reply behavior is new.
              Effect applies immediately on save; no reconnect needed.
            </span>
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
      <DeviceConfigSection radioId={row.radio_id} />
      <PositionConfigSection radioId={row.radio_id} />
      <DisplayConfigSection radioId={row.radio_id} />
      <BluetoothConfigSection radioId={row.radio_id} />
      <CannedMessagesSection radioId={row.radio_id} />
    </div>
  );
}

/**
 * v2.0 Beta 2 — Canned Messages editor.
 *
 * The device stores a pipe-delimited preset list (max ~200 bytes total).
 * Editable here per radio; the same list powers the dashboard quick-send
 * palette in the Messages view. Originally a hardware-input feature (rotary
 * encoder / buttons) but equally useful as operator presets.
 */
function CannedMessagesSection({ radioId }: { radioId: string }) {
  const [messages, setMessages] = React.useState<string[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioCannedMessages(radioId).then(data => {
      if (cancelled || !data) return;
      setMessages(data.messages ?? []);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [radioId]);

  const refresh = async () => {
    setRefreshing(true);
    await meshDataService.refreshRadioCannedMessages(radioId);
    setTimeout(async () => {
      const data = await meshDataService.getRadioCannedMessages(radioId);
      if (data) { setMessages(data.messages ?? []); setLoaded(true); }
      setRefreshing(false);
    }, 1200);
  };

  const addDraft = () => {
    const t = draft.trim();
    if (!t) return;
    setMessages([...messages, t]);
    setDraft('');
  };

  const removeAt = (i: number) => setMessages(messages.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const r = await meshDataService.setRadioCannedMessages(radioId, messages);
    setSaving(false);
    setMsg(r.ok ? 'Saved to radio.' : `Save failed: ${r.error}`);
    setTimeout(() => setMsg(null), 3000);
  };

  // Combined byte length — firmware caps the pipe-joined string at ~200 bytes.
  const usedBytes = messages.join('|').length;

  return (
    <div className="pt-3 border-t border-brand-line">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Canned Messages</h5>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {!loaded && (
        <div className="text-[11px] text-brand-muted mb-2">
          No canned-message readback yet. Click Refresh once the radio is connected.
        </div>
      )}
      <p className="text-[10px] text-brand-muted mb-2">
        Preset broadcasts the operator can one-click send from the Messages view. Also drive the radio's
        hardware input (rotary encoder / buttons) if fitted. Combined length is capped at ~200 bytes by the firmware.
      </p>
      <div className="space-y-1 mb-2">
        {messages.length === 0 ? (
          <div className="text-[11px] text-brand-muted italic">No canned messages set.</div>
        ) : messages.map((m, i) => (
          <div key={i} className="flex items-center gap-2 bg-brand-line/20 border border-brand-line rounded px-2 py-1">
            <span className="text-xs text-brand-ink flex-1 truncate">{m}</span>
            <button
              onClick={() => removeAt(i)}
              className="text-red-400 hover:text-red-300 p-0.5 rounded"
              title="Remove"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addDraft(); }}
          placeholder="Add a preset message…"
          maxLength={60}
          className="flex-1 bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink"
        />
        <button
          onClick={addDraft}
          disabled={!draft.trim()}
          className="bg-brand-line hover:bg-brand-line/70 disabled:opacity-40 border border-brand-line text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1"
        >
          <Plus size={11} className="inline" /> Add
        </button>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 border border-amber-500/40 text-amber-300 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
        >
          {saving ? 'Writing…' : 'Write Canned Messages to Radio'}
        </button>
        <span className={cn('text-[10px] mono-text', usedBytes > 200 ? 'text-red-400' : 'text-brand-muted')}>
          {usedBytes}/200 bytes
        </span>
        {msg && <span className="text-[11px] text-brand-muted">{msg}</span>}
      </div>
    </div>
  );
}

/**
 * v2.0 Beta 2 — Read-only Network config surface.
 *
 * v2.0 Beta 5: now editable. WiFi SSID/PSK, Eth toggle, and NTP can be
 * written from here, gated to LOCAL ADMIN ONLY — the server-side endpoint
 * refuses the write unless this radio has a live serial/TCP context (i.e.,
 * we're talking to the radio directly, not relaying admin packets across
 * the LoRa mesh). That's the threat we're avoiding: WiFi PSKs broadcast
 * over the air to every nearby node. Sentinel's admin path never touches
 * LoRa, so writes from here go strictly over the operator's own
 * connection to the device.
 *
 * Important: WiFi credentials don't survive a readback (firmware never
 * echoes the PSK). If you click Save without typing a PSK, the firmware
 * CLEARS the saved one. Empty + SSID + wifi=on = WPA-open expectation,
 * which most networks reject — the confirmation dialog flags this.
 */
function NetworkConfigSection({ radioId }: { radioId: string }) {
  const [live, setLive] = React.useState<{
    wifiEnabled: boolean; wifiSsid: string; ethEnabled: boolean; ntpServer: string;
  } | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  // Editable form state — synced from live on first load + every refresh.
  // PSK is intentionally NEVER synced (firmware doesn't echo it); operator
  // must re-enter on every change, which the warning copy explains.
  const [wifiEnabled, setWifiEnabled] = React.useState(false);
  const [wifiSsid, setWifiSsid] = React.useState('');
  const [wifiPsk, setWifiPsk] = React.useState('');
  const [ntpServer, setNtpServer] = React.useState('');
  const [ethEnabled, setEthEnabled] = React.useState(false);
  const [pskVisible, setPskVisible] = React.useState(false);

  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const applyLive = (snap: NonNullable<typeof live>) => {
    setLive(snap);
    setWifiEnabled(snap.wifiEnabled);
    setWifiSsid(snap.wifiSsid ?? '');
    setNtpServer(snap.ntpServer ?? '');
    setEthEnabled(snap.ethEnabled);
    // Deliberately NOT touching wifiPsk — firmware never returns it.
  };

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioNetwork(radioId).then(data => {
      if (cancelled || !data?.live) return;
      applyLive(data.live);
    });
    return () => { cancelled = true; };
  }, [radioId]);

  const refresh = async () => {
    setRefreshing(true);
    setMsg(null);
    await meshDataService.refreshRadioNetwork(radioId);
    setTimeout(async () => {
      const data = await meshDataService.getRadioNetwork(radioId);
      if (data?.live) applyLive(data.live);
      setRefreshing(false);
    }, 1200);
  };

  const ssidErr =
    wifiSsid.length > 32 ? 'SSID exceeds the 32-character 802.11 limit' :
    null;
  const pskErr =
    wifiPsk && (wifiPsk.length < 8 || wifiPsk.length > 63)
      ? 'WPA2 PSK must be 8..63 characters (or empty for an open network)'
      : null;
  const canSave = !ssidErr && !pskErr && !saving;

  const save = async () => {
    setMsg(null);
    // Empty-PSK confirm: nearly always a foot-gun unless the network is
    // genuinely open. Confirmation copy spells it out + offers cancel.
    if (wifiEnabled && !wifiPsk) {
      const proceed = confirm(
        `Save with an EMPTY WiFi PSK?\n\n` +
        `The firmware doesn't echo saved PSKs on readback, so leaving this blank ` +
        `will CLEAR the radio's current PSK — your radio will try to join "${wifiSsid}" as an OPEN network. ` +
        `Most networks reject this and the radio will fall off WiFi until you reconnect via USB.\n\n` +
        `Cancel and re-type your WiFi password unless you're sure this is an open network.`
      );
      if (!proceed) return;
    }
    if (!confirm(
      `Write Network config to ${radioId}?\n\n` +
      `WiFi: ${wifiEnabled ? 'ON' : 'off'}\n` +
      `SSID: ${wifiSsid || '(empty)'}\n` +
      `PSK:  ${wifiPsk ? `(${wifiPsk.length} chars)` : '(empty — will clear saved PSK)'}\n` +
      `Eth:  ${ethEnabled ? 'ON' : 'off'}\n` +
      `NTP:  ${ntpServer || '(empty)'}\n\n` +
      `Local admin only — Sentinel writes over its own connection to the radio, never over LoRa. ` +
      `If the radio is currently on WiFi and these credentials are wrong, it may drop the LAN connection ` +
      `until you reconnect via USB.`
    )) return;

    setSaving(true);
    const r = await meshDataService.setRadioNetwork(radioId, {
      wifiEnabled,
      wifiSsid,
      wifiPsk,
      ntpServer,
      ethEnabled,
    });
    setSaving(false);
    if (!r.ok) {
      setMsg({ tone: 'err', text: r.error || 'Save failed' });
      return;
    }
    setMsg({ tone: 'ok', text: 'Sent — radio should join the new network within ~15s. Refresh to confirm.' });
    // Clear the PSK input post-send so it isn't sitting in the DOM. The
    // input is `type=password` already but extra hygiene doesn't hurt.
    setWifiPsk('');
  };

  return (
    <div className="pt-3 border-t border-brand-line space-y-3">
      <div className="flex items-center justify-between">
        <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Network</h5>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {msg && (
        <div className={cn(
          'flex items-start gap-2 text-[11px] rounded border px-2 py-1.5',
          msg.tone === 'ok'
            ? 'border-brand-accent/40 bg-brand-accent/10 text-brand-accent'
            : 'border-red-500/40 bg-red-500/10 text-red-300',
        )}>
          {msg.tone === 'ok' ? <Check size={11} className="mt-0.5" /> : <AlertCircle size={11} className="mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* WiFi toggle */}
      <label className="flex items-center gap-2 text-[11px] text-brand-ink select-none cursor-pointer">
        <input type="checkbox" checked={wifiEnabled} onChange={e => setWifiEnabled(e.target.checked)} />
        <span className="font-bold">WiFi enabled</span>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">SSID</label>
          <input
            type="text"
            value={wifiSsid}
            onChange={e => setWifiSsid(e.target.value)}
            placeholder="MyWiFi"
            maxLength={32}
            className={cn(
              'w-full bg-brand-line/50 border rounded px-2 py-1 text-[12px] mono-text focus:outline-none',
              ssidErr ? 'border-brand-error' : 'border-brand-line focus:border-brand-accent',
            )}
          />
          {ssidErr && <div className="text-[10px] text-brand-error">{ssidErr}</div>}
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted flex items-center justify-between">
            <span>PSK</span>
            <button
              type="button"
              onClick={() => setPskVisible(v => !v)}
              className="text-brand-muted hover:text-brand-ink normal-case"
            >
              {pskVisible ? 'hide' : 'show'}
            </button>
          </label>
          <input
            type={pskVisible ? 'text' : 'password'}
            value={wifiPsk}
            onChange={e => setWifiPsk(e.target.value)}
            placeholder="(re-type on every change)"
            autoComplete="off"
            className={cn(
              'w-full bg-brand-line/50 border rounded px-2 py-1 text-[12px] mono-text focus:outline-none',
              pskErr ? 'border-brand-error' : 'border-brand-line focus:border-brand-accent',
            )}
          />
          {pskErr && <div className="text-[10px] text-brand-error">{pskErr}</div>}
        </div>
      </div>

      {/* Eth + NTP */}
      <label className="flex items-center gap-2 text-[11px] text-brand-ink select-none cursor-pointer">
        <input type="checkbox" checked={ethEnabled} onChange={e => setEthEnabled(e.target.checked)} />
        <span className="font-bold">Ethernet enabled</span>
        <span className="text-[10px] text-brand-muted normal-case font-normal">(boards with an Ethernet PHY only)</span>
      </label>

      <div className="space-y-1">
        <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">NTP server (optional)</label>
        <input
          type="text"
          value={ntpServer}
          onChange={e => setNtpServer(e.target.value)}
          placeholder="meshtastic.pool.ntp.org"
          className="w-full bg-brand-line/50 border border-brand-line rounded px-2 py-1 text-[12px] mono-text focus:outline-none focus:border-brand-accent"
        />
      </div>

      <button
        onClick={save}
        disabled={!canSave}
        className="bg-brand-accent/10 hover:bg-brand-accent/20 disabled:opacity-40 border border-brand-accent/40 text-brand-accent text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5"
      >
        {saving ? 'Writing…' : 'Save network config'}
      </button>

      <p className="text-[10px] text-brand-muted/80 italic leading-snug">
        Local admin only — Sentinel writes over its own direct connection to the radio (serial or TCP),
        never over LoRa. The firmware does not echo saved WiFi PSKs on readback, so the PSK field starts
        empty on every refresh. Type your current PSK every time you save, otherwise the radio will
        clear it. If you write wrong WiFi credentials, your radio may drop the LAN connection until you
        reconnect via USB.
      </p>
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

// ============================================================================
// v2.0 Beta 3 — Apple-parity config editors (Device / Position / Display /
// Bluetooth). Each mirrors PowerConfigSection's shape: live snapshot, refresh,
// dirty form, save with confirm dialog. Field semantics referenced inline from
// config.proto field numbers; firmware preserves unmodelled fields on round-trip.
// ============================================================================

const DEVICE_ROLE_OPTIONS = [
  { value: 0, label: 'CLIENT — app-connected / standalone (default)' },
  { value: 1, label: 'CLIENT_MUTE — does not forward packets' },
  { value: 2, label: 'ROUTER — coverage extender (sleeps wifi/screen)' },
  { value: 5, label: 'TRACKER — prioritizes position broadcasts' },
  { value: 6, label: 'SENSOR — prioritizes telemetry broadcasts' },
  { value: 7, label: 'TAK — ATAK-optimized, reduced routine broadcasts' },
  { value: 8, label: 'CLIENT_HIDDEN — speak only when spoken to' },
  { value: 9, label: 'LOST_AND_FOUND — auto position broadcasts for recovery' },
  { value: 10, label: 'TAK_TRACKER — auto TAK PLI broadcasts' },
  { value: 11, label: 'ROUTER_LATE — rebroadcasts after all other modes' },
  { value: 12, label: 'CLIENT_BASE — favorites as ROUTER_LATE, others as CLIENT' },
];
const REBROADCAST_OPTIONS = [
  { value: 0, label: 'ALL — rebroadcast any observed (default)' },
  { value: 1, label: 'ALL_SKIP_DECODING — repeater-only, no decode' },
  { value: 2, label: 'LOCAL_ONLY — local primary/secondary channels only' },
  { value: 3, label: 'KNOWN_ONLY — only known-NodeDB sources' },
  { value: 4, label: 'NONE — inhibit rebroadcast (SENSOR/TRACKER/TAK_TRACKER only)' },
  { value: 5, label: 'CORE_PORTNUMS_ONLY — drop TAK/RangeTest/Pax/etc.' },
];
const BUZZER_MODE_OPTIONS = [
  { value: 0, label: 'ALL — buttons + alerts (default)' },
  { value: 1, label: 'DISABLED' },
  { value: 2, label: 'NOTIFICATIONS_ONLY' },
  { value: 3, label: 'SYSTEM_ONLY — buttons / boot / shutdown' },
  { value: 4, label: 'DIRECT_MSG_ONLY' },
];

function DeviceConfigSection({ radioId }: { radioId: string }) {
  const [live, setLive] = React.useState<{
    role: number; rebroadcastMode: number; nodeInfoBroadcastSecs: number;
    doubleTapAsButtonPress: boolean; disableTripleClick: boolean; tzdef: string;
    ledHeartbeatDisabled: boolean; buzzerMode: number;
  } | null>(null);
  const [role, setRole] = React.useState(0);
  const [rebroadcastMode, setRebroadcastMode] = React.useState(0);
  const [nodeInfoSecs, setNodeInfoSecs] = React.useState(0);
  const [doubleTap, setDoubleTap] = React.useState(false);
  const [disableTriple, setDisableTriple] = React.useState(false);
  const [tzdef, setTzdef] = React.useState('');
  const [ledDisabled, setLedDisabled] = React.useState(false);
  const [buzzerMode, setBuzzerMode] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const applyLive = (snap: NonNullable<typeof live>) => {
    setLive(snap);
    setRole(snap.role);
    setRebroadcastMode(snap.rebroadcastMode);
    setNodeInfoSecs(snap.nodeInfoBroadcastSecs);
    setDoubleTap(snap.doubleTapAsButtonPress);
    setDisableTriple(snap.disableTripleClick);
    setTzdef(snap.tzdef);
    setLedDisabled(snap.ledHeartbeatDisabled);
    setBuzzerMode(snap.buzzerMode);
  };

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioDevice(radioId).then(data => {
      if (cancelled || !data || !data.live) return;
      applyLive(data.live);
    });
    return () => { cancelled = true; };
  }, [radioId]);

  const refresh = async () => {
    setRefreshing(true);
    await meshDataService.refreshRadioDevice(radioId);
    setTimeout(async () => {
      const data = await meshDataService.getRadioDevice(radioId);
      if (data?.live) applyLive(data.live);
      setRefreshing(false);
    }, 1200);
  };

  const save = async () => {
    const roleLbl = DEVICE_ROLE_OPTIONS.find(o => o.value === role)?.label ?? role;
    if (!confirm(`Write Device config to ${radioId}?\n\nRole: ${roleLbl}\nRebroadcast: ${rebroadcastMode}\nNodeInfo every: ${nodeInfoSecs}s (0=default 900s)\nTZ: ${tzdef || '(unset)'}\n\nRole changes affect how this radio participates in the mesh.`)) return;
    setSaving(true);
    setMsg(null);
    const r = await meshDataService.setRadioDevice(radioId, {
      role, rebroadcastMode, nodeInfoBroadcastSecs: nodeInfoSecs,
      doubleTapAsButtonPress: doubleTap, disableTripleClick: disableTriple,
      tzdef, ledHeartbeatDisabled: ledDisabled, buzzerMode,
    });
    setSaving(false);
    if (r.ok) { setMsg('Write sent. Awaiting firmware readback…'); setTimeout(() => setMsg(null), 3000); }
    else setMsg(`Write failed: ${r.error}`);
  };

  return (
    <div className="pt-3 border-t border-brand-line">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Device</h5>
        <button onClick={refresh} disabled={refreshing}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40">
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {!live && <div className="text-[11px] text-brand-muted mb-2">No Device config readback yet. Click Refresh once the radio is connected.</div>}
      <div className="space-y-3">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Role</label>
          <select value={role} onChange={e => setRole(Number(e.target.value))}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink">
            {DEVICE_ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Rebroadcast mode</label>
          <select value={rebroadcastMode} onChange={e => setRebroadcastMode(Number(e.target.value))}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink">
            {REBROADCAST_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">NodeInfo broadcast <span className="normal-case font-normal">(secs; 0=900s default)</span></label>
            <input type="number" min={0} value={nodeInfoSecs} onChange={e => setNodeInfoSecs(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink" />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Buzzer mode</label>
            <select value={buzzerMode} onChange={e => setBuzzerMode(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink">
              {BUZZER_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">POSIX timezone <span className="normal-case font-normal">(e.g. EST5EDT,M3.2.0,M11.1.0)</span></label>
          <input type="text" value={tzdef} onChange={e => setTzdef(e.target.value)} placeholder="(empty = unset)"
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink" />
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs text-brand-ink">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={doubleTap} onChange={e => setDoubleTap(e.target.checked)} />
            <span>Double-tap = button</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={disableTriple} onChange={e => setDisableTriple(e.target.checked)} />
            <span>Disable triple-click GPS</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={ledDisabled} onChange={e => setLedDisabled(e.target.checked)} />
            <span>Disable LED heartbeat</span>
          </label>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={saving || !live}
          className="bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 border border-amber-500/40 text-amber-300 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5">
          {saving ? 'Writing…' : 'Write Device Config to Radio'}
        </button>
        {msg && <span className="text-[11px] text-brand-muted">{msg}</span>}
      </div>
    </div>
  );
}

const GPS_MODE_OPTIONS = [
  { value: 0, label: 'DISABLED — GPS present but off' },
  { value: 1, label: 'ENABLED' },
  { value: 2, label: 'NOT_PRESENT — board has no GPS' },
];
// PositionFlags bitmask values from config.proto.
const POSITION_FLAGS = [
  { bit: 0x01, label: 'Altitude' },
  { bit: 0x02, label: 'Altitude MSL' },
  { bit: 0x04, label: 'Geoidal separation' },
  { bit: 0x08, label: 'DOP' },
  { bit: 0x10, label: 'HVDOP (split)' },
  { bit: 0x20, label: 'Satellites in view' },
  { bit: 0x40, label: 'Sequence number' },
  { bit: 0x80, label: 'Timestamp' },
  { bit: 0x100, label: 'Heading' },
  { bit: 0x200, label: 'Speed' },
];

function PositionConfigSection({ radioId }: { radioId: string }) {
  const [live, setLive] = React.useState<{
    positionBroadcastSecs: number; smartEnabled: boolean; fixedPosition: boolean;
    gpsUpdateIntervalSecs: number; positionFlags: number;
    smartMinimumDistanceMeters: number; smartMinimumIntervalSecs: number; gpsMode: number;
  } | null>(null);
  const [bcastSecs, setBcastSecs] = React.useState(0);
  const [smart, setSmart] = React.useState(true);
  const [fixed, setFixed] = React.useState(false);
  const [gpsSecs, setGpsSecs] = React.useState(0);
  const [flags, setFlags] = React.useState(0);
  const [smartMinDist, setSmartMinDist] = React.useState(0);
  const [smartMinSecs, setSmartMinSecs] = React.useState(0);
  const [gpsMode, setGpsMode] = React.useState(1);
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const applyLive = (snap: NonNullable<typeof live>) => {
    setLive(snap);
    setBcastSecs(snap.positionBroadcastSecs);
    setSmart(snap.smartEnabled);
    setFixed(snap.fixedPosition);
    setGpsSecs(snap.gpsUpdateIntervalSecs);
    setFlags(snap.positionFlags);
    setSmartMinDist(snap.smartMinimumDistanceMeters);
    setSmartMinSecs(snap.smartMinimumIntervalSecs);
    setGpsMode(snap.gpsMode);
  };

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioPosition(radioId).then(data => {
      if (cancelled || !data || !data.live) return;
      applyLive(data.live);
    });
    return () => { cancelled = true; };
  }, [radioId]);

  const refresh = async () => {
    setRefreshing(true);
    await meshDataService.refreshRadioPosition(radioId);
    setTimeout(async () => {
      const data = await meshDataService.getRadioPosition(radioId);
      if (data?.live) applyLive(data.live);
      setRefreshing(false);
    }, 1200);
  };

  const save = async () => {
    if (!confirm(`Write Position config to ${radioId}?\n\nBroadcast: ${bcastSecs}s (0=900s default)\nSmart enabled: ${smart}\nFixed position: ${fixed}\nGPS mode: ${GPS_MODE_OPTIONS.find(o => o.value === gpsMode)?.label}\nFlags: 0x${flags.toString(16)}\n\nLat/lng/alt for fixed positions are set separately via the radio itself or a phone app.`)) return;
    setSaving(true);
    setMsg(null);
    const r = await meshDataService.setRadioPosition(radioId, {
      positionBroadcastSecs: bcastSecs, smartEnabled: smart, fixedPosition: fixed,
      gpsUpdateIntervalSecs: gpsSecs, positionFlags: flags,
      smartMinimumDistanceMeters: smartMinDist, smartMinimumIntervalSecs: smartMinSecs, gpsMode,
    });
    setSaving(false);
    if (r.ok) { setMsg('Write sent. Awaiting firmware readback…'); setTimeout(() => setMsg(null), 3000); }
    else setMsg(`Write failed: ${r.error}`);
  };

  const toggleFlag = (bit: number) => setFlags(f => f & bit ? f & ~bit : f | bit);

  return (
    <div className="pt-3 border-t border-brand-line">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Position</h5>
        <button onClick={refresh} disabled={refreshing}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40">
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {!live && <div className="text-[11px] text-brand-muted mb-2">No Position config readback yet. Click Refresh once the radio is connected.</div>}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Position broadcast <span className="normal-case font-normal">(secs; 0=900s default)</span></label>
            <input type="number" min={0} value={bcastSecs} onChange={e => setBcastSecs(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink" />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">GPS update interval <span className="normal-case font-normal">(secs; 0=30s default)</span></label>
            <input type="number" min={0} value={gpsSecs} onChange={e => setGpsSecs(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink" />
          </div>
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">GPS mode</label>
          <select value={gpsMode} onChange={e => setGpsMode(Number(e.target.value))}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink">
            {GPS_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-xs text-brand-ink cursor-pointer">
            <input type="checkbox" checked={smart} onChange={e => setSmart(e.target.checked)} />
            <span>Smart broadcast (default)</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-brand-ink cursor-pointer">
            <input type="checkbox" checked={fixed} onChange={e => setFixed(e.target.checked)} />
            <span>Fixed position</span>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Smart min distance <span className="normal-case font-normal">(meters)</span></label>
            <input type="number" min={0} value={smartMinDist} onChange={e => setSmartMinDist(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink" />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Smart min interval <span className="normal-case font-normal">(secs)</span></label>
            <input type="number" min={0} value={smartMinSecs} onChange={e => setSmartMinSecs(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink" />
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Position flags <span className="normal-case font-normal">(extra fields per packet — more = larger airtime)</span></div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {POSITION_FLAGS.map(f => (
              <label key={f.bit} className="flex items-center gap-2 text-[11px] text-brand-ink cursor-pointer">
                <input type="checkbox" checked={(flags & f.bit) !== 0} onChange={() => toggleFlag(f.bit)} />
                <span>{f.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={saving || !live}
          className="bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 border border-amber-500/40 text-amber-300 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5">
          {saving ? 'Writing…' : 'Write Position Config to Radio'}
        </button>
        {msg && <span className="text-[11px] text-brand-muted">{msg}</span>}
      </div>
    </div>
  );
}

const DISPLAY_UNITS_OPTIONS = [
  { value: 0, label: 'Metric (default)' }, { value: 1, label: 'Imperial' },
];
const OLED_TYPE_OPTIONS = [
  { value: 0, label: 'Auto-detect' }, { value: 1, label: 'SSD1306' },
  { value: 2, label: 'SH1106' }, { value: 3, label: 'SH1107 (128×64)' },
  { value: 4, label: 'SH1107 (128×128)' }, { value: 5, label: 'SH1107 rotated' },
];
const DISPLAY_MODE_OPTIONS = [
  { value: 0, label: 'Default (128×64 OLED)' }, { value: 1, label: 'Two-color (bicolor OLED)' },
  { value: 2, label: 'Inverted (TwoColor + inverted top bar)' }, { value: 3, label: 'Color (TFT — not implemented)' },
];
const COMPASS_ORIENTATION_OPTIONS = [
  { value: 0, label: '0°' }, { value: 1, label: '90°' }, { value: 2, label: '180°' }, { value: 3, label: '270°' },
  { value: 4, label: '0° inverted' }, { value: 5, label: '90° inverted' },
  { value: 6, label: '180° inverted' }, { value: 7, label: '270° inverted' },
];

function DisplayConfigSection({ radioId }: { radioId: string }) {
  const [live, setLive] = React.useState<{
    screenOnSecs: number; autoScreenCarouselSecs: number; flipScreen: boolean;
    units: number; oled: number; displayMode: number; headingBold: boolean;
    wakeOnTapOrMotion: boolean; compassOrientation: number; use12hClock: boolean;
    useLongNodeName: boolean; enableMessageBubbles: boolean;
  } | null>(null);
  const [screenOn, setScreenOn] = React.useState(0);
  const [carousel, setCarousel] = React.useState(0);
  const [flip, setFlip] = React.useState(false);
  const [units, setUnits] = React.useState(0);
  const [oled, setOled] = React.useState(0);
  const [displayMode, setDisplayMode] = React.useState(0);
  const [headingBold, setHeadingBold] = React.useState(false);
  const [wakeOnTap, setWakeOnTap] = React.useState(false);
  const [compass, setCompass] = React.useState(0);
  const [use12h, setUse12h] = React.useState(false);
  const [longName, setLongName] = React.useState(false);
  const [bubbles, setBubbles] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const applyLive = (snap: NonNullable<typeof live>) => {
    setLive(snap);
    setScreenOn(snap.screenOnSecs);
    setCarousel(snap.autoScreenCarouselSecs);
    setFlip(snap.flipScreen);
    setUnits(snap.units);
    setOled(snap.oled);
    setDisplayMode(snap.displayMode);
    setHeadingBold(snap.headingBold);
    setWakeOnTap(snap.wakeOnTapOrMotion);
    setCompass(snap.compassOrientation);
    setUse12h(snap.use12hClock);
    setLongName(snap.useLongNodeName);
    setBubbles(snap.enableMessageBubbles);
  };

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioDisplay(radioId).then(data => {
      if (cancelled || !data || !data.live) return;
      applyLive(data.live);
    });
    return () => { cancelled = true; };
  }, [radioId]);

  const refresh = async () => {
    setRefreshing(true);
    await meshDataService.refreshRadioDisplay(radioId);
    setTimeout(async () => {
      const data = await meshDataService.getRadioDisplay(radioId);
      if (data?.live) applyLive(data.live);
      setRefreshing(false);
    }, 1200);
  };

  const save = async () => {
    if (!confirm(`Write Display config to ${radioId}?\n\nScreen on: ${screenOn}s (0=60s default)\nUnits: ${units === 0 ? 'Metric' : 'Imperial'}\nMode: ${DISPLAY_MODE_OPTIONS.find(o => o.value === displayMode)?.label}`)) return;
    setSaving(true);
    setMsg(null);
    const r = await meshDataService.setRadioDisplay(radioId, {
      screenOnSecs: screenOn, autoScreenCarouselSecs: carousel, flipScreen: flip,
      units, oled, displayMode, headingBold, wakeOnTapOrMotion: wakeOnTap,
      compassOrientation: compass, use12hClock: use12h, useLongNodeName: longName,
      enableMessageBubbles: bubbles,
    });
    setSaving(false);
    if (r.ok) { setMsg('Write sent. Awaiting firmware readback…'); setTimeout(() => setMsg(null), 3000); }
    else setMsg(`Write failed: ${r.error}`);
  };

  return (
    <div className="pt-3 border-t border-brand-line">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Display</h5>
        <button onClick={refresh} disabled={refreshing}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40">
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {!live && <div className="text-[11px] text-brand-muted mb-2">No Display config readback yet. Click Refresh once the radio is connected.</div>}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Screen on <span className="normal-case font-normal">(secs; 0=60s default)</span></label>
            <input type="number" min={0} value={screenOn} onChange={e => setScreenOn(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink" />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Auto screen carousel <span className="normal-case font-normal">(secs; 0=off)</span></label>
            <input type="number" min={0} value={carousel} onChange={e => setCarousel(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Units</label>
            <select value={units} onChange={e => setUnits(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink">
              {DISPLAY_UNITS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">OLED type</label>
            <select value={oled} onChange={e => setOled(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink">
              {OLED_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Display mode</label>
            <select value={displayMode} onChange={e => setDisplayMode(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink">
              {DISPLAY_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Compass orientation</label>
            <select value={compass} onChange={e => setCompass(Number(e.target.value))}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink">
              {COMPASS_ORIENTATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs text-brand-ink">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={flip} onChange={e => setFlip(e.target.checked)} />
            <span>Flip screen vertically</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={headingBold} onChange={e => setHeadingBold(e.target.checked)} />
            <span>Bold headings</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={wakeOnTap} onChange={e => setWakeOnTap(e.target.checked)} />
            <span>Wake on tap / motion</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={use12h} onChange={e => setUse12h(e.target.checked)} />
            <span>12-hour clock</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={longName} onChange={e => setLongName(e.target.checked)} />
            <span>Long node names on screen</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={bubbles} onChange={e => setBubbles(e.target.checked)} />
            <span>Message bubbles</span>
          </label>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={saving || !live}
          className="bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 border border-amber-500/40 text-amber-300 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5">
          {saving ? 'Writing…' : 'Write Display Config to Radio'}
        </button>
        {msg && <span className="text-[11px] text-brand-muted">{msg}</span>}
      </div>
    </div>
  );
}

const PAIRING_MODE_OPTIONS = [
  { value: 0, label: 'RANDOM_PIN — fresh PIN shown on screen each pair (default)' },
  { value: 1, label: 'FIXED_PIN — operator-set 6-digit PIN' },
  { value: 2, label: 'NO_PIN — pair without PIN (less secure)' },
];

function BluetoothConfigSection({ radioId }: { radioId: string }) {
  const [live, setLive] = React.useState<{
    enabled: boolean; mode: number; fixedPin: number;
  } | null>(null);
  const [enabled, setEnabled] = React.useState(false);
  const [mode, setMode] = React.useState(0);
  const [fixedPin, setFixedPin] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const applyLive = (snap: NonNullable<typeof live>) => {
    setLive(snap);
    setEnabled(snap.enabled);
    setMode(snap.mode);
    setFixedPin(snap.fixedPin);
  };

  React.useEffect(() => {
    let cancelled = false;
    meshDataService.getRadioBluetooth(radioId).then(data => {
      if (cancelled || !data || !data.live) return;
      applyLive(data.live);
    });
    return () => { cancelled = true; };
  }, [radioId]);

  const refresh = async () => {
    setRefreshing(true);
    await meshDataService.refreshRadioBluetooth(radioId);
    setTimeout(async () => {
      const data = await meshDataService.getRadioBluetooth(radioId);
      if (data?.live) applyLive(data.live);
      setRefreshing(false);
    }, 1200);
  };

  const save = async () => {
    if (mode === 1 && (fixedPin < 1 || fixedPin > 999999)) {
      setMsg('Fixed PIN must be 1–6 digits.'); return;
    }
    if (!confirm(`Write Bluetooth config to ${radioId}?\n\nEnabled: ${enabled}\nMode: ${PAIRING_MODE_OPTIONS.find(o => o.value === mode)?.label}\nPIN: ${mode === 1 ? fixedPin.toString().padStart(6, '0') : '(unused)'}\n\nDisabling BT may break the phone-app connection until WiFi is enabled.`)) return;
    setSaving(true);
    setMsg(null);
    const r = await meshDataService.setRadioBluetooth(radioId, { enabled, mode, fixedPin });
    setSaving(false);
    if (r.ok) { setMsg('Write sent. Awaiting firmware readback…'); setTimeout(() => setMsg(null), 3000); }
    else setMsg(`Write failed: ${r.error}`);
  };

  return (
    <div className="pt-3 border-t border-brand-line">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">Bluetooth</h5>
        <button onClick={refresh} disabled={refreshing}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink hover:bg-brand-line/40 px-2 py-1 rounded disabled:opacity-40">
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {!live && <div className="text-[11px] text-brand-muted mb-2">No Bluetooth config readback yet. Click Refresh once the radio is connected.</div>}
      <label className="flex items-center gap-2 text-xs text-brand-ink mb-3 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>Bluetooth enabled</span>
        <span className="text-[10px] text-brand-muted normal-case font-normal">— disabled = WiFi-only operation</span>
      </label>
      <div className="space-y-3">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Pairing mode</label>
          <select value={mode} onChange={e => setMode(Number(e.target.value))} disabled={!enabled}
            className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs text-brand-ink disabled:opacity-50">
            {PAIRING_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {mode === 1 && (
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-1">Fixed PIN <span className="normal-case font-normal">(1–6 digits, e.g. 123456)</span></label>
            <input type="number" min={1} max={999999} value={fixedPin}
              onChange={e => setFixedPin(Number(e.target.value))} disabled={!enabled}
              className="w-full bg-brand-bg border border-brand-line rounded px-2 py-1 text-xs mono-text text-brand-ink disabled:opacity-50" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={saving || !live}
          className="bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 border border-amber-500/40 text-amber-300 text-[10px] font-bold uppercase tracking-widest rounded px-3 py-1.5">
          {saving ? 'Writing…' : 'Write Bluetooth Config to Radio'}
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

  // v2.0 Beta 3: mDNS / Bonjour auto-discovery of Meshtastic radios on the LAN.
  // Polls `/api/mesh/discover/mdns` every 5 s; clicking a discovered row
  // auto-fills transport=tcp + target=<ipv4>:4403. Existing radios (those
  // already in the registry) are filtered out so the operator doesn't try to
  // re-add. List stays empty if the Sentinel container can't see mDNS
  // multicast (Docker bridge networking).
  type Discovered = Awaited<ReturnType<typeof meshDataService.getMdnsDiscovered>>[number];
  const [discovered, setDiscovered] = React.useState<Discovered[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const list = await meshDataService.getMdnsDiscovered();
      if (!cancelled) setDiscovered(list);
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);
  const usedTargets = new Set(existing.map(r => r.target.split(':')[0].trim()));
  const usedRadioIds = new Set(existing.map(r => r.radio_id));
  const candidates = discovered.filter(d =>
    d.ipv4 && !usedTargets.has(d.ipv4) && !usedRadioIds.has(d.name)
  );

  const useDiscovered = (svc: Discovered) => {
    if (!svc.ipv4) return;
    setTransport('tcp');
    setTarget(svc.ipv4);
    // Pre-fill short_name + long_name from the advertised host if the user
    // hasn't typed anything yet. Detect Identity will overwrite with the
    // radio's real values once connected.
    if (!radioId.trim()) setRadioId(svc.name.slice(0, 4).toUpperCase());
    if (!longName.trim()) setLongName(svc.name);
    setDetectMsg(`Selected ${svc.name} (${svc.ipv4}:${svc.port}) — click Detect Identity to verify.`);
  };

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

      {/* v2.0 Beta 3: mDNS / Bonjour auto-discovery. Lists Meshtastic radios
          announcing _meshtastic._tcp on the LAN that aren't already in the
          registry. One-click fills transport=tcp + target=<ipv4>. Stays
          hidden when nothing's discovered (e.g. Docker bridge networking
          blocks multicast). */}
      {candidates.length > 0 && (
        <div className="bg-sky-500/5 border border-sky-500/30 rounded p-2 space-y-1.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-sky-400">
            Discovered on WiFi ({candidates.length})
          </p>
          <div className="space-y-1">
            {candidates.map(svc => (
              <button
                key={svc.fqdn}
                onClick={() => useDiscovered(svc)}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-sky-500/20 bg-brand-bg/40 hover:bg-sky-500/10 hover:border-sky-500/50 text-left transition-colors group"
                title={`Click to fill: tcp / ${svc.ipv4}`}
              >
                <span className="text-xs text-brand-ink truncate">{svc.name}</span>
                <span className="text-[10px] mono-text text-brand-muted group-hover:text-sky-400 shrink-0">
                  {svc.ipv4}:{svc.port}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

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
