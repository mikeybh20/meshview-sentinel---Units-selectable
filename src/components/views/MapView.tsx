import React from 'react';
import { Signal, X, MessageSquare, Battery, MapPin, Wifi, Clock, Plus, Edit3, Lock, Trash2, ChevronRight, Route, Loader2, Network, QrCode, Ban, Undo2, History, Server, Star } from 'lucide-react';
import { Map, ZoomControl, Overlay } from "pigeon-maps";

import { Node, Message, Group, UnitSystem, Waypoint, TraceResult, NeighborInfoSnapshot, StoreForwardRouter } from '../../types';
import { MeshLinks } from '../ui/MeshLinks';
import { TraceLinks } from '../ui/TraceLinks';
import { WaypointEditorModal } from '../WaypointEditorModal';
import { ContactQrModal } from '../ContactQrModal';
import { roleLabel, hardwareLabel, ROLE_SHORT } from '../../lib/meshEnums';
import { hexToRgba } from '../../lib/color';

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
    : rssi > -70 ? 'text-emerald-400'
    : rssi > -90 ? 'text-amber-400'
    : 'text-red-400';

  return (
    <div
      className="rounded-lg border border-emerald-500/40 p-3 w-64 pointer-events-auto"
      style={{
        transform: 'translate(-50%, calc(-100% - 36px))',
        position: 'absolute',
        background: '#020617',
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
          background: '#020617',
          borderRight: '1px solid rgba(16,185,129,0.4)',
          borderBottom: '1px solid rgba(16,185,129,0.4)',
        }}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${node.online ? 'bg-emerald-400' : 'bg-slate-500'}`} />
            <span className="text-xs font-bold text-white truncate">{node.name}</span>
            {node.shortName && (
              <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/15 px-1 py-0.5 rounded flex-shrink-0">
                {node.shortName}
              </span>
            )}
            {node.publicKey && (
              <span
                className="flex items-center gap-0.5 text-[9px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 px-1 py-0.5 rounded flex-shrink-0"
                title="This node supports PKC-encrypted DMs (Curve25519 public key advertised)"
              >
                <Lock size={8} />
                PKC
              </span>
            )}
            {sfRouter && (
              <span
                className="flex items-center gap-0.5 text-[9px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1 py-0.5 rounded flex-shrink-0"
                title={`Store & Forward router (heartbeat every ${sfRouter.periodSecs}s${sfRouter.isSecondary ? ', secondary' : ''})`}
              >
                <Server size={8} />
                S&amp;F
              </span>
            )}
            {node.role !== undefined && node.role !== 0 && ROLE_SHORT[node.role] && (
              <span
                className="text-[9px] font-bold mono-text text-slate-300 bg-slate-700/50 border border-slate-600 px-1 py-0.5 rounded flex-shrink-0"
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
                className="text-[9px] font-bold mono-text text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 px-1 py-0.5 rounded flex-shrink-0"
                title="Last seen via MQTT bridge — not a direct LoRa peer"
              >
                MQTT
              </span>
            )}
          </div>
          <p className="text-[9px] mono-text text-slate-400 mt-0.5">
            {node.id}
            {hardwareLabel(node.hwModel) && (
              <span className="text-slate-500"> · {hardwareLabel(node.hwModel)}</span>
            )}
          </p>
        </div>
        <div className="flex items-start gap-1 flex-shrink-0 ml-1 mt-0.5">
          <button
            onClick={() => onToggleFavorite(node.id, !node.favorite)}
            title={node.favorite ? 'Remove from favorites' : 'Mark as favorite'}
            className={`transition-colors ${node.favorite ? 'text-amber-400 hover:text-amber-300' : 'text-slate-500 hover:text-amber-400'}`}
          >
            <Star size={12} fill={node.favorite ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Telemetry grid */}
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        <div className="bg-slate-800/80 border border-slate-700 rounded p-1.5">
          <div className="flex items-center gap-1 mb-0.5">
            <Wifi size={9} className="text-slate-400" />
            <span className="text-[8px] uppercase text-slate-400 font-semibold">RSSI</span>
          </div>
          <span className={`text-[11px] font-bold mono-text ${rssiColor}`}>
            {rssi !== undefined ? `${rssi} dBm` : '—'}
          </span>
        </div>
        <div className="bg-slate-800/80 border border-slate-700 rounded p-1.5">
          <div className="flex items-center gap-1 mb-0.5">
            <Signal size={9} className="text-slate-400" />
            <span className="text-[8px] uppercase text-slate-400 font-semibold">SNR</span>
          </div>
          <span className="text-[11px] font-bold mono-text text-white">
            {snr !== undefined ? `${snr} dB` : '—'}
          </span>
        </div>
        <div className="bg-slate-800/80 border border-slate-700 rounded p-1.5">
          <div className="flex items-center gap-1 mb-0.5">
            <Battery size={9} className="text-slate-400" />
            <span className="text-[8px] uppercase text-slate-400 font-semibold">Battery</span>
          </div>
          <span className={`text-[11px] font-bold mono-text ${battery !== undefined && battery < 20 ? 'text-red-400' : 'text-white'}`}>
            {battery !== undefined ? `${battery}%` : '—'}
          </span>
        </div>
        <div className="bg-slate-800/80 border border-slate-700 rounded p-1.5">
          <div className="flex items-center gap-1 mb-0.5">
            <MapPin size={9} className="text-slate-400" />
            <span className="text-[8px] uppercase text-slate-400 font-semibold">Dist</span>
          </div>
          <span className="text-[11px] font-bold mono-text text-white">
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
        <div className="bg-slate-800/60 border border-slate-700/50 rounded px-2 py-1 mb-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[9px] mono-text text-slate-300 truncate">
              {node.position.lat.toFixed(5)}, {node.position.lng.toFixed(5)}
              {node.position.alt > 0 && ` · ${node.position.alt}m`}
            </p>
            {node.positionSource && (
              <span
                className={`text-[8px] uppercase font-bold mono-text px-1 py-0.5 rounded flex-shrink-0 ${
                  node.positionSource === 'manual'
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
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
            <p className="text-[8px] mono-text text-slate-500 mt-0.5" title="Channel-limited position precision">
              Precision: {node.positionPrecisionBits} bits (privacy-reduced)
            </p>
          )}
        </div>
      )}

      {/* Last seen */}
      <div className="flex items-center gap-1 mb-2">
        <Clock size={9} className="text-slate-400" />
        <span className="text-[9px] mono-text text-slate-300">{formatLastSeen(node.lastSeen)}</span>
      </div>

      {/* NeighborInfo panel — what direct neighbors this node has reported */}
      {neighbors && neighbors.neighbors.length > 0 && (
        <div className="mb-2 bg-slate-800/40 border border-slate-700/50 rounded p-2">
          <div className="flex items-center gap-1 mb-1">
            <Network size={10} className="text-emerald-400" />
            <span className="text-[9px] uppercase font-semibold text-slate-400">
              Reports {neighbors.neighbors.length} neighbor{neighbors.neighbors.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="space-y-0.5">
            {neighbors.neighbors.slice(0, 5).map((n, i) => {
              const peer = nodes.find(x => x.id === n.nodeId);
              const label = peer?.shortName || peer?.name || n.nodeId.slice(-4);
              const snrColor = n.snr > 5 ? 'text-emerald-400' : n.snr > -5 ? 'text-amber-400' : 'text-red-400';
              return (
                <div key={i} className="flex items-center justify-between text-[10px] mono-text">
                  <span className="text-slate-200 truncate">{label}</span>
                  <span className={snrColor}>{n.snr.toFixed(1)}dB</span>
                </div>
              );
            })}
            {neighbors.neighbors.length > 5 && (
              <p className="text-[9px] text-slate-500 italic">+{neighbors.neighbors.length - 5} more</p>
            )}
          </div>
        </div>
      )}

      {/* Trace result panel (shown if there's a trace for this node) */}
      {trace && (
        <div className="mb-2 bg-slate-800/40 border border-slate-700/50 rounded p-2">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1">
              <Route size={10} className="text-emerald-400" />
              <span className="text-[9px] uppercase font-semibold text-slate-400">Last Trace</span>
            </div>
            <span className={`text-[8px] uppercase font-bold ${
              trace.status === 'response' ? 'text-emerald-400'
              : trace.status === 'pending' ? 'text-amber-400'
              : trace.status === 'timeout' ? 'text-slate-500'
              : 'text-red-400'
            }`}>
              {trace.status === 'response' ? 'OK' : trace.status === 'pending' ? 'Tracing...' : trace.status}
            </span>
          </div>

          {trace.status === 'pending' && (
            <p className="text-[9px] text-slate-400 italic">Awaiting response from {nodeLabel(trace.targetId)}…</p>
          )}

          {trace.status === 'response' && (
            <div className="space-y-1">
              <div>
                <p className="text-[8px] uppercase font-semibold text-slate-500 mb-0.5">Outbound</p>
                <p className="text-[10px] mono-text text-slate-200 break-all leading-snug">
                  {trace.route.length === 0
                    ? <span className="text-slate-400">direct → {nodeLabel(trace.targetId)}</span>
                    : trace.route.map((h, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-slate-500"> → </span>}
                          <span>{nodeLabel(h.nodeId)}</span>
                          {h.snr !== undefined && <span className="text-slate-500"> ({h.snr.toFixed(1)}dB)</span>}
                        </span>
                      ))
                  }
                </p>
              </div>
              {trace.routeBack.length > 0 && (
                <div>
                  <p className="text-[8px] uppercase font-semibold text-slate-500 mb-0.5">Return</p>
                  <p className="text-[10px] mono-text text-slate-200 break-all leading-snug">
                    {trace.routeBack.map((h, i) => (
                      <span key={i}>
                        {i > 0 && <span className="text-slate-500"> → </span>}
                        <span>{nodeLabel(h.nodeId)}</span>
                        {h.snr !== undefined && <span className="text-slate-500"> ({h.snr.toFixed(1)}dB)</span>}
                      </span>
                    ))}
                  </p>
                </div>
              )}
            </div>
          )}

          {trace.status === 'timeout' && (
            <p className="text-[9px] text-slate-400">{trace.errorMessage || 'No response'}</p>
          )}

          {trace.status === 'error' && trace.errorMessage && (
            <p className="text-[9px] text-red-400">{trace.errorMessage}</p>
          )}
        </div>
      )}

      {traceError && (
        <p className="mb-2 text-[9px] text-red-400">{traceError}</p>
      )}

      {/* Store & Forward router controls */}
      {sfRouter && (
        <div className="mb-2 bg-amber-500/5 border border-amber-500/20 rounded p-2">
          <div className="flex items-center gap-1 mb-1.5">
            <Server size={10} className="text-amber-400" />
            <span className="text-[9px] uppercase font-semibold text-amber-300">Store &amp; Forward Router</span>
          </div>
          <div className="grid grid-cols-2 gap-1 text-[10px] mono-text mb-1.5">
            <div>
              <span className="text-slate-400">Period: </span>
              <span className="text-slate-200">{sfRouter.periodSecs}s</span>
            </div>
            <div>
              <span className="text-slate-400">Type: </span>
              <span className="text-slate-200">{sfRouter.isSecondary ? 'Secondary' : 'Primary'}</span>
            </div>
            {sfRouter.stats?.messagesSaved !== undefined && (
              <div>
                <span className="text-slate-400">Saved: </span>
                <span className="text-slate-200">
                  {sfRouter.stats.messagesSaved}
                  {sfRouter.stats.messagesMax ? ` / ${sfRouter.stats.messagesMax}` : ''}
                </span>
              </div>
            )}
            {sfRouter.stats?.upTimeSecs !== undefined && (
              <div>
                <span className="text-slate-400">Uptime: </span>
                <span className="text-slate-200">{Math.floor(sfRouter.stats.upTimeSecs / 60)}m</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 mb-1">
            <select
              value={sfWindow}
              onChange={e => setSfWindow(parseInt(e.target.value, 10))}
              className="flex-1 bg-slate-800 border border-slate-700 rounded text-[10px] mono-text text-slate-200 px-1.5 py-1 focus:outline-none focus:border-amber-500/50"
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
              className="flex items-center gap-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 hover:text-amber-200 text-[9px] font-bold uppercase tracking-widest rounded px-2 py-1 transition-colors disabled:opacity-50"
            >
              {sfBusy ? <Loader2 size={10} className="animate-spin" /> : <History size={10} />}
              {sfBusy ? '...' : 'Replay'}
            </button>
          </div>

          {sfStatus && (
            <p className={`text-[9px] mt-1 leading-snug ${sfStatus.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
              {sfStatus.text}
            </p>
          )}
        </div>
      )}

      {/* Group assignment */}
      {groups.length > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[9px] uppercase font-bold text-slate-400 flex-shrink-0">Group</span>
          <select
            value={node.groupId ?? ''}
            onChange={(e) => onAssignGroup(node.id, e.target.value || undefined)}
            className="flex-1 bg-slate-800 border border-slate-700 rounded text-[11px] mono-text text-slate-200 px-1.5 py-0.5 focus:outline-none focus:border-emerald-500/50"
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
        <div className="mb-2 flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded p-2">
          <Ban size={12} className="text-red-400 flex-shrink-0" />
          <p className="text-[10px] text-red-300 leading-tight">
            <span className="font-bold uppercase tracking-wide">Blocked</span> — messages from this node are hidden.
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="grid grid-cols-3 gap-1.5">
        <button
          onClick={() => onDirectMessage(node.id)}
          disabled={isBlocked}
          className="flex items-center justify-center gap-1 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 hover:text-emerald-200 text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <MessageSquare size={11} />
          DM
        </button>
        <button
          onClick={handleTrace}
          disabled={!canTrace || buttonBusy}
          title={!canTrace ? 'Switch to live radio to traceroute' : 'Discover the path to this node'}
          className="flex items-center justify-center gap-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 hover:border-emerald-500/50 text-slate-300 hover:text-white text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
          className="flex items-center justify-center gap-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 hover:border-emerald-500/50 text-slate-300 hover:text-white text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors"
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
            ? 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-slate-300 hover:text-white'
            : 'bg-transparent hover:bg-red-500/10 border-slate-700 hover:border-red-500/40 text-slate-500 hover:text-red-300'
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
      className="rounded-lg border border-emerald-500/40 p-3 w-56 pointer-events-auto"
      style={{
        transform: 'translate(-50%, calc(-100% - 28px))',
        position: 'absolute',
        whiteSpace: 'nowrap',
        background: '#020617',
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
          background: '#020617',
          borderRight: '1px solid rgba(16,185,129,0.4)',
          borderBottom: '1px solid rgba(16,185,129,0.4)',
        }}
      />

      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xl flex-shrink-0">{codepointToEmoji(waypoint.icon)}</span>
          <div className="min-w-0">
            <p className="text-xs font-bold text-white truncate">
              {waypoint.name || 'Untitled waypoint'}
              {waypoint.lockedTo > 0 && <Lock size={9} className="inline ml-1 text-emerald-400/70" />}
            </p>
            <p className="text-[9px] mono-text text-slate-400">{formatExpiresIn(waypoint.expire)}</p>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white flex-shrink-0 ml-1 mt-0.5">
          <X size={12} />
        </button>
      </div>

      {waypoint.description && (
        <p className="text-[11px] text-slate-200 mb-2 whitespace-normal break-words leading-snug">
          {waypoint.description}
        </p>
      )}

      <div className="bg-slate-800/60 border border-slate-700/50 rounded px-2 py-1 mb-2">
        <p className="text-[9px] mono-text text-slate-300">
          {waypoint.lat.toFixed(5)}, {waypoint.lng.toFixed(5)}
        </p>
      </div>

      {waypoint.createdBy && (
        <p className="text-[9px] mono-text text-slate-400 mb-2">Placed by {waypoint.createdBy}</p>
      )}

      {canEdit ? (
        <button
          onClick={onEdit}
          className="w-full flex items-center justify-center gap-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 hover:text-emerald-200 text-[10px] font-bold uppercase tracking-widest rounded py-1.5 transition-colors"
        >
          <Edit3 size={11} />
          Edit
        </button>
      ) : (
        <div className="text-center text-[9px] text-slate-500 py-1 border-t border-slate-800">
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
  const [waypointPanelOpen, setWaypointPanelOpen] = React.useState(false);
  const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = React.useRef(false);

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

          {nodes.filter(n => n.position && !blockedNodeIds.has(n.id)).map(node => {
            // Match the Meshtastic mobile clients: render the short name inside
            // the marker so each node is identifiable at a glance, no popup needed.
            const label = node.shortName || node.id.slice(-4).toUpperCase();
            const isOpen = popupNodeId === node.id;

            // Color priority: assigned group > favorite > online > offline.
            // Operators with groups defined want to see their groupings at a glance;
            // the favorite star icon (rendered separately) carries the favorite signal.
            const group = node.groupId ? groups.find(g => g.id === node.groupId) : undefined;
            const groupRing = group ? hexToRgba(group.color, 0.95) : null;
            const groupFill = group ? hexToRgba(group.color, 0.18) : null;
            const ringColor = groupRing
              ?? (node.favorite ? 'rgba(245, 158, 11, 0.95)'      // amber for favorites
              :   node.online   ? 'rgba(16, 185, 129, 0.95)'      // emerald for active
              :                   'rgba(100, 116, 139, 0.85)');   // slate for offline
            const fillColor = groupFill
              ?? (node.favorite ? 'rgba(245, 158, 11, 0.18)'
              :   node.online   ? 'rgba(16, 185, 129, 0.18)'
              :                   'rgba(30, 41, 59, 0.85)');
            const textColor = group?.color ?? (node.favorite ? '#fbbf24' : node.online ? '#34d399' : '#cbd5e1');

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
                  background: '#020617',
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

      {/* Map Legend Overlay */}
      <div className="absolute top-8 right-8 w-64 technical-panel p-4 bg-brand-bg/90 backdrop-blur-md pointer-events-auto">
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-brand-muted mb-3">Map Legend</h4>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-brand-accent status-glow-green" />
              <span className="text-xs uppercase mono-text">Active Node</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-brand-warning status-glow-amber" />
              <span className="text-xs uppercase mono-text">Favorite Node</span>
            </div>
            <div className="pt-2 border-t border-brand-line space-y-2">
               <p className="text-[10px] font-bold uppercase text-brand-muted tracking-widest">Signal Quality (RSSI)</p>
               {traceMessageId && (
                 <div className="p-2 bg-brand-accent/5 border border-brand-accent/20 rounded-lg animate-pulse mb-2">
                   <div className="flex items-center justify-between mb-1">
                     <p className="text-[9px] font-bold text-brand-accent uppercase">Active Trace</p>
                     <button
                       onClick={() => setTraceMessageId(null)}
                       className="text-[8px] text-brand-muted hover:text-white"
                     >
                       [DISMISS]
                     </button>
                   </div>
                   <p className="text-[8px] mono-text truncate opacity-70">MSG ID: {traceMessageId}</p>
                 </div>
               )}
               <div className="space-y-1">
                  <div className="flex items-center gap-2">
                     <div className="w-4 h-0.5 bg-emerald-500" />
                     <span className="text-[9px] mono-text">EXCELLENT ({">"}-70dBm)</span>
                  </div>
                  <div className="flex items-center gap-2">
                     <div className="w-4 h-0.5 bg-amber-500" />
                     <span className="text-[9px] mono-text">GOOD (-70 to -90dBm)</span>
                  </div>
                  <div className="flex items-center gap-2">
                     <div className="w-4 h-0.5 bg-red-500" />
                     <span className="text-[9px] mono-text">WEAK ({"<"}-90dBm)</span>
                  </div>
               </div>
            </div>
            {groups.length > 0 && (
              <div className="pt-2 mt-2 border-t border-brand-line space-y-2">
                 <p className="text-[10px] font-bold uppercase text-brand-muted tracking-widest">Active Groups</p>
                 {groups.map(g => (
                   <div key={g.id} className="flex items-center gap-2">
                     <div className="w-2 h-2 rounded-full" style={{ backgroundColor: g.color }} />
                     <span className="text-[10px] mono-text">{g.name}</span>
                   </div>
                 ))}
              </div>
            )}
            <div className="pt-2 border-t border-brand-line">
               <p className="text-[9px] text-brand-muted leading-tight">Displayed nodes are within 50km radius of Home Base.</p>
            </div>
          </div>
      </div>

      {/* Waypoints panel (floating, top-left) */}
      <div className="absolute top-8 left-8 pointer-events-auto">
        <div
          className="rounded-lg border border-slate-700 overflow-hidden transition-all duration-200"
          style={{
            background: 'rgba(2,6,23,0.92)',
            backdropFilter: 'blur(8px)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            width: waypointPanelOpen ? '256px' : 'auto',
          }}
        >
          <button
            onClick={() => setWaypointPanelOpen(p => !p)}
            className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-slate-800/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <MapPin size={13} className="text-emerald-400" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-white">Waypoints</span>
              <span className="text-[10px] mono-text text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
                {waypoints.length}
              </span>
            </div>
            <ChevronRight
              size={13}
              className={`text-slate-400 transition-transform ${waypointPanelOpen ? 'rotate-90' : ''}`}
            />
          </button>

          {waypointPanelOpen && (
            <div className="border-t border-slate-800">
              {waypoints.length === 0 ? (
                <div className="px-3 py-4 text-center">
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    No waypoints yet.<br />
                    <span className="text-slate-500">Right-click the map to drop one.</span>
                  </p>
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  {waypoints.map(w => (
                    <button
                      key={w.id}
                      onClick={() => focusWaypoint(w)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800/60 border-b border-slate-800/50 last:border-b-0 transition-colors text-left"
                    >
                      <span className="text-lg flex-shrink-0">{codepointToEmoji(w.icon)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-white truncate">
                          {w.name || 'Untitled'}
                          {w.lockedTo > 0 && <Lock size={9} className="inline ml-1 text-emerald-400/60" />}
                        </p>
                        <p className="text-[9px] mono-text text-slate-400 truncate">{formatExpiresIn(w.expire)}</p>
                      </div>
                      <ChevronRight size={11} className="text-slate-500 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}
              <div className="px-3 py-2 border-t border-slate-800 bg-slate-900/40">
                <p className="text-[9px] text-slate-500 leading-tight">
                  <span className="text-slate-400">Tip:</span> right-click (or long-press on touch) anywhere on the map to drop a new waypoint.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Drop / edit modal */}
      {(dropDraft || editingWaypoint) && (
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
      )}

      {qrNode && <ContactQrModal node={qrNode} onClose={() => setQrNode(null)} />}
    </div>
  );
}
