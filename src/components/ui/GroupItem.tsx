import React from 'react';
import { Users, X } from 'lucide-react';
import { cn } from '../../lib/utils';

export function GroupItem({
  active,
  onClick,
  label,
  color,
  icon,
  count,
  onDelete,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
  icon?: React.ReactNode;
  count: number;
  /** When provided, a small × appears on hover to remove the group. */
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between w-full p-2 px-3 rounded transition-all group",
        active ? "bg-brand-surface text-brand-ink" : "text-brand-muted hover:text-brand-ink hover:bg-brand-surface/50"
      )}
    >
      <button
        onClick={onClick}
        className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 text-left"
      >
        {color ? (
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
        ) : icon ? (
          <div className="shrink-0">{icon}</div>
        ) : (
          <Users size={12} className="shrink-0 opacity-50" />
        )}
        <span className="text-xs font-medium truncate">{label}</span>
      </button>
      <div className="flex items-center gap-1 flex-shrink-0">
        <span className="text-[10px] mono-text opacity-40 group-hover:opacity-100 transition-opacity">{count}</span>
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover:opacity-100 text-brand-muted hover:text-red-400 transition-opacity"
            title={`Delete group "${label}"`}
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
