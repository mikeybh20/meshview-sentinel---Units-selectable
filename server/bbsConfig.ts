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

/**
 * v3.0 Subscriber Services — canonical list of Maryland county names
 * as they appear in CHART's `county` field. Kept exactly as CHART
 * returns them so a case-insensitive comparison downstream (in
 * mdotService.listByCounty) works reliably. Ordered alphabetically to
 * match how the settings-UI dropdown will present them.
 *
 * MD has 23 counties + Baltimore City (which CHART treats as its own
 * county-level jurisdiction). Some other CHART records use "Statewide"
 * for cross-county events — not included here since it's not a
 * subscriber-selectable filter target.
 */
export const MD_COUNTIES: readonly string[] = [
  'Allegany', 'Anne Arundel', 'Baltimore', 'Baltimore City',
  'Calvert', 'Caroline', 'Carroll', 'Cecil', 'Charles',
  'Dorchester', 'Frederick', 'Garrett', 'Harford', 'Howard',
  'Kent', 'Montgomery', "Prince George's", "Queen Anne's",
  'Somerset', "St. Mary's", 'Talbot', 'Washington',
  'Wicomico', 'Worcester',
] as const;

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
  /** v3.0 Subscriber Services — trigger keyword for the tide-prediction
   *  lookup. DMing this returns the next few high/low tides for the
   *  operator's configured default station, or a specified station:
   *    :tide            → next tides for default station
   *    :tide 8574680    → next tides for the specified NOAA station id
   *    :tide help / ?   → command catalog
   *  Empty defaultTideStation disables the no-arg form (subscribers
   *  can still query a station explicitly). Must start with `:`.
   *  Default ":tide". */
  tideTrigger: string;
  /** v3.0 Subscriber Services — NOAA CO-OPS station id used when a
   *  subscriber DMs `:tide` with no argument. Seven digits (empty
   *  disables the default-station form). Chesapeake/Maryland
   *  operators typically pick one of: 8574680 Baltimore, 8575512
   *  Annapolis, 8577330 Solomons Island, 8638863 Chesapeake Bay
   *  Bridge Tunnel, 8632200 Kiptopeke VA. */
  defaultTideStation: string;
  /** v3.0 Subscriber Services — trigger for the sun/moon almanac
   *  command. `:sun` with no arg uses sunLocationZip; `:sun 21701`
   *  and `:sun 39.42,-77.41` are one-off overrides. Must start with
   *  `:`. Default ":sun". */
  sunTrigger: string;
  /** v3.0 Subscriber Services — 5-digit US ZIP used as the default
   *  location for `:sun` when a subscriber sends the command with no
   *  argument. Empty disables the no-arg form (subscribers can still
   *  send ":sun <zip>" or ":sun lat,lng"). Typically the operator's
   *  home ZIP (same as homeZipCode) but kept separate so a coastal-
   *  operator can point weather alerts at one location and sun-
   *  almanac at another if they want. */
  sunLocationZip: string;
  /** v3.0 Subscriber Services — trigger for Maryland-DOT traffic
   *  incident lookup. `:mdot` with no arg uses mdotDefaultCounty;
   *  `:mdot Frederick` filters to a specific county; `:mdot all`
   *  returns statewide top-N. Must start with `:`. Default ":mdot". */
  mdotTrigger: string;
  /** v3.0 Subscriber Services — Maryland county name used to filter
   *  `:mdot` when a subscriber sends the command with no argument.
   *  CHART uses proper-case county names without the "County" suffix
   *  ("Frederick", "Baltimore", "Montgomery"). Empty disables the
   *  no-arg default-county filter and returns statewide top-N. Only
   *  MD's 24 counties + Baltimore City are valid values; anything else
   *  gets swapped to empty at load. */
  mdotDefaultCounty: string;
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
  tideTrigger: ':tide',
  defaultTideStation: '',
  sunTrigger: ':sun',
  sunLocationZip: '',
  mdotTrigger: ':mdot',
  mdotDefaultCounty: '',
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
  merged.tideTrigger = sanitizeTrigger(merged.tideTrigger, DEFAULTS.tideTrigger);
  // Empty is valid (disables the no-arg default-station form); otherwise
  // must be 7 digits. Bad input falls back to empty rather than to a
  // default station, so we don't accidentally show Baltimore tides to
  // an operator who typo'd a Californian station id.
  merged.defaultTideStation = /^\d{7}$/.test(String(merged.defaultTideStation ?? '')) ? String(merged.defaultTideStation) : '';
  merged.sunTrigger = sanitizeTrigger(merged.sunTrigger, DEFAULTS.sunTrigger);
  // Same policy as defaultTideStation: empty (disabled) or exactly-
  // 5-digit ZIP; typos fall back to empty rather than silently pointing
  // subscribers at the wrong city.
  merged.sunLocationZip = /^\d{5}$/.test(String(merged.sunLocationZip ?? '')) ? String(merged.sunLocationZip) : '';
  merged.mdotTrigger = sanitizeTrigger(merged.mdotTrigger, DEFAULTS.mdotTrigger);
  // MD's 24 counties + Baltimore City (which CHART treats as its own
  // county-level jurisdiction). Kept in proper case exactly as CHART
  // returns them, so a case-insensitive comparison downstream doesn't
  // have to normalize each row.
  const rawCounty = String(merged.mdotDefaultCounty ?? '').trim();
  merged.mdotDefaultCounty = MD_COUNTIES.find(c => c.toLowerCase() === rawCounty.toLowerCase()) ?? '';

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
  if (
    merged.tideTrigger === merged.mailTrigger ||
    merged.tideTrigger === merged.weatherTrigger ||
    merged.tideTrigger === merged.cmdTrigger ||
    merged.tideTrigger === merged.spotTrigger
  ) {
    merged.tideTrigger = DEFAULTS.tideTrigger;
  }
  if (
    merged.sunTrigger === merged.mailTrigger ||
    merged.sunTrigger === merged.weatherTrigger ||
    merged.sunTrigger === merged.cmdTrigger ||
    merged.sunTrigger === merged.spotTrigger ||
    merged.sunTrigger === merged.tideTrigger
  ) {
    merged.sunTrigger = DEFAULTS.sunTrigger;
  }
  if (
    merged.mdotTrigger === merged.mailTrigger ||
    merged.mdotTrigger === merged.weatherTrigger ||
    merged.mdotTrigger === merged.cmdTrigger ||
    merged.mdotTrigger === merged.spotTrigger ||
    merged.mdotTrigger === merged.tideTrigger ||
    merged.mdotTrigger === merged.sunTrigger
  ) {
    merged.mdotTrigger = DEFAULTS.mdotTrigger;
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
