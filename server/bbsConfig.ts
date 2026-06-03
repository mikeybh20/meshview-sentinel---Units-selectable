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
  /** Trigger keyword for the weather subsystem. Must start with `:`.
   *  v2.0 Beta 4: default changed from ":weather" → ":wx" so the help
   *  menu (`:wx` with no args) fits comfortably under the 200-char
   *  Meshtastic packet cap. Existing installs keep their saved trigger;
   *  only fresh defaults pick up ":wx". Operator can rename in Settings. */
  weatherTrigger: string;
  /** Trigger keyword for the global command-index handler. DMing this
   *  returns a one-packet list of every active root trigger so subscribers
   *  can discover what's available without remembering each subcommand.
   *  Must start with `:`. Default ":cmd". */
  cmdTrigger: string;
  /** Hard cap on mail body length, in chars. Meshtastic packet payload tops
   *  out at ~228 bytes after framing; 200 leaves headroom for protocol overhead. */
  bodyMaxChars: number;
  /** Days to retain mail in the DB before auto-pruning, regardless of read state. */
  retentionDays: number;
  /** Minimum gap between successive BBS replies to the same destination, in ms.
   *  Lower values risk firmware rate-limit rejection (err=38). */
  replyPaceMs: number;
  /** Per-session idle timeout in seconds. After this much time without a
   *  message from the operator, the session is reaped — most importantly,
   *  while typing a mail body. Beta 2 shipped 30s which was way too short
   *  for typing a ~200-char body on mobile; bumped to 300s default in
   *  Beta 3 with a 30..1800s clamp so operators on slow phones still have
   *  time, but stale half-finished sessions don't pile up forever. */
  sessionTimeoutSecs: number;
  /** 5-digit US ZIP for home-area weather alert polling. Empty disables the
   *  alert poller (the :weather command is unaffected). */
  homeZipCode: string;
  /** Daily forecast push to weather subscribers, "HH:MM" 24-hour local time.
   *  Empty disables the daily push (subscribers still get NWS alerts).
   *  Default "07:30" — matches operator request for morning weather. The
   *  scheduler uses the server's local timezone (set via `TZ` in
   *  docker-compose); subscribers see the forecast in the operator's
   *  zone, not their own. Skipped when homeZipCode is empty. */
  dailyForecastTime: string;
}

const DEFAULTS: BbsConfig = {
  enabled: true,
  mailTrigger: ':mail',
  weatherTrigger: ':wx',
  cmdTrigger: ':cmd',
  bodyMaxChars: 200,
  retentionDays: 30,
  replyPaceMs: 2_000,
  sessionTimeoutSecs: 300,
  homeZipCode: '',
  dailyForecastTime: '07:30',
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
  merged.cmdTrigger = sanitizeTrigger(merged.cmdTrigger, DEFAULTS.cmdTrigger);

  // Prevent identical triggers (would route everything to whichever check
  // runs first). Collisions snap the colliding trigger back to its default.
  if (merged.mailTrigger === merged.weatherTrigger) {
    merged.weatherTrigger = DEFAULTS.weatherTrigger;
  }
  if (merged.cmdTrigger === merged.mailTrigger || merged.cmdTrigger === merged.weatherTrigger) {
    merged.cmdTrigger = DEFAULTS.cmdTrigger;
  }

  merged.enabled = !!merged.enabled;
  merged.bodyMaxChars = clamp(merged.bodyMaxChars, 50, 228, DEFAULTS.bodyMaxChars);
  merged.retentionDays = clamp(merged.retentionDays, 1, 365, DEFAULTS.retentionDays);
  merged.replyPaceMs = clamp(merged.replyPaceMs, 0, 10_000, DEFAULTS.replyPaceMs);
  // 30s minimum so the reaper still cleans up genuinely abandoned sessions;
  // 30min cap so a forgotten "S → typed a few chars then put phone down" can't
  // hold a slot indefinitely.
  merged.sessionTimeoutSecs = clamp(merged.sessionTimeoutSecs, 30, 1800, DEFAULTS.sessionTimeoutSecs);

  // ZIP: 5 digits or empty.
  const zip = String(merged.homeZipCode ?? '').trim();
  merged.homeZipCode = /^\d{5}$/.test(zip) ? zip : '';

  // Daily-forecast time: "HH:MM" 24h, or empty to disable. Reject anything
  // that's not a valid clock time so a bad value can't silently DOS the
  // scheduler with "never fires" or fire at 99:99.
  const t = String(merged.dailyForecastTime ?? '').trim();
  if (t === '') {
    merged.dailyForecastTime = '';
  } else {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t);
    if (m) {
      // Normalize "7:30" → "07:30" so equality checks downstream are simpler.
      merged.dailyForecastTime = `${m[1].padStart(2, '0')}:${m[2]}`;
    } else {
      merged.dailyForecastTime = DEFAULTS.dailyForecastTime;
    }
  }

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
