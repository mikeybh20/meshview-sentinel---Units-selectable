import React from 'react';
import { Signal, X, MessageSquare, Battery, MapPin, Wifi, Clock, Plus, Edit3, Lock, Trash2, ChevronRight, ChevronDown, Route, Loader2, Network, QrCode, Ban, Undo2, History, Server, Star, Activity } from 'lucide-react';
import { Map, ZoomControl, Overlay } from "pigeon-maps";

import { Node, Message, Group, UnitSystem, Waypoint, TraceResult, NeighborInfoSnapshot, StoreForwardRouter } from '../../types';
import { MeshLinks } from '../ui/MeshLinks';
import { TraceLinks } from '../ui/TraceLinks';
// WaypointEditorModal pulls in `emoji-picker-react` (~140 KB). We lazy-load
// the modal so that bundle cost is paid only when the operator actually drops
// or edits a waypoint, not on every initial page load.
const WaypointEditorModal = React.lazy(() =>
  import('../WaypointEditorModal').then(m => ({ default: m.WaypointEditorModal }))
);
import { ContactQrModal } from '../ContactQrModal';
import { roleLabel, hardwareLabel, ROLE_SHORT } from '../../lib/meshEnums';
import { hexToRgba } from '../../lib/color';
import { cn } from '../../lib/utils';
import { meshDataService } from '../../services/meshDataService';
import { useMapClustering } from '../../hooks/useMapClustering';

interface MapViewProps {
  nodes: Node[];
  messages: Message[];
  groups: Group[];
  traceMessageId: string | null;
  setTraceMessageId: (id: string | null) => void;
  setSelectedNodeId: (id: string) => void;
  onDirectMessage: (nodeId: string) => void;
  unitSystem: UnitSystem;
  waypoints: Waypoint[];
  traces: TraceResult[];
  neighborInfo: NeighborInfoSnapshot[];
  storeForwardRouters: StoreForwardRouter[];
  blockedNodeIds: Set<string>;
  onBlockNode: (id: string) => void;
  onUnblockNode: (id: string) => void;
  onRequestStoreForwardHistory: (routerId: string, minutes: number) => Promise<{ ok: boolean; error?: string }>;
  onToggleFavorite: (nodeId: string, favorite: boolean) => Promise<void> | void;
  onAssignGroup: (nodeId: string, groupId: string | undefined) => Promise<void> | void;
  localNodeId: string | null;
  dataSource: 'live' | 'simulator';
  onSaveWaypoint: (input: {
    id?: number;
    lat: number;
    lng: number;
    name: string;
    description: string;
    icon: number;
    expire: number;
    lockedToSelf: boolean;
  }) => Promise<void> | void;
  onDeleteWaypoint: (id: number) => Promise<void> | void;
  onTraceroute: (nodeId: string) => Promise<{ ok: boolean; requestId?: string; error?: string }>;
}

function codepointToEmoji(cp: number): string {
  if (!cp) return '📍';
  try { return String.fromCodePoint(cp); } catch { return '📍'; }
}

function nodeNumFromHex(hex: string): number {
  return parseInt((hex || '').replace('!', ''), 16) >>> 0;
}

function formatExpiresIn(expireSec: number): string {
  if (!expireSec) return 'Never expires';
  const remaining = expireSec - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return 'Expired';
  if (remaining < 3600) return `Expires in ${Math.floor(remaining / 60)}m`;
  if (remaining < 86400) return `Expires in ${Math.floor(remaining / 3600)}h`;
  return `Expires in ${Math.floor(remaining / 86400)}d`;
}

// Maryland, home base
const FALLBACK_CENTER: [number, number] = [39.0, -76.7];
const FALLBACK_ZOOM = 9;

