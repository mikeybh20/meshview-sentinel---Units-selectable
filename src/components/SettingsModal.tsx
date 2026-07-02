import React from 'react';
import { motion } from 'motion/react';
import {
  X, Wifi, Bell, Globe, FileDown, FileUp, Bot, Plug, AlertCircle,
  Check, Loader2, Eye, EyeOff, Radio, Ban, Undo2, Network, RefreshCw,
  HelpCircle, ChevronDown, Activity, Mail, HardDrive, Database, BookOpen,
  Copy, Download, Cpu, Plus, Trash2, Star, Users as UsersIcon, Lock,
  UserPlus, KeyRound, ShieldCheck, ShieldOff,
} from 'lucide-react';
import { useAuth, useIsAdmin } from '../hooks/useAuth';
import { RADIO_COLOR_PALETTE } from '../lib/radioColors';
import type { RadioRow, LoRaConfigLive } from '../types';

import { meshDataService, TransportInfo, DataSource } from '../services/meshDataService';
import { LocalModuleConfigSnapshot, Node, UnitSystem } from '../types';
import { cn } from '../lib/utils';
import {
  browserPushSupported,
  getCurrentSubscription,
  enableBrowserPush,
  disableBrowserPush,
  sendTestPush,
} from '../lib/webPushClient';
import { MarkdownGuide } from './settings/MarkdownGuide';

const API_BASE = import.meta.env.VITE_API_URL || '';

// v2.1: lazy-loaded section components. Each section's JS chunk only
// loads when the operator opens that tab in Settings, cutting the
// initial bundle. Pattern: extract a self-contained section into
// src/components/settings/<Name>.tsx with `export default`, then
// React.lazy() it here. The Suspense fallback below renders a small
// "Loading…" placeholder while the chunk fetches.
const UsersSection = React.lazy(() => import('./settings/UsersSection'));
const WorkspacesSection = React.lazy(() => import('./settings/WorkspacesSection'));
const DataSection = React.lazy(() => import('./settings/DataSection'));
const DiskSection = React.lazy(() => import('./settings/DiskSection'));
const JetsonGuideSection = React.lazy(() => import('./settings/JetsonSection'));
const BbsSection = React.lazy(() => import('./settings/BbsSection'));
const ModulesSection = React.lazy(() => import('./settings/ModulesSection'));

/** Standard fallback for any lazy-loaded section while its chunk fetches. */
function SettingsSectionLoading() {
  return (
    <div className="flex items-center gap-2 text-xs text-brand-muted py-8">
      <Loader2 size={14} className="animate-spin" />
      <span>Loading section…</span>
    </div>
  );
}

// 'radios' was removed in Beta 2 — it lives in the top-level nav now.
// See [./views/RadiosView.tsx](./views/RadiosView.tsx) for the component
// and the App.tsx nav for the route.
// v2.0 Beta 5 Radios (fix): 'connection' section removed from the
// settings sidebar — every radio operation (add, edit, connect,
// disconnect, hot-swap-primary, delete) now lives in the top-level
// Radios tab so there's a single source of truth. The old single-
// radio TCP form here was a 1.x leftover that confused operators
// running multiple radios. See the Radios tab's guidance banner.
type SectionKey = 'mode' | 'modules' | 'notifications' | 'display' | 'blocked' | 'data' | 'disk' | 'guide' | 'jetson' | 'ai' | 'bbs' | 'users' | 'workspaces';

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: React.ReactNode;
}

