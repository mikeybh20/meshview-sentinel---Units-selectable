/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  LayoutDashboard,
  Map as MapIcon,
  MessageSquare,
  Settings,
  Activity,
  Signal,
  History,
  Star,
  Search,
  Plus,
  FileDown,
  Radio,
  RefreshCw,
  Mail,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import { simulator } from './services/meshtasticSimulator';
import { meshDataService, DataSource, TransportInfo } from './services/meshDataService';
import { SettingsModal } from './components/SettingsModal';
import { IncomingContactToast } from './components/IncomingContactToast';
import { useMeshNotifications } from './hooks/useMeshNotifications';
import { useReadStatus } from './hooks/useReadStatus';
import { parseDeepLinkFromHash, clearHash, DeepLink } from './lib/deepLink';
import { useBlockList } from './hooks/useBlockList';
import { useTheme } from './hooks/useTheme';
import { Node, Message, RadioEvent, Group, WidgetConfig, UnitSystem, Channel, Waypoint, TraceResult, NeighborInfoSnapshot, StoreForwardRouter, LocalModuleConfigSnapshot } from './types';
import { cn } from './lib/utils';
import { TopologyView } from './components/TopologyView';
import { NodeSettingsModal } from './components/NodeSettingsModal';
import { ChannelsModal } from './components/ChannelsModal';
import { ExportModal } from './components/ExportModal';
import { ImportModal } from './components/ImportModal';
import { DashboardDesigner } from './components/DashboardDesigner';
// RecipeView moved into SettingsModal as the "Install Guide" tab; the standalone
// dashboard page was removed per operator request to keep the main nav focused
// on operational views.
import { AIAssistant } from './components/AIAssistant';

import { NavItem } from './components/ui/NavItem';
import { GroupItem } from './components/ui/GroupItem';
import { RadioActivityLEDs } from './components/ui/RadioActivityLEDs';
import { DashboardView } from './components/views/DashboardView';
import { MapView } from './components/views/MapView';
import { MessagesView } from './components/views/MessagesView';
import { LogsView } from './components/views/LogsView';
import { MatrixView } from './components/views/MatrixView';
import { MailView } from './components/views/MailView';

