/**
 * Convert a 6-digit hex string like "#10b981" to "rgba(16, 185, 129, alpha)".
 * Returns null if the input isn't a recognized hex color so callers can fall
 * back to a default.
 */
export function hexToRgba(hex: string, alpha: number): string | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
