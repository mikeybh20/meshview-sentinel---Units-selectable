import React from 'react';
import { motion } from 'motion/react';
import {
  X, Wifi, Bell, Globe, FileDown, FileUp, Bot, Plug, AlertCircle,
  Check, Loader2, Eye, EyeOff, Radio, Ban, Undo2, Network, RefreshCw,
} from 'lucide-react';

import { meshDataService, TransportInfo } from '../services/meshDataService';
import { LocalModuleConfigSnapshot, Node, UnitSystem } from '../types';
import { cn } from '../lib/utils';

const API_BASE = import.meta.env.VITE_API_URL || '';

type SectionKey = 'connection' | 'modules' | 'notifications' | 'display' | 'blocked' | 'data' | 'ai';

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: React.ReactNode;
}

const SECTIONS: SectionDef[] = [
  { key: 'connection',    label: 'Connection',    icon: <Wifi size={14} /> },
  { key: 'modules',       label: 'Modules',       icon: <Network size={14} /> },
  { key: 'notifications', label: 'Notifications', icon: <Bell size={14} /> },
  { key: 'display',       label: 'Display',       icon: <Globe size={14} /> },
  { key: 'blocked',       label: 'Blocked',       icon: <Ban size={14} /> },
  { key: 'data',          label: 'Data',          icon: <FileDown size={14} /> },
  { key: 'ai',            label: 'AI',            icon: <Bot size={14} /> },
];

interface SettingsModalProps {
  onClose: () => void;

  // Connection section
  transport: TransportInfo | null;
  radioConnected: boolean;
  onTcpConnected?: () => void;

  // Notifications section
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  notificationPermission: NotificationPermission | 'unsupported';
  setNotificationPermission: (v: NotificationPermission | 'unsupported') => void;

  // Display section
  unitSystem: UnitSystem;
  setUnitSystem: (v: UnitSystem) => void;

  // Data section
  onOpenExport: () => void;
  onOpenImport: () => void;

  // Blocked section
  blockedNodeIds: Set<string>;
  nodes: Node[];
  onUnblockNode: (id: string) => void;

  // Modules section (also reuses `radioConnected` declared above)
  /** Current authoritative module config (undefined fields mean "not yet read"). */
  localModuleConfig: LocalModuleConfigSnapshot;
}

