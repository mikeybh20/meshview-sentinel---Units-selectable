import React from 'react';

export function StatCard({ label, value, subValue, icon }: { label: string, value: string, subValue: string, icon: React.ReactNode }) {
  return (
    <div className="technical-panel p-4 flex flex-col gap-4 bg-brand-bg/40 backdrop-blur-sm group hover:border-brand-accent/50 transition-all">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-muted">{label}</span>
        <div className="p-2 rounded bg-brand-line group-hover:bg-brand-accent/10 transition-colors">
          {icon}
        </div>
      </div>
      <div>
        <h3 className="text-2xl font-bold tracking-tighter">{value}</h3>
        <p className="text-[10px] mono-text opacity-50 mt-1 uppercase tracking-wider">{subValue}</p>
      </div>
    </div>
  );
}