export default function App() {
  const theme = useTheme();
  const [nodes, setNodes] = React.useState<Node[]>([]);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [events, setEvents] = React.useState<RadioEvent[]>([]);
  const [activeTab, setActiveTab] = React.useState<'dashboard' | 'map' | 'messages' | 'logs' | 'matrix' | 'topology' | 'mail'>('dashboard');
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [configuringNodeId, setConfiguringNodeId] = React.useState<string | null>(null);
  const [showExportModal, setShowExportModal] = React.useState(false);
  const [showImportModal, setShowImportModal] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const blockList = useBlockList();
  const [isEditingDashboard, setIsEditingDashboard] = React.useState(false);

  // Default dashboard layout. Four widgets arranged to put Node Info flush
  // with the top of the stats row, so the right column has more vertical real
  // estate to surface per-node detail:
  //
  //   ┌──────── STATS (large) ────────┬─ NODE_DETAILS (small, row-span 2) ─┐
  //   │                               │                                    │
  //   ├──── NODE_LIST (large) ────────┤                                    │
  //   │                               │                                    │
  //   ├───────────────────────────────┴────────────────────────────────────┤
  //   │                       MAP (full width)                             │
  //   └────────────────────────────────────────────────────────────────────┘
  //
  // The operator-customized layout (visibility + order + width) is persisted
  // to localStorage so it survives reloads AND container rebuilds.
  const DEFAULT_DASHBOARD_WIDGETS: WidgetConfig[] = React.useMemo(() => ([
    { id: 'w1', type: 'STATS',        visible: true, order: 0, width: 'large' },
    { id: 'w2', type: 'NODE_DETAILS', visible: true, order: 1, width: 'small' },
    { id: 'w3', type: 'NODE_LIST',    visible: true, order: 2, width: 'large' },
    { id: 'w4', type: 'MAP',          visible: true, order: 3, width: 'full'  },
  ]), []);
  /** Types we still know how to render. Older saved layouts may include
   *  retired types (MESSAGES, SENSOR_DATA) — those get filtered out on load. */
  const VALID_WIDGET_TYPES = new Set<WidgetConfig['type']>(['STATS', 'NODE_LIST', 'NODE_DETAILS', 'MAP']);
  // Storage key gets bumped whenever we change the widget schema OR the
  // canonical default widths so old layouts don't haunt the new dashboard.
  //  v3: MAP forced full width (no more half-row map)
  //  v4: STATS forced 'large' (was 'full'); NODE_DETAILS placed after STATS
  //      in DOM order so it lands in the top-right with row-span 2.
  const DASHBOARD_STORAGE_KEY = 'mesh.dashboardWidgets.v4';

  const [dashboardWidgets, setDashboardWidgets] = React.useState<WidgetConfig[]>(() => {
    try {
      // Migrate any older key we find — strip retired widgets, force the canonical
      // widths for STATS / MAP, normalize order for NODE_DETAILS placement.
      const oldKeys = ['mesh.dashboardWidgets.v1', 'mesh.dashboardWidgets.v2', 'mesh.dashboardWidgets.v3'];
      const current = localStorage.getItem(DASHBOARD_STORAGE_KEY);
      let raw = current;
      for (const k of oldKeys) {
        if (!raw) raw = localStorage.getItem(k);
        // Clean up stale keys so we don't leave them around indefinitely.
        if (!current) {
          try { localStorage.removeItem(k); } catch { /* */ }
        }
      }
      if (!raw) return DEFAULT_DASHBOARD_WIDGETS;
      const parsed = JSON.parse(raw) as WidgetConfig[];
      if (!Array.isArray(parsed)) return DEFAULT_DASHBOARD_WIDGETS;
      // Force canonical widths/visibility/order for widgets whose layout the
      // new design assumes. Operator's order overrides for NODE_LIST and
      // others stay intact; STATS + NODE_DETAILS + MAP are repositioned.
      const cleaned = parsed
        .filter(w => VALID_WIDGET_TYPES.has(w.type))
        .map(w => {
          if (w.type === 'STATS')        return { ...w, width: 'large' as const, visible: true, order: 0 };
          if (w.type === 'NODE_DETAILS') return { ...w, width: 'small' as const, visible: true, order: 1 };
          if (w.type === 'NODE_LIST')    return { ...w, width: 'large' as const, visible: true, order: 2 };
          if (w.type === 'MAP')          return { ...w, width: 'full'  as const, visible: true, order: 3 };
          return w;
        });
      const savedTypes = new Set(cleaned.map(w => w.type));
      const missing = DEFAULT_DASHBOARD_WIDGETS.filter(w => !savedTypes.has(w.type));
      return [...cleaned, ...missing].sort((a, b) => a.order - b.order);
    } catch {
      return DEFAULT_DASHBOARD_WIDGETS;
    }
  });
  // Persist on every change so the latest layout always wins on reload.
  React.useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(dashboardWidgets));
    } catch { /* private mode or storage full */ }
  }, [dashboardWidgets]);
  const [traceMessageId, setTraceMessageId] = React.useState<string | null>(null);
  const [waypoints, setWaypoints] = React.useState<Waypoint[]>([]);
  const [traces, setTraces] = React.useState<TraceResult[]>([]);
  const [neighborInfo, setNeighborInfo] = React.useState<NeighborInfoSnapshot[]>([]);
  const [sfRouters, setSfRouters] = React.useState<StoreForwardRouter[]>([]);
  const [localModuleConfig, setLocalModuleConfig] = React.useState<LocalModuleConfigSnapshot>({});
  const [localNodeId, setLocalNodeId] = React.useState<string | null>(null);
  const [activeChatId, setActiveChatId] = React.useState<string>('chan:0'); // 'chan:N' or a nodeId
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [showChannelsModal, setShowChannelsModal] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [draftMessage, setDraftMessage] = React.useState('');
  // ACK status overlay: messageId → status (overrides whatever the poll returns)
  const [ackStatuses, setAckStatuses] = React.useState<Record<string, { status: string; errorCode: number }>>({});
  
  // Grouping State — groups are persisted server-side; we mirror them here.
  const [groups, setGroups] = React.useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = React.useState<string | 'all' | 'favorites'>('all');
  const [isAddingGroup, setIsAddingGroup] = React.useState(false);
  const [newGroupName, setNewGroupName] = React.useState('');
  const [newGroupColor, setNewGroupColor] = React.useState<string>('#10b981');
  const [unitSystem, setUnitSystem] = React.useState<UnitSystem>('METRIC');
  // Default to live mode — production users have a radio attached and don't
  // want to flip the toggle every load. If no radio is connected the UI shows
  // a red "Radio Offline" indicator; the operator can switch to simulator
  // mode from Settings → Mode if they want demo data instead.
  const [dataSource, setDataSource] = React.useState<DataSource>(() => {
    try {
      const persisted = localStorage.getItem('mesh.dataSource');
      if (persisted === 'live' || persisted === 'simulator') return persisted;
    } catch { /* private mode */ }
    return 'live';
  });
  // Persist on change so a deliberate switch survives reloads.
  React.useEffect(() => {
    try { localStorage.setItem('mesh.dataSource', dataSource); } catch { /* */ }
  }, [dataSource]);
  const [radioConnected, setRadioConnected] = React.useState(false);
  const [transport, setTransport] = React.useState<TransportInfo | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = React.useState<boolean>(() => {
    try { return localStorage.getItem('mesh.notificationsEnabled') !== 'false'; }
    catch { return true; }
  });
  const [notificationPermission, setNotificationPermission] = React.useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  });
  const [refreshState, setRefreshState] = React.useState<'idle' | 'pending' | 'ok' | 'err'>('idle');

  // AI master switch — controls whether the floating AI Assistant launcher
  // surfaces in the corner. Fetched once on mount and refreshed when the
  // operator toggles it in Settings (via the 'mesh:aiEnabledChanged' event
  // the AI settings panel dispatches).
  const [aiEnabled, setAiEnabled] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/ai/config')
      .then(r => r.json())
      .then(c => { if (!cancelled) setAiEnabled(!!c?.enabled); })
      .catch(() => { /* leave default false */ });
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.enabled === 'boolean') setAiEnabled(detail.enabled);
    };
    window.addEventListener('mesh:aiEnabledChanged', handler);
    return () => { cancelled = true; window.removeEventListener('mesh:aiEnabledChanged', handler); };
  }, []);

  const handleRefreshNodeDb = React.useCallback(async () => {
    if (dataSource !== 'live' || !radioConnected) return;
    setRefreshState('pending');
    const result = await meshDataService.refreshNodeDb();
    setRefreshState(result.ok ? 'ok' : 'err');
    setTimeout(() => setRefreshState('idle'), 2000);
  }, [dataSource, radioConnected]);

  // Version comes from the server at runtime (sourced from .env SYSTEM_VERSION
   // via docker-compose env_file). We can't bake it at build time because the
   // .env file is intentionally excluded from the Docker build context to keep
   // API keys out of the image.
  const [systemVersion, setSystemVersion] = React.useState<string>('');

  // Pull system version + initial radio status. We no longer auto-flip the
  // dataSource here because live is now the default; the operator explicitly
  // switches to simulator from Settings → Mode when they want demo data.
  React.useEffect(() => {
    fetch('/api/mesh/status')
      .then(r => r.json())
      .then(status => {
        if (status.systemVersion) setSystemVersion(status.systemVersion);
        if (status.radioConnected) setRadioConnected(true);
      })
      .catch(() => { /* server not running yet — fine, status will update via SSE */ });
  }, []);

  // Subscribe to the active data source
  React.useEffect(() => {
    if (dataSource === 'live') {
      meshDataService.start();
      const unsub = meshDataService.subscribe((n, m, e) => {
        setNodes(n);
        setMessages(m);
        setEvents(e);
      });
      const unsubStatus = meshDataService.onStatus((status) => {
        setRadioConnected(status?.radioConnected ?? false);
        setTransport(status?.transport ?? null);
      });
      const unsubChannels = meshDataService.onChannels((list) => {
        setChannels(list);
      });
      const unsubAck = meshDataService.onAckUpdate((msgId, status, errorCode) => {
        setAckStatuses(prev => ({ ...prev, [msgId]: { status, errorCode } }));
      });
      const unsubWaypoints = meshDataService.onWaypoints((list) => {
        setWaypoints(list);
        setLocalNodeId(meshDataService.getLocalNodeId());
      });
      const unsubTraces = meshDataService.onTraces((list) => setTraces(list));
      const unsubNeighbors = meshDataService.onNeighborInfo((list) => setNeighborInfo(list));
      const unsubSfRouters = meshDataService.onStoreForwardRouters((list) => setSfRouters(list));
      const unsubModuleConfig = meshDataService.onModuleConfig((cfg) => setLocalModuleConfig(cfg));
      const unsubGroups = meshDataService.onGroups((list) => setGroups(list));
      return () => {
        unsub();
        unsubStatus();
        unsubChannels();
        unsubAck();
        unsubWaypoints();
        unsubTraces();
        unsubNeighbors();
        unsubSfRouters();
        unsubModuleConfig();
        unsubGroups();
        meshDataService.stop();
      };
    } else {
      // Simulator has no channel concept — clear so the UI shows the synthetic
      // "LongFast" fallback in MessagesView.
      setChannels([]);
      setLocalNodeId(simulator.getLocalNodeId());
      const unsub = simulator.subscribe((n, m, e) => {
        setNodes(n);
        setMessages(m);
        setEvents(e);
      });
      const unsubWp = simulator.onWaypoints((list) => setWaypoints(list));
      return () => { unsub(); unsubWp(); };
    }
  }, [dataSource]);

  const activeChatPartner = React.useMemo(() => 
    nodes.find(n => n.id === activeChatId),
    [nodes, activeChatId]
  );

  const activeChannel = React.useMemo<Channel | undefined>(() => {
    if (!activeChatId.startsWith('chan:')) return undefined;
    const idx = parseInt(activeChatId.slice(5), 10);
    const found = channels.find(c => c.index === idx);
    if (found) return found;
    // Fallback synthetic primary so simulator/empty state still works.
    if (idx === 0) {
      return { index: 0, name: '', role: 'PRIMARY', pskBase64: '', uplinkEnabled: true, downlinkEnabled: true };
    }
    return undefined;
  }, [activeChatId, channels]);

  const filteredMessages = React.useMemo(() => {
    const applyAck = (m: Message): Message => {
      const ack = ackStatuses[m.id];
      return ack ? { ...m, status: ack.status as Message['status'], errorCode: ack.errorCode } : m;
    };

    if (activeChannel) {
      const label = activeChannel.name || (activeChannel.role === 'PRIMARY' ? 'LongFast' : `Channel ${activeChannel.index}`);
      return messages
        .filter(m =>
          m.channel === label ||
          (activeChannel.role === 'PRIMARY' && (m.channel === 'LongFast' || m.channel === 'Broadcast')) ||
          m.channel === `Channel ${activeChannel.index}`
        )
        .filter(m => !blockList.isBlocked(m.from))
        .map(applyAck);
    }
    return messages
      .filter(m =>
        (m.from === activeChatId && m.to !== '!ffffffff') ||
        (m.to === activeChatId)
      )
      .filter(m => !blockList.isBlocked(m.from))
      .map(applyAck);
  }, [messages, activeChatId, activeChannel, ackStatuses, blockList]);

  const handleSendMessage = async (
    overrideText?: string,
    opts?: { replyTo?: number; isReaction?: boolean },
  ) => {
    const text = overrideText ?? draftMessage;
    if (!text.trim()) return;
    if (dataSource === 'live') {
      const channelIndex = activeChannel?.index ?? 0;
      const to = activeChannel ? '!ffffffff' : activeChatId;
      if (!overrideText) setDraftMessage('');
      await meshDataService.sendMessage(text, to, channelIndex, opts);
    } else {
      setDraftMessage('');
    }
  };

  const selectedNode = React.useMemo(() =>
    nodes.find(n => n.id === selectedNodeId),
    [nodes, selectedNodeId]
  );

  useMeshNotifications({
    nodes,
    messages,
    events,
    channels,
    localNodeId,
    activeChatId,
    enabled: notificationsEnabled && notificationPermission === 'granted',
  });

  // Shared read/unread state — drives both the sidebar Messages badge and the
  // in-view "—— New ——" divider. Only marks as read while user is actually
  // on the messages tab; otherwise unread counts keep accruing.
  const { unreadCounts, totalUnread, firstUnreadAt } = useReadStatus({
    messages,
    channels,
    localNodeId,
    activeChatId,
    markActiveAsRead: activeTab === 'messages',
  });

  // BBS unread mail counter — drives the Mail nav badge. Refreshed on mount,
  // when localNodeId changes, and on every bbsMail SSE event from the server.
  const [bbsUnread, setBbsUnread] = React.useState(0);
  React.useEffect(() => {
    if (!localNodeId || dataSource !== 'live') {
      setBbsUnread(0);
      return;
    }
    let cancelled = false;
    const fetchUnread = async () => {
      const r = await meshDataService.getBbsInbox(localNodeId);
      if (!cancelled && r) setBbsUnread(r.unread);
    };
    fetchUnread();
    const unsub = meshDataService.onBbsMail(() => { fetchUnread(); });
    return () => { cancelled = true; unsub(); };
  }, [localNodeId, dataSource]);

  // Notification click → switch tab + chat
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.nodeId) {
        setActiveChatId(detail.nodeId);
        setActiveTab('messages');
      }
    };
    window.addEventListener('mesh:openChat', handler);
    return () => window.removeEventListener('mesh:openChat', handler);
  }, []);

  // Deep links: a URL hash like '#v/<base64>' opens the contact-import toast,
  // and '#chat=!hex' or '#chat=chan:N' jumps to that chat. We re-check on
  // hashchange so links work even after the app is already loaded.
  const [incomingContact, setIncomingContact] = React.useState<Extract<DeepLink, { type: 'contact' }> | null>(null);

  React.useEffect(() => {
    const handle = () => {
      const link = parseDeepLinkFromHash(window.location.hash);
      if (!link) return;
      if (link.type === 'contact') {
        setIncomingContact(link);
        clearHash();
      } else if (link.type === 'chat') {
        setActiveChatId(link.chatId);
        setActiveTab('messages');
        clearHash();
      }
    };
    handle();
    window.addEventListener('hashchange', handle);
    return () => window.removeEventListener('hashchange', handle);
  }, []);

  const filteredNodes = React.useMemo(() => {
    let result = nodes;
    if (selectedGroupId === 'favorites') {
      result = result.filter(n => n.favorite);
    } else if (selectedGroupId !== 'all') {
      result = result.filter(n => n.groupId === selectedGroupId);
    }
    
    return result.filter(n => 
      n.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.id.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [nodes, searchQuery, selectedGroupId]);

  const stats = React.useMemo(() => ({
    total: nodes.length,
    online: nodes.filter(n => n.online).length,
    offline: nodes.filter(n => !n.online).length,
    favorites: nodes.filter(n => n.favorite).length
  }), [nodes]);

  const handleCreateGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    if (dataSource === 'live') {
      const r = await meshDataService.createGroup(name, newGroupColor);
      if (!r.ok) console.error('createGroup failed:', r.error);
    } else {
      // Simulator path: keep client-side state for development
      const newGroup: Group = {
        id: Math.random().toString(36).substring(2, 11),
        name,
        color: newGroupColor,
      };
      setGroups([...groups, newGroup]);
    }
    setNewGroupName('');
    setNewGroupColor('#10b981');
    setIsAddingGroup(false);
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (dataSource === 'live') {
      const r = await meshDataService.deleteGroup(groupId);
      if (!r.ok) console.error('deleteGroup failed:', r.error);
    } else {
      setGroups(prev => prev.filter(g => g.id !== groupId));
      setNodes(prev => prev.map(n => n.groupId === groupId ? { ...n, groupId: undefined } : n));
    }
    if (selectedGroupId === groupId) setSelectedGroupId('all');
  };

  const handleRenameGroup = async (groupId: string, name: string) => {
    if (dataSource === 'live') {
      const r = await meshDataService.updateGroup(groupId, { name });
      if (!r.ok) console.error('updateGroup failed:', r.error);
    } else {
      setGroups(prev => prev.map(g => g.id === groupId ? { ...g, name } : g));
    }
  };

  const assignNodeToGroup = async (nodeId: string, groupId?: string) => {
    if (dataSource === 'live') {
      const r = await meshDataService.setNodeGroup(nodeId, groupId ?? null);
      if (!r.ok) console.error('setNodeGroup failed:', r.error);
    } else {
      setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, groupId } : n));
    }
  };

  // Matrix Stats Calculation
  // Comm Matrix data is now computed inside MatrixView itself with filter state
  // (time range, top-N senders, etc.) — see src/components/views/MatrixView.tsx.
  // The view consumes raw `messages`, `nodes`, and `channels` directly.

  return (
    <div className="flex h-screen bg-brand-bg font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-16 md:w-64 border-r border-brand-line flex flex-col items-center md:items-stretch bg-brand-bg/50 backdrop-blur-md z-50">
        <div className="p-4 flex items-center gap-3 border-b border-brand-line h-16">
          <div className="w-8 h-8 rounded bg-brand-accent flex items-center justify-center">
            <Activity className="text-black w-5 h-5" />
          </div>
          <h1 className="text-lg font-bold hidden md:block tracking-tighter">MESHVIEW SENTINEL</h1>
        </div>

        <nav className="flex-1 p-2 space-y-1 mt-4 overflow-y-auto">
          <NavItem 
            active={activeTab === 'dashboard'} 
            onClick={() => setActiveTab('dashboard')}
            icon={<LayoutDashboard size={20} />}
            label="Dashboard"
          />
          <NavItem 
            active={activeTab === 'map'} 
            onClick={() => setActiveTab('map')}
            icon={<MapIcon size={20} />}
            label="Map Network"
          />
          <NavItem
            active={activeTab === 'messages'}
            onClick={() => setActiveTab('messages')}
            icon={<MessageSquare size={20} />}
            label="Messages"
            badge={totalUnread}
          />
          <NavItem
            active={activeTab === 'mail'}
            onClick={() => setActiveTab('mail')}
            icon={<Mail size={20} />}
            label="BBS Mail"
            badge={bbsUnread}
          />
          <NavItem
            active={activeTab === 'logs'}
            onClick={() => setActiveTab('logs')}
            icon={<History size={20} />}
            label="Event Logs"
          />
          <NavItem 
            active={activeTab === 'matrix'} 
            onClick={() => setActiveTab('matrix')}
            icon={<Signal size={20} />}
            label="Comm Matrix"
          />
          <NavItem 
            active={activeTab === 'topology'} 
            onClick={() => setActiveTab('topology')}
            icon={<Activity size={20} />}
            label="Topology"
          />
          {/* Recipe / Installation Guide moved to Settings → Install Guide. */}
          
          <div className="mt-auto pt-4 border-t border-brand-line space-y-1">
            {/* Radio status display. Click-to-toggle was removed — switching
                between live and simulator now lives in Settings → Mode so
                operators can't accidentally flip into demo data mid-session. */}
            <button
              onClick={() => setShowSettings(true)}
              title="Open Settings → Mode to switch between Live and Simulator"
              className={cn(
                "w-full h-10 flex items-center justify-center md:justify-start gap-3 px-3 rounded-lg transition-all group cursor-pointer",
                dataSource === 'live'
                  ? "text-brand-accent bg-brand-accent/10 hover:bg-brand-accent/20"
                  : "text-brand-warning bg-brand-warning/10 hover:bg-brand-warning/20"
              )}
            >
              <Radio size={20} className={cn(
                "flex-shrink-0 transition-colors",
                dataSource === 'live' ? "text-brand-accent" : "text-brand-warning"
              )} />
              <div className="hidden md:flex flex-col items-start overflow-hidden flex-1">
                <span className="text-[10px] font-bold uppercase tracking-widest leading-none">
                  {dataSource === 'live'
                    ? (radioConnected && transport?.mode === 'tcp' ? 'TCP RADIO'
                      : radioConnected && transport?.mode === 'serial' ? 'SERIAL RADIO'
                      : 'LIVE RADIO')
                    : 'SIMULATOR'}
                </span>
                <span className={cn(
                  "text-[8px] uppercase truncate leading-none mt-1",
                  dataSource === 'live' && radioConnected ? "text-brand-accent"
                    : dataSource === 'simulator' ? "text-brand-warning"
                    : "text-brand-muted"
                )}>
                  {dataSource === 'live'
                    ? (radioConnected
                        ? (transport?.mode === 'tcp' && transport.tcp ? `${transport.tcp.host}:${transport.tcp.port}`
                          : transport?.mode === 'serial' && transport.serial ? transport.serial.port
                          : 'Connected')
                        : 'Waiting for radio...')
                    : 'Demo Data'}
                </span>
              </div>
              <RadioActivityLEDs enabled={dataSource === 'live' && radioConnected} />
            </button>
          </div>

          <div className="pt-4 mt-4 border-t border-brand-line hidden md:block">
            <div className="px-3 mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">Node Groups</span>
              <button 
                onClick={() => setIsAddingGroup(true)}
                className="p-1 hover:text-brand-accent transition-colors"
                title="Create Group"
              >
                <Plus size={14} />
              </button>
            </div>
            
            <div className="space-y-1">
              <GroupItem 
                active={selectedGroupId === 'all'} 
                onClick={() => setSelectedGroupId('all')}
                label="All Nodes"
                count={nodes.length}
              />
              <GroupItem 
                active={selectedGroupId === 'favorites'} 
                onClick={() => setSelectedGroupId('favorites')}
                label="Favorites"
                icon={<Star size={12} className="text-brand-warning" />}
                count={stats.favorites}
              />
              {groups.map(group => (
                <GroupItem
                  key={group.id}
                  active={selectedGroupId === group.id}
                  onClick={() => setSelectedGroupId(group.id)}
                  label={group.name}
                  color={group.color}
                  count={nodes.filter(n => n.groupId === group.id).length}
                  onDelete={() => {
                    if (confirm(`Delete group "${group.name}"? Nodes in this group will be unassigned.`)) {
                      handleDeleteGroup(group.id);
                    }
                  }}
                  onRename={(name) => handleRenameGroup(group.id, name)}
                />
              ))}
            </div>
          </div>
        </nav>

        <div className="p-4 border-t border-brand-line space-y-4">
          <div className="hidden md:block">
            <p className="text-[10px] text-brand-muted uppercase font-bold tracking-widest mb-2">SYSTEM STATUS</p>
            {(() => {
              // Three states: live + radio = green pulse, live + no radio = red,
              // simulator = amber static (link is "active" in a sense but it's
              // synthetic, so we don't want to mislead the operator).
              const liveOk = dataSource === 'live' && radioConnected;
              const liveOff = dataSource === 'live' && !radioConnected;
              const dotClass = liveOk
                ? 'bg-brand-accent animate-pulse'
                : liveOff
                  ? 'bg-brand-error'
                  : 'bg-brand-warning';
              const labelClass = liveOk
                ? 'text-brand-accent'
                : liveOff
                  ? 'text-brand-error'
                  : 'text-brand-warning';
              const label = liveOk
                ? 'Link Active'
                : liveOff
                  ? 'Radio Offline'
                  : 'Simulator Mode';
              return (
                <div className="flex items-center gap-2 mb-2">
                  <div className={cn('w-2 h-2 rounded-full', dotClass)} />
                  <span className={cn('mono-text uppercase', labelClass)}>{label}</span>
                </div>
              );
            })()}
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="w-full h-10 rounded border border-brand-line hover:bg-brand-line hover:text-brand-accent transition-colors flex items-center justify-center gap-2"
            title="Open settings"
          >
            <Settings size={18} />
            <span className="hidden md:inline text-sm">Settings</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Header */}
        <header className="h-16 border-b border-brand-line flex items-center justify-between gap-2 px-3 sm:px-6 bg-brand-bg/80 backdrop-blur-sm z-40">
          <div className="flex items-center gap-6">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-light">{activeTab.toUpperCase()}</span>
              <span className="text-xs text-brand-muted mono-text tracking-widest hidden sm:inline" title="Application version">
                v{systemVersion || '—'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative hidden sm:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={16} />
              <input
                type="text"
                placeholder="Filter nodes..."
                className="bg-brand-line/50 border border-brand-line rounded-full py-1.5 pl-10 pr-4 text-sm focus:outline-none focus:border-brand-accent transition-colors w-64"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            {dataSource === 'live' && (
              <button
                onClick={handleRefreshNodeDb}
                disabled={!radioConnected || refreshState === 'pending'}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors",
                  refreshState === 'ok' && "border-brand-accent text-brand-accent",
                  refreshState === 'err' && "border-brand-danger text-brand-danger",
                  refreshState !== 'ok' && refreshState !== 'err' && "border-brand-line text-brand-muted hover:text-brand-accent hover:border-brand-accent/40",
                  (!radioConnected || refreshState === 'pending') && "opacity-50 cursor-not-allowed"
                )}
                title={
                  !radioConnected
                    ? 'Connect a radio first'
                    : refreshState === 'err'
                      ? 'Refresh failed — see server logs'
                      : 'Re-pull NodeDB / channels / module configs from the radio'
                }
              >
                <RefreshCw
                  size={14}
                  className={cn(refreshState === 'pending' && 'animate-spin')}
                />
                <span className="text-xs font-medium mono-text hidden md:inline">
                  {refreshState === 'pending' ? 'REFRESHING' : refreshState === 'ok' ? 'REFRESHED' : refreshState === 'err' ? 'FAILED' : 'REFRESH'}
                </span>
              </button>
            )}
            {(() => {
              // Truthful MQTT status pill. Three states:
              //   active   — local radio's MQTT module is enabled (authoritative readback)
              //   observed — module disabled or unread, but at least one peer has been
              //              seen via the MQTT bridge in the last 30 min
              //   off      — neither (no MQTT traffic, no module enable)
              const cutoff = Date.now() - 30 * 60 * 1000;
              const moduleEnabled = !!localModuleConfig.mqtt?.enabled;
              const observed = nodes.some(n => n.lastVia === 'mqtt' && n.lastSeen >= cutoff);
              const state: 'active' | 'observed' | 'off' =
                moduleEnabled ? 'active' : observed ? 'observed' : 'off';
              const label =
                state === 'active'   ? 'MQTT: ACTIVE' :
                state === 'observed' ? 'MQTT: OBSERVED' :
                                       'MQTT: OFF';
              const tone =
                state === 'active'   ? 'text-brand-accent' :
                state === 'observed' ? 'text-brand-warning' :
                                       'text-brand-muted';
              const title =
                state === 'active'   ? 'Local radio\'s MQTT module is enabled (per its admin readback). Per-channel uplink/downlink toggles still live in Channels.' :
                state === 'observed' ? 'MQTT module not enabled here, but at least one peer has reached us via an MQTT bridge in the last 30 minutes.' :
                                       'No MQTT activity. Configure the local module in Settings → Modules → MQTT, or wait for an MQTT-bridged peer to appear.';
              return (
                <div
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-line/30 border border-brand-line"
                  title={title}
                >
                  <Signal size={14} className={tone} />
                  <span className={cn('text-xs font-medium mono-text', tone)}>{label}</span>
                </div>
              );
            })()}
          </div>
        </header>

        {/* View Layout */}
        <div className="flex-1 relative overflow-hidden">
          {/* Modal for adding group */}
          <AnimatePresence>
            {isAddingGroup && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-brand-bg/80 backdrop-blur-md z-[100] flex items-center justify-center p-6"
              >
                <div className="technical-panel w-full max-w-sm p-6 space-y-4 bg-brand-bg">
                  <h3 className="text-lg font-bold tracking-tight">Create New Group</h3>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Group Name</label>
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && newGroupName.trim()) handleCreateGroup(); }}
                      placeholder="e.g. West Relay Team"
                      className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Color</label>
                    <div className="flex items-center gap-2 flex-wrap">
                      {['#10b981', '#f59e0b', '#3b82f6', '#a855f7', '#ec4899', '#ef4444', '#06b6d4', '#84cc16'].map(c => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setNewGroupColor(c)}
                          className={cn(
                            "w-7 h-7 rounded-full transition-all border-2",
                            newGroupColor === c ? "border-brand-ink scale-110" : "border-transparent hover:border-brand-muted"
                          )}
                          style={{ backgroundColor: c }}
                          title={c}
                        />
                      ))}
                      <input
                        type="color"
                        value={newGroupColor}
                        onChange={(e) => setNewGroupColor(e.target.value)}
                        className="w-7 h-7 rounded cursor-pointer bg-transparent border border-brand-line"
                        title="Custom color"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setIsAddingGroup(false)}
                      className="px-4 py-2 text-sm hover:text-brand-accent transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateGroup}
                      disabled={!newGroupName.trim()}
                      className="bg-brand-accent text-black px-4 py-2 rounded text-sm font-bold hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Create
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait">
            {activeTab === 'dashboard' && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="p-6 h-full overflow-y-auto"
              >
                <DashboardView
                  nodes={nodes}
                  messages={messages}
                  filteredNodes={filteredNodes}
                  selectedNode={selectedNode}
                  selectedNodeId={selectedNodeId}
                  setSelectedNodeId={setSelectedNodeId}
                  setConfiguringNodeId={setConfiguringNodeId}
                  setIsEditingDashboard={setIsEditingDashboard}
                  dashboardWidgets={dashboardWidgets}
                  stats={stats}
                  unitSystem={unitSystem}
                  onToggleFavorite={(nodeId, favorite) => {
                    if (dataSource === 'live') {
                      meshDataService.setFavorite(nodeId, favorite).then(r => {
                        if (!r.ok) console.error('setFavorite failed:', r.error);
                      });
                    } else {
                      simulator.setFavorite(nodeId, favorite);
                    }
                  }}
                  groups={groups}
                  onAssignGroup={(nodeId, groupId) => assignNodeToGroup(nodeId, groupId)}
                  dataSource={dataSource}
                />
              </motion.div>
            )}

            {activeTab === 'map' && (
              <motion.div 
                key="map"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full relative"
              >
                <MapView
                  nodes={nodes}
                  messages={messages}
                  groups={groups}
                  traceMessageId={traceMessageId}
                  setTraceMessageId={setTraceMessageId}
                  setSelectedNodeId={setSelectedNodeId}
                  unitSystem={unitSystem}
                  waypoints={waypoints}
                  traces={traces}
                  neighborInfo={neighborInfo}
                  storeForwardRouters={sfRouters}
                  localNodeId={localNodeId}
                  dataSource={dataSource}
                  onTraceroute={async (nodeId) => {
                    if (dataSource !== 'live') return { ok: false, error: 'Switch to live radio to run traceroute' };
                    return await meshDataService.sendTraceroute(nodeId);
                  }}
                  blockedNodeIds={blockList.blocked}
                  onBlockNode={blockList.block}
                  onUnblockNode={blockList.unblock}
                  onRequestStoreForwardHistory={async (routerId, minutes) => {
                    if (dataSource !== 'live') return { ok: false, error: 'Switch to live radio to request history' };
                    return await meshDataService.requestStoreForwardHistory(routerId, minutes);
                  }}
                  onToggleFavorite={async (nodeId, favorite) => {
                    if (dataSource === 'live') {
                      const r = await meshDataService.setFavorite(nodeId, favorite);
                      if (!r.ok) console.error('setFavorite failed:', r.error);
                    } else {
                      simulator.setFavorite(nodeId, favorite);
                    }
                  }}
                  onAssignGroup={(nodeId, groupId) => assignNodeToGroup(nodeId, groupId)}
                  onSaveWaypoint={async (input) => {
                    if (dataSource === 'live') {
                      const r = await meshDataService.saveWaypoint(input);
                      if (!r.ok) console.error('saveWaypoint failed:', r.error);
                    } else {
                      simulator.saveWaypoint(input);
                    }
                  }}
                  onDeleteWaypoint={async (id) => {
                    if (dataSource === 'live') {
                      const r = await meshDataService.deleteWaypoint(id);
                      if (!r.ok) console.error('deleteWaypoint failed:', r.error);
                    } else {
                      simulator.deleteWaypoint(id);
                    }
                  }}
                  onDirectMessage={(nodeId) => {
                    setActiveChatId(nodeId);
                    setActiveTab('messages');
                  }}
                />
              </motion.div>
            )}

            {activeTab === 'messages' && (
              <motion.div 
                key="messages"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="p-6 h-full grid grid-cols-1 md:grid-cols-12 gap-6 overflow-hidden"
              >
                <MessagesView
                  nodes={nodes}
                  messages={messages}
                  channels={channels}
                  filteredMessages={filteredMessages}
                  activeChatId={activeChatId}
                  setActiveChatId={setActiveChatId}
                  activeChatPartner={activeChatPartner}
                  activeChannel={activeChannel}
                  traceMessageId={traceMessageId}
                  setTraceMessageId={setTraceMessageId}
                  setActiveTab={setActiveTab}
                  draftMessage={draftMessage}
                  setDraftMessage={setDraftMessage}
                  handleSendMessage={handleSendMessage}
                  onManageChannels={() => setShowChannelsModal(true)}
                  localNodeId={localNodeId}
                  blockedNodeIds={blockList.blocked}
                  unreadCounts={unreadCounts}
                  firstUnreadAt={firstUnreadAt[activeChatId] || 0}
                />
              </motion.div>
            )}

            {activeTab === 'matrix' && (
              <motion.div
                key="matrix"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="p-6 h-full flex flex-col gap-6"
              >
                <MatrixView nodes={nodes} messages={messages} channels={channels} />
              </motion.div>
            )}

            {activeTab === 'mail' && (
              <motion.div
                key="mail"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="h-full overflow-hidden"
              >
                <MailView nodes={nodes} localNodeId={localNodeId} />
              </motion.div>
            )}

            {activeTab === 'topology' && (
              <motion.div 
                key="topology"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="p-6 h-full flex flex-col"
              >
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-xl font-bold tracking-tight">NETWORK TOPOLOGY</h2>
                      <p className="text-xs text-brand-muted mono-text uppercase">Force-Directed Graph Visualization</p>
                    </div>
                    <div className="flex gap-2">
                       <div className="technical-panel px-3 py-1 flex items-center gap-2">
                          <Activity size={12} className="text-brand-accent" />
                          <span className="text-[10px] mono-text">{nodes.length} NODES DISCOVERED</span>
                       </div>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0">
                    <TopologyView
                      nodes={nodes}
                      neighborInfo={neighborInfo}
                      groups={groups}
                      localNodeId={localNodeId}
                      canConfigureRadio={dataSource === 'live' && radioConnected}
                      neighborInfoConfig={localModuleConfig.neighborInfo}
                      onConfigureNeighborInfo={(opts) => meshDataService.setNeighborInfoConfig(opts)}
                      onNodeSelect={(id) => { setSelectedNodeId(id); }}
                    />
                  </div>
              </motion.div>
            )}

            {activeTab === 'logs' && (
              <motion.div 
                key="logs"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="p-6 h-full overflow-hidden flex flex-col"
              >
                <LogsView events={events} />
              </motion.div>
            )}

          </AnimatePresence>
        </div>

        <AnimatePresence>
          {configuringNodeId && nodes.find(n => n.id === configuringNodeId) && (
            <NodeSettingsModal 
              node={nodes.find(n => n.id === configuringNodeId)!} 
              onClose={() => setConfiguringNodeId(null)} 
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showExportModal && (
            <ExportModal 
              nodes={nodes}
              messages={messages}
              events={events}
              onClose={() => setShowExportModal(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showImportModal && (
            <ImportModal 
              nodes={nodes}
              onClose={() => setShowImportModal(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isEditingDashboard && (
            <DashboardDesigner 
              widgets={dashboardWidgets}
              onUpdate={setDashboardWidgets}
              onClose={() => setIsEditingDashboard(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showSettings && (
            <SettingsModal
              onClose={() => setShowSettings(false)}
              transport={transport}
              radioConnected={radioConnected}
              onTcpConnected={() => setDataSource('live')}
              notificationsEnabled={notificationsEnabled}
              setNotificationsEnabled={setNotificationsEnabled}
              notificationPermission={notificationPermission}
              setNotificationPermission={setNotificationPermission}
              unitSystem={unitSystem}
              setUnitSystem={setUnitSystem}
              themePreference={theme.preference}
              setThemePreference={theme.setPreference}
              appliedTheme={theme.applied}
              onOpenExport={() => setShowExportModal(true)}
              onOpenImport={() => setShowImportModal(true)}
              blockedNodeIds={blockList.blocked}
              nodes={nodes}
              onUnblockNode={blockList.unblock}
              localModuleConfig={localModuleConfig}
              dataSource={dataSource}
              setDataSource={setDataSource}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showChannelsModal && (
            <ChannelsModal onClose={() => setShowChannelsModal(false)} />
          )}
        </AnimatePresence>

        <IncomingContactToast
          contact={incomingContact}
          alreadyKnown={!!(incomingContact && nodes.some(n => n.id === incomingContact.nodeId))}
          onDismiss={() => setIncomingContact(null)}
          onOpenChat={(nodeId) => { setActiveChatId(nodeId); setActiveTab('messages'); }}
        />

        {aiEnabled && (
          <AIAssistant
            nodes={nodes}
            messages={messages}
            events={events}
          />
        )}
      </main>
    </div>
  );
}

