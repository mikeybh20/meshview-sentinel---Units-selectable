import { Lock } from 'lucide-react';
import { cn } from '../../lib/utils';

export function ChannelItem({ name, active, count, isDM, isPkc, lastMsg, onClick }: { name: string, active?: boolean, count?: number, isDM?: boolean, isPkc?: boolean, lastMsg: string, onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "p-3 mx-2 my-1 rounded-lg cursor-pointer transition-all border border-transparent",
        active ? "bg-brand-accent/10 border-brand-accent/30" : "hover:bg-brand-line"
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span className={cn("text-xs font-bold uppercase tracking-tight flex items-center gap-1.5", active && "text-brand-accent")}>
          {isDM ? "@" : "#"} {name}
          {isPkc && (
            <Lock
              size={10}
              className="text-brand-accent flex-shrink-0"
              aria-label="PKC encrypted"
            >
              <title>PKC encrypted</title>
            </Lock>
          )}
        </span>
        {count !== undefined && count > 0 && (
          <span
            className="text-[9px] font-bold bg-emerald-500 text-emerald-950 px-1.5 py-0.5 rounded-full mono-text"
            title={`${count} unread`}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </div>
      <p className="text-[10px] text-brand-muted truncate grayscale group-hover:grayscale-0">{lastMsg}</p>
    </div>
  );
}
