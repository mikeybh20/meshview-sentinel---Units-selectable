import React from 'react';
import { 
  MessageSquare, 
  Settings, 
  Activity, 
  Signal, 
  Star,
  ArrowRight,
  Wifi,
  AlertCircle,
  LayoutTemplate,
  Compass,
  ArrowsUpFromLine
} from 'lucide-react';
import { Map, Marker } from "pigeon-maps";

import { Node, Message, WidgetConfig, UnitSystem } from '../../types';
import { cn } from '../../lib/utils';
import { StatCard } from '../ui/StatCard';
import { TelemetryItem } from '../ui/TelemetryItem';
import { SensorWidget } from '../SensorWidget';

interface DashboardViewProps {
  nodes: Node[];
  messages: Message[];
  filteredNodes: Node[];
  selectedNode: Node | undefined;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string) => void;
  setConfiguringNodeId: (id: string) => void;
  setIsEditingDashboard: (v: boolean) => void;
  dashboardWidgets: WidgetConfig[];
  stats: { total: number; online: number; offline: number; favorites: number };
  unitSystem: UnitSystem;
}

export function DashboardView({
  nodes,
  messages,
  filteredNodes,
  selectedNode,
  selectedNodeId,
  setSelectedNodeId,
  setConfiguringNodeId,
  setIsEditingDashboard,
  dashboardWidgets,
  stats,
  unitSystem,
}: DashboardViewProps) {
  return (
    <>
      <div className="flex items-center justify-between mb-6">
         <div>
           <h2 className="text-xl font-bold tracking-tight text-white">NETWORK OVERVIEW</h2>
           <p className="text-xs text-brand-muted mono-text uppercase">Real-time mesh diagnostics</p>
         </div>
         <button 
           onClick={() => setIsEditingDashboard(true)}
           className="flex items-center gap-2 px-3 py-1.5 rounded bg-brand-line/50 border border-brand-line hover:border-brand-accent transition-all text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-white"
         >
           <LayoutTemplate size={14} />
           Customize Dashboard
         </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {dashboardWidgets.filter(w => w.visible).sort((a, b) => a.order - b.order).map(widget => {
          const colSpan = {
            full: 'lg:col-span-12',
            large: 'lg:col-span-8',
            medium: 'lg:col-span-6',
            small: 'lg:col-span-4'
          }[widget.width];

          return (
            <div key={widget.id} className={colSpan}>
              {widget.type === 'STATS' && (
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard label="Nodes Online" value={`${stats.offline + stats.online}`} subValue={`${stats.online} Active`} icon={<Wifi size={20} className="text-brand-accent"/>} />
                  <StatCard label="Total Messages" value={`${messages.length}`} subValue="Last hour" icon={<MessageSquare size={20} className="text-blue-400"/>} />
                  <StatCard label="Favorites" value={`${stats.favorites}`} subValue="Prioritized" icon={<Star size={20} className="text-yellow-400"/>} />
                  <StatCard 
                    label="Environment" 
                    value={nodes.some(n => n.sensors?.temperature) 
                      ? unitSystem === 'METRIC' 
                        ? `${(nodes.filter(n => n.sensors?.temperature).reduce((acc, n) => acc + n.sensors!.temperature!, 0) / nodes.filter(n => n.sensors?.temperature).length).toFixed(1)}°C`
                        : `${((nodes.filter(n => n.sensors?.temperature).reduce((acc, n) => acc + n.sensors!.temperature!, 0) / nodes.filter(n => n.sensors?.temperature).length) * 9/5 + 32).toFixed(1)}°F` 
                      : "N/A"} 
                    subValue={nodes.some(n => n.sensors?.humidity)
                      ? `Humidity ${(nodes.filter(n => n.sensors?.humidity).reduce((acc, n) => acc + n.sensors!.humidity!, 0) / nodes.filter(n => n.sensors?.humidity).length).toFixed(0)}%`
                      : "No Data"} 
                    icon={<Activity size={20} className="text-purple-400"/>} 
                  />
                </div>
              )}

              {widget.type === 'NODE_LIST' && (
                <div className="technical-panel h-full">
                  <div className="p-4 border-b border-brand-line flex items-center justify-between">
                    <h3 className="font-bold flex items-center gap-2 text-xs uppercase tracking-widest text-brand-muted">
                      Active Network Peers
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-brand-line bg-brand-line/20">
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted">Status</th>
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted">Node ID</th>
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted">Name</th>
                          <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredNodes.map(node => (
                          <tr 
                            key={node.id} 
                            onClick={() => setSelectedNodeId(node.id)}
                            className={cn(
                              "group border-b border-brand-line/50 hover:bg-brand-ink hover:text-brand-bg transition-all cursor-pointer",
                              selectedNodeId === node.id && "bg-brand-line/30"
                            )}
                          >
                            <td className="px-4 py-4">
                              <div className={cn(
                                "w-2 h-2 rounded-full",
                                node.online ? "bg-brand-accent status-glow-green" : "bg-red-500 status-glow-amber opacity-50"
                              )} />
                            </td>
                            <td className="px-4 py-4 data-value text-xs">{node.id}</td>
                            <td className="px-4 py-4">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{node.name}</span>
                                {node.favorite && <Star size={12} className="fill-brand-warning text-brand-warning" />}
                                {node.sensors && <Activity size={12} className="text-brand-accent animate-pulse" />}
                              </div>
                            </td>
                            <td className="px-4 py-4 text-right">
                              <ArrowRight size={16} className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {widget.type === 'NODE_DETAILS' && (
                <div className="technical-panel p-4 h-full">
                  {selectedNode ? (
                    <div className="space-y-6">
                      <div className="flex items-start justify-between">
                        <div>
                          <h2 className="text-xl font-bold tracking-tighter">{selectedNode.name}</h2>
                          <p className="mono-text text-brand-muted uppercase mt-1">{selectedNode.id}</p>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                           <button 
                            onClick={() => setConfiguringNodeId(selectedNode.id)}
                            className="p-2 bg-brand-line hover:bg-brand-accent hover:text-black rounded-lg transition-all"
                          >
                            <Settings size={14} />
                          </button>
                        </div>
                      </div>
                        <div className="grid grid-cols-2 gap-4">
                          <TelemetryItem icon={<Signal size={14}/>} label="RSSI" value={`${selectedNode.telemetry?.rssi} dBm`} />
                          <TelemetryItem icon={<Activity size={14}/>} label="SNR" value={`${selectedNode.telemetry?.snr} dB`} />
                          {selectedNode.telemetry?.distance && (
                            <TelemetryItem 
                              icon={<ArrowsUpFromLine size={14}/>} 
                              label="Distance" 
                              value={unitSystem === 'METRIC' 
                                ? `${selectedNode.telemetry.distance.toFixed(2)} km` 
                                : `${(selectedNode.telemetry.distance * 0.621371).toFixed(2)} mi`
                              } 
                            />
                          )}
                          {selectedNode.position?.alt && (
                            <TelemetryItem 
                              icon={<Compass size={14}/>} 
                              label="Altitude" 
                              value={unitSystem === 'METRIC' 
                                ? `${selectedNode.position.alt.toFixed(0)} m` 
                                : `${(selectedNode.position.alt * 3.28084).toFixed(0)} ft`
                              } 
                            />
                          )}
                        </div>
                      <div className="space-y-2">
                        <p className="text-[10px] text-brand-muted uppercase font-bold tracking-widest">Location Data</p>
                        <div className="p-3 bg-brand-line/30 rounded border border-brand-line mono-text space-y-1 text-[10px]">
                          <p className="flex justify-between"><span>LAT:</span> <span className="text-brand-ink">{selectedNode.position?.lat.toFixed(6)}</span></p>
                          <p className="flex justify-between"><span>LNG:</span> <span className="text-brand-ink">{selectedNode.position?.lng.toFixed(6)}</span></p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-50">
                      <AlertCircle size={32} />
                      <p className="text-xs">Select node to view data</p>
                    </div>
                  )}
                </div>
              )}

              {widget.type === 'MESSAGES' && (
                <div className="technical-panel h-[360px] flex flex-col">
                  <div className="p-4 border-b border-brand-line">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-brand-muted flex items-center gap-2">
                      <MessageSquare size={14} /> Recent Network Traffic
                    </h3>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {messages.slice(-10).reverse().map(m => (
                      <div key={m.id} className="text-[10px]">
                        <div className="flex justify-between text-brand-muted mb-0.5">
                          <span className="font-bold">{nodes.find(n => n.id === m.from)?.name || m.from}</span>
                          <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div className="p-2 bg-brand-line/20 rounded border border-brand-line italic">
                          {m.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {widget.type === 'MAP' && (
                <div className="technical-panel h-[360px] overflow-hidden relative">
                  <div className="absolute inset-0 z-0">
                     <Map defaultCenter={[45.523062, -122.676482]} defaultZoom={10}>
                        {nodes.filter(n => n.position).map(node => (
                          <Marker 
                            key={node.id}
                            width={20}
                            anchor={[node.position!.lat, node.position!.lng]} 
                            color="var(--color-brand-accent)"
                          />
                        ))}
                     </Map>
                  </div>
                  <div className="absolute top-2 left-2 px-2 py-1 bg-brand-bg/80 backdrop-blur-md rounded text-[10px] font-bold uppercase tracking-widest border border-brand-line">
                    Mesh Coverage
                  </div>
                </div>
              )}

              {widget.type === 'SENSOR_DATA' && (
                <div className="technical-panel p-4 h-full">
                  <SensorWidget node={selectedNode || null} allNodes={nodes} unitSystem={unitSystem} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
