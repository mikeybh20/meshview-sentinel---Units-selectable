import React from 'react';
import { motion } from 'motion/react';
import {
  X, Wifi, Bell, Globe, FileDown, FileUp, Bot, Plug, AlertCircle,
  Check, Loader2, Eye, EyeOff, Radio, Ban, Undo2, Network, RefreshCw,
  HelpCircle, ChevronDown, Activity,
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
  themePreference: 'auto' | 'light' | 'dark';
  setThemePreference: (v: 'auto' | 'light' | 'dark') => void;
  appliedTheme: 'light' | 'dark';

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
        className="w-full max-w-3xl rounded-lg border border-brand-accent/30 overflow-hidden flex flex-col max-h-[85vh]"
        style={{ background: 'var(--color-brand-bg)', boxShadow: '0 20px 60px rgba(0,0,0,0.7)' }}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-brand-line flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-bold tracking-tight uppercase text-brand-ink">Settings</h3>
          </div>
          <button onClick={props.onClose} className="p-1 text-brand-muted hover:text-brand-ink hover:bg-brand-line rounded">
            <X size={18} />
          </button>
        </div>

        {/* Body: tabs + content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Tab nav */}
          <nav className="w-44 border-r border-brand-line py-2 flex-shrink-0">
            {SECTIONS.map(s => (
              <button
                key={s.key}
                onClick={() => setActive(s.key)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-4 py-2 text-xs font-bold uppercase tracking-widest transition-colors",
                  active === s.key
                    ? "bg-brand-accent/10 text-brand-accent border-l-2 border-emerald-400"
                    : "text-brand-muted hover:bg-brand-line/40 hover:text-brand-ink border-l-2 border-transparent"
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

  // Live-subscribe to bridge status so we can show the radio's firmware version
  // and reboot count once they arrive (newer firmware sends them via DeviceMetadata,
  // older firmware via MyNodeInfo — either path lands in MeshStatus).
  const [status, setStatus] = React.useState(meshDataService.getStatus());
  React.useEffect(() => meshDataService.onStatus(setStatus), []);

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
      <div className="bg-brand-line/60 border border-brand-line rounded p-3">
        <div className="flex items-center gap-2 mb-2">
          <Radio size={13} className={cn(radioConnected ? 'text-brand-accent' : 'text-brand-muted')} />
          <span className="text-[10px] uppercase font-bold text-brand-muted">Active Transport</span>
        </div>
        {transport?.mode ? (
          <p className="text-xs mono-text text-brand-ink">
            {transport.mode === 'serial' && transport.serial
              ? <>Serial · {transport.serial.port}</>
              : transport.mode === 'tcp' && transport.tcp
              ? <>TCP · {transport.tcp.host}:{transport.tcp.port}</>
              : '—'}
            {radioConnected
              ? <span className="text-brand-accent ml-2">CONNECTED</span>
              : <span className="text-brand-muted ml-2">DISCONNECTED</span>}
          </p>
        ) : (
          <p className="text-xs text-brand-muted italic">No active transport</p>
        )}

        {/* Firmware / local-node identity, once MyNodeInfo / DeviceMetadata arrives */}
        {radioConnected && (status?.firmwareVersion || status?.localNodeId || status?.rebootCount != null) && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2 pt-2 border-t border-brand-line text-[10px] mono-text">
            {status.firmwareVersion && (
              <>
                <span className="text-brand-muted">firmware</span>
                <span className="text-brand-ink truncate" title={status.firmwareVersion}>{status.firmwareVersion}</span>
              </>
            )}
            {status.localNodeId && (
              <>
                <span className="text-brand-muted">local node</span>
                <span className="text-brand-ink truncate">{status.localNodeId}</span>
              </>
            )}
            {status.rebootCount != null && (
              <>
                <span className="text-brand-muted">reboot count</span>
                <span className="text-brand-ink">{status.rebootCount}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* TCP connect form */}
      <form onSubmit={handleConnect} className="space-y-3">
        <div>
          <p className="text-[10px] uppercase font-bold text-brand-muted mb-1.5">TCP Connect (Network Radio)</p>
          <p className="text-[11px] text-brand-muted leading-relaxed mb-3">
            Meshtastic firmware 2.7.4+ exposes a TCP server on port <span className="mono-text text-brand-ink">4403</span>.
            Useful for radios on Wi-Fi or behind a Raspberry Pi gateway.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted">Host / IP</label>
            <input
              type="text"
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder="192.168.1.42"
              className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink placeholder-slate-500 focus:outline-none focus:border-brand-accent/50 mono-text"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted">Port</label>
            <input
              type="number"
              value={port}
              onChange={e => setPort(e.target.value)}
              min={1}
              max={65535}
              className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 mono-text"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-brand-error/10 border border-brand-error/30 rounded px-3 py-2">
            <AlertCircle size={13} className="text-brand-error flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-brand-error">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {isConnectedTcp ? (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
              className="text-xs font-bold uppercase tracking-widest text-brand-error hover:text-brand-error px-3 py-1.5 disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : <div />}

          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-50"
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
    ? 'text-brand-accent'
    : 'text-brand-muted';

  return (
    <div className="space-y-5">
      <SectionHeader title="Browser Notifications" subtitle="Get alerted when DMs arrive or favorite nodes go offline." />

      <div className="bg-brand-line/60 border border-brand-line rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-brand-ink uppercase tracking-wide">Status</p>
            <p className={cn("text-[11px] mt-0.5", stateColor)}>{stateLabel}</p>
          </div>
          <button
            onClick={handleClick}
            disabled={notificationPermission === 'unsupported' || notificationPermission === 'denied'}
            className={cn(
              "text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border",
              notificationPermission === 'granted' && notificationsEnabled
                ? "bg-brand-accent/20 hover:bg-brand-accent/30 border-brand-accent/50 text-brand-accent"
                : "bg-brand-line hover:bg-brand-line border-brand-line text-brand-ink"
            )}
          >
            {notificationPermission === 'default' ? 'Enable'
              : notificationPermission === 'granted' && notificationsEnabled ? 'Mute'
              : notificationPermission === 'granted' ? 'Unmute'
              : 'Unavailable'}
          </button>
        </div>

        <div className="text-[11px] text-brand-muted leading-relaxed border-t border-brand-line/50 pt-3 space-y-1">
          <p><strong className="text-brand-ink">Triggers:</strong> incoming DMs to the local node (suppressed if you're already viewing that chat) and NODE_LOST events for favorited nodes.</p>
          <p>Notifications include a "click to open chat" action that switches to the messages tab with the sender's chat active.</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Display
// ============================================================================
const MESSAGE_RETENTION_LABELS: Record<number, string> = {
  0: 'Keep all (count cap only)',
  24: '1 day',
  72: '3 days',
  168: '1 week',
  720: '30 days',
  2160: '90 days',
};

function MessageRetentionControl() {
  const [hours, setHours] = React.useState<number>(0);
  const [allowed, setAllowed] = React.useState<number[]>([0, 24, 72, 168, 720, 2160]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const API_BASE = import.meta.env.VITE_API_URL || '';

  React.useEffect(() => {
    fetch(`${API_BASE}/api/mesh/message-retention`)
      .then(r => r.ok ? r.json() : null)
      .then(body => {
        if (body) {
          if (typeof body.hours === 'number') setHours(body.hours);
          if (Array.isArray(body.allowed)) setAllowed(body.allowed);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [API_BASE]);

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = parseInt(e.target.value, 10);
    setError(null);
    setHours(next);
    try {
      const res = await fetch(`${API_BASE}/api/mesh/message-retention`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `HTTP ${res.status}`);
      }
    } catch (err: any) {
      setError(err.message || 'Network error');
    }
  };

  return (
    <div>
      <p className="text-[10px] uppercase font-bold text-brand-muted mb-2">Message Retention</p>
      <select
        value={hours}
        onChange={handleChange}
        disabled={!loaded}
        className="w-full max-w-sm bg-brand-line text-xs rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      >
        {allowed.map(h => (
          <option key={h} value={h}>{MESSAGE_RETENTION_LABELS[h] ?? `${h}h`}</option>
        ))}
      </select>
      <p className="text-[10px] text-brand-muted mt-1.5 leading-snug max-w-sm">
        Older messages are pruned from disk on a 5-minute timer. Count cap of 5,000 always applies as a safety net.
      </p>
      {error && (
        <p className="text-[10px] text-brand-error mt-1.5">Update failed: {error}</p>
      )}
    </div>
  );
}

function DisplaySection({ unitSystem, setUnitSystem, themePreference, setThemePreference, appliedTheme }: SettingsModalProps) {
  const themeOptions: Array<{ value: 'auto' | 'light' | 'dark'; label: string; subtitle: string }> = [
    { value: 'auto',  label: 'Auto',  subtitle: 'Follow OS preference' },
    { value: 'light', label: 'Light', subtitle: 'Always light' },
    { value: 'dark',  label: 'Dark',  subtitle: 'Always dark' },
  ];

  return (
    <div className="space-y-5">
      <SectionHeader title="Display" subtitle="Visual and unit preferences." />

      <div>
        <p className="text-[10px] uppercase font-bold text-brand-muted mb-2">Theme</p>
        <div className="grid grid-cols-3 gap-2 max-w-md">
          {themeOptions.map(opt => {
            const active = themePreference === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setThemePreference(opt.value)}
                className={cn(
                  'p-3 border rounded-lg text-left transition-all',
                  active
                    ? 'border-brand-accent/50 bg-brand-accent/10'
                    : 'border-brand-line hover:border-brand-muted bg-brand-line/40'
                )}
              >
                <p className="text-xs font-bold text-brand-ink">{opt.label}</p>
                <p className="text-[10px] text-brand-muted mono-text">{opt.subtitle}</p>
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-brand-muted mt-1.5 leading-snug max-w-md">
          Currently rendering in <span className="text-brand-ink font-bold">{appliedTheme}</span> mode.
          {' '}Light theme is a first pass: the body and main panels swap, but some modals and Settings cards still use hardcoded dark surfaces and will be cleaned up in a follow-up round.
        </p>
      </div>

      <div>
        <p className="text-[10px] uppercase font-bold text-brand-muted mb-2">Unit System</p>
        <div className="grid grid-cols-2 gap-2 max-w-sm">
          {(['METRIC', 'IMPERIAL'] as UnitSystem[]).map(opt => (
            <button
              key={opt}
              onClick={() => setUnitSystem(opt)}
              className={cn(
                "p-3 border rounded-lg text-left transition-all",
                unitSystem === opt
                  ? "border-brand-accent/50 bg-brand-accent/10"
                  : "border-brand-line hover:border-brand-muted bg-brand-line/40"
              )}
            >
              <p className="text-xs font-bold text-brand-ink">{opt}</p>
              <p className="text-[10px] text-brand-muted mono-text">
                {opt === 'METRIC' ? '°C · km · hPa' : '°F · mi · inHg'}
              </p>
            </button>
          ))}
        </div>
      </div>

      <MessageRetentionControl />
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
          className="flex flex-col items-start gap-1.5 bg-brand-line/40 hover:bg-brand-line border border-brand-line hover:border-brand-accent/50 rounded-lg p-4 text-left transition-colors"
        >
          <FileDown size={16} className="text-brand-accent" />
          <p className="text-xs font-bold text-brand-ink uppercase tracking-wide">Export</p>
          <p className="text-[10px] text-brand-muted leading-snug">Download messages, events, or telemetry as CSV with date and node filters.</p>
        </button>
        <button
          onClick={() => { onOpenImport(); onClose(); }}
          className="flex flex-col items-start gap-1.5 bg-brand-line/40 hover:bg-brand-line border border-brand-line hover:border-brand-accent/50 rounded-lg p-4 text-left transition-colors"
        >
          <FileUp size={16} className="text-brand-accent" />
          <p className="text-xs font-bold text-brand-ink uppercase tracking-wide">Import</p>
          <p className="text-[10px] text-brand-muted leading-snug">Bulk-import node data from CSV.</p>
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// AI (provider + API keys, inlined from former AISettingsModal)
// ============================================================================
type AIProvider = 'anthropic' | 'gemini' | 'ollama';

interface AIConfig {
  provider: AIProvider;
  anthropicModel: string;
  geminiModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  redactPii: boolean;
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  anthropicKeyHint: string;
  geminiKeyHint: string;
}

interface OllamaModelInfo {
  name: string;
  sizeBytes: number | null;
  parameterSize: string | null;
  quantization: string | null;
}

function formatOllamaModelLabel(m: OllamaModelInfo): string {
  const parts: string[] = [m.name];
  if (m.parameterSize) parts.push(m.parameterSize);
  if (m.sizeBytes != null) {
    const gib = m.sizeBytes / (1024 ** 3);
    parts.push(`${gib.toFixed(1)} GB`);
  }
  return parts.join(' · ');
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
  const [provider, setProvider] = React.useState<AIProvider>('anthropic');

  // Ollama-specific local state
  const [ollamaBaseUrl, setOllamaBaseUrl] = React.useState('');
  const [ollamaModel, setOllamaModel] = React.useState('');
  const [ollamaModels, setOllamaModels] = React.useState<OllamaModelInfo[]>([]);
  const [ollamaTesting, setOllamaTesting] = React.useState(false);
  const [ollamaTestStatus, setOllamaTestStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Privacy: redact node IDs / names / message text from prompts before they
  // reach the AI provider.
  const [redactPii, setRedactPii] = React.useState(false);

  React.useEffect(() => {
    fetch(`${API_BASE}/api/ai/config`)
      .then(r => r.json())
      .then((cfg: AIConfig) => {
        setConfig(cfg);
        setProvider(cfg.provider);
        setOllamaBaseUrl(cfg.ollamaBaseUrl ?? '');
        setOllamaModel(cfg.ollamaModel ?? '');
        setRedactPii(!!cfg.redactPii);
      })
      .catch(() => setError('Failed to load AI config'))
      .finally(() => setLoading(false));
  }, []);

  const handleTestOllama = async () => {
    setOllamaTesting(true);
    setOllamaTestStatus(null);
    try {
      const url = `${API_BASE}/api/ai/ollama/tags?baseUrl=${encodeURIComponent(ollamaBaseUrl)}`;
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOllamaTestStatus({ kind: 'error', text: body.error || `HTTP ${res.status}` });
        setOllamaModels([]);
        return;
      }
      const models: OllamaModelInfo[] = body.models ?? [];
      setOllamaModels(models);
      if (models.length === 0) {
        setOllamaTestStatus({ kind: 'error', text: `Connected, but no models are loaded on ${ollamaBaseUrl}. Run \`ollama pull <name>\` first.` });
      } else {
        setOllamaTestStatus({ kind: 'ok', text: `Connected — ${models.length} model${models.length > 1 ? 's' : ''} available` });
        // If the user hasn't picked a model yet, default to the first one.
        if (!ollamaModel || !models.some(m => m.name === ollamaModel)) {
          setOllamaModel(models[0].name);
        }
      }
    } catch (err: any) {
      setOllamaTestStatus({ kind: 'error', text: err?.message || 'Network error' });
      setOllamaModels([]);
    } finally {
      setOllamaTesting(false);
    }
  };

  // Auto-list models if the active provider is Ollama and we have a configured base URL.
  React.useEffect(() => {
    if (provider !== 'ollama') return;
    if (!ollamaBaseUrl) return;
    handleTestOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // Mixed-type payload: provider + URLs are strings, redactPii is a boolean.
      const body: Record<string, string | boolean> = { provider };
      if (anthropicKey) body.anthropicKey = anthropicKey;
      if (geminiKey) body.geminiKey = geminiKey;
      // Always send the Ollama config — even when the active provider is something else,
      // so the operator can stage it before flipping the radio button.
      body.ollamaBaseUrl = ollamaBaseUrl;
      body.ollamaModel = ollamaModel;
      body.redactPii = redactPii;

      const res = await fetch(`${API_BASE}/api/ai/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Save failed');

      const updated = await fetch(`${API_BASE}/api/ai/config`).then(r => r.json());
      setConfig(updated);
      setProvider(updated.provider);
      setOllamaBaseUrl(updated.ollamaBaseUrl ?? '');
      setOllamaModel(updated.ollamaModel ?? '');
      setRedactPii(!!updated.redactPii);
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
          <Loader2 size={20} className="animate-spin text-brand-muted" />
        </div>
      ) : (
        <>
          <div>
            <p className="text-[10px] uppercase font-bold text-brand-muted mb-2">Active Provider</p>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setProvider('anthropic')}
                className={cn(
                  "p-3 border rounded-lg text-left transition-all",
                  provider === 'anthropic'
                    ? "border-brand-accent/50 bg-brand-accent/10"
                    : "border-brand-line hover:border-brand-muted"
                )}
              >
                <p className="text-xs font-bold text-brand-ink">Anthropic</p>
                <p className="text-[10px] text-brand-muted mono-text">Claude Sonnet / Opus / Haiku</p>
                {config?.hasAnthropicKey && (
                  <span className="text-[9px] text-brand-accent mono-text mt-0.5 block">KEY SET ({config.anthropicKeyHint})</span>
                )}
              </button>
              <button
                onClick={() => setProvider('gemini')}
                className={cn(
                  "p-3 border rounded-lg text-left transition-all",
                  provider === 'gemini'
                    ? "border-brand-accent/50 bg-brand-accent/10"
                    : "border-brand-line hover:border-brand-muted"
                )}
              >
                <p className="text-xs font-bold text-brand-ink">Google Gemini</p>
                <p className="text-[10px] text-brand-muted mono-text">Gemini Flash / Pro</p>
                {config?.hasGeminiKey && (
                  <span className="text-[9px] text-brand-accent mono-text mt-0.5 block">KEY SET ({config.geminiKeyHint})</span>
                )}
              </button>
              <button
                onClick={() => setProvider('ollama')}
                className={cn(
                  "p-3 border rounded-lg text-left transition-all",
                  provider === 'ollama'
                    ? "border-brand-accent/50 bg-brand-accent/10"
                    : "border-brand-line hover:border-brand-muted"
                )}
              >
                <p className="text-xs font-bold text-brand-ink">Ollama (local)</p>
                <p className="text-[10px] text-brand-muted mono-text">Self-hosted · OpenAI-compat</p>
                {config?.ollamaModel && (
                  <span className="text-[9px] text-brand-accent mono-text mt-0.5 block truncate">
                    {config.ollamaModel}
                  </span>
                )}
              </button>
            </div>
          </div>

          {provider === 'ollama' ? (
            <div className="space-y-3">
              <div>
                <p className="text-[10px] uppercase font-bold text-brand-muted mb-2">Ollama Server URL</p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={ollamaBaseUrl}
                    onChange={e => setOllamaBaseUrl(e.target.value)}
                    placeholder="http://host.docker.internal:11434"
                    className="flex-1 bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50"
                  />
                  <button
                    onClick={handleTestOllama}
                    disabled={ollamaTesting || !ollamaBaseUrl}
                    className="px-3 py-2 rounded text-[10px] font-bold uppercase tracking-widest border border-brand-line hover:border-brand-accent/50 hover:bg-brand-accent/10 text-brand-ink transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {ollamaTesting ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                    {ollamaTesting ? 'Testing…' : 'Test & List'}
                  </button>
                </div>
                <p className="text-[10px] text-brand-muted mt-1.5 leading-snug">
                  Default for the Docker container is <code className="bg-brand-line px-1 rounded">http://host.docker.internal:11434</code>.
                  If your Ollama listens on a LAN host, use that IP directly. The server uses Ollama's OpenAI-compatible <code className="bg-brand-line px-1 rounded">/v1/chat/completions</code> endpoint.
                </p>
              </div>

              <div>
                <p className="text-[10px] uppercase font-bold text-brand-muted mb-2">Model</p>
                {ollamaModels.length > 0 ? (
                  <select
                    value={ollamaModel}
                    onChange={e => setOllamaModel(e.target.value)}
                    className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50"
                  >
                    {!ollamaModels.some(m => m.name === ollamaModel) && ollamaModel && (
                      <option value={ollamaModel}>{ollamaModel} (saved — not currently loaded)</option>
                    )}
                    {ollamaModels.map(m => (
                      <option key={m.name} value={m.name}>{formatOllamaModelLabel(m)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={ollamaModel}
                    onChange={e => setOllamaModel(e.target.value)}
                    placeholder="llama3.1:8b"
                    className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50"
                  />
                )}
                <p className="text-[10px] text-brand-muted mt-1.5 leading-snug">
                  Click <span className="text-brand-ink font-bold">Test & List</span> to populate this dropdown from your server's <code className="bg-brand-line px-1 rounded">/api/tags</code>.
                </p>
              </div>

              {ollamaTestStatus && (
                <p className={cn(
                  'text-[11px] leading-snug',
                  ollamaTestStatus.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error',
                )}>
                  {ollamaTestStatus.text}
                </p>
              )}

              <OllamaSetupHelp />
            </div>
          ) : (
            <>
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
            </>
          )}

          {/* Privacy: PII redaction toggle (applies to all providers; particularly
              important for cloud Anthropic / Gemini, less so for local Ollama). */}
          <div className="border-t border-brand-line pt-4">
            <p className="text-[10px] uppercase font-bold text-brand-muted mb-2">Privacy</p>
            <label className="flex items-start justify-between gap-3 cursor-pointer p-3 rounded-lg border border-brand-line hover:border-brand-muted bg-brand-line/20 transition-colors">
              <div className="min-w-0">
                <p className="text-xs font-bold text-brand-ink">Redact PII from AI prompts</p>
                <p className="text-[10px] text-brand-muted leading-snug mt-0.5">
                  When on, only aggregate counts go to the AI provider — node identifiers,
                  names, positions, and message contents are stripped from the system prompt.
                  Use this when your provider is a third-party cloud (Anthropic / Gemini) and
                  you don't want mesh PII leaving your network. Setting persists across sessions
                  and is applied client-side <span className="font-bold">before</span> the request leaves the browser.
                </p>
                <p className="text-[10px] text-brand-warning mt-1.5">
                  Trade-off: the assistant can answer questions about <span className="font-bold">general patterns</span>{' '}
                  (counts, online/offline ratios, recent event types) but <span className="font-bold">cannot</span> reason
                  about specific nodes or messages.
                </p>
              </div>
              <input
                type="checkbox"
                checked={redactPii}
                onChange={e => setRedactPii(e.target.checked)}
                className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
              />
            </label>
          </div>

          {error && <p className="text-[11px] text-brand-error">{error}</p>}

          <div className="flex justify-end pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className={cn(
                "px-4 py-1.5 rounded text-xs font-bold uppercase tracking-widest transition-all flex items-center gap-2 border",
                saved
                  ? "bg-brand-accent/20 text-brand-accent border-brand-accent/40"
                  : "bg-brand-accent/20 hover:bg-brand-accent/30 border-brand-accent/50 text-brand-accent"
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

// ============================================================================
// Ollama setup help — shown inside the AI panel when provider === 'ollama'
// ============================================================================
type OllamaHostOs = 'ubuntu' | 'macos' | 'windows';

function OllamaSetupHelp() {
  const [open, setOpen] = React.useState(false);
  const [os, setOs] = React.useState<OllamaHostOs>('ubuntu');

  return (
    <div className="border border-brand-line rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-brand-line/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <HelpCircle size={13} className="text-brand-muted" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-brand-ink">
            Setup help · how to expose Ollama on your network
          </span>
        </div>
        <ChevronDown
          size={14}
          className={cn('text-brand-muted transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="border-t border-brand-line p-3 space-y-3">
          <p className="text-[11px] text-brand-muted leading-relaxed">
            By default Ollama listens on <code className="bg-brand-line px-1 rounded">127.0.0.1:11434</code>, which means
            only the host itself can talk to it. The Meshview Sentinel container has its own network namespace and won't
            reach <code className="bg-brand-line px-1 rounded">localhost</code>. Set <code className="bg-brand-line px-1 rounded">OLLAMA_HOST=0.0.0.0:11434</code> on
            the host where Ollama runs so it accepts connections from the Docker bridge.
          </p>

          <div className="flex gap-1 border border-brand-line rounded p-1 bg-brand-line/20 max-w-md">
            {([
              { value: 'ubuntu',  label: 'Ubuntu / Linux' },
              { value: 'macos',   label: 'macOS' },
              { value: 'windows', label: 'Windows' },
            ] as Array<{ value: OllamaHostOs; label: string }>).map(opt => (
              <button
                key={opt.value}
                onClick={() => setOs(opt.value)}
                className={cn(
                  'flex-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-widest transition-colors',
                  os === opt.value
                    ? 'bg-brand-accent/15 text-brand-accent'
                    : 'text-brand-muted hover:text-brand-ink',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {os === 'ubuntu' && <UbuntuOllamaSteps />}
          {os === 'macos' && <MacOsOllamaSteps />}
          {os === 'windows' && <WindowsOllamaSteps />}

          <div className="border-t border-brand-line pt-2">
            <p className="text-[10px] text-brand-warning leading-snug flex items-start gap-1.5">
              <AlertCircle size={11} className="flex-shrink-0 mt-0.5" />
              <span>
                <span className="font-bold">Security note:</span> <code className="bg-brand-line px-1 rounded">0.0.0.0</code> exposes Ollama on every network interface,
                including LAN. If the host is on an untrusted network, restrict to the Docker bridge only —
                find your bridge IP with <code className="bg-brand-line px-1 rounded">ip route show default</code> (typically
                {' '}<code className="bg-brand-line px-1 rounded">172.17.0.1</code>) and set
                {' '}<code className="bg-brand-line px-1 rounded">OLLAMA_HOST=172.17.0.1:11434</code> instead. Or guard port 11434 with
                {' '}<code className="bg-brand-line px-1 rounded">ufw</code> / firewall rules.
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function HelpStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-[11px] leading-relaxed text-brand-ink">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-brand-accent/15 border border-brand-accent/40 text-brand-accent text-[10px] font-bold mono-text flex items-center justify-center">
        {n}
      </span>
      <div className="flex-1 min-w-0 space-y-1.5">{children}</div>
    </li>
  );
}

function HelpCode({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-brand-bg border border-brand-line rounded p-2 text-[10.5px] mono-text text-brand-ink overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

function UbuntuOllamaSteps() {
  return (
    <ol className="space-y-2.5">
      <HelpStep n={1}>
        <p>Confirm Ollama is currently bound to localhost only (the symptom):</p>
        <HelpCode>{`sudo ss -tlnp | grep 11434
# expect: LISTEN ... 127.0.0.1:11434`}</HelpCode>
      </HelpStep>
      <HelpStep n={2}>
        <p>Open a systemd override for the Ollama service. This creates <code className="bg-brand-line px-1 rounded">/etc/systemd/system/ollama.service.d/override.conf</code>:</p>
        <HelpCode>sudo systemctl edit ollama.service</HelpCode>
      </HelpStep>
      <HelpStep n={3}>
        <p>Paste this between the comment markers in the editor:</p>
        <HelpCode>{`[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"`}</HelpCode>
        <p className="text-brand-muted">Save and exit.</p>
      </HelpStep>
      <HelpStep n={4}>
        <p>Reload systemd and restart Ollama:</p>
        <HelpCode>{`sudo systemctl daemon-reload
sudo systemctl restart ollama`}</HelpCode>
      </HelpStep>
      <HelpStep n={5}>
        <p>Verify the new bind address:</p>
        <HelpCode>{`sudo ss -tlnp | grep 11434
# expect: LISTEN ... 0.0.0.0:11434`}</HelpCode>
      </HelpStep>
      <HelpStep n={6}>
        <p>Click <span className="font-bold text-brand-ink">Test &amp; List</span> above. The model dropdown should populate.</p>
        <p className="text-brand-muted">If you don't have a service unit, run <code className="bg-brand-line px-1 rounded">systemctl list-units --type=service | grep -i ollama</code> to find the right name, or use the manual <code className="bg-brand-line px-1 rounded">OLLAMA_HOST=0.0.0.0:11434 ollama serve</code> form.</p>
      </HelpStep>
    </ol>
  );
}

function MacOsOllamaSteps() {
  return (
    <ol className="space-y-2.5">
      <HelpStep n={1}>
        <p>Quit the Ollama app from the menu bar (icon → Quit).</p>
      </HelpStep>
      <HelpStep n={2}>
        <p>Set the env var system-wide so the GUI app inherits it on relaunch:</p>
        <HelpCode>launchctl setenv OLLAMA_HOST "0.0.0.0:11434"</HelpCode>
      </HelpStep>
      <HelpStep n={3}>
        <p>Relaunch the Ollama app from Applications or Spotlight.</p>
      </HelpStep>
      <HelpStep n={4}>
        <p>Verify the listener:</p>
        <HelpCode>{`lsof -iTCP:11434 -sTCP:LISTEN
# expect *:11434 (or 0.0.0.0:11434), not 127.0.0.1`}</HelpCode>
      </HelpStep>
      <HelpStep n={5}>
        <p>Click <span className="font-bold text-brand-ink">Test &amp; List</span> above.</p>
        <p className="text-brand-muted">
          On macOS the env var via <code className="bg-brand-line px-1 rounded">launchctl setenv</code> persists until reboot. To make it permanent across reboots, add a launch agent or use the Ollama app's preferences dialog (newer versions expose this in the UI).
        </p>
      </HelpStep>
    </ol>
  );
}

function WindowsOllamaSteps() {
  return (
    <ol className="space-y-2.5">
      <HelpStep n={1}>
        <p>Quit Ollama from the system tray (right-click the icon → Quit Ollama).</p>
      </HelpStep>
      <HelpStep n={2}>
        <p>Set the user environment variable. PowerShell one-liner:</p>
        <HelpCode>{`[System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0:11434', 'User')`}</HelpCode>
        <p className="text-brand-muted">
          Or via the GUI: <span className="text-brand-ink">Settings → System → About → Advanced system settings → Environment Variables → New (User variables)</span>. Name <code className="bg-brand-line px-1 rounded">OLLAMA_HOST</code>, Value <code className="bg-brand-line px-1 rounded">0.0.0.0:11434</code>.
        </p>
      </HelpStep>
      <HelpStep n={3}>
        <p>Relaunch Ollama from the Start Menu.</p>
      </HelpStep>
      <HelpStep n={4}>
        <p>Verify in PowerShell:</p>
        <HelpCode>{`Get-NetTCPConnection -LocalPort 11434 |
  Select-Object LocalAddress, State`}</HelpCode>
        <p className="text-brand-muted">Look for a row where <span className="text-brand-ink">LocalAddress</span> is <code className="bg-brand-line px-1 rounded">0.0.0.0</code> and <span className="text-brand-ink">State</span> is <code className="bg-brand-line px-1 rounded">Listen</code>.</p>
      </HelpStep>
      <HelpStep n={5}>
        <p>Click <span className="font-bold text-brand-ink">Test &amp; List</span> above.</p>
        <p className="text-brand-muted">If Windows Defender Firewall blocks the connection from Docker, allow port 11434 inbound for the active network profile (Private if the host and Docker are on the same LAN).</p>
      </HelpStep>
    </ol>
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
      <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted block mb-1.5">
        {label} {configured && <span className="text-brand-accent normal-case font-normal">(configured)</span>}
      </label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={configured ? `Current: ${hint}` : placeholder}
          className="w-full bg-brand-line border border-brand-line rounded py-2 pl-3 pr-10 text-xs mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 placeholder:text-brand-muted"
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-brand-muted hover:text-brand-ink hover:bg-brand-line rounded"
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
        <div className="bg-brand-warning/10 border border-brand-warning/30 rounded p-3 flex items-start gap-2">
          <AlertCircle size={14} className="text-brand-warning flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-brand-warning leading-relaxed">
            No live radio connected. Module configuration is only available when a real Meshtastic radio is attached via serial or TCP.
          </p>
        </div>
      )}

      {/* NeighborInfo */}
      <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Network size={14} className="text-brand-accent" />
              <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">NeighborInfo</h5>
              {ni && (
                <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                  ni.enabled
                    ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                    : 'text-brand-muted bg-brand-line border-brand-line'
                }`}>
                  {ni.enabled ? 'Enabled' : 'Disabled'}
                </span>
              )}
              {!ni && radioConnected && (
                <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                  Reading…
                </span>
              )}
            </div>
            <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
              Each node periodically broadcasts a list of its directly-heard neighbors with SNR.
              These broadcasts are what populate the Topology view's real edges.
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={!radioConnected || refreshing}
            title="Re-read the config from the radio"
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '...' : 'Refresh'}
          </button>
        </div>

        {/* Enabled toggle */}
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Enabled</p>
            <p className="text-[10px] text-brand-muted">When on, this radio broadcasts and ingests NeighborInfo packets.</p>
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
          <label className="text-[10px] uppercase font-bold text-brand-muted block">
            Update Interval
          </label>
          <select
            value={NI_INTERVAL_PRESETS.some(p => p.value === intervalSecs) ? String(intervalSecs) : 'custom'}
            onChange={e => {
              const v = e.target.value;
              if (v !== 'custom') setIntervalSecs(parseInt(v, 10));
            }}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
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
            <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom (s)</label>
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
              className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
            />
            <span className="text-[9px] text-brand-muted">
              ≈ {intervalSecs < 3600
                ? `${Math.round(intervalSecs / 60)} min`
                : `${(intervalSecs / 3600).toFixed(1)} hr`}
              · {Math.round(86400 / intervalSecs)}/day per node
            </span>
          </div>
          <p className="text-[10px] text-brand-warning/80 leading-snug">
            ⚠️ Lower intervals (faster updates) consume more LoRa airtime. 30 min is the recommended balance for most meshes; 4 hr is the firmware default.
          </p>
        </div>

        {/* Transmit over LoRa */}
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Transmit over LoRa</p>
            <p className="text-[10px] text-brand-muted">If off, observations are local-only (MQTT-only meshes). Leave on for normal operation.</p>
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
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
          <p className="text-[9px] mono-text text-brand-muted">
            {lastReadLabel
              ? `Last read: ${lastReadLabel}`
              : ni
                ? 'Set by you (no readback yet)'
                : 'No readback yet — Save will apply your values'}
          </p>
          <button
            onClick={handleSave}
            disabled={!radioConnected || busy || !dirty}
            className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
          </button>
        </div>

        {status && (
          <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
            {status.text}
          </p>
        )}

        <SurveyControl
          title="Site Survey"
          description="Temporarily speed up NeighborInfo broadcasts so the topology graph fills in within minutes instead of hours. Useful right after deploying a new node or fixed repeater. The radio's current NeighborInfo config is captured before the survey and restored when it expires."
          durationOptions={[
            { value: 5,  label: '5 minutes' },
            { value: 10, label: '10 minutes' },
            { value: 15, label: '15 minutes' },
            { value: 30, label: '30 minutes' },
            { value: 60, label: '1 hour' },
          ]}
          defaultDuration={10}
          cadenceOptions={[
            { value: 60,   label: 'Every 1 min · fast' },
            { value: 120,  label: 'Every 2 min' },
            { value: 300,  label: 'Every 5 min · airtime-friendly' },
            { value: 600,  label: 'Every 10 min' },
          ]}
          defaultCadence={120}
          expiresAt={localModuleConfig.activeSurveys?.neighborInfoExpiresAt ?? null}
          disabled={!radioConnected}
          onStart={(durationMinutes, intervalSecs) => meshDataService.startNeighborInfoSurvey({ durationMinutes, intervalSecs })}
          onCancel={() => meshDataService.cancelNeighborInfoSurvey()}
        />
      </div>

      {/* Range Test */}
      <RangeTestModuleCard
        radioConnected={radioConnected}
        rt={localModuleConfig.rangeTest}
        surveyExpiresAt={localModuleConfig.activeSurveys?.rangeTestExpiresAt ?? null}
      />

      {/* Telemetry */}
      <TelemetryModuleCard radioConnected={radioConnected} t={localModuleConfig.telemetry} />

      {/* Store & Forward */}
      <StoreForwardModuleCard radioConnected={radioConnected} sf={localModuleConfig.storeForward} />

      {/* External Notification */}
      <ExternalNotificationModuleCard radioConnected={radioConnected} en={localModuleConfig.externalNotification} />

      {/* MQTT */}
      <MqttModuleCard radioConnected={radioConnected} m={localModuleConfig.mqtt} />

      {/* Detection Sensor */}
      <DetectionSensorModuleCard radioConnected={radioConnected} ds={localModuleConfig.detectionSensor} />

      {/* Audio (Codec2 over LoRa) */}
      <AudioModuleCard radioConnected={radioConnected} a={localModuleConfig.audio} />

      <p className="text-[10px] text-brand-muted leading-relaxed">
        Eight modules now configurable end-to-end. Canned Messages, Remote Hardware, Ambient Lighting, and Paxcounter remain on the roadmap.
      </p>
    </div>
  );
}

const RT_INTERVAL_PRESETS = [
  { value: 0,    label: 'Receive only (recommended)' },
  { value: 60,   label: 'Send every 1 minute' },
  { value: 300,  label: 'Send every 5 minutes' },
  { value: 900,  label: 'Send every 15 minutes' },
  { value: 1800, label: 'Send every 30 minutes' },
  { value: 3600, label: 'Send every 1 hour' },
];

/**
 * Shared survey-control widget for the Range Test and NeighborInfo cards.
 * Renders a "Run a survey" panel with a duration selector and a start/cancel
 * button, plus a live countdown when a survey is in progress. The actual
 * start/cancel work is delegated to the parent so each card can pass its
 * module-specific cadence + handler.
 */
function SurveyControl({
  title,
  description,
  durationOptions,
  defaultDuration,
  cadenceOptions,
  defaultCadence,
  expiresAt,
  disabled,
  onStart,
  onCancel,
}: {
  title: string;
  description: string;
  durationOptions: Array<{ value: number; label: string }>;
  defaultDuration: number;
  cadenceOptions: Array<{ value: number; label: string }>;
  defaultCadence: number;
  expiresAt: number | null;
  disabled?: boolean;
  onStart: (durationMinutes: number, cadenceSecs: number) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [duration, setDuration] = React.useState<number>(defaultDuration);
  const [cadence, setCadence] = React.useState<number>(defaultCadence);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Live-updating countdown for the active survey.
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const remainingSecs = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : 0;
  const remainingLabel = remainingSecs > 60
    ? `${Math.floor(remainingSecs / 60)}m ${String(remainingSecs % 60).padStart(2, '0')}s`
    : `${remainingSecs}s`;

  const handleStart = async () => {
    setBusy(true); setError(null);
    const r = await onStart(duration, cadence);
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Failed to start survey');
  };

  const handleCancel = async () => {
    setBusy(true); setError(null);
    const r = await onCancel();
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Failed to cancel survey');
  };

  const surveyActive = !!expiresAt && remainingSecs > 0;

  return (
    <div className="border-t border-brand-line pt-4 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] uppercase font-bold text-brand-muted tracking-widest">{title}</p>
        {surveyActive && (
          <span className="text-[10px] mono-text text-brand-warning bg-brand-warning/15 border border-brand-warning/40 px-1.5 py-0.5 rounded uppercase font-bold tracking-widest">
            Active · {remainingLabel} left
          </span>
        )}
      </div>
      <p className="text-[10px] text-brand-muted leading-snug">{description}</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[9px] uppercase font-bold text-brand-muted block mb-0.5">Duration</label>
          <select
            value={duration}
            onChange={e => setDuration(parseInt(e.target.value, 10))}
            disabled={disabled || surveyActive || busy}
            className="w-full bg-brand-line text-xs rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {durationOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[9px] uppercase font-bold text-brand-muted block mb-0.5">Survey cadence</label>
          <select
            value={cadence}
            onChange={e => setCadence(parseInt(e.target.value, 10))}
            disabled={disabled || surveyActive || busy}
            className="w-full bg-brand-line text-xs rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {cadenceOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center justify-end pt-1">
        {surveyActive ? (
          <button
            onClick={handleCancel}
            disabled={disabled || busy}
            className="flex items-center gap-1.5 bg-brand-error/15 hover:bg-brand-error/25 border border-brand-error/40 text-brand-error text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            Cancel survey · restore
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={disabled || busy}
            className="flex items-center gap-1.5 bg-brand-warning/15 hover:bg-brand-warning/25 border border-brand-warning/40 text-brand-warning text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
            Start survey
          </button>
        )}
      </div>
      {error && <p className="text-[10px] text-brand-error">{error}</p>}
      <p className="text-[9px] text-brand-muted leading-snug">
        On expiry the radio is restored to the config that was active when the survey started.
        Cancelling early restores immediately. Server restart mid-survey leaves the survey config in place — re-open this card to revert.
      </p>
    </div>
  );
}

function RangeTestModuleCard({ radioConnected, rt, surveyExpiresAt }: { radioConnected: boolean; rt: import('../types').RangeTestModuleConfig | undefined; surveyExpiresAt: number | null }) {
  const [enabled, setEnabled] = React.useState<boolean>(rt?.enabled ?? false);
  const [senderIntervalSecs, setSenderIntervalSecs] = React.useState<number>(rt?.senderIntervalSecs ?? 0);
  const [save, setSave] = React.useState<boolean>(rt?.save ?? false);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!rt || busy) return;
    if (lastSyncedRef.current === rt.lastReadAt) return;
    lastSyncedRef.current = rt.lastReadAt;
    setEnabled(rt.enabled);
    setSenderIntervalSecs(rt.senderIntervalSecs);
    setSave(rt.save);
  }, [rt?.lastReadAt, rt?.enabled, rt?.senderIntervalSecs, rt?.save, busy]);

  const dirty = !rt
    ? true
    : (enabled !== rt.enabled ||
       senderIntervalSecs !== rt.senderIntervalSecs ||
       save !== rt.save);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setRangeTestConfig({ enabled, senderIntervalSecs, save });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshRangeTestConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = rt?.lastReadAt
    ? new Date(rt.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const isSender = enabled && senderIntervalSecs > 0;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Range Test</h5>
            {rt && (
              <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                rt.enabled
                  ? (rt.senderIntervalSecs > 0
                      ? 'text-brand-warning bg-brand-warning/10 border-brand-warning/30'
                      : 'text-brand-accent bg-brand-accent/10 border-brand-accent/30')
                  : 'text-brand-muted bg-brand-line border-brand-line'
              }`}>
                {rt.enabled ? (rt.senderIntervalSecs > 0 ? `Sending every ${rt.senderIntervalSecs}s` : 'Receive only') : 'Disabled'}
              </span>
            )}
            {!rt && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            The Range Test sender broadcasts numbered "seq N" packets at a fixed interval — other meshmates log them with SNR/RSSI so operators can map coverage. Receive-only mode is polite for shared meshes.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">When on, this radio participates in Range Test (as sender or receiver, depending on the interval).</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Sender Interval</label>
        <select
          value={RT_INTERVAL_PRESETS.some(p => p.value === senderIntervalSecs) ? String(senderIntervalSecs) : 'custom'}
          onChange={e => {
            const v = e.target.value;
            if (v !== 'custom') setSenderIntervalSecs(parseInt(v, 10));
          }}
          disabled={!radioConnected || !enabled}
          className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        >
          {RT_INTERVAL_PRESETS.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
          {!RT_INTERVAL_PRESETS.some(p => p.value === senderIntervalSecs) && (
            <option value="custom">Custom: {senderIntervalSecs}s</option>
          )}
        </select>

        <div className="flex items-center gap-2 mt-1">
          <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom (s)</label>
          <input
            type="number"
            min={0}
            max={86400}
            step={30}
            value={senderIntervalSecs}
            onChange={e => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v)) setSenderIntervalSecs(Math.max(0, Math.min(86400, v)));
            }}
            disabled={!radioConnected || !enabled}
            className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
          <span className="text-[9px] text-brand-muted">
            {senderIntervalSecs === 0
              ? 'receive-only'
              : `≈ ${senderIntervalSecs < 3600
                    ? `${Math.round(senderIntervalSecs / 60)} min`
                    : `${(senderIntervalSecs / 3600).toFixed(1)} hr`} · ${Math.round(86400 / senderIntervalSecs)}/day`}
          </span>
        </div>
        {isSender && (
          <p className="text-[10px] text-brand-warning/90 leading-snug">
            ⚠️ Active sending consumes mesh airtime — every "seq N" packet is broadcast across the channel. Keep intervals at or above 5 min unless you're actively running a coverage survey, and disable when finished.
          </p>
        )}
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Save results to flash</p>
          <p className="text-[10px] text-brand-muted">Persist received Range Test packets to the radio's onboard CSV log. Off is fine for most users — server-side ingest already records them.</p>
        </div>
        <input
          type="checkbox"
          checked={save}
          onChange={e => setSave(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : rt
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}

      <SurveyControl
        title="Coverage Survey"
        description="Run an accelerated Range Test sender for a fixed duration to map coverage. The radio's current Range Test config is captured before the survey and restored when it expires."
        durationOptions={[
          { value: 5,  label: '5 minutes' },
          { value: 10, label: '10 minutes' },
          { value: 15, label: '15 minutes' },
          { value: 30, label: '30 minutes' },
          { value: 60, label: '1 hour' },
        ]}
        defaultDuration={10}
        cadenceOptions={[
          { value: 30,   label: 'Every 30 s · fast' },
          { value: 60,   label: 'Every 1 min · default' },
          { value: 120,  label: 'Every 2 min' },
          { value: 300,  label: 'Every 5 min · airtime-friendly' },
        ]}
        defaultCadence={60}
        expiresAt={surveyExpiresAt}
        disabled={!radioConnected}
        onStart={(durationMinutes, senderIntervalSecs) => meshDataService.startRangeTestSurvey({ durationMinutes, senderIntervalSecs })}
        onCancel={() => meshDataService.cancelRangeTestSurvey()}
      />
    </div>
  );
}

const TELEMETRY_INTERVAL_PRESETS = [
  { value: 0,     label: 'Firmware default' },
  { value: 300,   label: '5 minutes' },
  { value: 600,   label: '10 minutes' },
  { value: 900,   label: '15 minutes' },
  { value: 1800,  label: '30 minutes' },
  { value: 3600,  label: '1 hour' },
  { value: 7200,  label: '2 hours' },
];

function TelemetryModuleCard({ radioConnected, t }: { radioConnected: boolean; t: import('../types').TelemetryModuleConfig | undefined }) {
  const [deviceUpdateIntervalSecs, setDeviceUpdateIntervalSecs] = React.useState<number>(t?.deviceUpdateIntervalSecs ?? 0);
  const [environmentEnabled, setEnvironmentEnabled] = React.useState<boolean>(t?.environmentEnabled ?? false);
  const [environmentUpdateIntervalSecs, setEnvironmentUpdateIntervalSecs] = React.useState<number>(t?.environmentUpdateIntervalSecs ?? 0);
  const [powerEnabled, setPowerEnabled] = React.useState<boolean>(t?.powerEnabled ?? false);
  const [powerUpdateIntervalSecs, setPowerUpdateIntervalSecs] = React.useState<number>(t?.powerUpdateIntervalSecs ?? 0);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!t || busy) return;
    if (lastSyncedRef.current === t.lastReadAt) return;
    lastSyncedRef.current = t.lastReadAt;
    setDeviceUpdateIntervalSecs(t.deviceUpdateIntervalSecs);
    setEnvironmentEnabled(t.environmentEnabled);
    setEnvironmentUpdateIntervalSecs(t.environmentUpdateIntervalSecs);
    setPowerEnabled(t.powerEnabled);
    setPowerUpdateIntervalSecs(t.powerUpdateIntervalSecs);
  }, [t?.lastReadAt, t?.deviceUpdateIntervalSecs, t?.environmentEnabled, t?.environmentUpdateIntervalSecs, t?.powerEnabled, t?.powerUpdateIntervalSecs, busy]);

  const dirty = !t
    ? true
    : (deviceUpdateIntervalSecs !== t.deviceUpdateIntervalSecs ||
       environmentEnabled !== t.environmentEnabled ||
       environmentUpdateIntervalSecs !== t.environmentUpdateIntervalSecs ||
       powerEnabled !== t.powerEnabled ||
       powerUpdateIntervalSecs !== t.powerUpdateIntervalSecs);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setTelemetryConfig({
      deviceUpdateIntervalSecs,
      environmentEnabled,
      environmentUpdateIntervalSecs,
      powerEnabled,
      powerUpdateIntervalSecs,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshTelemetryConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = t?.lastReadAt
    ? new Date(t.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const intervalSelect = (val: number, onChange: (v: number) => void, disabled: boolean) => (
    <>
      <select
        value={TELEMETRY_INTERVAL_PRESETS.some(p => p.value === val) ? String(val) : 'custom'}
        onChange={e => {
          const v = e.target.value;
          if (v !== 'custom') onChange(parseInt(v, 10));
        }}
        disabled={disabled}
        className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      >
        {TELEMETRY_INTERVAL_PRESETS.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
        {!TELEMETRY_INTERVAL_PRESETS.some(p => p.value === val) && (
          <option value="custom">Custom: {val}s</option>
        )}
      </select>
      <div className="flex items-center gap-2 mt-1">
        <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom (s)</label>
        <input
          type="number"
          min={0}
          max={86400}
          step={30}
          value={val}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onChange(Math.max(0, Math.min(86400, v)));
          }}
          disabled={disabled}
          className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
      </div>
    </>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Telemetry</h5>
            {t && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border text-brand-accent bg-brand-accent/10 border-brand-accent/30">
                Active
              </span>
            )}
            {!t && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            How often the local radio broadcasts telemetry: device metrics (battery, voltage, channel utilization), environment sensors (BME280 etc.), and power monitors (INA219/INA260). Lower intervals give fresher data at the cost of mesh airtime.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Device Metrics Interval</label>
        {intervalSelect(deviceUpdateIntervalSecs, setDeviceUpdateIntervalSecs, !radioConnected)}
        <p className="text-[10px] text-brand-muted leading-snug">Battery percentage, voltage, channel utilization, air-tx utilization. Firmware default is typically 30 minutes.</p>
      </div>

      <div className="border-t border-brand-line/50 pt-4 space-y-1.5">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Environment Sensors</p>
            <p className="text-[10px] text-brand-muted">Temperature / humidity / pressure from a connected BME280, BME680, etc.</p>
          </div>
          <input
            type="checkbox"
            checked={environmentEnabled}
            onChange={e => setEnvironmentEnabled(e.target.checked)}
            disabled={!radioConnected}
            className="w-4 h-4 accent-emerald-500"
          />
        </label>
        {environmentEnabled && (
          <div className="pt-1">
            <label className="text-[10px] uppercase font-bold text-brand-muted block mb-1">Environment Interval</label>
            {intervalSelect(environmentUpdateIntervalSecs, setEnvironmentUpdateIntervalSecs, !radioConnected)}
          </div>
        )}
      </div>

      <div className="border-t border-brand-line/50 pt-4 space-y-1.5">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Power Monitor</p>
            <p className="text-[10px] text-brand-muted">Per-channel current / voltage / power readings from an INA219 or INA260.</p>
          </div>
          <input
            type="checkbox"
            checked={powerEnabled}
            onChange={e => setPowerEnabled(e.target.checked)}
            disabled={!radioConnected}
            className="w-4 h-4 accent-emerald-500"
          />
        </label>
        {powerEnabled && (
          <div className="pt-1">
            <label className="text-[10px] uppercase font-bold text-brand-muted block mb-1">Power Interval</label>
            {intervalSelect(powerUpdateIntervalSecs, setPowerUpdateIntervalSecs, !radioConnected)}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : t
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

const SF_RECORDS_PRESETS = [
  { value: 0,    label: 'Firmware default' },
  { value: 100,  label: '100 records' },
  { value: 250,  label: '250 records' },
  { value: 500,  label: '500 records' },
  { value: 1000, label: '1,000 records' },
];

const SF_RETURN_MAX_PRESETS = [
  { value: 0,   label: 'Firmware default' },
  { value: 25,  label: '25 records / request' },
  { value: 50,  label: '50 records / request' },
  { value: 100, label: '100 records / request' },
];

const SF_WINDOW_PRESETS = [
  { value: 0,    label: 'Firmware default' },
  { value: 60,   label: '1 hour' },
  { value: 240,  label: '4 hours' },
  { value: 720,  label: '12 hours' },
  { value: 1440, label: '24 hours' },
];

function StoreForwardModuleCard({ radioConnected, sf }: { radioConnected: boolean; sf: import('../types').StoreForwardLocalConfig | undefined }) {
  const [enabled, setEnabled] = React.useState<boolean>(sf?.enabled ?? false);
  const [isServer, setIsServer] = React.useState<boolean>(sf?.isServer ?? false);
  const [heartbeat, setHeartbeat] = React.useState<boolean>(sf?.heartbeat ?? false);
  const [records, setRecords] = React.useState<number>(sf?.records ?? 0);
  const [historyReturnMax, setHistoryReturnMax] = React.useState<number>(sf?.historyReturnMax ?? 0);
  const [historyReturnWindow, setHistoryReturnWindow] = React.useState<number>(sf?.historyReturnWindow ?? 0);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!sf || busy) return;
    if (lastSyncedRef.current === sf.lastReadAt) return;
    lastSyncedRef.current = sf.lastReadAt;
    setEnabled(sf.enabled);
    setIsServer(sf.isServer);
    setHeartbeat(sf.heartbeat);
    setRecords(sf.records);
    setHistoryReturnMax(sf.historyReturnMax);
    setHistoryReturnWindow(sf.historyReturnWindow);
  }, [sf?.lastReadAt, sf?.enabled, sf?.isServer, sf?.heartbeat, sf?.records, sf?.historyReturnMax, sf?.historyReturnWindow, busy]);

  const dirty = !sf
    ? true
    : (enabled !== sf.enabled ||
       isServer !== sf.isServer ||
       heartbeat !== sf.heartbeat ||
       records !== sf.records ||
       historyReturnMax !== sf.historyReturnMax ||
       historyReturnWindow !== sf.historyReturnWindow);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setStoreForwardConfig({
      enabled,
      isServer,
      heartbeat,
      records,
      historyReturnMax,
      historyReturnWindow,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshStoreForwardConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = sf?.lastReadAt
    ? new Date(sf.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const presetSelect = (
    val: number,
    onChange: (v: number) => void,
    presets: Array<{ value: number; label: string }>,
    disabled: boolean,
    customMax = 100000,
  ) => (
    <>
      <select
        value={presets.some(p => p.value === val) ? String(val) : 'custom'}
        onChange={e => {
          const v = e.target.value;
          if (v !== 'custom') onChange(parseInt(v, 10));
        }}
        disabled={disabled}
        className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      >
        {presets.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
        {!presets.some(p => p.value === val) && (
          <option value="custom">Custom: {val}</option>
        )}
      </select>
      <div className="flex items-center gap-2 mt-1">
        <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom</label>
        <input
          type="number"
          min={0}
          max={customMax}
          step={10}
          value={val}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onChange(Math.max(0, Math.min(customMax, v)));
          }}
          disabled={disabled}
          className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
      </div>
    </>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Store &amp; Forward</h5>
            {sf && (
              <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                sf.enabled
                  ? (sf.isServer
                      ? 'text-brand-warning bg-brand-warning/10 border-brand-warning/30'
                      : 'text-brand-accent bg-brand-accent/10 border-brand-accent/30')
                  : 'text-brand-muted bg-brand-line border-brand-line'
              }`}>
                {sf.enabled ? (sf.isServer ? 'Router / server' : 'Client') : 'Disabled'}
              </span>
            )}
            {!sf && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            S&amp;F lets a powered, always-on radio buffer mesh traffic and replay it to peers that come back online.
            Client mode (the default) just listens for and requests replays. Router/server mode means this radio buffers
            for everyone — only enable on a stable-power node.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">Turn the S&amp;F module on. With server mode off, this is the standard client-side replay-request behavior.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Act as router / server</p>
          <p className="text-[10px] text-brand-muted">Buffer traffic for the whole mesh and serve replays. Requires stable power; not for battery nodes.</p>
        </div>
        <input
          type="checkbox"
          checked={isServer}
          onChange={e => setIsServer(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      {isServer && enabled && (
        <div className="border-t border-brand-line/50 pt-4 space-y-4">
          <p className="text-[10px] uppercase font-bold text-brand-warning/90 tracking-widest">Router parameters</p>

          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <p className="text-xs font-bold text-brand-ink">Heartbeat</p>
              <p className="text-[10px] text-brand-muted">Periodically broadcast that this node is an active S&amp;F router so peers know they can request replays.</p>
            </div>
            <input
              type="checkbox"
              checked={heartbeat}
              onChange={e => setHeartbeat(e.target.checked)}
              disabled={!radioConnected}
              className="w-4 h-4 accent-emerald-500"
            />
          </label>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted block">Buffer size (records)</label>
            {presetSelect(records, setRecords, SF_RECORDS_PRESETS, !radioConnected, 100000)}
            <p className="text-[10px] text-brand-muted leading-snug">Maximum messages this router will retain. More = longer history but more flash usage.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted block">Max replay per request</label>
            {presetSelect(historyReturnMax, setHistoryReturnMax, SF_RETURN_MAX_PRESETS, !radioConnected, 100000)}
            <p className="text-[10px] text-brand-muted leading-snug">How many records to send to a single CLIENT_HISTORY request — caps the airtime burst when a peer comes back online.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-brand-muted block">Replay time window (minutes)</label>
            {presetSelect(historyReturnWindow, setHistoryReturnWindow, SF_WINDOW_PRESETS, !radioConnected, 1440)}
            <p className="text-[10px] text-brand-muted leading-snug">Maximum age of records that will be replayed. 0 = firmware default (typically 4 hours).</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : sf
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

const EN_DURATION_PRESETS = [
  { value: 250,   label: 'Quick beep (250 ms)' },
  { value: 500,   label: 'Short (500 ms)' },
  { value: 1000,  label: 'Default (1 s)' },
  { value: 2000,  label: 'Long (2 s)' },
  { value: 5000,  label: 'Very long (5 s)' },
];
const EN_NAG_PRESETS = [
  { value: 0,     label: 'Off (alert once, no nag)' },
  { value: 30,    label: 'Nag for 30 s' },
  { value: 60,    label: 'Nag for 1 min' },
  { value: 300,   label: 'Nag for 5 min' },
  { value: 900,   label: 'Nag for 15 min' },
];

function ExternalNotificationModuleCard({ radioConnected, en }: {
  radioConnected: boolean;
  en: import('../types').ExternalNotificationModuleConfig | undefined;
}) {
  // Operator-editable knobs
  const [enabled, setEnabled] = React.useState<boolean>(en?.enabled ?? false);
  const [alertMessage, setAlertMessage] = React.useState<boolean>(en?.alertMessage ?? false);
  const [alertBell, setAlertBell] = React.useState<boolean>(en?.alertBell ?? true);
  const [outputMs, setOutputMs] = React.useState<number>(en?.outputMs ?? 1000);
  const [nagTimeout, setNagTimeout] = React.useState<number>(en?.nagTimeout ?? 0);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!en || busy) return;
    if (lastSyncedRef.current === en.lastReadAt) return;
    lastSyncedRef.current = en.lastReadAt;
    setEnabled(en.enabled);
    setAlertMessage(en.alertMessage);
    setAlertBell(en.alertBell);
    setOutputMs(en.outputMs || 1000);
    setNagTimeout(en.nagTimeout);
  }, [en?.lastReadAt, en?.enabled, en?.alertMessage, en?.alertBell, en?.outputMs, en?.nagTimeout, busy]);

  const dirty = !en
    ? true
    : (enabled !== en.enabled ||
       alertMessage !== en.alertMessage ||
       alertBell !== en.alertBell ||
       outputMs !== en.outputMs ||
       nagTimeout !== en.nagTimeout);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    // Pass-through fields preserve board-specific GPIO assignments and the
    // advanced PWM/I2S/vibra/buzzer routing the operator hasn't touched.
    const r = await meshDataService.setExternalNotificationConfig({
      enabled,
      outputMs,
      output: en?.output ?? 0,
      active: en?.active ?? false,
      alertMessage,
      alertBell,
      usePwm: en?.usePwm ?? false,
      outputVibra: en?.outputVibra ?? 0,
      outputBuzzer: en?.outputBuzzer ?? 0,
      alertMessageVibra: en?.alertMessageVibra ?? false,
      alertMessageBuzzer: en?.alertMessageBuzzer ?? false,
      alertBellVibra: en?.alertBellVibra ?? false,
      alertBellBuzzer: en?.alertBellBuzzer ?? false,
      nagTimeout,
      useI2sAsBuzzer: en?.useI2sAsBuzzer ?? false,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshExternalNotificationConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = en?.lastReadAt
    ? new Date(en.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const presetSelect = (val: number, onChange: (v: number) => void, presets: Array<{ value: number; label: string }>, customMax: number, disabled: boolean) => (
    <>
      <select
        value={presets.some(p => p.value === val) ? String(val) : 'custom'}
        onChange={e => {
          const v = e.target.value;
          if (v !== 'custom') onChange(parseInt(v, 10));
        }}
        disabled={disabled}
        className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      >
        {presets.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
        {!presets.some(p => p.value === val) && (
          <option value="custom">Custom: {val}</option>
        )}
      </select>
      <div className="flex items-center gap-2 mt-1">
        <label className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Custom</label>
        <input
          type="number"
          min={0}
          max={customMax}
          step={50}
          value={val}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onChange(Math.max(0, Math.min(customMax, v)));
          }}
          disabled={disabled}
          className="w-32 bg-brand-line border border-brand-line rounded px-2 py-1 text-[11px] mono-text text-brand-ink focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
      </div>
    </>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">External Notification</h5>
            {en && (
              <span className={`text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border ${
                en.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line'
              }`}>
                {en.enabled ? 'Enabled' : 'Disabled'}
              </span>
            )}
            {!en && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Drive a buzzer, LED, or vibration motor wired to the radio when text messages arrive. GPIO pin assignments come from your board's firmware build and are preserved on save — the controls below only change the high-level alerting behavior.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch for the External Notification module.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Alert on any text message</p>
          <p className="text-[10px] text-brand-muted">Trigger the alert pin / buzzer for every received text message (channel + DM). Noisy on busy meshes.</p>
        </div>
        <input
          type="checkbox"
          checked={alertMessage}
          onChange={e => setAlertMessage(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Alert on bell character only</p>
          <p className="text-[10px] text-brand-muted">Trigger only when a sender embeds the bell character (^G) in their message. Quieter; lets specific senders raise an alert intentionally.</p>
        </div>
        <input
          type="checkbox"
          checked={alertBell}
          onChange={e => setAlertBell(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Alert Duration (ms)</label>
        {presetSelect(outputMs, setOutputMs, EN_DURATION_PRESETS, 60000, !radioConnected || !enabled)}
        <p className="text-[10px] text-brand-muted leading-snug">How long the buzzer / LED stays on per alert.</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Nag Timeout (s)</label>
        {presetSelect(nagTimeout, setNagTimeout, EN_NAG_PRESETS, 86400, !radioConnected || !enabled)}
        <p className="text-[10px] text-brand-muted leading-snug">If &gt; 0, keep re-alerting every {Math.max(outputMs / 1000, 1).toFixed(0)}s for up to this duration until the user dismisses on the radio. Useful for sleeping operators; annoying otherwise.</p>
      </div>

      {en && (en.output > 0 || en.outputBuzzer > 0 || en.outputVibra > 0) && (
        <div className="border-t border-brand-line/50 pt-3 text-[10px] text-brand-muted mono-text leading-relaxed">
          <p className="text-brand-muted uppercase font-bold mb-1 tracking-widest">Hardware (read-only)</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {en.output > 0      && <><span>output pin</span><span>GPIO {en.output}{en.active ? ' (active-high)' : ' (active-low)'}</span></>}
            {en.outputBuzzer > 0 && <><span>buzzer pin</span><span>GPIO {en.outputBuzzer}{en.usePwm ? ' (PWM)' : ''}</span></>}
            {en.outputVibra > 0  && <><span>vibra pin</span><span>GPIO {en.outputVibra}</span></>}
            {en.useI2sAsBuzzer    && <><span>i2s as buzzer</span><span>yes</span></>}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line/50">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : en
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// MQTT module card (broker URL / auth / encryption / topic)
// ============================================================================
function MqttModuleCard({ radioConnected, m }: {
  radioConnected: boolean;
  m: import('../types').MqttModuleConfig | undefined;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(m?.enabled ?? false);
  const [address, setAddress] = React.useState<string>(m?.address ?? '');
  const [username, setUsername] = React.useState<string>(m?.username ?? '');
  const [password, setPassword] = React.useState<string>(m?.password ?? '');
  const [encryptionEnabled, setEncryptionEnabled] = React.useState<boolean>(m?.encryptionEnabled ?? true);
  const [jsonEnabled, setJsonEnabled] = React.useState<boolean>(m?.jsonEnabled ?? false);
  const [tlsEnabled, setTlsEnabled] = React.useState<boolean>(m?.tlsEnabled ?? false);
  const [root, setRoot] = React.useState<string>(m?.root ?? '');
  const [proxyToClientEnabled, setProxyToClientEnabled] = React.useState<boolean>(m?.proxyToClientEnabled ?? false);
  const [mapReportingEnabled, setMapReportingEnabled] = React.useState<boolean>(m?.mapReportingEnabled ?? false);
  const [showPassword, setShowPassword] = React.useState(false);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!m || busy) return;
    if (lastSyncedRef.current === m.lastReadAt) return;
    lastSyncedRef.current = m.lastReadAt;
    setEnabled(m.enabled);
    setAddress(m.address);
    setUsername(m.username);
    setPassword(m.password);
    setEncryptionEnabled(m.encryptionEnabled);
    setJsonEnabled(m.jsonEnabled);
    setTlsEnabled(m.tlsEnabled);
    setRoot(m.root);
    setProxyToClientEnabled(m.proxyToClientEnabled);
    setMapReportingEnabled(m.mapReportingEnabled);
  }, [m?.lastReadAt, m, busy]);

  const dirty = !m
    ? true
    : (enabled !== m.enabled ||
       address !== m.address ||
       username !== m.username ||
       password !== m.password ||
       encryptionEnabled !== m.encryptionEnabled ||
       jsonEnabled !== m.jsonEnabled ||
       tlsEnabled !== m.tlsEnabled ||
       root !== m.root ||
       proxyToClientEnabled !== m.proxyToClientEnabled ||
       mapReportingEnabled !== m.mapReportingEnabled);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setMqttConfig({
      enabled,
      address,
      username,
      password,
      encryptionEnabled,
      jsonEnabled,
      tlsEnabled,
      root,
      proxyToClientEnabled,
      mapReportingEnabled,
      // Pass through MapReportSettings opaque blob from the readback so we don't drop unmodelled fields.
      mapReportSettingsRaw: m?.mapReportSettingsRaw ?? null,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshMqttConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = m?.lastReadAt
    ? new Date(m.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  // Encryption + JSON together is contradictory — JSON requires unencrypted payloads.
  // Surface a soft warning rather than blocking the operator.
  const conflictWarning = encryptionEnabled && jsonEnabled
    ? 'Encryption + JSON together: most firmware builds will silently drop the JSON publish. Pick one.'
    : null;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">MQTT Bridge</h5>
            {m && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                m.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {m.enabled ? (m.proxyToClientEnabled ? 'Active · proxy' : 'Active') : 'Disabled'}
              </span>
            )}
            {!m && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Bridges per-channel mesh traffic to/from an MQTT broker. Per-channel uplink/downlink toggles still live in <span className="text-brand-ink font-bold">Channels</span>; this card configures the broker the radio talks to.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch for the MQTT module on the local radio.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Broker Address</label>
        <input
          type="text"
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="mqtt.meshtastic.org"
          disabled={!radioConnected || !enabled}
          className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
        <p className="text-[10px] text-brand-muted leading-snug">
          Hostname or IP of your broker. Empty value falls back to the firmware default (usually the public Meshtastic broker).
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Username</label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="(blank = anonymous)"
            disabled={!radioConnected || !enabled}
            autoComplete="off"
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Password</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="(blank = anonymous)"
              disabled={!radioConnected || !enabled}
              autoComplete="off"
              className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 pr-9 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowPassword(s => !s)}
              disabled={!radioConnected || !enabled}
              tabIndex={-1}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-brand-muted hover:text-brand-ink disabled:opacity-50"
            >
              {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Topic Root</label>
        <input
          type="text"
          value={root}
          onChange={e => setRoot(e.target.value)}
          placeholder="msh/US/2/e/"
          disabled={!radioConnected || !enabled}
          className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
        <p className="text-[10px] text-brand-muted leading-snug">
          Topic prefix for publish/subscribe. Must match what other gateways on your broker use. Empty = firmware default.
        </p>
      </div>

      <div className="border-t border-brand-line pt-3 grid grid-cols-2 gap-3">
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink">TLS</p>
            <p className="text-[10px] text-brand-muted leading-snug">Encrypt the connection to the broker.</p>
          </div>
          <input
            type="checkbox"
            checked={tlsEnabled}
            onChange={e => setTlsEnabled(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink">Channel encryption</p>
            <p className="text-[10px] text-brand-muted leading-snug">Encrypt payloads with the per-channel PSK before publish.</p>
          </div>
          <input
            type="checkbox"
            checked={encryptionEnabled}
            onChange={e => setEncryptionEnabled(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink">JSON publish</p>
            <p className="text-[10px] text-brand-muted leading-snug">Plaintext JSON for IoT consumers. Disables channel encryption in practice.</p>
          </div>
          <input
            type="checkbox"
            checked={jsonEnabled}
            onChange={e => setJsonEnabled(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink">Proxy to client</p>
            <p className="text-[10px] text-brand-muted leading-snug">Use the connected client (this app) as the MQTT relay; useful when the radio has no WiFi.</p>
          </div>
          <input
            type="checkbox"
            checked={proxyToClientEnabled}
            onChange={e => setProxyToClientEnabled(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
      </div>

      <label className="flex items-center justify-between cursor-pointer pt-1 border-t border-brand-line">
        <div className="pt-3">
          <p className="text-xs font-bold text-brand-ink">Map reporting</p>
          <p className="text-[10px] text-brand-muted">Publish the local node's position to the public Meshtastic map. Only enable if you're OK broadcasting your location.</p>
        </div>
        <input
          type="checkbox"
          checked={mapReportingEnabled}
          onChange={e => setMapReportingEnabled(e.target.checked)}
          disabled={!radioConnected || !enabled}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      {conflictWarning && (
        <p className="text-[10px] text-brand-warning leading-snug flex items-start gap-1.5">
          <AlertCircle size={11} className="flex-shrink-0 mt-0.5" />
          <span>{conflictWarning}</span>
        </p>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : m
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Detection Sensor module — broadcasts when a monitored GPIO changes state
// ============================================================================
function DetectionSensorModuleCard({ radioConnected, ds }: {
  radioConnected: boolean;
  ds: import('../types').DetectionSensorModuleConfig | undefined;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(ds?.enabled ?? false);
  const [name, setName] = React.useState<string>(ds?.name ?? '');
  const [minimumBroadcastSecs, setMinimumBroadcastSecs] = React.useState<number>(ds?.minimumBroadcastSecs ?? 30);
  const [stateBroadcastSecs, setStateBroadcastSecs] = React.useState<number>(ds?.stateBroadcastSecs ?? 0);
  const [sendBell, setSendBell] = React.useState<boolean>(ds?.sendBell ?? true);
  const [monitorPin, setMonitorPin] = React.useState<number>(ds?.monitorPin ?? 0);
  const [detectionTriggeredHigh, setDetectionTriggeredHigh] = React.useState<boolean>(ds?.detectionTriggeredHigh ?? false);
  const [usePullup, setUsePullup] = React.useState<boolean>(ds?.usePullup ?? true);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!ds || busy) return;
    if (lastSyncedRef.current === ds.lastReadAt) return;
    lastSyncedRef.current = ds.lastReadAt;
    setEnabled(ds.enabled);
    setName(ds.name);
    setMinimumBroadcastSecs(ds.minimumBroadcastSecs);
    setStateBroadcastSecs(ds.stateBroadcastSecs);
    setSendBell(ds.sendBell);
    setMonitorPin(ds.monitorPin);
    setDetectionTriggeredHigh(ds.detectionTriggeredHigh);
    setUsePullup(ds.usePullup);
  }, [ds?.lastReadAt, ds, busy]);

  const dirty = !ds
    ? true
    : (enabled !== ds.enabled ||
       name !== ds.name ||
       minimumBroadcastSecs !== ds.minimumBroadcastSecs ||
       stateBroadcastSecs !== ds.stateBroadcastSecs ||
       sendBell !== ds.sendBell ||
       monitorPin !== ds.monitorPin ||
       detectionTriggeredHigh !== ds.detectionTriggeredHigh ||
       usePullup !== ds.usePullup);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setDetectionSensorConfig({
      enabled, name, minimumBroadcastSecs, stateBroadcastSecs, sendBell,
      monitorPin, detectionTriggeredHigh, usePullup,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshDetectionSensorConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = ds?.lastReadAt
    ? new Date(ds.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Detection Sensor</h5>
            {ds && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                ds.enabled
                  ? 'text-brand-accent bg-brand-accent/10 border-brand-accent/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {ds.enabled ? `Watching pin ${ds.monitorPin}` : 'Disabled'}
              </span>
            )}
            {!ds && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            Broadcast a text message to the mesh whenever a monitored GPIO pin changes state. Useful for door sensors, mailbox flags, PIR motion detectors, reed switches, etc. The pin is wired to your radio's exposed GPIO header.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch for the Detection Sensor module.</p>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold text-brand-muted block">Sensor Name</label>
        <input
          type="text"
          maxLength={20}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Front door"
          disabled={!radioConnected || !enabled}
          className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
        />
        <p className="text-[10px] text-brand-muted leading-snug">
          Shown in broadcast messages, e.g. "Front door triggered". Keep short — bandwidth is precious.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Monitor pin (GPIO)</label>
          <input
            type="number"
            min={0}
            max={64}
            value={monitorPin}
            onChange={e => setMonitorPin(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Min broadcast (s)</label>
          <input
            type="number"
            min={0}
            max={86400}
            step={5}
            value={minimumBroadcastSecs}
            onChange={e => setMinimumBroadcastSecs(Math.max(0, Math.min(86400, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Periodic state (s)</label>
          <input
            type="number"
            min={0}
            max={86400}
            step={60}
            value={stateBroadcastSecs}
            onChange={e => setStateBroadcastSecs(Math.max(0, Math.min(86400, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
          <p className="text-[10px] text-brand-muted leading-snug">0 = no periodic; only on change.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 border-t border-brand-line pt-3">
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Active high</p>
            <p className="text-[10px] text-brand-muted leading-snug">Trigger on HIGH (off) or LOW (on).</p>
          </div>
          <input
            type="checkbox"
            checked={detectionTriggeredHigh}
            onChange={e => setDetectionTriggeredHigh(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Pullup</p>
            <p className="text-[10px] text-brand-muted leading-snug">Internal pullup resistor.</p>
          </div>
          <input
            type="checkbox"
            checked={usePullup}
            onChange={e => setUsePullup(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
        <label className="flex items-start justify-between gap-2 cursor-pointer">
          <div>
            <p className="text-xs font-bold text-brand-ink">Send bell (^G)</p>
            <p className="text-[10px] text-brand-muted leading-snug">Triggers buzzer on receivers.</p>
          </div>
          <input
            type="checkbox"
            checked={sendBell}
            onChange={e => setSendBell(e.target.checked)}
            disabled={!radioConnected || !enabled}
            className="w-4 h-4 accent-emerald-500 mt-0.5 shrink-0"
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : ds
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Audio module — Codec2 voice over LoRa (very experimental)
// ============================================================================
const AUDIO_BITRATE_OPTIONS = [
  { value: 0, label: 'Codec2 default' },
  { value: 1, label: 'Codec2 3200 bps' },
  { value: 2, label: 'Codec2 2400 bps' },
  { value: 3, label: 'Codec2 1600 bps' },
  { value: 4, label: 'Codec2 1400 bps' },
  { value: 5, label: 'Codec2 1300 bps' },
  { value: 6, label: 'Codec2 1200 bps' },
  { value: 7, label: 'Codec2 700B bps' },
];

function AudioModuleCard({ radioConnected, a }: {
  radioConnected: boolean;
  a: import('../types').AudioModuleConfig | undefined;
}) {
  const [codec2Enabled, setCodec2Enabled] = React.useState<boolean>(a?.codec2Enabled ?? false);
  const [pttPin, setPttPin] = React.useState<number>(a?.pttPin ?? 0);
  const [bitrate, setBitrate] = React.useState<number>(a?.bitrate ?? 0);
  const [i2sWs, setI2sWs] = React.useState<number>(a?.i2sWs ?? 0);
  const [i2sSd, setI2sSd] = React.useState<number>(a?.i2sSd ?? 0);
  const [i2sDin, setI2sDin] = React.useState<number>(a?.i2sDin ?? 0);
  const [i2sSck, setI2sSck] = React.useState<number>(a?.i2sSck ?? 0);

  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const lastSyncedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!a || busy) return;
    if (lastSyncedRef.current === a.lastReadAt) return;
    lastSyncedRef.current = a.lastReadAt;
    setCodec2Enabled(a.codec2Enabled);
    setPttPin(a.pttPin);
    setBitrate(a.bitrate);
    setI2sWs(a.i2sWs);
    setI2sSd(a.i2sSd);
    setI2sDin(a.i2sDin);
    setI2sSck(a.i2sSck);
  }, [a?.lastReadAt, a, busy]);

  const dirty = !a
    ? true
    : (codec2Enabled !== a.codec2Enabled ||
       pttPin !== a.pttPin ||
       bitrate !== a.bitrate ||
       i2sWs !== a.i2sWs ||
       i2sSd !== a.i2sSd ||
       i2sDin !== a.i2sDin ||
       i2sSck !== a.i2sSck);

  const handleSave = async () => {
    setBusy(true);
    setStatus(null);
    const r = await meshDataService.setAudioConfig({
      codec2Enabled, pttPin, bitrate, i2sWs, i2sSd, i2sDin, i2sSck,
    });
    setBusy(false);
    if (r.ok) setStatus({ kind: 'ok', text: 'Saved — radio is committing the new config' });
    else setStatus({ kind: 'error', text: r.error ?? 'Save failed' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setStatus(null);
    const r = await meshDataService.refreshAudioConfig();
    setRefreshing(false);
    if (!r.ok) setStatus({ kind: 'error', text: r.error ?? 'Refresh failed' });
  };

  const lastReadLabel = a?.lastReadAt
    ? new Date(a.lastReadAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null;

  const pinInput = (val: number, onChange: (v: number) => void, label: string) => (
    <div className="space-y-1">
      <label className="text-[10px] uppercase font-bold text-brand-muted block">{label}</label>
      <input
        type="number"
        min={0}
        max={64}
        value={val}
        onChange={e => onChange(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))}
        disabled={!radioConnected || !codec2Enabled}
        className="w-full bg-brand-line text-xs mono-text rounded px-2 py-1.5 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
      />
    </div>
  );

  return (
    <div className="bg-brand-line/40 border border-brand-line rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network size={14} className="text-brand-accent" />
            <h5 className="text-xs font-bold uppercase tracking-tight text-brand-ink">Audio</h5>
            {a && (
              <span className={cn(
                'text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border',
                a.codec2Enabled
                  ? 'text-brand-warning bg-brand-warning/10 border-brand-warning/30'
                  : 'text-brand-muted bg-brand-line border-brand-line',
              )}>
                {a.codec2Enabled ? 'Codec2 active' : 'Disabled'}
              </span>
            )}
            {!a && radioConnected && (
              <span className="text-[9px] uppercase font-bold mono-text px-1.5 py-0.5 rounded border border-brand-line text-brand-muted bg-brand-line">
                Reading…
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted mt-1 leading-relaxed">
            <span className="text-brand-warning font-bold">Experimental.</span> Codec2 voice over LoRa requires an I2S microphone + speaker wired to the radio. Most off-the-shelf Meshtastic boards (T-Beam, Heltec v3, etc.) do <span className="font-bold">not</span> ship with the necessary hardware. Leave disabled unless you've explicitly built for it.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={!radioConnected || refreshing}
          title="Re-read the config from the radio"
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-ink border border-brand-line hover:border-brand-muted rounded px-2 py-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '...' : 'Refresh'}
        </button>
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <p className="text-xs font-bold text-brand-ink">Codec2 enabled</p>
          <p className="text-[10px] text-brand-muted">Master switch — disables every Audio control below when off.</p>
        </div>
        <input
          type="checkbox"
          checked={codec2Enabled}
          onChange={e => setCodec2Enabled(e.target.checked)}
          disabled={!radioConnected}
          className="w-4 h-4 accent-emerald-500"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">PTT pin</label>
          <input
            type="number"
            min={0}
            max={64}
            value={pttPin}
            onChange={e => setPttPin(Math.max(0, Math.min(64, parseInt(e.target.value, 10) || 0)))}
            disabled={!radioConnected || !codec2Enabled}
            className="w-full bg-brand-line text-xs mono-text rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase font-bold text-brand-muted block">Bitrate</label>
          <select
            value={bitrate}
            onChange={e => setBitrate(parseInt(e.target.value, 10))}
            disabled={!radioConnected || !codec2Enabled}
            className="w-full bg-brand-line text-xs rounded px-3 py-2 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50 disabled:opacity-50"
          >
            {AUDIO_BITRATE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="border-t border-brand-line pt-3">
        <p className="text-[10px] uppercase font-bold tracking-widest text-brand-muted mb-2">I2S Pins</p>
        <div className="grid grid-cols-4 gap-2">
          {pinInput(i2sWs, setI2sWs, 'WS')}
          {pinInput(i2sSd, setI2sSd, 'SD')}
          {pinInput(i2sDin, setI2sDin, 'DIN')}
          {pinInput(i2sSck, setI2sSck, 'SCK')}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-brand-line">
        <p className="text-[9px] mono-text text-brand-muted">
          {lastReadLabel
            ? `Last read: ${lastReadLabel}`
            : a
              ? 'Set by you (no readback yet)'
              : 'No readback yet — Save will apply your values'}
        </p>
        <button
          onClick={handleSave}
          disabled={!radioConnected || busy || !dirty}
          className="flex items-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {busy ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </button>
      </div>

      {status && (
        <p className={`text-[10px] leading-snug ${status.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
          {status.text}
        </p>
      )}
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
        <div className="bg-brand-line/40 border border-brand-line rounded p-4 text-center">
          <Ban size={20} className="mx-auto text-brand-muted mb-2" />
          <p className="text-xs text-brand-muted">No nodes blocked</p>
          <p className="text-[10px] text-brand-muted mt-1">
            Click a node on the map and use the Block button to hide them.
          </p>
        </div>
      ) : (
        <div className="bg-brand-line/40 border border-brand-line rounded divide-y divide-slate-700/50">
          {blocked.map(id => {
            const node = nodes.find(n => n.id === id);
            return (
              <div key={id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-brand-ink truncate">{node?.name || id}</p>
                  <p className="text-[10px] mono-text text-brand-muted">{id}</p>
                </div>
                <button
                  onClick={() => onUnblockNode(id)}
                  className="flex items-center gap-1 bg-brand-line hover:bg-brand-line border border-brand-line hover:border-brand-accent/50 text-brand-ink hover:text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded px-2 py-1 transition-colors flex-shrink-0"
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
      <h4 className="text-sm font-bold uppercase tracking-tight text-brand-ink">{title}</h4>
      <p className="text-[11px] text-brand-muted mt-0.5">{subtitle}</p>
    </div>
  );
}
