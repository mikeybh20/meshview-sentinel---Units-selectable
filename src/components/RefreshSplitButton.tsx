/**
 * v2.0 multi-radio — Refresh split-button.
 *
 * Main button refreshes the default radio (Phase 3a) / all enabled radios
 * (Phase 3b). The chevron opens a dropdown listing each configured radio
 * individually so the operator can refresh one in isolation.
 *
 * Replaces the single Refresh button in the header. Pre-multi-radio installs
 * (zero rows in the radios table) collapse to a single button with no chevron.
 */
import React from 'react';
import { RefreshCw, ChevronDown, Star } from 'lucide-react';
import { useRadios } from '../hooks/useRadios';
import { cn } from '../lib/utils';

export type RefreshState = 'idle' | 'pending' | 'ok' | 'err';

interface Props {
  state: RefreshState;
  disabled: boolean;
  radioConnected: boolean;
  /** Called with `null` to refresh all, or a specific `radio_id`. */
  onRefresh: (radioId: string | null) => void;
}

export function RefreshSplitButton({ state, disabled, radioConnected, onRefresh }: Props) {
  const { radios, defaultRadioId } = useRadios();
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);

  // Close on click-outside
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const colorClasses = cn(
    state === 'ok' && "border-brand-accent text-brand-accent",
    state === 'err' && "border-brand-danger text-brand-danger",
    state !== 'ok' && state !== 'err' && "border-brand-line text-brand-muted hover:text-brand-accent hover:border-brand-accent/40",
    disabled && "opacity-50 cursor-not-allowed"
  );

  const label =
    state === 'pending' ? 'REFRESHING' :
    state === 'ok'      ? 'REFRESHED' :
    state === 'err'     ? 'FAILED' :
                          'REFRESH';

  const title = !radioConnected
    ? 'Connect a radio first'
    : state === 'err'
      ? 'Refresh failed — see server logs'
      : 'Re-pull NodeDB / channels / module configs from the radio';

  // Pre-multi-radio: collapse to plain button.
  if (radios.length === 0) {
    return (
      <button
        onClick={() => onRefresh(null)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors",
          colorClasses,
        )}
        title={title}
      >
        <RefreshCw size={14} className={cn(state === 'pending' && 'animate-spin')} />
        <span className="text-xs font-medium mono-text hidden md:inline">{label}</span>
      </button>
    );
  }

  return (
    <div ref={wrapperRef} className="relative flex items-stretch">
      <button
        onClick={() => onRefresh(null)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-l-full border border-r-0 transition-colors",
          colorClasses,
        )}
        title={title}
      >
        <RefreshCw size={14} className={cn(state === 'pending' && 'animate-spin')} />
        <span className="text-xs font-medium mono-text hidden md:inline">{label}</span>
      </button>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled || state === 'pending'}
        className={cn(
          "px-2 py-1.5 rounded-r-full border transition-colors",
          colorClasses,
        )}
        title="Refresh a specific radio"
      >
        <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-brand-bg border border-brand-line rounded-md shadow-lg z-50 overflow-hidden">
          <button
            onClick={() => { setOpen(false); onRefresh(null); }}
            className="w-full text-left px-3 py-2 text-xs hover:bg-brand-line/50 transition-colors"
          >
            <span className="font-bold text-brand-ink">Refresh all radios</span>
            <p className="text-[10px] text-brand-muted mt-0.5">Re-pull NodeDB on every enabled radio</p>
          </button>
          <div className="h-px bg-brand-line" />
          {radios.map(r => {
            const isDefault = r.radio_id === defaultRadioId;
            return (
              <button
                key={r.radio_id}
                onClick={() => { setOpen(false); onRefresh(r.radio_id); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-brand-line/50 transition-colors flex items-center gap-2"
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: r.color_hex ?? '#666' }}
                />
                <span className="mono-text font-bold text-brand-ink">{r.radio_id}</span>
                {isDefault && <Star size={9} className="text-amber-400 fill-amber-400" />}
                <span className="text-[10px] text-brand-muted truncate">
                  {r.network_label ?? r.long_name}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
