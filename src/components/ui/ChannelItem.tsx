import { cn } from '../../lib/utils';

export function ChannelItem({ name, active, count, isDM, lastMsg, onClick }: { name: string, active?: boolean, count?: number, isDM?: boolean, lastMsg: string, onClick: () => void }) {
  return (
    <div 
      onClick={onClick}
      className={cn(
        "p-3 mx-2 my-1 rounded-lg cursor-pointer transition-all border border-transparent",
        active ? "bg-brand-accent/10 border-brand-accent/30" : "hover:bg-brand-line"
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span className={cn("text-xs font-bold uppercase tracking-tight", active && "text-brand-accent")}>
          {isDM ? "@" : "#"} {name}
        </span>
        {count && <span className="text-[8px] bg-brand-line px-1.5 rounded-full mono-text opacity-50">{count}</span>}
      </div>
      <p className="text-[10px] text-brand-muted truncate grayscale group-hover:grayscale-0">{lastMsg}</p>
    </div>
  );
}