function formatLastSeen(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Compact stats tile for the map info panel. `tone` selects a color treatment:
 *   ink     — primary text (totals)
 *   accent  — emerald (positive / online)
 *   warning — amber (favorites / base stations)
 *   info    — cyan (routers / infrastructure)
 *   muted   — slate (offline / inactive)
 * `hint` becomes the native hover tooltip so we can explain what's being counted
 * without spending vertical space.
 */
function StatTile({ label, value, tone, hint }: {
  label: string;
  value: number;
  tone: 'ink' | 'accent' | 'warning' | 'info' | 'muted';
  hint?: string;
}) {
  const valueClass =
    tone === 'accent'  ? 'text-brand-accent'
    : tone === 'warning' ? 'text-brand-warning'
    : tone === 'info'    ? 'text-brand-info'
    : tone === 'muted'   ? 'text-brand-muted'
    :                       'text-brand-ink';
  return (
    <div
      className="bg-brand-line/30 border border-brand-line rounded px-2 py-1.5"
      title={hint}
    >
      <div className={`text-base font-bold mono-text ${valueClass}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-widest text-brand-muted mt-0.5">{label}</div>
    </div>
  );
}

function NodePopup({
  node,
  nodes,
  onClose,
  onDirectMessage,
  onTraceroute,
  onShareContact,
  onBlock,
  onUnblock,
  onToggleFavorite,
  isBlocked,
  trace,
  neighbors,
  sfRouter,
  onRequestHistory,
  unitSystem,
  canTrace,
  groups,
  onAssignGroup,
}: {
  node: Node;
  nodes: Node[];
  onClose: () => void;
  onDirectMessage: (id: string) => void;
  onTraceroute: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onShareContact: (node: Node) => void;
  onBlock: (id: string) => void;
  onUnblock: (id: string) => void;
  onToggleFavorite: (nodeId: string, favorite: boolean) => void;
  isBlocked: boolean;
  trace: TraceResult | null;
  neighbors: NeighborInfoSnapshot | null;
  sfRouter: StoreForwardRouter | null;
  onRequestHistory: (routerId: string, minutes: number) => Promise<{ ok: boolean; error?: string }>;
  unitSystem: UnitSystem;
  canTrace: boolean;
  groups: Group[];
  onAssignGroup: (nodeId: string, groupId: string | undefined) => void;
}) {
  const rssi = node.telemetry?.rssi;
  const snr = node.telemetry?.snr;
  const battery = node.telemetry?.battery;
  const distance = node.telemetry?.distance;
  const [tracing, setTracing] = React.useState(false);
  const [traceError, setTraceError] = React.useState<string | null>(null);
  const [sfWindow, setSfWindow] = React.useState<number>(60);
  const [sfBusy, setSfBusy] = React.useState(false);
  const [sfStatus, setSfStatus] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const handleRequestSfHistory = async () => {
    if (!sfRouter) return;
    setSfBusy(true);
    setSfStatus(null);
    const r = await onRequestHistory(node.id, sfWindow);
    setSfBusy(false);
    if (r.ok) setSfStatus({ kind: 'ok', text: `Requested last ${sfWindow}min — replays will arrive over the next minute or two` });
    else setSfStatus({ kind: 'error', text: r.error ?? 'Request failed' });
  };

  const isPending = trace?.status === 'pending';
  const buttonBusy = tracing || isPending;

  const nodeLabel = (id: string): string => {
    const n = nodes.find(x => x.id === id);
    if (!n) return id;
    return n.shortName || n.name || id;
  };

  const handleTrace = async () => {
    setTraceError(null);
    setTracing(true);
    const r = await onTraceroute(node.id);
    setTracing(false);
    if (!r.ok) setTraceError(r.error ?? 'Trace failed');
  };

  const rssiColor =
    rssi === undefined ? 'text-brand-muted'
    : rssi > -70 ? 'text-brand-accent'
    : rssi > -90 ? 'text-brand-warning'
    : 'text-brand-error';

  return (
    <div
      className="rounded-lg border border-brand-accent/40 p-3 w-64 pointer-events-auto"
      style={{
        transform: 'translate(-50%, calc(-100% - 36px))',
        position: 'absolute',
        background: 'var(--color-brand-bg)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(16,185,129,0.15)',
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Pointer arrow toward the marker */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: '-6px',
          transform: 'translateX(-50%) rotate(45deg)',
          width: '12px',
          height: '12px',
          background: 'var(--color-brand-bg)',
          borderRight: '1px solid rgba(16,185,129,0.4)',
          borderBottom: '1px solid rgba(16,185,129,0.4)',
        }}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${node.online ? 'bg-brand-accent' : 'bg-brand-muted'}`} />
            <span className="text-xs font-bold text-brand-ink truncate">{node.name}</span>
            {node.shortName && (
              <span className="text-[9px] font-bold text-brand-accent bg-brand-accent/15 px-1 py-0.5 rounded flex-shrink-0">
                {node.shortName}
              </span>
            )}
            {node.publicKey && (
              <span
                className="flex items-center gap-0.5 text-[9px] font-bold text-brand-accent bg-brand-accent/10 border border-brand-accent/30 px-1 py-0.5 rounded flex-shrink-0"
                title="This node supports PKC-encrypted DMs (Curve25519 public key advertised)"
              >
                <Lock size={8} />
                PKC
              </span>
            )}
            {sfRouter && (
              <span
                className="flex items-center gap-0.5 text-[9px] font-bold text-brand-warning bg-brand-warning/10 border border-brand-warning/30 px-1 py-0.5 rounded flex-shrink-0"
                title={`Store & Forward router (heartbeat every ${sfRouter.periodSecs}s${sfRouter.isSecondary ? ', secondary' : ''})`}
              >
                <Server size={8} />
                S&amp;F
              </span>
            )}
            {node.role !== undefined && node.role !== 0 && ROLE_SHORT[node.role] && (
              <span
                className="text-[9px] font-bold mono-text text-brand-ink bg-brand-line/50 border border-brand-line px-1 py-0.5 rounded flex-shrink-0"
                title={`Role: ${roleLabel(node.role) ?? 'Unknown'}`}
              >
                {ROLE_SHORT[node.role]}
              </span>
            )}
            {node.isLicensed && (
              <span
                className="text-[9px] font-bold mono-text text-blue-300 bg-blue-500/10 border border-blue-500/30 px-1 py-0.5 rounded flex-shrink-0"
                title="Operator has identified as a licensed amateur radio operator"
              >
                LIC
              </span>
            )}
            {node.lastVia === 'mqtt' && (
              <span
                className="text-[9px] font-bold mono-text text-brand-info bg-brand-info/10 border border-brand-info/30 px-1 py-0.5 rounded flex-shrink-0"
                title="Last seen via MQTT bridge — not a direct LoRa peer"
              >
                MQTT
              </span>
            )}
          </div>
          <p className="text-[9px] mono-text text-brand-muted mt-0.5">
            {node.id}
            {hardwareLabel(node.hwModel) && (
              <span className="text-brand-muted"> · {hardwareLabel(node.hwModel)}</span>
            )}
          </p>
        </div>
        <div className="flex items-start gap-1 flex-shrink-0 ml-1 mt-0.5">
          <button
            onClick={() => onToggleFavorite(node.id, !node.favorite)}
            title={node.favorite ? 'Remove from favorites' : 'Mark as favorite'}
            className={`transition-colors ${node.favorite ? 'text-brand-warning hover:text-brand-warning' : 'text-brand-muted hover:text-brand-warning'}`}
          >
            <Star size={12} fill={node.favorite ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={onClose}
            className="text-brand-muted hover:text-brand-ink"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Telemetry grid */}
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        <div className="bg-brand-line/80 border border-brand-line rounded p-1.5">
          <div className="flex items-center gap-1 mb-0.5">
            <Wifi size={9} className="text-brand-muted" />
            <span className="text-[8px] uppercase text-brand-muted font-semibold">RSSI</span>
          </div>
          <span className={`text-[11px] font-bold mono-text ${rssiColor}`}>
            {rssi !== undefined ? `${rssi} dBm` : '—'}
          </span>
        </div>
        <div className="bg-brand-line/80 border border-brand-line rounded p-1.5">
          <div className="flex items-center gap-1 mb-0.5">
            <Signal size={9} className="text-brand-muted" />
            <span className="text-[8px] uppercase text-brand-muted font-semibold">SNR</span>
          </div>
          <span className="text-[11px] font-bold mono-text text-brand-ink">
            {snr !== undefined ? `${snr} dB` : '—'}
          </span>
        </div>
        <div className="bg-brand-line/80 border border-brand-line rounded p-1.5">
          <div className="flex items-center gap-1 mb-0.5">
            <Battery size={9} className="text-brand-muted" />
            <span className="text-[8px] uppercase text-brand-muted font-semibold">Battery</span>
          </div>
          <span className={`text-[11px] font-bold mono-text ${battery !== undefined && battery < 20 ? 'text-brand-error' : 'text-brand-ink'}`}>
            {battery !== undefined ? `${battery}%` : '—'}
          </span>
        </div>
        <div className="bg-brand-line/80 border border-brand-line rounded p-1.5">
          <div className="flex items-center gap-1 mb-0.5">
            <MapPin size={9} className="text-brand-muted" />
            <span className="text-[8px] uppercase text-brand-muted font-semibold">Dist</span>
          </div>
          <span className="text-[11px] font-bold mono-text text-brand-ink">
            {distance !== undefined
              ? unitSystem === 'IMPERIAL'
                ? `${(distance * 0.621371).toFixed(1)} mi`
                : `${distance.toFixed(1)} km`
              : '—'}
          </span>
        </div>
      </div>

      {/* Position */}
      {node.position && (
        <div className="bg-brand-line/60 border border-brand-line/50 rounded px-2 py-1 mb-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[9px] mono-text text-brand-ink truncate">
              {node.position.lat.toFixed(5)}, {node.position.lng.toFixed(5)}
              {node.position.alt > 0 && ` · ${node.position.alt}m`}
            </p>
            {node.positionSource && (
              <span
                className={`text-[8px] uppercase font-bold mono-text px-1 py-0.5 rounded flex-shrink-0 ${
                  node.positionSource === 'manual'
                    ? 'bg-brand-warning/15 text-brand-warning border border-brand-warning/30'
                    : 'bg-brand-accent/10 text-brand-accent border border-brand-accent/30'
                }`}
                title={
                  node.positionSource === 'manual'
                    ? 'Fixed position (manually configured on the node)'
                    : 'Live GPS fix from the node'
                }
              >
                {node.positionSource === 'manual' ? 'Fixed' : 'GPS'}
              </span>
            )}
          </div>
          {node.positionPrecisionBits !== undefined && node.positionPrecisionBits > 0 && node.positionPrecisionBits < 32 && (
            <p className="text-[8px] mono-text text-brand-muted mt-0.5" title="Channel-limited position precision">
              Precision: {node.positionPrecisionBits} bits (privacy-reduced)
            </p>
          )}
        </div>
      )}

      {/* Last seen */}
      <div className="flex items-center gap-1 mb-2">
        <Clock size={9} className="text-brand-muted" />
        <span className="text-[9px] mono-text text-brand-ink">{formatLastSeen(node.lastSeen)}</span>
      </div>

      {/* NeighborInfo panel — what direct neighbors this node has reported */}
      {neighbors && neighbors.neighbors.length > 0 && (
        <div className="mb-2 bg-brand-line/40 border border-brand-line/50 rounded p-2">
          <div className="flex items-center gap-1 mb-1">
            <Network size={10} className="text-brand-accent" />
            <span className="text-[9px] uppercase font-semibold text-brand-muted">
              Reports {neighbors.neighbors.length} neighbor{neighbors.neighbors.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="space-y-0.5">
            {neighbors.neighbors.slice(0, 5).map((n, i) => {
              const peer = nodes.find(x => x.id === n.nodeId);
              const label = peer?.shortName || peer?.name || n.nodeId.slice(-4);
              const snrColor = n.snr > 5 ? 'text-brand-accent' : n.snr > -5 ? 'text-brand-warning' : 'text-brand-error';
              return (
                <div key={i} className="flex items-center justify-between text-[10px] mono-text">
                  <span className="text-brand-ink truncate">{label}</span>
                  <span className={snrColor}>{n.snr.toFixed(1)}dB</span>
                </div>
              );
            })}
            {neighbors.neighbors.length > 5 && (
              <p className="text-[9px] text-brand-muted italic">+{neighbors.neighbors.length - 5} more</p>
            )}
          </div>
        </div>
      )}

      {/* Trace result panel (shown if there's a trace for this node) */}
      {trace && (
        <div className="mb-2 bg-brand-line/40 border border-brand-line/50 rounded p-2">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1">
              <Route size={10} className="text-brand-accent" />
              <span className="text-[9px] uppercase font-semibold text-brand-muted">Last Trace</span>
            </div>
            <span className={`text-[8px] uppercase font-bold ${
              trace.status === 'response' ? 'text-brand-accent'
              : trace.status === 'pending' ? 'text-brand-warning'
              : trace.status === 'timeout' ? 'text-brand-muted'
              : 'text-brand-error'
            }`}>
              {trace.status === 'response' ? 'OK' : trace.status === 'pending' ? 'Tracing...' : trace.status}
            </span>
          </div>

          {trace.status === 'pending' && (
            <p className="text-[9px] text-brand-muted italic">Awaiting response from {nodeLabel(trace.targetId)}…</p>
          )}

          {trace.status === 'response' && (
            <div className="space-y-1">
              <div>
                <p className="text-[8px] uppercase font-semibold text-brand-muted mb-0.5">Outbound</p>
                <p className="text-[10px] mono-text text-brand-ink break-all leading-snug">
                  {trace.route.length === 0
                    ? <span className="text-brand-muted">direct → {nodeLabel(trace.targetId)}</span>
                    : trace.route.map((h, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-brand-muted"> → </span>}
                          <span>{nodeLabel(h.nodeId)}</span>
                          {h.snr !== undefined && <span className="text-brand-muted"> ({h.snr.toFixed(1)}dB)</span>}
                        </span>
                      ))
                  }
                </p>
              </div>
              {trace.routeBack.length > 0 && (
                <div>
                  <p className="text-[8px] uppercase font-semibold text-brand-muted mb-0.5">Return</p>
                  <p className="text-[10px] mono-text text-brand-ink break-all leading-snug">
                    {trace.routeBack.map((h, i) => (
                      <span key={i}>
                        {i > 0 && <span className="text-brand-muted"> → </span>}
                        <span>{nodeLabel(h.nodeId)}</span>
                        {h.snr !== undefined && <span className="text-brand-muted"> ({h.snr.toFixed(1)}dB)</span>}
                      </span>
                    ))}
                  </p>
                </div>
              )}
            </div>
          )}

          {trace.status === 'timeout' && (
            <p className="text-[9px] text-brand-muted">{trace.errorMessage || 'No response'}</p>
          )}

          {trace.status === 'error' && trace.errorMessage && (
            <p className="text-[9px] text-brand-error">{trace.errorMessage}</p>
          )}
        </div>
      )}

      {traceError && (
        <p className="mb-2 text-[9px] text-brand-error">{traceError}</p>
      )}

      {/* Store & Forward router controls */}
      {sfRouter && (
        <div className="mb-2 bg-brand-warning/5 border border-brand-warning/20 rounded p-2">
          <div className="flex items-center gap-1 mb-1.5">
            <Server size={10} className="text-brand-warning" />
            <span className="text-[9px] uppercase font-semibold text-brand-warning">Store &amp; Forward Router</span>
          </div>
          <div className="grid grid-cols-2 gap-1 text-[10px] mono-text mb-1.5">
            <div>
              <span className="text-brand-muted">Period: </span>
              <span className="text-brand-ink">{sfRouter.periodSecs}s</span>
            </div>
            <div>
              <span className="text-brand-muted">Type: </span>
              <span className="text-brand-ink">{sfRouter.isSecondary ? 'Secondary' : 'Primary'}</span>
            </div>
            {sfRouter.stats?.messagesSaved !== undefined && (
              <div>
                <span className="text-brand-muted">Saved: </span>
                <span className="text-brand-ink">
                  {sfRouter.stats.messagesSaved}
                  {sfRouter.stats.messagesMax ? ` / ${sfRouter.stats.messagesMax}` : ''}
                </span>
              </div>
            )}
            {sfRouter.stats?.upTimeSecs !== undefined && (
              <div>
                <span className="text-brand-muted">Uptime: </span>
                <span className="text-brand-ink">{Math.floor(sfRouter.stats.upTimeSecs / 60)}m</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 mb-1">
            <select
              value={sfWindow}
              onChange={e => setSfWindow(parseInt(e.target.value, 10))}
              className="flex-1 bg-brand-line border border-brand-line rounded text-[10px] mono-text text-brand-ink px-1.5 py-1 focus:outline-none focus:border-brand-warning/50"
            >
              <option value={15}>Last 15 min</option>
              <option value={30}>Last 30 min</option>
              <option value={60}>Last 60 min</option>
              <option value={180}>Last 3 hr</option>
              <option value={360}>Last 6 hr</option>
              <option value={720}>Last 12 hr</option>
              <option value={1440}>Last 24 hr</option>
            </select>
            <button
              onClick={handleRequestSfHistory}
              disabled={sfBusy}
              className="flex items-center gap-1 bg-brand-warning/20 hover:bg-brand-warning/30 border border-brand-warning/50 text-brand-warning hover:text-amber-200 text-[9px] font-bold uppercase tracking-widest rounded px-2 py-1 transition-colors disabled:opacity-50"
            >
              {sfBusy ? <Loader2 size={10} className="animate-spin" /> : <History size={10} />}
              {sfBusy ? '...' : 'Replay'}
            </button>
          </div>

          {sfStatus && (
            <p className={`text-[9px] mt-1 leading-snug ${sfStatus.kind === 'ok' ? 'text-brand-accent' : 'text-brand-error'}`}>
              {sfStatus.text}
            </p>
          )}
        </div>
      )}

      {/* Group assignment */}
      {groups.length > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[9px] uppercase font-bold text-brand-muted flex-shrink-0">Group</span>
          <select
            value={node.groupId ?? ''}
            onChange={(e) => onAssignGroup(node.id, e.target.value || undefined)}
            className="flex-1 bg-brand-line border border-brand-line rounded text-[11px] mono-text text-brand-ink px-1.5 py-0.5 focus:outline-none focus:border-brand-accent/50"
          >
            <option value="">— Unassigned —</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          {node.groupId && (
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: groups.find(g => g.id === node.groupId)?.color ?? 'transparent' }}
            />
          )}
        </div>
      )}

      {/* Blocked banner */}
      {isBlocked && (
        <div className="mb-2 flex items-center gap-2 bg-brand-error/10 border border-brand-error/30 rounded p-2">
          <Ban size={12} className="text-brand-error flex-shrink-0" />
          <p className="text-[10px] text-brand-error leading-tight">
            <span className="font-bold uppercase tracking-wide">Blocked</span> — messages from this node are hidden.
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="grid grid-cols-3 gap-1.5">
        <button
          onClick={() => onDirectMessage(node.id)}
          disabled={isBlocked}
          className="flex items-center justify-center gap-1 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <MessageSquare size={11} />
          DM
        </button>
        <button
          onClick={handleTrace}
          disabled={!canTrace || buttonBusy}
          title={!canTrace ? 'Switch to live radio to traceroute' : 'Discover the path to this node'}
          className="flex items-center justify-center gap-1 bg-brand-line hover:bg-brand-line border border-brand-line hover:border-brand-accent/50 text-brand-ink hover:text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {buttonBusy
            ? <Loader2 size={11} className="animate-spin" />
            : <Route size={11} />
          }
          {buttonBusy ? '...' : 'Trace'}
        </button>
        <button
          onClick={() => onShareContact(node)}
          title={node.publicKey ? 'Share this contact via QR code' : 'No public key known yet — wait for a NodeInfo packet'}
          className="flex items-center justify-center gap-1 bg-brand-line hover:bg-brand-line border border-brand-line hover:border-brand-accent/50 text-brand-ink hover:text-brand-ink text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors"
        >
          <QrCode size={11} />
          QR
        </button>
      </div>

      {/* Block / Unblock — secondary, less prominent */}
      <button
        onClick={() => isBlocked ? onUnblock(node.id) : onBlock(node.id)}
        className={`mt-1.5 w-full flex items-center justify-center gap-1 border text-[10px] font-bold uppercase tracking-widest rounded py-1 transition-colors ${
          isBlocked
            ? 'bg-brand-line hover:bg-brand-line border-brand-line text-brand-ink hover:text-brand-ink'
            : 'bg-transparent hover:bg-brand-error/10 border-brand-line hover:border-brand-error/40 text-brand-muted hover:text-brand-error'
        }`}
        title={isBlocked ? 'Stop blocking this node' : 'Hide all messages and markers from this node'}
      >
        {isBlocked
          ? <><Undo2 size={10} /> Unblock</>
          : <><Ban size={10} /> Block</>
        }
      </button>
    </div>
  );
}

function WaypointPopup({
  waypoint,
  canEdit,
  onClose,
  onEdit,
}: {
  waypoint: Waypoint;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-brand-accent/40 p-3 w-56 pointer-events-auto"
      style={{
        transform: 'translate(-50%, calc(-100% - 28px))',
        position: 'absolute',
        whiteSpace: 'nowrap',
        background: 'var(--color-brand-bg)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(16,185,129,0.15)',
      }}
      onClick={e => e.stopPropagation()}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: '-6px',
          transform: 'translateX(-50%) rotate(45deg)',
          width: '12px',
          height: '12px',
          background: 'var(--color-brand-bg)',
          borderRight: '1px solid rgba(16,185,129,0.4)',
          borderBottom: '1px solid rgba(16,185,129,0.4)',
        }}
      />

      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xl flex-shrink-0">{codepointToEmoji(waypoint.icon)}</span>
          <div className="min-w-0">
            <p className="text-xs font-bold text-brand-ink truncate">
              {waypoint.name || 'Untitled waypoint'}
              {waypoint.lockedTo > 0 && <Lock size={9} className="inline ml-1 text-brand-accent/70" />}
            </p>
            <p className="text-[9px] mono-text text-brand-muted">{formatExpiresIn(waypoint.expire)}</p>
          </div>
        </div>
        <button onClick={onClose} className="text-brand-muted hover:text-brand-ink flex-shrink-0 ml-1 mt-0.5">
          <X size={12} />
        </button>
      </div>

      {waypoint.description && (
        <p className="text-[11px] text-brand-ink mb-2 whitespace-normal break-words leading-snug">
          {waypoint.description}
        </p>
      )}

      <div className="bg-brand-line/60 border border-brand-line/50 rounded px-2 py-1 mb-2">
        <p className="text-[9px] mono-text text-brand-ink">
          {waypoint.lat.toFixed(5)}, {waypoint.lng.toFixed(5)}
        </p>
      </div>

      {waypoint.createdBy && (
        <p className="text-[9px] mono-text text-brand-muted mb-2">Placed by {waypoint.createdBy}</p>
      )}

      {canEdit ? (
        <button
          onClick={onEdit}
          className="w-full flex items-center justify-center gap-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 text-brand-accent hover:text-emerald-200 text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors"
        >
          <Edit3 size={11} />
          Edit
        </button>
      ) : (
        <div className="text-center text-[9px] text-brand-muted py-1 border-t border-brand-line">
          <Lock size={9} className="inline mr-1" />
          Locked by placer
        </div>
      )}
    </div>
  );
}

