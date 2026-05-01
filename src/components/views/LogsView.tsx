import React from 'react';

import { RadioEvent } from '../../types';
import { cn } from '../../lib/utils';

interface LogsViewProps {
  events: RadioEvent[];
}

export function LogsView({ events }: LogsViewProps) {
  return (
    <div className="technical-panel flex-1 flex flex-col">
      <div className="p-4 border-b border-brand-line flex items-center justify-between sticky top-0 bg-brand-bg z-10">
        <h3 className="font-bold flex items-center gap-2 text-xs uppercase tracking-widest text-brand-muted">
          Packet & Event Stream
        </h3>
        <div className="flex gap-2">
          <button className="px-3 py-1 bg-brand-line text-[10px] rounded hover:bg-brand-muted/20 transition-colors uppercase font-bold tracking-tighter">Export CSV</button>
          <button className="px-3 py-1 bg-brand-line text-[10px] rounded hover:bg-brand-muted/20 transition-colors uppercase font-bold tracking-tighter">Clear Console</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto font-mono text-[11px] p-2 space-y-0.5 bg-black/40">
         {events.map(event => (
           <div key={event.id} className="group hover:bg-brand-line/30 flex gap-4 px-2 py-1 rounded transition-colors">
              <span className="text-brand-muted opacity-40 shrink-0">[{new Date(event.timestamp).toLocaleTimeString()}]</span>
              <span className={cn(
                "font-bold shrink-0 w-24",
                event.type === 'MESSAGE' ? "text-blue-400" :
                event.type === 'TELEMETRY' ? "text-brand-accent" :
                event.type === 'NODE_JOINED' ? "text-yellow-400" : "text-brand-muted"
              )}>{event.type}</span>
              <span className="text-brand-ink/80 truncate">{event.details}</span>
              <span className="ml-auto opacity-0 group-hover:opacity-100 text-brand-muted text-[10px] shrink-0">{event.nodeId}</span>
           </div>
         ))}
         {events.length === 0 && (
           <div className="h-full flex items-center justify-center text-brand-muted opacity-30 italic">No network activity recorded...</div>
         )}
      </div>
    </div>
  );
}
