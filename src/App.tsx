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
  FileUp,
  Globe,
  TrendingUp,
  Radio,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import { simulator } from './services/meshtasticSimulator';
import { meshDataService, DataSource, TransportInfo } from './services/meshDataService';
import { SettingsModal } from './components/SettingsModal';
import { IncomingContactToast } from './components/IncomingContactToast';
import { useMeshNotifications } from './hooks/useMeshNotifications';
import { parseDeepLinkFromHash, clearHash, DeepLink } from './lib/deepLink';
import { useBlockList } from './hooks/useBlockList';
import { Node, Message, RadioEvent, Group, WidgetConfig, UnitSystem, Channel, Waypoint, TraceResult, NeighborInfoSnapshot, StoreForwardRouter, LocalModuleConfigSnapshot } from './types';
import { cn } from './lib/utils';
import { TopologyView } from './components/TopologyView';
import { NodeSettingsModal } from './components/NodeSettingsModal';
import { ChannelsModal } from './components/ChannelsModal';
import { ExportModal } from './components/ExportModal';
import { ImportModal } from './components/ImportModal';
import { DashboardDesigner } from './components/DashboardDesigner';
import { RecipeView } from './components/RecipeView';
import { AIAssistant } from './components/AIAssistant';

import { NavItem } from './components/ui/NavItem';
import { GroupItem } from './components/ui/GroupItem';
import { DashboardView } from './components/views/DashboardView';
import { MapView } from './components/views/MapView';
import { MessagesView } from './components/views/MessagesView';
import { LogsView } from './components/views/LogsView';
import { MatrixView } from './components/views/MatrixView';
import { RouteIntelView } from './components/views/RouteIntelView';

