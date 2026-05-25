import { useEffect, useState } from 'react';
import { meshDataService } from '../../services/meshDataService';
import { cn } from '../../lib/utils';

const FLASH_MS = 400;

/**
 * Modem-style TX/RX LEDs. Each LED brightens for FLASH_MS milliseconds when
 * its respective event fires, then fades back to dim. Driven by the activity
 * feed in meshDataService — only meaningful in live mode (the simulator
 * doesn't fire these events).
 *
 * Why two LEDs and not a single pulsing icon: separating TX from RX lets the
 * operator see whether the radio is mostly listening (typical, RX-heavy on a
 * busy mesh) or actively transmitting. Mirrors what the official iOS app
 * surfaces.
 */
export function RadioActivityLEDs({ enabled }: { enabled: boolean }) {
  const [txFlashAt, setTxFlashAt] = useState(0);
  const [rxFlashAt, setRxFlashAt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const unsub = meshDataService.onActivity(kind => {
      if (kind === 'tx') setTxFlashAt(Date.now());
      else setRxFlashAt(Date.now());
    });
    return unsub;
  }, [enabled]);

  // Repaint to fade the LED back. We don't need fine-grained animation — the
  // CSS transition handles the visual; we just need to drop the "active" state
  // after FLASH_MS so the indicator settles back to dim.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => setTick(t => t + 1), 100);
    return () => clearInterval(interval);
  }, [enabled]);

  const now = Date.now();
  const txActive = enabled && now - txFlashAt < FLASH_MS;
  const rxActive = enabled && now - rxFlashAt < FLASH_MS;

  return (
    <div className="flex flex-col gap-1 items-center pl-1" aria-label="Radio TX/RX activity">
      <div
        className={cn(
          'w-1.5 h-1.5 rounded-full transition-all duration-300',
          txActive
            ? 'bg-brand-warning shadow-[0_0_4px_var(--brand-warning,#f59e0b)] scale-125'
            : enabled ? 'bg-brand-warning/20' : 'bg-brand-line/40'
        )}
        title={txActive ? 'Transmitting…' : 'TX (transmit) idle'}
      />
      <div
        className={cn(
          'w-1.5 h-1.5 rounded-full transition-all duration-300',
          rxActive
            ? 'bg-brand-accent shadow-[0_0_4px_var(--brand-accent,#10b981)] scale-125'
            : enabled ? 'bg-brand-accent/20' : 'bg-brand-line/40'
        )}
        title={rxActive ? 'Receiving…' : 'RX (receive) idle'}
      />
    </div>
  );
}
