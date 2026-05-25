import React from 'react';
import { motion } from 'motion/react';
import { cn } from '../../lib/utils';

export function NavItem({ active, onClick, icon, label, badge }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string, badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 w-full p-3 rounded-lg transition-all group relative",
        active ? "bg-brand-accent text-black" : "text-brand-muted hover:text-brand-ink hover:bg-brand-line"
      )}
    >
      <div className="shrink-0 relative">
        {icon}
        {badge !== undefined && badge > 0 && (
          // At collapsed (icon-only) widths there's no room for a number — show
          // a small dot anchored to the icon so the user still sees "new" state.
          <span
            className="md:hidden absolute -top-1 -right-1 w-2 h-2 rounded-full bg-brand-warning ring-2 ring-brand-bg"
            aria-label={`${badge} unread`}
          />
        )}
      </div>
      <span className="font-medium text-sm hidden md:block">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            "hidden md:inline-flex ml-auto min-w-[20px] h-5 items-center justify-center px-1.5 text-[10px] font-bold mono-text rounded-full",
            active ? "bg-black/30 text-black" : "bg-brand-warning text-brand-bg"
          )}
          title={`${badge} unread`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {active && (
        <motion.div
          layoutId="sidebar-active"
          className="absolute left-0 w-1 h-6 bg-brand-accent rounded-r-full md:hidden"
        />
      )}
    </button>
  );
}