export default function App() {
  const [nodes, setNodes] = React.useState<Node[]>([]);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [events, setEvents] = React.useState<RadioEvent[]>([]);
  const [activeTab, setActiveTab] = React.useState<'dashboard' | 'map' | 'messages' | 'logs' | 'matrix' | 'topology' | 'recipe' | 'routes'>('dashboard');
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [configuringNodeId, setConfiguringNodeId] = React.useState<string | null>(null);
  const [showExportModal, setShowExportModal] = React.useState(false);
  const [showImportModal, setShowImportModal] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const blockList = useBlockList();
  const [isEditingDashboard, setIsEditingDashboard] = React.useState(false);
  const [dashboardWidgets, setDashboardWidgets] = React.useState<WidgetConfig[]>([
    { id: 'w1', type: 'STATS', visible: true, order: 0, width: 'full' },
    { id: 'w2', type: 'NODE_LIST', visible: true, order: 1, width: 'large' },
    { id: 'w3', type: 'NODE_DETAILS', visible: true, order: 2, width: 'small' },
    { id: 'w4', type: 'MESSAGES', visible: true, order: 3, width: 'medium' },
    { id: 'w5', type: 'MAP', visible: true, order: 4, width: 'medium' },
    { id: 'w6', type: 'SENSOR_DATA', visible: true, order: 5, width: 'large' },
  ]);
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
  
  // Grouping State
  const [groups, setGroups] = React.useState<Group[]>([
    { id: 'g1', name: 'Field Team', color: '#10b981' },
    { id: 'g2', name: 'Logistics', color: '#f59e0b' }
  ]);
  const [selectedGroupId, setSelectedGroupId] = React.useState<string | 'all' | 'favorites'>('all');
  const [isAddingGroup, setIsAddingGroup] = React.useState(false);
  const [newGroupName, setNewGroupName] = React.useState('');
  const [unitSystem, setUnitSystem] = React.useState<UnitSystem>('METRIC');
  const [dataSource, setDataSource] = React.useState<DataSource>('simulator');
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

  // Check if a real radio is available on mount
  React.useEffect(() => {
    fetch('/api/mesh/status')
      .then(r => r.json())
      .then(status => {
        if (status.radioConnected) {
          setRadioConnected(true);
          setDataSource('live');
        }
      })
      .catch(() => { /* server not running, stay on simulator */ });
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

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return;
    const newGroup: Group = {
      id: Math.random().toString(36).substr(2, 9),
      name: newGroupName,
      color: `hsl(${Math.random() * 360}, 70%, 50%)`
    };
    setGroups([...groups, newGroup]);
    setNewGroupName('');
    setIsAddingGroup(false);
  };

  const assignNodeToGroup = (nodeId: string, groupId?: string) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, groupId } : n));
  };

  // Matrix Stats Calculation
  const matrixData = React.useMemo(() => {
    const list = nodes.map(n => ({ id: n.id, name: n.shortName }));
    const matrix: Record<string, Record<string, { count: number, success: number }>> = {};
    
    list.forEach(from => {
      matrix[from.id] = {};
      list.forEach(to => {
        const pairingMessages = messages.filter(m => m.from === from.id && m.to === to.id);
        matrix[from.id][to.id] = {
          count: pairingMessages.length,
          success: pairingMessages.length > 0 ? 100 : 0 // Simplified for demo
        };
      });
    });

    return { nodes: list, matrix };
  }, [nodes, messages]);

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
          <NavItem 
            active={activeTab === 'routes'} 
            onClick={() => setActiveTab('routes')}
            icon={<TrendingUp size={20} />}
            label="Route Intel"
          />
          <NavItem 
            active={activeTab === 'recipe'} 
            onClick={() => setActiveTab('recipe')}
            icon={<FileDown size={20} />}
            label="Recipe Guide"
          />
          
          <div className="mt-auto pt-4 border-t border-brand-line space-y-1">
            <button 
              onClick={() => setDataSource(prev => prev === 'simulator' ? 'live' : 'simulator')}
              className={cn(
                "w-full h-10 flex items-center justify-center md:justify-start gap-3 px-3 rounded-lg transition-all group",
                dataSource === 'live' 
                  ? "text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20" 
                  : "text-brand-muted hover:bg-brand-line/10 hover:text-brand-accent"
              )}
            >
              <Radio size={20} className={cn(
                "flex-shrink-0 transition-colors",
                dataSource === 'live' ? "text-emerald-400" : "group-hover:text-brand-accent",
                radioConnected && dataSource === 'live' && "animate-pulse"
              )} />
              <div className="hidden md:flex flex-col items-start overflow-hidden">
                <span className="text-[10px] font-bold uppercase tracking-widest leading-none">
                  {dataSource === 'live'
                    ? (radioConnected && transport?.mode === 'tcp' ? 'TCP RADIO'
                      : radioConnected && transport?.mode === 'serial' ? 'SERIAL RADIO'
                      : 'LIVE RADIO')
                    : 'SIMULATOR'}
                </span>
                <span className={cn(
                  "text-[8px] uppercase truncate leading-none mt-1",
                  dataSource === 'live' && radioConnected ? "text-emerald-400" : "text-brand-muted"
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
                />
              ))}
            </div>
          </div>
        </nav>

        <div className="p-4 border-t border-brand-line space-y-4">
          <div className="hidden md:block">
            <p className="text-[10px] text-brand-muted uppercase font-bold tracking-widest mb-2">SYSTEM STATUS</p>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-brand-accent animate-pulse" />
              <span className="mono-text text-brand-accent uppercase">Link Active</span>
            </div>
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
        <header className="h-16 border-b border-brand-line flex items-center justify-between px-6 bg-brand-bg/80 backdrop-blur-sm z-40">
          <div className="flex items-center gap-6">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-light">{activeTab.toUpperCase()}</span>
              <span className="text-xs text-brand-muted mono-text tracking-widest hidden sm:inline">v2.4.0-STABLE</span>
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
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-line/30 border border-brand-line">
              <Signal size={14} className="text-brand-accent" />
              <span className="text-xs font-medium mono-text">MQTT: ONLINE</span>
            </div>
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
                <div className="technical-panel w-full max-w-sm p-6 space-y-4">
                  <h3 className="text-lg font-bold tracking-tight">Create New Group</h3>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Group Name</label>
                    <input 
                      type="text" 
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="e.g. West Relay Team"
                      className="w-full bg-brand-line border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent"
                      autoFocus
                    />
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
                      className="bg-brand-accent text-black px-4 py-2 rounded text-sm font-bold hover:brightness-110"
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
                <MatrixView matrixData={matrixData} />
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
                      localNodeId={localNodeId}
                      canConfigureRadio={dataSource === 'live' && radioConnected}
                      neighborInfoConfig={localModuleConfig.neighborInfo}
                      onConfigureNeighborInfo={(opts) => meshDataService.setNeighborInfoConfig(opts)}
                      onNodeSelect={(id) => { setSelectedNodeId(id); }}
                    />
                  </div>
              </motion.div>
            )}

            {activeTab === 'routes' && (
              <motion.div 
                key="routes"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="p-6 h-full overflow-hidden"
              >
                <RouteIntelView nodes={nodes} />
              </motion.div>
            )}

            {activeTab === 'recipe' && (
              <motion.div 
                key="recipe"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="p-6 h-full overflow-hidden"
              >
                <RecipeView />
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
              onOpenExport={() => setShowExportModal(true)}
              onOpenImport={() => setShowImportModal(true)}
              blockedNodeIds={blockList.blocked}
              nodes={nodes}
              onUnblockNode={blockList.unblock}
              localModuleConfig={localModuleConfig}
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

        <AIAssistant 
          nodes={nodes}
          messages={messages}
          events={events}
        />
      </main>
    </div>
  );
}