const SECTIONS: SectionDef[] = [
  { key: 'mode',          label: 'Mode',          icon: <Radio size={14} /> },
  { key: 'modules',       label: 'Modules',       icon: <Network size={14} /> },
  { key: 'notifications', label: 'Notifications', icon: <Bell size={14} /> },
  { key: 'display',       label: 'Display',       icon: <Globe size={14} /> },
  { key: 'blocked',       label: 'Blocked',       icon: <Ban size={14} /> },
  { key: 'data',          label: 'Data',          icon: <FileDown size={14} /> },
  { key: 'disk',          label: 'Disk',          icon: <HardDrive size={14} /> },
  { key: 'bbs',           label: 'BBS',           icon: <Mail size={14} /> },
  // v2.0 Beta 5: Users section. Visible to everyone in the sidebar but
  // gated to admin in the panel itself — the in-panel section explains
  // why a viewer can see the tab but not its contents.
  { key: 'users',         label: 'Users',         icon: <UsersIcon size={14} /> },
  // v2.0 Beta 5 Workspaces Phase 1C: tenant management. Same admin-only
  // pattern as Users — viewers see a read-only notice.
  { key: 'workspaces',    label: 'Workspaces',    icon: <UsersIcon size={14} /> },
  { key: 'ai',            label: 'AI',            icon: <Bot size={14} /> },
  { key: 'guide',         label: 'Install Guide', icon: <BookOpen size={14} /> },
  { key: 'jetson',        label: 'Jetson Nano',   icon: <Cpu size={14} /> },
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

  // Blocked section
  blockedNodeIds: Set<string>;
  nodes: Node[];
  onUnblockNode: (id: string) => void;

  // Modules section (also reuses `radioConnected` declared above)
  /** Current authoritative module config (undefined fields mean "not yet read"). */
  localModuleConfig: LocalModuleConfigSnapshot;

  // Mode section
  dataSource: DataSource;
  setDataSource: (v: DataSource) => void;
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

export function SettingsModal(props: SettingsModalProps) {
  const [active, setActive] = React.useState<SectionKey>('mode');

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
            {active === 'modules' && (
              <React.Suspense fallback={<SettingsSectionLoading />}>
                <ModulesSection localModuleConfig={props.localModuleConfig} radioConnected={props.radioConnected} />
              </React.Suspense>
            )}
            {active === 'notifications' && <NotificationsSection {...props} />}
            {active === 'display'       && <DisplaySection {...props} />}
            {active === 'blocked'       && <BlockedSection {...props} />}
            {active === 'mode'          && <ModeSection {...props} />}
            {active === 'data' && (
              <React.Suspense fallback={<SettingsSectionLoading />}>
                <DataSection onOpenExport={props.onOpenExport} onClose={props.onClose} />
              </React.Suspense>
            )}
            {active === 'disk' && (
              <React.Suspense fallback={<SettingsSectionLoading />}>
                <DiskSection />
              </React.Suspense>
            )}
            {active === 'bbs' && (
              <React.Suspense fallback={<SettingsSectionLoading />}>
                <BbsSection />
              </React.Suspense>
            )}
            {active === 'users' && (
              <React.Suspense fallback={<SettingsSectionLoading />}>
                <UsersSection />
              </React.Suspense>
            )}
            {active === 'workspaces' && (
              <React.Suspense fallback={<SettingsSectionLoading />}>
                <WorkspacesSection />
              </React.Suspense>
            )}
            {active === 'ai'            && <AiSection />}
            {active === 'guide'         && <InstallGuideSection />}
            {active === 'jetson' && (
              <React.Suspense fallback={<SettingsSectionLoading />}>
                <JetsonGuideSection />
              </React.Suspense>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ============================================================================
// Connection (REMOVED — see top of file). ConnectionSection function
// kept as a non-rendered helper so any stray external import doesn't
// hard-break the build. The Settings sidebar no longer routes to it;
// all radio management lives in the top-level Radios tab.
// ============================================================================
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _ConnectionSectionLegacy({ transport, radioConnected, onTcpConnected, onClose }: SettingsModalProps) {
  const [host, setHost] = React.useState(transport?.tcp?.host ?? '');
  const [port, setPort] = React.useState(String(transport?.tcp?.port ?? 4403));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
          <p><strong className="text-brand-ink">Triggers:</strong> incoming DMs to the local node (suppressed if you're already viewing that chat) and OUTAGE events for favorited nodes — fired when a favorite goes silent past the staleness threshold and again when it returns.</p>
          <p>Notifications include a "click to open chat" action that switches to the messages tab with the sender's chat active.</p>
          <p className="text-brand-muted/80">Only works while a dashboard tab is open. Use <strong className="text-brand-ink">Background Push</strong> below to get alerted when no tab is open.</p>
        </div>
      </div>

      <WebPushPanel />
    </div>
  );
}

/**
 * v2.0.0 Web Push — server → OS push channel that survives tab close.
 *
 * Distinct from the in-page Notification API above:
 *   - In-page notifications fire from the running tab via SSE +
 *     useMeshNotifications. They stop the moment the tab closes.
 *   - Web Push fires from the SERVER through Apple/Google/Mozilla
 *     push services straight to the OS. Works with the browser
 *     closed (depending on platform — see help text below).
 *
 * Both can be on at the same time; the in-page path suppresses if
 * the user is actively viewing the source chat, the push path doesn't
 * (it has no knowledge of what tab is foreground).
 */
function WebPushPanel() {
  const [supported] = React.useState(() => browserPushSupported());
  const [subscribed, setSubscribed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  React.useEffect(() => {
    if (!supported) return;
    let alive = true;
    getCurrentSubscription().then(sub => {
      if (alive) setSubscribed(!!sub);
    });
    return () => { alive = false; };
  }, [supported]);

  const handleEnable = async () => {
    setBusy(true); setMsg(null);
    const r = await enableBrowserPush();
    setBusy(false);
    if (!r.ok) {
      setMsg({ tone: 'err', text: r.error || 'Enable failed' });
      return;
    }
    setSubscribed(true);
    setMsg({ tone: 'ok', text: 'Push enabled. Try Send Test to verify the path.' });
  };

  const handleDisable = async () => {
    setBusy(true); setMsg(null);
    await disableBrowserPush();
    setBusy(false);
    setSubscribed(false);
    setMsg({ tone: 'ok', text: 'Push disabled on this browser.' });
  };

  const handleTest = async () => {
    setBusy(true); setMsg(null);
    const r = await sendTestPush();
    setBusy(false);
    if (!r.ok) {
      setMsg({ tone: 'err', text: r.error || 'Test failed' });
      return;
    }
    const n = r.delivered ?? 0;
    setMsg({ tone: 'ok', text: `Sent test push (${n} subscription${n === 1 ? '' : 's'} delivered).` });
  };

  return (
    <div className="bg-brand-line/60 border border-brand-line rounded p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold text-brand-ink uppercase tracking-wide">Background Push (Web Push)</p>
          <p className={cn(
            'text-[11px] mt-0.5',
            !supported ? 'text-brand-error'
              : subscribed ? 'text-brand-accent'
              : 'text-brand-muted',
          )}>
            {!supported ? 'Not supported in this browser'
              : subscribed ? 'On — this browser will receive push alerts even when the tab is closed'
              : 'Off on this browser'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {subscribed && (
            <button
              onClick={handleTest}
              disabled={busy}
              className="text-[10px] font-bold uppercase tracking-widest border border-brand-accent/40 text-brand-accent hover:bg-brand-accent/10 disabled:opacity-40 rounded px-2.5 py-1.5"
            >
              {busy ? '…' : 'Send Test'}
            </button>
          )}
          <button
            onClick={subscribed ? handleDisable : handleEnable}
            disabled={!supported || busy}
            className={cn(
              'text-xs font-bold uppercase tracking-widest rounded px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border',
              subscribed
                ? 'bg-brand-line hover:bg-brand-line border-brand-line text-brand-ink'
                : 'bg-brand-accent/20 hover:bg-brand-accent/30 border-brand-accent/50 text-brand-accent',
            )}
          >
            {busy ? '…' : subscribed ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>

      {msg && (
        <div className={cn(
          'flex items-start gap-2 text-[11px] rounded border px-2.5 py-1.5',
          msg.tone === 'ok'
            ? 'border-brand-accent/40 bg-brand-accent/10 text-brand-accent'
            : 'border-red-500/40 bg-red-500/10 text-red-300',
        )}>
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
          <span>{msg.text}</span>
        </div>
      )}

      <div className="text-[11px] text-brand-muted leading-relaxed border-t border-brand-line/50 pt-3 space-y-1">
        <p><strong className="text-brand-ink">What fires push:</strong> DMs to your local node, OUTAGE events on favorite nodes, and WEATHER_ALERTs.</p>
        <p><strong className="text-brand-ink">Where it works:</strong> Chrome / Firefox / Edge on desktop reliably deliver even when the browser is closed. Safari delivers when the browser is open in the background. On mobile, behavior depends on the browser + battery-saver settings.</p>
        <p><strong className="text-brand-ink">Per-browser:</strong> enable separately on each browser / device that should receive alerts. Disabling here only removes this browser's subscription.</p>
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
function ModeSection({ dataSource, setDataSource, radioConnected, transport }: SettingsModalProps) {
  const isLive = dataSource === 'live';
  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h3 className="text-base font-bold tracking-tight uppercase flex items-center gap-2">
          <Radio size={16} className="text-brand-accent" />
          Data Source
        </h3>
        <p className="text-xs text-brand-muted leading-snug mt-1">
          Choose what populates the dashboard. <strong>Live</strong> draws from your attached
          Meshtastic radio (USB or TCP). <strong>Simulator</strong> generates synthetic mesh
          traffic for demos and UI testing; nothing is transmitted on-air. Defaults to Live.
        </p>
      </div>

      {/* Two-card layout — click either card to switch modes. */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setDataSource('live')}
          className={cn(
            "technical-panel p-4 text-left transition-colors",
            isLive
              ? "border-brand-accent/60 bg-brand-accent/10"
              : "hover:border-brand-line/70 hover:bg-brand-line/20"
          )}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <Radio size={16} className={isLive ? "text-brand-accent" : "text-brand-muted"} />
              <span className="text-sm font-bold uppercase tracking-tight">Live</span>
            </div>
            {isLive && (
              <span className="text-[9px] mono-text uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-brand-accent/20 text-brand-accent">
                Active
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted leading-snug mb-2">
            Real radio over USB or TCP. Default mode for production use.
          </p>
          <div className="text-[10px] mono-text">
            <span className={radioConnected ? "text-brand-accent" : "text-brand-warning"}>
              {radioConnected
                ? (transport?.mode === 'tcp' && transport.tcp
                    ? `Connected · ${transport.tcp.host}:${transport.tcp.port}`
                  : transport?.mode === 'serial' && transport.serial
                    ? `Connected · ${transport.serial.port}`
                  : 'Connected')
                : 'No radio detected'}
            </span>
          </div>
        </button>

        <button
          onClick={() => setDataSource('simulator')}
          className={cn(
            "technical-panel p-4 text-left transition-colors",
            !isLive
              ? "border-brand-warning/60 bg-brand-warning/10"
              : "hover:border-brand-line/70 hover:bg-brand-line/20"
          )}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <Activity size={16} className={!isLive ? "text-brand-warning" : "text-brand-muted"} />
              <span className="text-sm font-bold uppercase tracking-tight">Playground</span>
            </div>
            {!isLive && (
              <span className="text-[9px] mono-text uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-brand-warning/20 text-brand-warning">
                Active
              </span>
            )}
          </div>
          <p className="text-[11px] text-brand-muted leading-snug mb-2">
            Synthetic mesh data for demos and UI work. Nothing on the air.
          </p>
          <div className="text-[10px] mono-text text-brand-muted">
            ~50 nodes · scripted topology
          </div>
        </button>
      </div>

      {/* v3.0 note: Playground is now session-only. */}
      <div className="text-[10px] text-brand-muted leading-snug px-1 pb-2 border-b border-brand-line/40">
        <strong className="text-brand-warning">v3.0 change:</strong> Playground (formerly "Simulator") is now <strong>session-only</strong> — it doesn't persist across reloads. Refresh the page and you're back in Live mode. This was a deliberate change from v2.x where the toggle persisted and occasionally trapped operators who forgot they'd enabled it and wondered why their real radio's traffic wasn't showing up.
      </div>

      {/* Re-open First-Run Wizard — useful for demoing Sentinel to a
          colleague, or for anyone who dismissed the wizard early. */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-[10px] text-brand-muted leading-snug">
          Want the fresh-install experience again? Clears the "wizard dismissed" flag and re-shows the welcome flow.
        </div>
        <button
          onClick={() => {
            try { localStorage.removeItem('mesh.wizardDismissed'); } catch {}
            // Force a reload — App.tsx reads wizardDismissed once at
            // mount, so simply clearing it here doesn't re-show the
            // wizard until next reload. The reload also picks up any
            // fresh-install detection changes.
            window.location.reload();
          }}
          className="text-[10px] uppercase font-bold tracking-widest px-3 py-1.5 rounded border border-brand-accent/40 text-brand-accent hover:bg-brand-accent/10 shrink-0"
        >
          Show First-Run Wizard
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Installation Guide section — embedded markdown + Copy/Download (moved here
// from the main nav per operator request; the main page no longer carries it).
// ----------------------------------------------------------------------------

/**
 * Reusable markdown-guide panel. Used by both the general Installation Guide
 * and the platform-specific (Jetson Nano) guide. Each consumer provides a
 * title, description, icon, lazy content loader, and the download filename;
 * everything else (Copy / Download buttons, terminal-styled viewer) is shared.
 */

function InstallGuideSection() {
  return (
    <MarkdownGuide
      title="Installation Guide"
      description="Step-by-step deployment recipe — gateway prep, install, dashboard tour, BBS configuration, troubleshooting. Copy the markdown source or download the file for offline reference."
      icon={<BookOpen size={16} className="text-brand-accent" />}
      loadContent={async () => {
        const m = await import('../constants/installationGuide');
        return m.INSTALLATION_GUIDE_DELL_GB10;
      }}
      downloadFilename="MeshView-Sentinel-Installation-Guide.md"
      displayFilename="install-guide.md"
    />
  );
}


// v2.1: AI config types — used by AiSection which is still in this
// file (deferred extraction, "spike for another day"). When AiSection
// moves to its own chunk, these come with it.
type AIProvider = 'anthropic' | 'gemini' | 'ollama';

interface AIConfig {
  enabled: boolean;
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

  // Master switch. Disabled by default on fresh installs; persists immediately
  // on toggle (no Save needed) so flipping it has instant effect.
  const [enabled, setEnabled] = React.useState(false);
  const [togglingEnabled, setTogglingEnabled] = React.useState(false);

  React.useEffect(() => {
    fetch(`${API_BASE}/api/ai/config`)
      .then(r => r.json())
      .then((cfg: AIConfig) => {
        setConfig(cfg);
        setEnabled(!!cfg.enabled);
        setProvider(cfg.provider);
        setOllamaBaseUrl(cfg.ollamaBaseUrl ?? '');
        setOllamaModel(cfg.ollamaModel ?? '');
        setRedactPii(!!cfg.redactPii);
      })
      .catch(() => setError('Failed to load AI config'))
      .finally(() => setLoading(false));
  }, []);

  const handleToggleEnabled = async (next: boolean) => {
    setTogglingEnabled(true);
    setError('');
    // Optimistic update — flip locally so the UI feels instant; revert on
    // failure. The window event signals App.tsx to hide/show the launcher
    // without waiting for the next config poll.
    setEnabled(next);
    try {
      const res = await fetch(`${API_BASE}/api/ai/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.dispatchEvent(new CustomEvent('mesh:aiEnabledChanged', { detail: { enabled: next } }));
    } catch (err: any) {
      setEnabled(!next); // revert
      setError(err?.message || 'Failed to toggle AI');
    } finally {
      setTogglingEnabled(false);
    }
  };

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
      {/* Master switch — operator can turn the whole AI feature off without
          erasing keys / models. Persists on toggle; no Save click needed. */}
      <div className="technical-panel p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => handleToggleEnabled(e.target.checked)}
            disabled={togglingEnabled || loading}
            className="w-4 h-4 accent-brand-accent mt-0.5"
          />
          <div>
            <div className="text-sm font-bold uppercase tracking-tight flex items-center gap-2">
              AI Assistant
              {togglingEnabled && <Loader2 size={11} className="animate-spin text-brand-muted" />}
              {enabled ? (
                <span className="text-[9px] mono-text uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-brand-accent/15 text-brand-accent">enabled</span>
              ) : (
                <span className="text-[9px] mono-text uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-brand-line text-brand-muted">disabled</span>
              )}
            </div>
            <div className="text-[10px] text-brand-muted leading-snug mt-0.5">
              When off, the AI launcher is hidden from the dashboard and the
              <code className="text-brand-accent mx-1">/api/ai/chat</code>
              endpoint returns 503. Keys, models, and preferences below stay
              persisted so flipping back on doesn't require re-entering them.
            </div>
          </div>
        </label>
      </div>

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

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h4 className="text-sm font-bold uppercase tracking-tight text-brand-ink">{title}</h4>
      <p className="text-[11px] text-brand-muted mt-0.5">{subtitle}</p>
    </div>
  );
}

