import { Wifi } from 'lucide-react';
import { cn } from '../../lib/utils';

export function HopNode({ id, name, active }: { id: string, name: string, active?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 z-10">
       <div className={cn(
         "w-10 h-10 rounded shadow-lg flex items-center justify-center border-2 transition-all",
         active ? "bg-brand-accent border-brand-accent text-black scale-110 status-glow-green" : "bg-brand-surface border-brand-line text-brand-muted"
       )}>
          <Wifi size={18} />
       </div>
       <div className="text-center">
          <p className="text-[10px] font-bold uppercase tracking-tighter">{name}</p>
          <p className="text-[8px] mono-text opacity-30">{id}</p>
       </div>
    </div>
  )
}
