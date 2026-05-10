import React from 'react';
import { motion } from 'motion/react';
import { cn } from '../../lib/utils';

export function NavItem({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 w-full p-3 rounded-lg transition-all group relative",
        active ? "bg-brand-accent text-black" : "text-brand-muted hover:text-brand-ink hover:bg-brand-line"
      )}
    >
      <div className="shrink-0">{icon}</div>
      <span className="font-medium text-sm hidden md:block">{label}</span>
      {active && (
        <motion.div 
          layoutId="sidebar-active"
          className="absolute left-0 w-1 h-6 bg-brand-accent rounded-r-full md:hidden"
        />
      )}
    </button>
  );
}
