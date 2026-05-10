import React, { useEffect, useRef, useState } from 'react';
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
  onRename,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
  icon?: React.ReactNode;
  count: number;
  /** When provided, a small × appears on hover to remove the group. */
  onDelete?: () => void;
  /** When provided, double-clicking the label opens an inline rename input. */
  onRename?: (newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(label);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, label]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== label) onRename?.(next);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(label);
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between w-full p-2 px-3 rounded transition-all group",
        active ? "bg-brand-surface text-brand-ink" : "text-brand-muted hover:text-brand-ink hover:bg-brand-surface/50"
      )}
    >
      {editing ? (
        <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
          {color ? (
            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          ) : icon ? (
            <div className="shrink-0">{icon}</div>
          ) : (
            <Users size={12} className="shrink-0 opacity-50" />
          )}
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            }}
            maxLength={40}
            className="flex-1 min-w-0 text-xs font-medium bg-brand-bg border border-brand-line rounded px-1.5 py-0.5 text-brand-ink focus:outline-none focus:border-brand-accent"
          />
        </div>
      ) : (
        <button
          onClick={onClick}
          onDoubleClick={(e) => {
            if (onRename) { e.stopPropagation(); setEditing(true); }
          }}
          className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 text-left"
          title={onRename ? `${label} (double-click to rename)` : label}
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
      )}
      <div className="flex items-center gap-1 flex-shrink-0">
        <span className="text-[10px] mono-text opacity-40 group-hover:opacity-100 transition-opacity">{count}</span>
        {onDelete && !editing && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover:opacity-100 text-brand-muted hover:text-brand-error transition-opacity"
            title={`Delete group "${label}"`}
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