export function SettingsModal(props: SettingsModalProps) {
  const [active, setActive] = React.useState<SectionKey>('connection');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-brand-bg/85 backdrop-blur-md p-6"
      onClick={props.onClose}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-3xl rounded-lg border border-emerald-500/30 overflow-hidden flex flex-col max-h-[85vh]"
        style={{ background: '#020617', boxShadow: '0 20px 60px rgba(0,0,0,0.7)' }}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-bold tracking-tight uppercase text-white">Settings</h3>
          </div>
          <button onClick={props.onClose} className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded">
            <X size={18} />
          </button>
        </div>

        {/* Body: tabs + content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Tab nav */}
          <nav className="w-44 border-r border-slate-800 py-2 flex-shrink-0">
            {SECTIONS.map(s => (
              <button
                key={s.key}
                onClick={() => setActive(s.key)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-4 py-2 text-xs font-bold uppercase tracking-widest transition-colors",
                  active === s.key
                    ? "bg-emerald-500/10 text-emerald-300 border-l-2 border-emerald-400"
                    : "text-slate-400 hover:bg-slate-800/40 hover:text-white border-l-2 border-transparent"
                )}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5">
            {active === 'connection'    && <ConnectionSection {...props} />}
            {active === 'modules'       && <ModulesSection {...props} />}
            {active === 'notifications' && <NotificationsSection {...props} />}
            {active === 'display'       && <DisplaySection {...props} />}
            {active === 'blocked'       && <BlockedSection {...props} />}
            {active === 'data'          && <DataSection {...props} />}
            {active === 'ai'            && <AiSection />}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ============================================================================
// Connection
// ============================================================================
function ConnectionSection({ transport, radioConnected, onTcpConnected, onClose }: SettingsModalProps) {
  const [host, setHost] = React.useState(transport?.tcp?.host ?? '');
  const [port, setPort] = React.useState(String(transport?.tcp?.port ?? 4403));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!host.trim()) { setError('Host is required'); return; }
    const portNum = parseInt(port, 10);
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      setError('Port must be between 1 and 65535');
      return;
    }
    setBusy(true);
    const r = await meshDataService.connectTcp(host.trim(), portNum);
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Connect failed'); return; }
    onTcpConnected?.();
    onClose();
  };

  const handleDisconnect = async () => {
    setError(null);
    setBusy(true);
    const r = await meshDataService.disconnect();
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Disconnect failed'); return; }
  };

  const isConnectedTcp = radioConnected && transport?.mode === 'tcp';

  return (
    <div className="space-y-5">
      <SectionHeader title="Radio Connection" subtitle="Manage how the server talks to your Meshtastic radio." />

      {/* Current connection status */}
      <div className="bg-slate-800/60 border border-slate-700 rounded p-3">
        <div className="flex items-center gap-2 mb-2">
          <Radio size={13} className={cn(radioConnected ? 'text-emerald-400' : 'text-slate-500')} />
          <span className="text-[10px] uppercase font-bold text-slate-400">Active Transport</span>
        </div>
        {transport?.mode ? (
          <p className="text-xs mono-text text-slate-200">
            {transport.mode === 'serial' && transport.serial
              ? <>Serial · {transport.serial.port}</>
              : transport.mode === 'tcp' && transport.tcp
              ? <>TCP · {transport.tcp.host}:{transport.tcp.port}</>
              : '—'}
            {radioConnected
              ? <span className="text-emerald-400 ml-2">CONNECTED</span>
              : <span className="text-slate-500 ml-2">DISCONNECTED</span>}
          </p>
        ) : (
          <p className="text-xs text-slate-400 italic">No active transport</p>
        )}
      </div>

      {/* TCP connect form */}
      <form onSubmit={handleConnect} className="space-y-3">
        <div>
          <p className="text-[10px] uppercase font-bold text-slate-400 mb-1.5">TCP Connect (Network Radio)</p>
          <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
            Meshtastic firmware 2.7.4+ exposes a TCP server on port <span className="mono-text text-slate-200">4403</span>.
            Useful for radios on Wi-Fi or behind a Raspberry Pi gateway.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-400">Host / IP</label>
            <input
              type="text"
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder="192.168.1.42"
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 mono-text"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-400">Port</label>
            <input
              type="number"
              value={port}
              onChange={e => setPort(e.target.value)}
              min={1}
              max={65535}
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50 mono-text"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
            <AlertCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-red-300">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {isConnectedTcp ? (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
              className="text-xs font-bold uppercase tracking-widest text-red-400 hover:text-red-300 px-3 py-1.5 disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : <div />}

          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            <Plug size={12} />
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================================
// Notifications
// ============================================================================
function NotificationsSection({
  notificationsEnabled, setNotificationsEnabled,
  notificationPermission, setNotificationPermission,
}: SettingsModalProps) {
  const handleClick = async () => {
    if (notificationPermission === 'unsupported' || notificationPermission === 'denied') return;
    if (notificationPermission === 'default') {
      const result = await Notification.requestPermission();
      setNotificationPermission(result);
      if (result === 'granted') {
        setNotificationsEnabled(true);
        try { localStorage.setItem('mesh.notificationsEnabled', 'true'); } catch { /* noop */ }
      }
      return;
    }
    const next = !notificationsEnabled;
    setNotificationsEnabled(next);
    try { localStorage.setItem('mesh.notificationsEnabled', String(next)); } catch { /* noop */ }
  };

  const stateLabel = notificationPermission === 'unsupported' ? 'Not supported in this browser'
    : notificationPermission === 'denied' ? 'Blocked — enable in browser settings'
    : notificationPermission === 'default' ? 'Permission not yet granted'
    : notificationsEnabled ? 'On — DMs and node-lost alerts will trigger notifications'
    : 'Muted';

  const stateColor = notificationPermission === 'granted' && notificationsEnabled
    ? 'text-emerald-400'
    : 'text-slate-400';

  return (
    <div className="space-y-5">
      <SectionHeader title="Browser Notifications" subtitle="Get alerted when DMs arrive or favorite nodes go offline." />

      <div className="bg-slate-800/60 border border-slate-700 rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-white uppercase tracking-wide">Status</p>
            <p className={cn("text-[11px] mt-0.5", stateColor)}>{stateLabel}</p>
          </div>
          <button
            onClick={handleClick}
            disabled={notificationPermission === 'unsupported' || notificationPermission === 'denied'}
            className={cn(
              "text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border",
              notificationPermission === 'granted' && notificationsEnabled
                ? "bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-500/50 text-emerald-300"
                : "bg-slate-800 hover:bg-slate-700 border-slate-600 text-slate-200"
            )}
          >
            {notificationPermission === 'default' ? 'Enable'
              : notificationPermission === 'granted' && notificationsEnabled ? 'Mute'
              : notificationPermission === 'granted' ? 'Unmute'
              : 'Unavailable'}
          </button>
        </div>

        <div className="text-[11px] text-slate-400 leading-relaxed border-t border-slate-700/50 pt-3 space-y-1">
          <p><strong className="text-slate-300">Triggers:</strong> incoming DMs to the local node (suppressed if you're already viewing that chat) and NODE_LOST events for favorited nodes.</p>
          <p>Notifications include a "click to open chat" action that switches to the messages tab with the sender's chat active.</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Display
// ============================================================================
function DisplaySection({ unitSystem, setUnitSystem }: SettingsModalProps) {
  return (
    <div className="space-y-5">
      <SectionHeader title="Display" subtitle="Visual and unit preferences." />

      <div>
        <p className="text-[10px] uppercase font-bold text-slate-400 mb-2">Unit System</p>
        <div className="grid grid-cols-2 gap-2 max-w-sm">
          {(['METRIC', 'IMPERIAL'] as UnitSystem[]).map(opt => (
            <button
              key={opt}
              onClick={() => setUnitSystem(opt)}
              className={cn(
                "p-3 border rounded-lg text-left transition-all",
                unitSystem === opt
                  ? "border-emerald-500/50 bg-emerald-500/10"
                  : "border-slate-700 hover:border-slate-500 bg-slate-800/40"
              )}
            >
              <p className="text-xs font-bold text-white">{opt}</p>
              <p className="text-[10px] text-slate-400 mono-text">
                {opt === 'METRIC' ? '°C · km · hPa' : '°F · mi · inHg'}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Data (Export / Import)
// ============================================================================
function DataSection({ onOpenExport, onOpenImport, onClose }: SettingsModalProps) {
  return (
    <div className="space-y-5">
      <SectionHeader title="Data" subtitle="Export and import mesh data as CSV." />

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => { onOpenExport(); onClose(); }}
          className="flex flex-col items-start gap-1.5 bg-slate-800/40 hover:bg-slate-800 border border-slate-700 hover:border-emerald-500/50 rounded-lg p-4 text-left transition-colors"
        >
          <FileDown size={16} className="text-emerald-400" />
          <p className="text-xs font-bold text-white uppercase tracking-wide">Export</p>
          <p className="text-[10px] text-slate-400 leading-snug">Download messages, events, or telemetry as CSV with date and node filters.</p>
        </button>
        <button
          onClick={() => { onOpenImport(); onClose(); }}
          className="flex flex-col items-start gap-1.5 bg-slate-800/40 hover:bg-slate-800 border border-slate-700 hover:border-emerald-500/50 rounded-lg p-4 text-left transition-colors"
        >
          <FileUp size={16} className="text-emerald-400" />
          <p className="text-xs font-bold text-white uppercase tracking-wide">Import</p>
          <p className="text-[10px] text-slate-400 leading-snug">Bulk-import node data from CSV.</p>
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// AI (provider + API keys, inlined from former AISettingsModal)
// ============================================================================
interface AIConfig {
  provider: 'anthropic' | 'gemini';
  anthropicModel: string;
  geminiModel: string;
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  anthropicKeyHint: string;
  geminiKeyHint: string;
}

function AiSection() {
  const [config, setConfig] = React.useState<AIConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState('');

  const [anthropicKey, setAnthropicKey] = React.useState('');
  const [geminiKey, setGeminiKey] = React.useState('');
  const [showAnthropicKey, setShowAnthropicKey] = React.useState(false);
  const [showGeminiKey, setShowGeminiKey] = React.useState(false);
  const [provider, setProvider] = React.useState<'anthropic' | 'gemini'>('anthropic');

  React.useEffect(() => {
    fetch(`${API_BASE}/api/ai/config`)
      .then(r => r.json())
      .then((cfg: AIConfig) => { setConfig(cfg); setProvider(cfg.provider); })
      .catch(() => setError('Failed to load AI config'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const body: Record<string, string> = { provider };
      if (anthropicKey) body.anthropicKey = anthropicKey;
      if (geminiKey) body.geminiKey = geminiKey;

      const res = await fetch(`${API_BASE}/api/ai/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Save failed');

      const updated = await fetch(`${API_BASE}/api/ai/config`).then(r => r.json());
      setConfig(updated);
      setProvider(updated.provider);
      setAnthropicKey('');
      setGeminiKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionHeader title="AI Provider" subtitle="API keys are stored server-side and never sent to the browser." />

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-slate-500" />
        </div>
      ) : (
        <>
          <div>
            <p className="text-[10px] uppercase font-bold text-slate-400 mb-2">Active Provider</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setProvider('anthropic')}
                className={cn(
                  "p-3 border rounded-lg text-left transition-all",
                  provider === 'anthropic'
                    ? "border-emerald-500/50 bg-emerald-500/10"
                    : "border-slate-700 hover:border-slate-500"
                )}
              >
                <p className="text-xs font-bold text-white">Anthropic</p>
                <p className="text-[10px] text-slate-400 mono-text">Claude Sonnet / Opus / Haiku</p>
                {config?.hasAnthropicKey && (
                  <span className="text-[9px] text-emerald-400 mono-text mt-0.5 block">KEY SET ({config.anthropicKeyHint})</span>
                )}
              </button>
              <button
                onClick={() => setProvider('gemini')}
                className={cn(
                  "p-3 border rounded-lg text-left transition-all",
                  provider === 'gemini'
                    ? "border-emerald-500/50 bg-emerald-500/10"
                    : "border-slate-700 hover:border-slate-500"
                )}
              >
                <p className="text-xs font-bold text-white">Google Gemini</p>
                <p className="text-[10px] text-slate-400 mono-text">Gemini Flash / Pro</p>
                {config?.hasGeminiKey && (
                  <span className="text-[9px] text-emerald-400 mono-text mt-0.5 block">KEY SET ({config.geminiKeyHint})</span>
                )}
              </button>
            </div>
          </div>

          <KeyInput
            label="Anthropic API Key"
            configured={!!config?.hasAnthropicKey}
            hint={config?.anthropicKeyHint ?? ''}
            placeholder="sk-ant-..."
            value={anthropicKey}
            onChange={setAnthropicKey}
            visible={showAnthropicKey}
            setVisible={setShowAnthropicKey}
          />

          <KeyInput
            label="Gemini API Key"
            configured={!!config?.hasGeminiKey}
            hint={config?.geminiKeyHint ?? ''}
            placeholder="AIza..."
            value={geminiKey}
            onChange={setGeminiKey}
            visible={showGeminiKey}
            setVisible={setShowGeminiKey}
          />

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          <div className="flex justify-end pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className={cn(
                "px-4 py-1.5 rounded text-xs font-bold uppercase tracking-widest transition-all flex items-center gap-2 border",
                saved
                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                  : "bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-500/50 text-emerald-300"
              )}
            >
              {saving ? <Loader2 size={12} className="animate-spin" />
                : saved ? <><Check size={12} /> Saved</>
                : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function KeyInput({ label, configured, hint, placeholder, value, onChange, visible, setVisible }: {
  label: string;
  configured: boolean;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  visible: boolean;
  setVisible: (v: boolean) => void;
}) {
  return (
    <div>
      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 block mb-1.5">
        {label} {configured && <span className="text-emerald-400 normal-case font-normal">(configured)</span>}
      </label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={configured ? `Current: ${hint}` : placeholder}
          className="w-full bg-slate-800 border border-slate-700 rounded py-2 pl-3 pr-10 text-xs mono-text text-white focus:outline-none focus:border-emerald-500/50 placeholder:text-slate-500"
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded"
        >
          {visible ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Modules — firmware module configuration on the local radio
// ============================================================================

const NI_INTERVAL_PRESETS = [
  { value: 600,   label: '10 minutes' },
  { value: 1800,  label: '30 minutes (default)' },
  { value: 3600,  label: '1 hour' },
  { value: 7200,  label: '2 hours' },
  { value: 14400, label: '4 hours (firmware default)' },
  { value: 28800, label: '8 hours' },
  { value: 43200, label: '12 hours' },
];

function ModulesSection({ localModuleConfig, radioConnected }: SettingsModalProps) {
  const ni = localModuleConfig.neighborInfo;

  // Local-edit state. Initialise from the authoritative config when it arrives;
  // re-sync if the snapshot updates (e.g. another tab made a change).
  const [enabled, setEnabled] = React.useState<boolean>(ni?.enabled ?? false);
  const [intervalSecs, setIntervalSecs] = React.useState<number>(ni?.updateIntervalSecs ?? 1800);
  const [transmitOverLora, setTransmitOverLora] = React.useState<boolean>(ni?.transmitOverLora ?? true);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Re-sync local edit state whenever the authoritative snapshot changes
  // (e.g. first readback after connect, or another tab saved). Skip if the
  // user is mid-edit (busy = true).
  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!ni || busy) return;
    if (lastSyncedRef.current === ni.lastReadAt) return;
    lastSyncedRef.current = ni.lastReadAt;
    setEnabled(ni.enabled);
    setIntervalSecs(ni.updateIntervalSecs);
    setTransmitOverLora(ni.transmitOverLora);
  }, [ni?.lastReadAt, ni?.enabled, ni?.updateIntervalSecs, ni?.transmitOverLora, busy]);

  // Dirty when the form differs from the radio's last-known state. When we have
  // no baseline yet (firmware hasn't responded to a readback request), treat the
  // form as always saveable — the operator should be able to *set* values even
  // if the radio never acks the read. After Save, the bridge optimistically
  // populates `localModuleConfig.neighborInfo`, so subsequent edits dirty-check
  // properly.
  const dirty = !ni
    ? true
    : (enabled !== ni.enabled ||
       intervalSecs !== ni.updateIntervalSecs ||
       transmitOverLora !== ni.transmitOverLora);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setNeighborInfoConfig({ enabled, intervalSecs, transmitOverLora });
    setBusy(false);
    if (r.ok) {
      setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    } else {
      setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshNeighborInfoConfig();
    setRefreshing(false);
    if (!r.ok) {
      setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
    }
    // The actual config update arrives asynchronously via the snapshot poll;
    // the useEffect above will re-sync the form when ni.lastReadAt changes.
  };

  const lastReadLabel = ni?.lastReadAt
    ? new Date(ni.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Radio Modules"
        subtitle="Configure firmware modules on the locally-connected radio. Admin writes are local-only — they don't consume mesh airtime."
      />

      {!radioConnected && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 flex items-start gap-2">
          <AlertCircle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-300 leading-relaxed">
            No live radio connected. Module configuration is only available when a real Meshtastic radio is attached via serial or TCP.
          </p>
        </div>
      )}

      {/* NeighborInfo */}
      <div className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Network size={14} className="text-emerald-400" />
              <h5 className="text-xs font-bold uppercase tracking-tight text-white">NeighborInfo</h5>
              {ni && (
                <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                  ni.enabled
                    ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                    : 'text-slate-400 bg-slate-800 border-slate-600'
                }`}>
                  {ni.enabled ? 'Enabled' : 'Disabled'}
                </span>
              )}
              {!ni && radioConnected && (
                <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-slate-600 text-slate-400 bg-slate-800">
                  Reading…
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
              Each node periodically broadcasts a list of its directly-heard neighbors with SNR.
              These broadcasts are what populate the Topology view's real edges.
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={!radioConnected || refreshing}
            title="Re-read the config from the radio"
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500 rounded px-2 py-1 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '...' : 'Refresh'}
          </button>
        </div>

        {/* Enabled toggle */}
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-slate-200">Enabled</p>
            <p className="text-[10px] text-slate-400">When on, this radio broadcasts and ingests NeighborInfo packets.</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            disabled={!radioConnected}
            className="w-4 h-4 accent-emerald-500"
          />
        </label>

        {/* Update interval */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-slate-400 block">
            Update Interval
          </label>
          <select
            value={NI_INTERVAL_PRESETS.some(p => p.value === intervalSecs) ? String(intervalSecs) : 'custom'}
            onChange={e => {
              const v = e.target.value;
              if (v !== 'custom') setIntervalSecs(parseInt(v, 10));
            }}
            disabled={!radioConnected || !enabled}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50 disabled:opacity-50"
          >
            {NI_INTERVAL_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
            {!NI_INTERVAL_PRESETS.some(p => p.value === intervalSecs) && (
              <option value="custom">Custom: {intervalSecs}s</option>
            )}
          </select>

          {/* Manual / fine-grained input */}
          <div className="flex items-center gap-2 mt-1">
            <label className="text-[9px] uppercase font-bold text-slate-500 flex-shrink-0">Custom (s)</label>
            <input
              type="number"
              min={60}
              max={86400}
              step={60}
              value={intervalSecs}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v)) setIntervalSecs(Math.max(60, Math.min(86400, v)));
              }}
              disabled={!radioConnected || !enabled}
              className="w-32 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] mono-text text-white focus:outline-none focus:border-emerald-500/50 disabled:opacity-50"
            />
            <span className="text-[9px] text-slate-500">
              ≈ {intervalSecs < 3600
                ? `${Math.round(intervalSecs / 60)} min`
                : `${(intervalSecs / 3600).toFixed(1)} hr`}
              · {Math.round(86400 / intervalSecs)}/day per node
            </span>
          </div>
          <p className="text-[10px] text-amber-400/80 leading-snug">
            ⚠️ Lower intervals (faster updates) consume more LoRa airtime. 30 min is the recommended balance for most meshes; 4 hr is the firmware default.
          </p>
        </div>

        {/* Transmit over LoRa */}
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-slate-200">Transmit over LoRa</p>
            <p className="text-[10px] text-slate-400">If off, observations are local-only (MQTT-only meshes). Leave on for normal operation.</p>
          </div>
          <input
            type="checkbox"
            checked={transmitOverLora}
            onChange={e => setTransmitOverLora(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500"
          />
        </label>

        {/* Footer / status */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-700/50">
          <p className="text-[9px] mono-text text-slate-500">
            {lastReadLabel
              ? `Last read: ${lastReadLabel}`
              : ni
                ? 'Set by you (no readback yet)'
                : 'No readback yet — Save will apply your values'}
          </p>
          <button
            onClick={handleSave}
            disabled={!radioConnected || busy || !dirty}
            className="flex items-center gap-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
          </button>
        </div>

        {status && (
          <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
            {status.text}
          </p>
        )}
      </div>

      <p className="text-[10px] text-slate-500 leading-relaxed">
        More modules (Range Test, Store &amp; Forward as router, MQTT broker, etc.) will be added here as the admin write paths are implemented.
      </p>
    </div>
  );
}

// ============================================================================
// Blocked nodes
// ============================================================================
function BlockedSection({ blockedNodeIds, nodes, onUnblockNode }: SettingsModalProps) {
  const blocked = Array.from(blockedNodeIds);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Blocked Nodes"
        subtitle="Hide messages, DMs, and map markers from specific nodes. The radio still receives their traffic — this is a local UI filter only."
      />

      {blocked.length === 0 ? (
        <div className="bg-slate-800/40 border border-slate-700 rounded p-4 text-center">
          <Ban size={20} className="mx-auto text-slate-500 mb-2" />
          <p className="text-xs text-slate-400">No nodes blocked</p>
          <p className="text-[10px] text-slate-500 mt-1">
            Click a node on the map and use the Block button to hide them.
          </p>
        </div>
      ) : (
        <div className="bg-slate-800/40 border border-slate-700 rounded divide-y divide-slate-700/50">
          {blocked.map(id => {
            const node = nodes.find(n => n.id === id);
            return (
              <div key={id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white truncate">{node?.name || id}</p>
                  <p className="text-[10px] mono-text text-slate-400">{id}</p>
                </div>
                <button
                  onClick={() => onUnblockNode(id)}
                  className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 hover:border-emerald-500/50 text-slate-300 hover:text-white text-[10px] font-bold uppercase tracking-widest rounded px-2 py-1 transition-colors flex-shrink-0"
                >
                  <Undo2 size={10} />
                  Unblock
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h4 className="text-sm font-bold uppercase tracking-tight text-white">{title}</h4>
      <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>
    </div>
  );
}
