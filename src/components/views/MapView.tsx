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

// Maryland, home base
const FALLBACK_CENTER: [number, number] = [39.0, -76.7];
const FALLBACK_ZOOM = 9;

export function MapView({
  nodes,
  messages,
  groups,
  traceMessageId,
  setTraceMessageId,
  setSelectedNodeId,
}: MapViewProps) {
  const positioned = nodes.filter(n => n.position);

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

  return (
    <div className="h-full relative">
      <div className="absolute inset-4 technical-panel z-0">
        <Map
          center={center}
          zoom={zoom}
          onBoundsChanged={({ center: c, zoom: z }) => { setCenter(c); setZoom(z); }}
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