interface DropDraft {
  lat: number;
  lng: number;
}

export function MapView({
  nodes,
  messages,
  groups,
  traceMessageId,
  setTraceMessageId,
  setSelectedNodeId,
  onDirectMessage,
  unitSystem,
  waypoints,
  localNodeId,
  dataSource,
  onSaveWaypoint,
  onDeleteWaypoint,
  traces,
  neighborInfo,
  storeForwardRouters,
  onTraceroute,
  blockedNodeIds,
  onBlockNode,
  onUnblockNode,
  onRequestStoreForwardHistory,
  onToggleFavorite,
  onAssignGroup,
}: MapViewProps) {
  const positioned = nodes.filter(n => n.position);
  const [popupNodeId, setPopupNodeId] = React.useState<string | null>(null);
  const [popupWaypointId, setPopupWaypointId] = React.useState<number | null>(null);
  const [editingWaypoint, setEditingWaypoint] = React.useState<Waypoint | null>(null);
  const [dropDraft, setDropDraft] = React.useState<DropDraft | null>(null);
  const [qrNode, setQrNode] = React.useState<Node | null>(null);
  const [mapInfoOpen, setMapInfoOpen] = React.useState(true);
  // Per-section disclosure state (lets operators collapse the parts they don't need).
  const [coverageSectionOpen, setCoverageSectionOpen] = React.useState(true);
  const [waypointsSectionOpen, setWaypointsSectionOpen] = React.useState(false);
  const [legendSectionOpen, setLegendSectionOpen] = React.useState(false);
  const [coverageWindowMs, setCoverageWindowMs] = React.useState<number>(24 * 3600 * 1000);
  const [coverageData, setCoverageData] = React.useState<Awaited<ReturnType<typeof meshDataService.getRangeTestCoverage>> | null>(null);
  const [coverageLoading, setCoverageLoading] = React.useState(false);
  const [coverageHeatmap, setCoverageHeatmap] = React.useState(false);
  // v2.1: GPU/CPU spatial clustering for map pins. When on, the
  // marker render path swaps individual node pins for cluster markers
  // (single pin per cluster with a count). DBSCAN runs on the sidecar;
  // backend reads back as cuML / CPU and surfaces in the Coverage
  // panel toggle subtitle.
  const [clusterMode, setClusterMode] = React.useState(false);
  const clusterResult = useMapClustering(nodes, {
    enabled: clusterMode,
    epsMeters: 80,
    minSamples: 2,
  });

  /**
   * Mesh stats derived from the current node set + visible-on-map subset.
   * "Visible" = the node is rendered on the map right now (has a position
   * and isn't blocked). The Routers / Base Stations counts are constrained
   * to the visible subset because that's the operator-relevant figure when
   * looking at infrastructure on the map.
   */
  const meshStats = React.useMemo(() => {
    const visible = nodes.filter(n => n.position && !blockedNodeIds.has(n.id));
    let online = 0, offline = 0, favorites = 0, routers = 0, baseStations = 0, withPosition = 0;
    for (const n of nodes) {
      if (n.online) online++; else offline++;
      if (n.favorite) favorites++;
      if (n.position) withPosition++;
    }
    for (const n of visible) {
      // Routers / repeaters / router-clients = roles 2, 3, 4 in our enum table.
      if (n.role === 2 || n.role === 3 || n.role === 4) routers++;
      // "Base station" = licensed amateur operator. Closest thing we model to a
      // fixed amateur radio station; the firmware doesn't expose a stricter
      // definition. (CLIENT_BASE role doesn't exist in our enum table yet.)
      if (n.isLicensed) baseStations++;
    }
    return {
      total: nodes.length,
      online, offline, favorites,
      withPosition,
      visible: visible.length,
      routers, baseStations,
    };
  }, [nodes, blockedNodeIds]);
  const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = React.useRef(false);

  // Fetch / refresh coverage data when the right panel is open AND its
  // coverage section is expanded, OR when heatmap mode is on (the heatmap
  // needs aggregates even if the section's collapsed). Auto-refreshes every
  // 30 s while one of those is true.
  React.useEffect(() => {
    const needsData = mapInfoOpen && (coverageSectionOpen || coverageHeatmap);
    if (!needsData) return;
    let cancelled = false;
    setCoverageLoading(true);
    meshDataService.getRangeTestCoverage(coverageWindowMs).then(d => {
      if (!cancelled) {
        setCoverageData(d);
        setCoverageLoading(false);
      }
    });
    const t = setInterval(() => {
      meshDataService.getRangeTestCoverage(coverageWindowMs).then(d => {
        if (!cancelled) setCoverageData(d);
      });
    }, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [mapInfoOpen, coverageSectionOpen, coverageHeatmap, coverageWindowMs]);

  // Derive center/zoom from node positions; re-center when the first position arrives
  const derivedCenter = React.useMemo<[number, number]>(() => {
    if (positioned.length === 0) return FALLBACK_CENTER;
    const lats = positioned.map(n => n.position!.lat);
    const lngs = positioned.map(n => n.position!.lng);
    return [
      (Math.min(...lats) + Math.max(...lats)) / 2,
      (Math.min(...lngs) + Math.max(...lngs)) / 2,
    ];
  }, [positioned.length]); // only recompute when count changes (new node arrives)

  const derivedZoom = React.useMemo(() => {
    if (positioned.length === 0) return FALLBACK_ZOOM;
    if (positioned.length === 1) return 13;
    // Rough zoom based on lat/lng span
    const lats = positioned.map(n => n.position!.lat);
    const lngs = positioned.map(n => n.position!.lng);
    const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs));
    if (span < 0.05) return 13;
    if (span < 0.2)  return 11;
    if (span < 1)    return 9;
    if (span < 5)    return 7;
    return 5;
  }, [positioned.length]);

  const [center, setCenter] = React.useState<[number, number]>(derivedCenter);
  const [zoom, setZoom] = React.useState(derivedZoom);

  // Snap to derived center the first time real positions arrive
  const hasSnapped = React.useRef(false);
  React.useEffect(() => {
    if (!hasSnapped.current && positioned.length > 0) {
      hasSnapped.current = true;
      setCenter(derivedCenter);
      setZoom(derivedZoom);
    }
  }, [derivedCenter, derivedZoom, positioned.length]);

  const popupNode = popupNodeId ? nodes.find(n => n.id === popupNodeId) ?? null : null;
  const popupWaypoint = popupWaypointId ? waypoints.find(w => w.id === popupWaypointId) ?? null : null;

  const localNodeNum = localNodeId ? nodeNumFromHex(localNodeId) : 0;
  const canEditWaypoint = (w: Waypoint): boolean => {
    if (!w.lockedTo) return true;
    return w.lockedTo === localNodeNum;
  };

  const mapBoxRef = React.useRef<HTMLDivElement | null>(null);

  /** Convert a pixel position inside the map box to lat/lng using Web Mercator. */
  const pixelToLatLng = (clientX: number, clientY: number): [number, number] | null => {
    const el = mapBoxRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const worldSize = 256 * Math.pow(2, zoom);
    const centerWorldX = ((center[1] + 180) / 360) * worldSize;
    const sinLat = Math.sin((center[0] * Math.PI) / 180);
    const centerWorldY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;
    const clickWorldX = centerWorldX + (px - rect.width / 2);
    const clickWorldY = centerWorldY + (py - rect.height / 2);
    const lng = (clickWorldX / worldSize) * 360 - 180;
    const n = Math.PI - 2 * Math.PI * (clickWorldY / worldSize);
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return [lat, lng];
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ll = pixelToLatLng(e.clientX, e.clientY);
    if (!ll) return;
    setPopupNodeId(null);
    setPopupWaypointId(null);
    setDropDraft({ lat: ll[0], lng: ll[1] });
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    longPressFiredRef.current = false;
    const t = e.touches[0];
    const cx = t.clientX, cy = t.clientY;
    longPressTimer.current = setTimeout(() => {
      const ll = pixelToLatLng(cx, cy);
      if (!ll) return;
      longPressFiredRef.current = true;
      setPopupNodeId(null);
      setPopupWaypointId(null);
      setDropDraft({ lat: ll[0], lng: ll[1] });
    }, 600);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const focusWaypoint = (w: Waypoint) => {
    setCenter([w.lat, w.lng]);
    if (zoom < 12) setZoom(12);
    setPopupWaypointId(w.id);
    setPopupNodeId(null);
  };

  return (
    <div className="h-full relative">
      <div
        ref={mapBoxRef}
        className="absolute inset-4 technical-panel z-0"
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <Map
          center={center}
          zoom={zoom}
          onBoundsChanged={({ center: c, zoom: z }) => { setCenter(c); setZoom(z); }}
          dprs={[1, 2]}
          onClick={() => {
            if (longPressFiredRef.current) {
              longPressFiredRef.current = false;
              return;
            }
            setPopupNodeId(null);
            setPopupWaypointId(null);
          }}
        >
          <ZoomControl />

          {/* Signal Layer (Actual Link Visualization) */}
          <MeshLinks nodes={nodes} />

          {/* Message Trace Layer */}
          <TraceLinks nodes={nodes} messages={messages} traceMessageId={traceMessageId} />

          {/* v2.1: when clusterMode is on, render a single pin per
              multi-member cluster at the centroid + suppress the
              individual markers for nodes that belong to those
              clusters. Singletons (size-1 clusters) still render as
              normal markers. Clicking a cluster pin re-pans to its
              centroid and zooms in one step so the operator can
              explode it. */}
          {clusterMode && clusterResult?.clusters
            .filter(c => c.count > 1)
            .map(c => (
              <Overlay key={`cluster:${c.id}`} anchor={[c.lat, c.lng]} offset={[24, 24]}>
                <button
                  type="button"
                  onClick={() => {
                    // Pan + zoom to the cluster centroid; pigeon-maps
                    // doesn't expose a setZoom prop directly, but the
                    // parent <Map>'s state-driven center prop picks up
                    // changes. The simplest "explode" gesture is to
                    // temporarily reduce eps via the toggle off-and-on.
                    setClusterMode(false);
                  }}
                  title={`Cluster of ${c.count} nodes near ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}. Click to disable clustering and see the individual pins.`}
                  className="w-12 h-12 rounded-full bg-brand-accent/30 hover:bg-brand-accent/45 border-2 border-brand-accent text-brand-ink font-bold text-xs flex items-center justify-center cursor-pointer transition-colors shadow-lg"
                >
                  {c.count}
                </button>
              </Overlay>
            ))}

          {nodes.filter(n => {
            if (!n.position || blockedNodeIds.has(n.id)) return false;
            // v2.1: suppress markers for nodes inside a multi-member
            // cluster while clusterMode is on. We keep singleton
            // clusters rendering as normal markers.
            if (clusterMode && clusterResult) {
              const cid = clusterResult.byNodeId.get(n.id);
              if (cid != null) {
                const cluster = clusterResult.clusters.find(c => c.id === cid);
                if (cluster && cluster.count > 1) return false;
              }
            }
            return true;
          }).map(node => {
            // Match the Meshtastic mobile clients: render the short name inside
            // the marker so each node is identifiable at a glance, no popup needed.
            const label = node.shortName || node.id.slice(-4).toUpperCase();
            const isOpen = popupNodeId === node.id;

            // Heatmap mode (when toggled on the coverage panel): recolor markers
            // by their avg Range-Test SNR instead of group/favorite/online status.
            // Senders we have observations for get a red→amber→emerald gradient;
            // senders we've never heard from over Range Test stay muted.
            const heatSnr = (coverageHeatmap && coverageData && 'aggregates' in coverageData)
              ? coverageData.aggregates.find(a => a.senderId === node.id)?.avgSnr ?? null
              : null;

            // Color priority: heatmap (when active) > assigned group > favorite > online > offline.
            // Operators with groups defined want to see their groupings at a glance;
            // the favorite star icon (rendered separately) carries the favorite signal.
            const group = node.groupId ? groups.find(g => g.id === node.groupId) : undefined;
            const groupRing = group ? hexToRgba(group.color, 0.95) : null;
            const groupFill = group ? hexToRgba(group.color, 0.18) : null;

            let ringColor: string;
            let fillColor: string;
            let textColor: string;

            if (coverageHeatmap) {
              if (heatSnr === null) {
                // Sender never heard via Range Test in this window — drop them to muted.
                ringColor = 'rgba(100, 116, 139, 0.55)';
                fillColor = 'rgba(30, 41, 59, 0.6)';
                textColor = '#94a3b8';
              } else if (heatSnr >= 5) {
                ringColor = 'rgba(16, 185, 129, 0.95)';   // emerald
                fillColor = 'rgba(16, 185, 129, 0.30)';
                textColor = '#34d399';
              } else if (heatSnr >= 0) {
                ringColor = 'rgba(245, 158, 11, 0.95)';   // amber
                fillColor = 'rgba(245, 158, 11, 0.30)';
                textColor = '#fbbf24';
              } else {
                ringColor = 'rgba(239, 68, 68, 0.95)';    // red
                fillColor = 'rgba(239, 68, 68, 0.28)';
                textColor = '#fca5a5';
              }
            } else {
              ringColor = groupRing
                ?? (node.favorite ? 'rgba(245, 158, 11, 0.95)'      // amber for favorites
                :   node.online   ? 'rgba(16, 185, 129, 0.95)'      // emerald for active
                :                   'rgba(100, 116, 139, 0.85)');   // slate for offline
              fillColor = groupFill
                ?? (node.favorite ? 'rgba(245, 158, 11, 0.18)'
                :   node.online   ? 'rgba(16, 185, 129, 0.18)'
                :                   'rgba(30, 41, 59, 0.85)');
              textColor = group?.color ?? (node.favorite ? '#fbbf24' : node.online ? '#34d399' : '#cbd5e1');
            }

            return (
              <Overlay key={node.id} anchor={[node.position!.lat, node.position!.lng]} offset={[18, 18]}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedNodeId(node.id);
                    setPopupWaypointId(null);
                    setPopupNodeId(prev => prev === node.id ? null : node.id);
                  }}
                  title={`${node.name}${node.shortName ? ` (${node.shortName})` : ''} · ${node.id}`}
                  className="flex items-center justify-center rounded-full font-bold mono-text transition-transform hover:scale-110 pointer-events-auto"
                  style={{
                    width: 36,
                    height: 36,
                    background: fillColor,
                    border: `2px solid ${ringColor}`,
                    color: textColor,
                    fontSize: label.length <= 2 ? '13px' : label.length <= 3 ? '11px' : '9px',
                    letterSpacing: '0.02em',
                    boxShadow: isOpen
                      ? `0 0 0 2px rgba(2,6,23,0.9), 0 0 0 4px ${ringColor}, 0 4px 12px rgba(0,0,0,0.5)`
                      : '0 2px 8px rgba(0,0,0,0.4)',
                    backdropFilter: 'blur(2px)',
                  }}
                >
                  {label}
                </button>
              </Overlay>
            );
          })}

          {/* Waypoint markers */}
          {waypoints.map(w => (
            <Overlay key={`wp-${w.id}`} anchor={[w.lat, w.lng]} offset={[14, 28]}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPopupNodeId(null);
                  setPopupWaypointId(prev => prev === w.id ? null : w.id);
                }}
                className="flex items-center justify-center w-7 h-7 rounded-full text-lg leading-none hover:scale-110 transition-transform pointer-events-auto"
                style={{
                  background: 'var(--color-brand-bg)',
                  border: '2px solid rgba(16,185,129,0.6)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                }}
                title={w.name || 'Waypoint'}
              >
                {codepointToEmoji(w.icon)}
              </button>
            </Overlay>
          ))}

          {/* Node info popup */}
          {popupNode?.position && (
            <Overlay anchor={[popupNode.position.lat, popupNode.position.lng]} offset={[0, 0]}>
              <NodePopup
                node={popupNode}
                nodes={nodes}
                onClose={() => setPopupNodeId(null)}
                onDirectMessage={id => { onDirectMessage(id); setPopupNodeId(null); }}
                onTraceroute={onTraceroute}
                onShareContact={(n) => { setQrNode(n); setPopupNodeId(null); }}
                onBlock={onBlockNode}
                onUnblock={onUnblockNode}
                onToggleFavorite={(id, fav) => { onToggleFavorite(id, fav); }}
                isBlocked={blockedNodeIds.has(popupNode.id)}
                trace={
                  traces
                    .filter(t => t.targetId === popupNode.id)
                    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
                }
                neighbors={neighborInfo.find(n => n.fromNodeId === popupNode.id) ?? null}
                sfRouter={storeForwardRouters.find(r => r.nodeId === popupNode.id) ?? null}
                onRequestHistory={onRequestStoreForwardHistory}
                canTrace={dataSource === 'live'}
                unitSystem={unitSystem}
                groups={groups}
                onAssignGroup={onAssignGroup}
              />
            </Overlay>
          )}

          {/* Waypoint popup */}
          {popupWaypoint && (
            <Overlay anchor={[popupWaypoint.lat, popupWaypoint.lng]} offset={[0, 0]}>
              <WaypointPopup
                waypoint={popupWaypoint}
                canEdit={canEditWaypoint(popupWaypoint)}
                onClose={() => setPopupWaypointId(null)}
                onEdit={() => {
                  setEditingWaypoint(popupWaypoint);
                  setPopupWaypointId(null);
                }}
              />
            </Overlay>
          )}
        </Map>
      </div>

      {/* Right slide-out: mesh stats + Range Test coverage + map legend */}
      <div
        className="absolute top-4 bottom-4 right-4 z-20 flex pointer-events-none"
        style={{ transform: mapInfoOpen ? 'translateX(0)' : 'translateX(calc(100% - 28px))', transition: 'transform 250ms ease' }}
      >
        {/* Vertical edge tab — toggles the panel open/closed */}
        <button
          onClick={() => setMapInfoOpen(o => !o)}
          title={mapInfoOpen ? 'Hide map info panel' : 'Show map info panel'}
          className="self-start mt-3 mr-1 pointer-events-auto rounded-l border-y border-l border-brand-line bg-brand-bg/95 backdrop-blur-md hover:border-brand-accent/50 hover:bg-brand-line/40 transition-colors"
          style={{ width: 22, height: 56 }}
        >
          <ChevronRight
            size={14}
            className={cn('mx-auto text-brand-muted transition-transform', mapInfoOpen ? 'rotate-0' : 'rotate-180')}
          />
        </button>

        {/* Panel body */}
        <div
          className="pointer-events-auto rounded-lg border border-brand-line overflow-hidden flex flex-col bg-brand-bg/95 backdrop-blur-md shadow-xl"
          style={{ width: 360 }}
        >
          {/* Header */}
          <div className="px-3 py-2 border-b border-brand-line flex items-center justify-between bg-brand-line/30">
            <div className="flex items-center gap-2">
              <Activity size={13} className="text-brand-accent" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand-ink">Mesh Status</span>
            </div>
            <span className="text-[9px] mono-text text-brand-muted">
              {meshStats.visible} on map · {meshStats.total} known
            </span>
          </div>

          <div className="flex-1 overflow-y-auto">

            {/* Mesh stats — always visible at top, no collapse */}
            <div className="px-3 py-3 border-b border-brand-line space-y-2">
              <div className="grid grid-cols-3 gap-2 text-center">
                <StatTile label="Total" value={meshStats.total} tone="ink" />
                <StatTile label="Online" value={meshStats.online} tone="accent" />
                <StatTile label="Offline" value={meshStats.offline} tone="muted" />
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <StatTile label="Routers" value={meshStats.routers} tone="info" hint="Visible on map · role = Router/Repeater" />
                <StatTile label="Base stns" value={meshStats.baseStations} tone="warning" hint="Visible on map · licensed amateur operators (LIC badge)" />
                <StatTile label="Favorites" value={meshStats.favorites} tone="warning" />
              </div>
              <p className="text-[9px] text-brand-muted leading-snug pt-1">
                "Routers" and "Base stns" reflect what's visible on the map (positioned + not blocked). Total / Online / Offline cover every node we know about, including those without a position.
              </p>
            </div>

            {/* Range Test Coverage section */}
            <div className="border-b border-brand-line">
              <button
                onClick={() => setCoverageSectionOpen(o => !o)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-brand-line/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Activity size={12} className="text-brand-accent" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-brand-ink">Range Test Coverage</span>
                  {coverageData && 'aggregates' in coverageData && (
                    <span className="text-[10px] mono-text text-brand-muted bg-brand-line px-1.5 py-0.5 rounded">
                      {coverageData.aggregates.length}
                    </span>
                  )}
                </div>
                <ChevronDown
                  size={13}
                  className={cn('text-brand-muted transition-transform', coverageSectionOpen ? 'rotate-180' : '')}
                />
              </button>

              {coverageSectionOpen && (
                <div className="border-t border-brand-line">
                  <div className="px-3 py-2 border-b border-brand-line bg-brand-surface/40 flex items-center gap-2">
                    <span className="text-[9px] uppercase font-bold text-brand-muted tracking-widest">Window</span>
                    <select
                      value={coverageWindowMs}
                      onChange={e => setCoverageWindowMs(parseInt(e.target.value, 10))}
                      className="flex-1 bg-brand-line text-[10px] mono-text rounded px-2 py-1 border border-brand-line hover:border-brand-muted focus:outline-none focus:border-brand-accent/50"
                    >
                      <option value={3600 * 1000}>Last 1 hour</option>
                      <option value={6 * 3600 * 1000}>Last 6 hours</option>
                      <option value={24 * 3600 * 1000}>Last 24 hours</option>
                      <option value={7 * 24 * 3600 * 1000}>Last 7 days</option>
                      <option value={0}>All time</option>
                    </select>
                    {coverageLoading && <Loader2 size={10} className="animate-spin text-brand-muted" />}
                  </div>

                  <div className="px-3 py-2 border-b border-brand-line bg-brand-surface/40">
                    <label className="flex items-center justify-between gap-2 cursor-pointer">
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase font-bold tracking-widest text-brand-ink">Heatmap mode</p>
                        <p className="text-[9px] text-brand-muted leading-snug">
                          Recolor map markers by avg SNR. Senders not heard via Range Test in this window are dimmed.
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={coverageHeatmap}
                        onChange={e => setCoverageHeatmap(e.target.checked)}
                        className="w-4 h-4 accent-emerald-500 shrink-0"
                      />
                    </label>
                    {coverageHeatmap && (
                      <div className="mt-2 flex items-center gap-3 text-[9px] mono-text">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-brand-accent"></span>≥ 5 dB</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-brand-warning"></span>0–5 dB</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-brand-error"></span>{'< 0 dB'}</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-brand-muted/50"></span>none</span>
                      </div>
                    )}

                    {/* v2.1: GPU/CPU spatial clustering toggle. Routes
                        through the sidecar so the operator can see which
                        backend handled it (cuML on Orin, CPU otherwise).
                        epsMeters=80 collapses markers within a city block. */}
                    <label className="flex items-start justify-between gap-3 pt-3 border-t border-brand-line/60 cursor-pointer">
                      <div className="flex-1">
                        <p className="text-[10px] uppercase font-bold tracking-widest text-brand-ink">Cluster pins</p>
                        <p className="text-[9px] text-brand-muted leading-snug">
                          DBSCAN-collapse markers within ~80m so dense areas (city centers, repeater clusters) read as one pin with a count.
                          {clusterResult && (
                            <span className="ml-1 inline-flex items-center gap-1 px-1 py-0.5 rounded border border-brand-line/60 text-brand-muted">
                              backend: <span className="text-brand-accent mono-text">{clusterResult.backend}</span>
                            </span>
                          )}
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={clusterMode}
                        onChange={e => setClusterMode(e.target.checked)}
                        className="w-4 h-4 accent-emerald-500 shrink-0"
                      />
                    </label>
                  </div>

                  {!coverageData ? (
                    <div className="px-3 py-3 text-[10px] text-brand-muted">Loading…</div>
                  ) : 'error' in coverageData ? (
                    <div className="px-3 py-3 text-[10px] text-brand-error">Coverage fetch failed: {coverageData.error}</div>
                  ) : coverageData.aggregates.length === 0 ? (
                    <div className="px-3 py-4 text-center">
                      <p className="text-[10px] text-brand-muted leading-relaxed">
                        No Range Test packets observed in this window.<br />
                        <span className="text-brand-muted">Have any meshmates configured to send Range Test? See Settings → Modules → Range Test.</span>
                      </p>
                    </div>
                  ) : (
                    <div className="max-h-72 overflow-y-auto">
                      {[...coverageData.aggregates].sort((a, b) => b.count - a.count).map(agg => {
                        const node = nodes.find(n => n.id === agg.senderId);
                        const senderName = node?.shortName || node?.name || agg.senderId.slice(-4).toUpperCase();
                        const fullName = node?.name ?? agg.senderId;
                        const snr = agg.avgSnr;
                        const snrColor = snr == null
                          ? 'text-brand-muted'
                          : snr >= 5  ? 'text-brand-accent'
                          : snr >= 0  ? 'text-brand-warning'
                          : 'text-brand-error';
                        const minutesAgo = Math.round((Date.now() - agg.lastSeen) / 60000);
                        const ageLabel = minutesAgo < 1 ? 'just now'
                          : minutesAgo < 60 ? `${minutesAgo}m`
                          : minutesAgo < 1440 ? `${Math.floor(minutesAgo / 60)}h`
                          : `${Math.floor(minutesAgo / 1440)}d`;
                        const hasPos = agg.lastLat != null && agg.lastLng != null;
                        return (
                          <div
                            key={agg.senderId}
                            className="px-3 py-2 hover:bg-brand-line/60 border-b border-brand-line/50 last:border-b-0 transition-colors"
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <button
                                onClick={() => {
                                  if (hasPos) {
                                    setCenter([agg.lastLat!, agg.lastLng!]);
                                    if (zoom < 11) setZoom(13);
                                    setPopupNodeId(agg.senderId);
                                  }
                                }}
                                disabled={!hasPos}
                                title={hasPos ? `Center map on ${fullName}` : 'No position known for this sender'}
                                className="flex items-center gap-1.5 text-left flex-1 min-w-0 disabled:cursor-not-allowed"
                              >
                                <span className="text-[9px] mono-text text-brand-accent bg-brand-accent/10 border border-brand-accent/30 px-1 py-0.5 rounded shrink-0">
                                  {(node?.shortName || senderName).slice(0, 4)}
                                </span>
                                <span className="text-xs font-semibold text-brand-ink truncate">{fullName}</span>
                                {hasPos && <ChevronRight size={11} className="text-brand-muted shrink-0" />}
                              </button>
                            </div>
                            <div className="grid grid-cols-4 gap-2 text-[10px] mono-text pl-1">
                              <span className="text-brand-muted">×{agg.count}</span>
                              <span className={snrColor}>
                                {snr != null ? `${snr.toFixed(1)} dB` : 'no SNR'}
                              </span>
                              <span className="text-brand-muted">
                                {agg.avgRssi != null ? `${Math.round(agg.avgRssi)} dBm` : '-'}
                              </span>
                              <span className="text-brand-muted text-right">{ageLabel}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Waypoints section */}
            <div className="border-b border-brand-line">
              <button
                onClick={() => setWaypointsSectionOpen(o => !o)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-brand-line/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <MapPin size={12} className="text-brand-accent" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-brand-ink">Waypoints</span>
                  <span className="text-[10px] mono-text text-brand-muted bg-brand-line px-1.5 py-0.5 rounded">
                    {waypoints.length}
                  </span>
                </div>
                <ChevronDown
                  size={13}
                  className={cn('text-brand-muted transition-transform', waypointsSectionOpen ? 'rotate-180' : '')}
                />
              </button>

              {waypointsSectionOpen && (
                <div className="border-t border-brand-line">
                  {waypoints.length === 0 ? (
                    <div className="px-3 py-4 text-center">
                      <p className="text-[10px] text-brand-muted leading-relaxed">
                        No waypoints yet.<br />
                        <span className="text-brand-muted">Right-click the map to drop one.</span>
                      </p>
                    </div>
                  ) : (
                    <div className="max-h-72 overflow-y-auto">
                      {waypoints.map(w => (
                        <button
                          key={w.id}
                          onClick={() => focusWaypoint(w)}
                          className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-brand-line/60 border-b border-brand-line/50 last:border-b-0 transition-colors text-left"
                        >
                          <span className="text-lg flex-shrink-0">{codepointToEmoji(w.icon)}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-brand-ink truncate">
                              {w.name || 'Untitled'}
                              {w.lockedTo > 0 && <Lock size={9} className="inline ml-1 text-brand-accent/60" />}
                            </p>
                            <p className="text-[9px] mono-text text-brand-muted truncate">{formatExpiresIn(w.expire)}</p>
                          </div>
                          <ChevronRight size={11} className="text-brand-muted flex-shrink-0" />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="px-3 py-2 border-t border-brand-line bg-brand-surface/40">
                    <p className="text-[9px] text-brand-muted leading-tight">
                      <span className="text-brand-muted">Tip:</span> right-click (or long-press on touch) anywhere on the map to drop a new waypoint.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Map Legend section */}
            <div>
              <button
                onClick={() => setLegendSectionOpen(o => !o)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-brand-line/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <MapPin size={12} className="text-brand-accent" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-brand-ink">Map Legend</span>
                </div>
                <ChevronDown
                  size={13}
                  className={cn('text-brand-muted transition-transform', legendSectionOpen ? 'rotate-180' : '')}
                />
              </button>

              {legendSectionOpen && (
                <div className="border-t border-brand-line p-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 rounded-full bg-brand-accent status-glow-green" />
                    <span className="text-xs uppercase mono-text text-brand-ink">Active Node</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 rounded-full bg-brand-warning status-glow-amber" />
                    <span className="text-xs uppercase mono-text text-brand-ink">Favorite Node</span>
                  </div>
                  <div className="pt-2 border-t border-brand-line space-y-2">
                    <p className="text-[10px] font-bold uppercase text-brand-muted tracking-widest">Signal Quality (RSSI)</p>
                    {traceMessageId && (
                      <div className="p-2 bg-brand-accent/5 border border-brand-accent/20 rounded animate-pulse mb-2">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[9px] font-bold text-brand-accent uppercase">Active Trace</p>
                          <button
                            onClick={() => setTraceMessageId(null)}
                            className="text-[8px] text-brand-muted hover:text-brand-ink"
                          >
                            [DISMISS]
                          </button>
                        </div>
                        <p className="text-[8px] mono-text truncate opacity-70 text-brand-ink">MSG ID: {traceMessageId}</p>
                      </div>
                    )}
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-0.5 bg-brand-accent" />
                        <span className="text-[9px] mono-text text-brand-ink">EXCELLENT ({">"}-70dBm)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-0.5 bg-brand-warning" />
                        <span className="text-[9px] mono-text text-brand-ink">GOOD (-70 to -90dBm)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-0.5 bg-brand-error" />
                        <span className="text-[9px] mono-text text-brand-ink">WEAK ({"<"}-90dBm)</span>
                      </div>
                    </div>
                  </div>
                  {groups.length > 0 && (
                    <div className="pt-2 border-t border-brand-line space-y-2">
                      <p className="text-[10px] font-bold uppercase text-brand-muted tracking-widest">Active Groups</p>
                      {groups.map(g => (
                        <div key={g.id} className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: g.color }} />
                          <span className="text-[10px] mono-text text-brand-ink">{g.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Drop / edit modal — lazy-loaded; the emoji picker is heavy */}
      {(dropDraft || editingWaypoint) && (
        <React.Suspense fallback={null}>
        <WaypointEditorModal
          isEditing={!!editingWaypoint}
          initial={
            editingWaypoint
              ? {
                  id: editingWaypoint.id,
                  lat: editingWaypoint.lat,
                  lng: editingWaypoint.lng,
                  name: editingWaypoint.name,
                  description: editingWaypoint.description,
                  icon: editingWaypoint.icon,
                  expire: editingWaypoint.expire,
                  lockedToSelf: editingWaypoint.lockedTo > 0 && editingWaypoint.lockedTo === localNodeNum,
                }
              : { lat: dropDraft!.lat, lng: dropDraft!.lng }
          }
          onSave={async (data) => {
            await onSaveWaypoint(data);
            setDropDraft(null);
            setEditingWaypoint(null);
          }}
          onDelete={editingWaypoint ? async () => {
            await onDeleteWaypoint(editingWaypoint.id);
            setEditingWaypoint(null);
          } : undefined}
          onClose={() => {
            setDropDraft(null);
            setEditingWaypoint(null);
          }}
        />
        </React.Suspense>
      )}

      {qrNode && <ContactQrModal node={qrNode} onClose={() => setQrNode(null)} />}
    </div>
  );
}
