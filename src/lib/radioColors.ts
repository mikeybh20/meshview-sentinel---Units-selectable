/**
 * v2.0 multi-radio — shared color palette.
 *
 * Kept in lockstep with `RADIO_COLOR_PALETTE` in [../../server/api.ts](../../server/api.ts).
 * Radios get auto-assigned a hue from this palette on add; operators can
 * override per-radio in the Settings → Radios editor.
 */
export const RADIO_COLOR_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
] as const;

export function nextRadioColor(existing: string[]): string {
  for (const c of RADIO_COLOR_PALETTE) {
    if (!existing.includes(c)) return c;
  }
  return RADIO_COLOR_PALETTE[existing.length % RADIO_COLOR_PALETTE.length];
}
