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
  /** v3.0 SKYWARN: trigger keyword for the storm-spotter :spot flow.
   *  DMing this to the BBS starts a multi-step form that produces a
   *  Local Storm Report row (see storm_reports table). Must start with
   *  `:`. Default ":spot". */
  spotTrigger: string;
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
  /** v2.0 Beta 5: array of daily forecast push times, each "HH:MM"
   *  24-hour local time. Default ['07:30', '12:00', '17:30'] — morning,
   *  midday, evening per operator request. Empty array disables the
   *  daily push (subscribers still get NWS alerts). Scheduler fires
   *  each entry once per day; tracked per-time so a 12:00 push fires
   *  even if the 07:30 one was missed. Timezone is the server's local
   *  zone (set via `TZ` in docker-compose); subscribers see the
   *  forecast in the operator's zone, not their own. Skipped when
   *  homeZipCode is empty.
   *
   *  Back-compat: the old `dailyForecastTime: string` field still loads
   *  — normalizeBbsConfig migrates it into a single-element array. */
  dailyForecastTimes: string[];
}

const DEFAULTS: BbsConfig = {
  enabled: true,
  mailTrigger: ':mail',
  weatherTrigger: ':wx',
  cmdTrigger: ':cmd',
  spotTrigger: ':spot',
  bodyMaxChars: 200,
  retentionDays: 30,
  replyPaceMs: 2_000,
  sessionTimeoutSecs: 300,
  homeZipCode: '',
  dailyForecastTimes: ['07:30', '12:00', '17:30'],
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
  merged.spotTrigger = sanitizeTrigger(merged.spotTrigger, DEFAULTS.spotTrigger);

  // Prevent identical triggers (would route everything to whichever check
  // runs first). Collisions snap the colliding trigger back to its default.
  if (merged.mailTrigger === merged.weatherTrigger) {
    merged.weatherTrigger = DEFAULTS.weatherTrigger;
  }
  if (merged.cmdTrigger === merged.mailTrigger || merged.cmdTrigger === merged.weatherTrigger) {
    merged.cmdTrigger = DEFAULTS.cmdTrigger;
  }
  if (
    merged.spotTrigger === merged.mailTrigger ||
    merged.spotTrigger === merged.weatherTrigger ||
    merged.spotTrigger === merged.cmdTrigger
  ) {
    merged.spotTrigger = DEFAULTS.spotTrigger;
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

  // Daily-forecast times: array of "HH:MM" 24h strings. Invalid entries
  // are silently dropped (rather than snapping to defaults) so partial
  // updates from the UI don't blow away the operator's good values.
  // Empty array disables the daily push entirely; subscribers still
  // get NWS alerts on the regular poll cadence.
  //
  // Back-compat: if the input only has the old singular
  // `dailyForecastTime` field (string), promote it to a one-element
  // array. Lets pre-Beta-5 configs upgrade without surgery.
  const normalizeTime = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    if (!t) return null;
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t);
    if (!m) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  };
  let rawTimes: unknown[] = [];
  if (Array.isArray((partial as any).dailyForecastTimes)) {
    rawTimes = (partial as any).dailyForecastTimes;
  } else if (Array.isArray((merged as any).dailyForecastTimes)) {
    rawTimes = (merged as any).dailyForecastTimes;
  } else if (typeof (partial as any).dailyForecastTime === 'string') {
    // Pre-Beta-5 singular field — migrate.
    rawTimes = [(partial as any).dailyForecastTime];
  }
  const normalized = Array.from(new Set(
    rawTimes.map(normalizeTime).filter((x): x is string => !!x)
  )).sort();
  // If the caller sent something but every entry was invalid, fall back
  // to defaults rather than silently disabling. If they sent an
  // explicit empty array, honor it (disables).
  if (rawTimes.length > 0 && normalized.length === 0) {
    merged.dailyForecastTimes = [...DEFAULTS.dailyForecastTimes];
  } else {
    merged.dailyForecastTimes = normalized;
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
    console.log(`[BBSConfig] Loaded from ${CONFIG_PATH}: enabled=${normalized.enabled} mailTrigger="${normalized.mailTrigger}" weatherTrigger="${normalized.weatherTrigger}" homeZip="${normalized.homeZipCode || '(unset)'}" dailyForecastTimes=[${normalized.dailyForecastTimes.join(',') || '<disabled>'}]`);
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
