/**
 * v2.0 Beta 2 — RF / MQTT filter strip.
 *
 * Today the dashboard's 200+ node list mixes two very different things:
 * peers actually reachable over LoRa, and peers we only see because the
 * radio's MQTT module is subscribed to public-broker topics. Operators
 * trying to triage signal quality or plan a deployment want to look at
 * just the RF set; operators investigating cross-mesh traffic want just
 * MQTT. This chip strip is the toggle.
 *
 * State lives in App.tsx as `selectedVia: 'all' | 'lora' | 'mqtt'` and
 * threads into the filteredNodes pipeline alongside the radio + group +
 * search filters.
 */
import React from 'react';
import { Wifi, Cloud } from 'lucide-react';
import { cn } from '../lib/utils';

export type ViaFilterValue = 'all' | 'lora' | 'mqtt';

interface ViaFilterProps {
  value: ViaFilterValue;
  onChange: (v: ViaFilterValue) => void;
  /** Counts shown inline on each chip. Pass post-radio-filter counts so
   *  the numbers match what the operator will actually see in the list. */
  counts: { all: number; lora: number; mqtt: number };
}

export function ViaFilter({ value, onChange, counts }: ViaFilterProps) {
  // Hide the strip when there's no MQTT traffic in scope — keeps the UI
  // quiet for RF-only operators. Show it as soon as there's something
  // to filter against.
  if (counts.mqtt === 0 && counts.lora === counts.all) return null;

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <Chip
        active={value === 'all'}
        onClick={() => onChange('all')}
        label={`All · ${counts.all}`}
        title="Show every node regardless of how its last packet reached us"
      />
      <Chip
        active={value === 'lora'}
        onClick={() => onChange('lora')}
        label={`LoRa · ${counts.lora}`}
        icon={<Wifi size={10} />}
        title="Only nodes whose last packet arrived over RF (your actual physical mesh)"
      />
      <Chip
        active={value === 'mqtt'}
        onClick={() => onChange('mqtt')}
        label={`MQTT · ${counts.mqtt}`}
        icon={<Cloud size={10} />}
        title="Only nodes whose last packet arrived via the MQTT bridge (typically out of RF range)"
      />
    </div>
  );
}

function Chip({ active, onClick, label, icon, title }: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full border transition-colors",
        active
          ? "bg-brand-accent/15 border-brand-accent/50 text-brand-accent"
          : "border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-accent/30"
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
