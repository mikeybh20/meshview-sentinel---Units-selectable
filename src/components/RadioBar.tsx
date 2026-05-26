/**
 * v2.0 multi-radio — RadioBar.
 *
 * Slim horizontal strip below the header that lists every configured radio
 * as a colored pill. Clicking a pill scopes node/message/event views to
 * that radio. Clicking "All" clears the filter. The default radio is marked
 * with a star.
 *
 * Pill format: `[SHORT] · region · preset · slot N · n nodes ✓/✗`
 *
 * Hidden entirely when zero radios are configured (cold-boot before the
 * first hardware identity arrives).
 */
import React from 'react';
import { Star } from 'lucide-react';
import { useRadios } from '../hooks/useRadios';
import { cn } from '../lib/utils';

interface RadioBarProps {
  /** Live radio-connected state from the bridge (default radio only in Phase 3a). */
  defaultConnected: boolean;
  /** Total node count, used as the "n nodes" badge until per-radio counts land. */
  totalNodes: number;
}

export function RadioBar({ defaultConnected, totalNodes }: RadioBarProps) {
  const { radios, defaultRadioId, selectedRadioId, setSelectedRadioId } = useRadios();

  if (radios.length === 0) return null;

  return (
    <div className="border-b border-brand-line bg-brand-bg/50 px-3 sm:px-6 py-1.5 flex items-center gap-2 overflow-x-auto">
      <button
        onClick={() => setSelectedRadioId(null)}
        className={cn(
          "text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full border transition-colors flex-shrink-0",
          selectedRadioId === null
            ? "bg-brand-accent/15 border-brand-accent/50 text-brand-accent"
            : "border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-accent/30"
        )}
      >
        All Radios
      </button>
      {radios.map(r => {
        const isSelected = selectedRadioId === r.radio_id;
        const isDefault = r.radio_id === defaultRadioId;
        // Connection status only known for the default radio in Phase 3a;
        // secondary radios fall back to the row's `enabled` flag until
        // Phase 3b lights up per-radio bridge state.
        const connected = isDefault ? defaultConnected : !!r.enabled;
        return (
          <button
            key={r.radio_id}
            onClick={() => setSelectedRadioId(r.radio_id)}
            title={[
              r.long_name,
              r.network_label,
              `${r.region ?? '?region'} · ${r.modem_preset ?? '?preset'}`,
              `Frequency Slot ${r.frequency_slot ?? '?'}`,
              `${r.num_hops ?? '?'} hops`,
            ].filter(Boolean).join('\n')}
            className={cn(
              "flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full border transition-colors flex-shrink-0",
              isSelected
                ? "bg-brand-accent/15 border-brand-accent/50 text-brand-accent"
                : "border-brand-line text-brand-muted hover:text-brand-ink hover:border-brand-accent/30"
            )}
            style={
              isSelected && r.color_hex
                ? { borderColor: r.color_hex, color: r.color_hex }
                : undefined
            }
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: r.color_hex ?? '#666' }}
            />
            <span className="mono-text">{r.radio_id}</span>
            {isDefault && <Star size={9} className="text-amber-400 fill-amber-400 flex-shrink-0" />}
            <span className="opacity-70 normal-case font-normal">
              {r.region ?? '?'} · {r.modem_preset ?? '?'} · slot {r.frequency_slot ?? '?'}
            </span>
            {isDefault && (
              <span className="opacity-70 normal-case font-normal">
                · {totalNodes} nodes
              </span>
            )}
            <span className={connected ? 'text-emerald-400' : 'text-red-400'}>
              {connected ? '✓' : '✗'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
