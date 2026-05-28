/**
 * BBS configuration — persisted to `data/bbs-config.json` so settings survive
 * container rebuilds. Mirrored to clients via SSE so multiple dashboard tabs
 * stay in sync. Defaults applied at load time so adding new fields here
 * doesn't require migrating existing config files.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve alongside the SQLite DB (server/database.ts uses the same
// __dirname-relative `data/` dir): /app/data in Docker, <repo>/data in dev.
// MESHVIEW_DATA_DIR overrides for custom deployments.
const CONFIG_PATH = process.env.MESHVIEW_DATA_DIR
  ? join(process.env.MESHVIEW_DATA_DIR, 'bbs-config.json')
  : join(__dirname, '..', 'data', 'bbs-config.json');

export interface BbsConfig {
  /** Master switch. When false, ALL BBS triggers are ignored and the state
   *  machine never engages. DMs to the local node flow through to the normal
   *  message log instead. */
  enabled: boolean;
  /** Trigger keyword for the mail subsystem. Must start with `:`. */
  mailTrigger: string;
  /** Trigger keyword for the weather subsystem. Must start with `:`. */
  weatherTrigger: string;
  /** Hard cap on mail body length, in chars. Meshtastic packet payload tops
   *  out at ~228 bytes after framing; 200 leaves headroom for protocol overhead. */
  bodyMaxChars: number;
  /** Days to retain mail in the DB before auto-pruning, regardless of read state. */
  retentionDays: number;
  /** Minimum gap between successive BBS replies to the same destination, in ms.
   *  Lower values risk firmware rate-limit rejection (err=38). */
  replyPaceMs: number;
  /** 5-digit US ZIP for home-area weather alert polling. Empty disables the
   *  alert poller (the :weather command is unaffected). */
  homeZipCode: string;
}

const DEFAULTS: BbsConfig = {
  enabled: true,
  mailTrigger: ':mail',
  weatherTrigger: ':weather',
  bodyMaxChars: 200,
  retentionDays: 30,
  replyPaceMs: 2_000,
  homeZipCode: '',
};

/** Validate + clamp config inputs to safe ranges so a bad POST body can't
 *  brick the BBS. Returns a fully-populated config. */
export function normalizeBbsConfig(partial: Partial<BbsConfig>): BbsConfig {
  const merged = { ...DEFAULTS, ...partial };

  // Triggers: must start with `:`, must be 2-16 chars total, lowercase enforced.
  const sanitizeTrigger = (raw: unknown, fallback: string): string => {
    if (typeof raw !== 'string') return fallback;
    const t = raw.trim().toLowerCase();
    if (!t.startsWith(':')) return fallback;
    if (t.length < 2 || t.length > 16) return fallback;
    if (!/^:[a-z0-9_-]+$/.test(t)) return fallback;
    return t;
  };

  merged.mailTrigger = sanitizeTrigger(merged.mailTrigger, DEFAULTS.mailTrigger);
  merged.weatherTrigger = sanitizeTrigger(merged.weatherTrigger, DEFAULTS.weatherTrigger);

  // Prevent identical triggers (would route everything to whichever check runs first).
  if (merged.mailTrigger === merged.weatherTrigger) {
    merged.weatherTrigger = DEFAULTS.weatherTrigger;
  }

  merged.enabled = !!merged.enabled;
  merged.bodyMaxChars = clamp(merged.bodyMaxChars, 50, 228, DEFAULTS.bodyMaxChars);
  merged.retentionDays = clamp(merged.retentionDays, 1, 365, DEFAULTS.retentionDays);
  merged.replyPaceMs = clamp(merged.replyPaceMs, 0, 10_000, DEFAULTS.replyPaceMs);

  // ZIP: 5 digits or empty.
  const zip = String(merged.homeZipCode ?? '').trim();
  merged.homeZipCode = /^\d{5}$/.test(zip) ? zip : '';

  return merged;
}

function clamp(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function loadBbsConfig(): BbsConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      console.log('[BBSConfig] No config file — using defaults');
      return { ...DEFAULTS };
    }
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BbsConfig>;
    const normalized = normalizeBbsConfig(parsed);
    console.log(`[BBSConfig] Loaded from ${CONFIG_PATH}: enabled=${normalized.enabled} mailTrigger="${normalized.mailTrigger}" weatherTrigger="${normalized.weatherTrigger}" homeZip="${normalized.homeZipCode || '(unset)'}"`);
    return normalized;
  } catch (err: any) {
    console.error(`[BBSConfig] Load failed (${err.message}) — using defaults`);
    return { ...DEFAULTS };
  }
}

export function saveBbsConfig(config: BbsConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[BBSConfig] Saved to ${CONFIG_PATH}`);
  } catch (err: any) {
    console.error('[BBSConfig] Save failed:', err.message);
    throw err;
  }
}

export function defaultBbsConfig(): BbsConfig {
  return { ...DEFAULTS };
}
