import React from 'react';
import { Users } from 'lucide-react';
import { cn } from '../../lib/utils';

export function GroupItem({ active, onClick, label, color, icon, count }: { active: boolean, onClick: () => void, label: string, color?: string, icon?: React.ReactNode, count: number }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex items-center justify-between w-full p-2 px-3 rounded transition-all group",
        active ? "bg-brand-surface text-brand-ink" : "text-brand-muted hover:text-brand-ink hover:bg-brand-surface/50"
      )}
    >
      <div className="flex items-center gap-2 overflow-hidden">
        {color ? (
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
        ) : icon ? (
          <div className="shrink-0">{icon}</div>
        ) : (
          <Users size={12} className="shrink-0 opacity-50" />
        )}
        <span className="text-xs font-medium truncate">{label}</span>
      </div>
      <span className="text-[10px] mono-text opacity-40 group-hover:opacity-100 transition-opacity">{count}</span>
    </button>
  );
}
