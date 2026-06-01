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
import type { Node } from '../types';

interface RadioBarProps {
  /** Live radio-connected state from the bridge (default radio only in Phase 3a). */
  defaultConnected: boolean;
  /** v2.0 Beta 2: full nodes list. Per-radio counts derive from each node's
   *  heardByRadios so every pill shows its own scope, including disconnected
   *  secondaries (their historical heard-by set is what made the row useful). */
  nodes: Node[];
  /** v2.0 Beta 2: when true, omit the outer border/background so the bar
   *  can sit inside a shared wrapper alongside the ViaFilter. */
  embedded?: boolean;
  /** v2.0 Beta 3: count of unread messages per radio_id. Pills render a
   *  small red badge with the count when > 0 so multi-radio operators can
   *  see at a glance which radio has fresh traffic. */
  unreadByRadio?: Record<string, number>;
}

export function RadioBar({ defaultConnected, nodes, embedded, unreadByRadio }: RadioBarProps) {
  const { radios, defaultRadioId, connectionStates, selectedRadioId, setSelectedRadioId } = useRadios();
  // Pre-compute per-radio heard-by counts so each pill renders its own
  // tally without re-scanning nodes inside the map callback.
  const countByRadio = React.useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const r of radios) out[r.radio_id] = 0;
    for (const n of nodes) {
      for (const rid of n.heardByRadios ?? []) {
        if (out[rid] !== undefined) out[rid] += 1;
      }
    }
    return out;
  }, [radios, nodes]);

  if (radios.length === 0) return null;

  return (
    <div className={embedded
      ? "flex items-center gap-2 overflow-x-auto"
      : "border-b border-brand-line bg-brand-bg/50 px-3 sm:px-6 py-1.5 flex items-center gap-2 overflow-x-auto"
    }>
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
        // Phase 3b: BridgeManager owns the authoritative per-radio
        // connection state for both the default radio (forwarded from
        // meshBridge) and any secondary bridges. Fall back to the prop
        // `defaultConnected` only while connectionStates is still empty
        // (very early boot, before the first fetch).
        const liveConn = connectionStates[r.radio_id];
        const connected = liveConn ? liveConn.connected : (isDefault ? defaultConnected : false);
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
            {/* v2.0 Beta 3: per-radio unread message badge. Surfaces fresh
                traffic on each pill so multi-radio operators don't have to
                click each one to find out which has new messages. */}
            {(unreadByRadio?.[r.radio_id] ?? 0) > 0 && (
              <span className="flex-shrink-0 text-[9px] font-bold mono-text text-white bg-red-500 rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center leading-none">
                {unreadByRadio![r.radio_id] > 99 ? '99+' : unreadByRadio![r.radio_id]}
              </span>
            )}
            {isDefault && <Star size={9} className="text-amber-400 fill-amber-400 flex-shrink-0" />}
            <span className="opacity-70 normal-case font-normal">
              {r.region ?? '?'} · {r.modem_preset ?? '?'} · slot {r.frequency_slot ?? '?'}
            </span>
            {/* v2.0 Beta 2: per-radio node count from heardByRadios. Renders
                for every radio (including disconnected secondaries) so the
                pill tells you "this radio has heard N peers" — primary is
                no longer the only one with a tally. */}
            <span className="opacity-70 normal-case font-normal">
              · {countByRadio[r.radio_id] ?? 0} nodes
            </span>
            <span className={connected ? 'text-emerald-400' : 'text-red-400'}>
              {connected ? '✓' : '✗'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
