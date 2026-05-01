import React from 'react';
import { Signal } from 'lucide-react';
import { Map, Marker, ZoomControl } from "pigeon-maps";

import { Node, Message, Group } from '../../types';
import { MeshLinks } from '../ui/MeshLinks';
import { TraceLinks } from '../ui/TraceLinks';

interface MapViewProps {
  nodes: Node[];
  messages: Message[];
  groups: Group[];
  traceMessageId: string | null;
  setTraceMessageId: (id: string | null) => void;
  setSelectedNodeId: (id: string) => void;
}

export function MapView({
  nodes,
  messages,
  groups,
  traceMessageId,
  setTraceMessageId,
  setSelectedNodeId,
}: MapViewProps) {
  return (
    <div className="h-full relative">
      <div className="absolute inset-4 technical-panel z-0">
        <Map 
          defaultCenter={[45.523062, -122.676482]} 
          defaultZoom={12}
          dprs={[1, 2]}
        >
          <ZoomControl />
          
          {/* Signal Layer (Actual Link Visualization) */}
          <MeshLinks nodes={nodes} />
          
          {/* Message Trace Layer */}
          <TraceLinks nodes={nodes} messages={messages} traceMessageId={traceMessageId} />

          {nodes.filter(n => n.position).map(node => (
            <Marker 
              key={node.id}
              width={30}
              anchor={[node.position!.lat, node.position!.lng]} 
              onClick={() => setSelectedNodeId(node.id)}
              color={node.favorite ? "var(--color-brand-warning)" : "var(--color-brand-accent)"}
            />
          ))}
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
    </div>
  );
}
