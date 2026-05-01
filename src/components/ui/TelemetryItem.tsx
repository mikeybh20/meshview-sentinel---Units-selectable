import React from 'react';

export function TelemetryItem({ icon, label, value }: { icon: React.ReactNode, label: string, value: string }) {
  return (
    <div className="p-3 bg-brand-line/20 rounded border border-brand-line flex items-center gap-3">
      <div className="text-brand-accent opacity-70">{icon}</div>
      <div>
        <p className="text-[9px] uppercase font-bold text-brand-muted tracking-widest leading-none mb-1">{label}</p>
        <p className="mono-text font-bold text-sm tracking-tighter">{value}</p>
      </div>
    </div>
  );
}
