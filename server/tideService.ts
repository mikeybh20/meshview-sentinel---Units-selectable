/**
 * v3.0 Subscriber Services — tide predictions for the `:tide` BBS command.
 *
 * Backs by NOAA CO-OPS (Tides and Currents) — free, no auth, US
 * government-operated. The API is stable and well-documented at
 * https://api.tidesandcurrents.noaa.gov/api/prod/datagetter/
 *
 * Query shape: predictions of type "hilo" (high/low events only, not
 * the raw 6-minute observation series) for the next 24-48 hours,
 * in station-local time, MLLW datum (Mean Lower Low Water — the
 * standard US tidal reference), English units (feet).
 *
 * Caching:
 *   - Predictions cached 15 minutes per station. NOAA calculates
 *     these years in advance so they don't change hour-by-hour;
 *     the 15-minute cache is defensive against burst subscriber
 *     requests during a fishing tournament, not because the data
 *     drifts.
 *   - Station metadata (name, timezone abbreviation) cached for
 *     the process lifetime. Station metadata is effectively static.
 *
 * Chesapeake Bay / Maryland station references (for operators
 * setting the default station):
 *   8574680  Baltimore
 *   8575512  Annapolis
 *   8577330  Solomons Island
 *   8638863  Chesapeake Bay Bridge Tunnel
 *   8632200  Kiptopeke, VA
 */

interface TidePrediction {
  /** Epoch ms of the predicted high or low. */
  timestamp: number;
  /** Original NOAA time string in station-local time — kept for
   *  display so the reply doesn't have to reason about timezone
   *  conversion when the operator serves a mixed-timezone audience. */
  localTimeStr: string;
  /** Water height above datum, in feet (MLLW datum). */
  heightFeet: number;
  /** 'H' = high tide, 'L' = low tide. */
  type: 'H' | 'L';
}

interface StationMeta {
  name: string;
  state: string;
  timeZoneAbbrev: string; // e.g. "EST" / "EDT" / "PST" / "PDT"
}

interface PredictionCache {
  predictions: TidePrediction[];
  cachedAt: number;
}

/**
 * v3.0 refresh policy (operator-set — see conversation on cache
 * strategy).
 *
 * NOAA computes tide predictions years in advance, so there's no
 * benefit to hammering the API on a short polling cadence. Instead:
 *
 *   - The operator's DEFAULT station is refreshed by a scheduler
 *     at four fixed times per server-local day: 00:00, 06:00,
 *     12:00, 18:00. If a scheduled fetch fails, retry every 20
 *     minutes until success or the next scheduled tick — whichever
 *     comes first (a scheduled tick supersedes a pending retry).
 *
 *   - NON-DEFAULT stations (subscriber types `:tide 8632200` for
 *     some station that isn't the operator's default) are fetched
 *     on demand and cached for 6h. That aligns the cache TTL with
 *     the scheduler's cadence — a station queried at 10am gets
 *     re-fetched at ~4pm if queried again, matching what the
 *     default station's schedule would produce.
 *
 *   - On startup the scheduler primes the cache with one immediate
 *     fetch so subscribers querying just after boot get data
 *     instead of an empty cache.
 *
 * Net result: at most 4 NOAA calls/day/station for the default,
 * plus a handful of on-demand calls for whatever ad-hoc stations
 * subscribers ask about — versus the 96/day/station ceiling a
 * naive 15-min TTL would allow.
 */
const SCHEDULED_TICK_HOURS: readonly number[] = [0, 6, 12, 18];
const ON_DEMAND_TTL_MS = 6 * 3600_000;
const RETRY_INTERVAL_MS = 20 * 60_000;
const STARTUP_BOOTSTRAP_DELAY_MS = 5_000;

const NOAA_UA = process.env.MESHVIEW_NOAA_UA
  || 'MeshViewSentinel/1.0 (https://github.com/mikeybh20/meshview-sentinel)';

/** Response from CO-OPS datagetter for product=predictions. */
interface NoaaPredictionsResponse {
  predictions?: Array<{
    t: string;      // "2026-07-01 12:34" — station-local time
    v: string;      // "2.345" — height in feet
    type: 'H' | 'L';
  }>;
  error?: {
    message: string;
  };
}

/** Response from the MD-API stations endpoint. */
interface NoaaStationResponse {
  stations?: Array<{
    id: string;
    name: string;
    state: string;
    timezone: string;      // "EST" or similar
    timezonecorr: string;  // e.g. "-5" — UTC offset in hours
  }>;
}

class TideService {
  private predictionCache = new Map<string, PredictionCache>();
  private stationCache = new Map<string, StationMeta>();
  // v3.0 scheduler state — see refresh-policy doc block near top of file.
  private scheduleTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private getDefaultStation: (() => string) | null = null;

  /**
   * Fetch the next `count` high/low tide events for the given station,
   * starting from now. Cache-first — a fresh cache entry (< 6h) is
   * always served without hitting NOAA. Only cache misses AND stale
   * entries trigger a live fetch. For the operator's default station,
   * the scheduler keeps the cache fresh; for non-default stations
   * this path is the primary source of cache entries.
   *
   * Throws on invalid station ID, network failure, or NOAA error
   * response — the BBS handler catches and shows the operator-friendly
   * fallback reply.
   */
  async getNextTides(stationId: string, count: number = 4): Promise<TidePrediction[]> {
    if (!/^\d{7}$/.test(stationId)) {
      throw new Error(`Station ID must be 7 digits — got "${stationId}"`);
    }

    const cached = this.predictionCache.get(stationId);
    if (cached && Date.now() - cached.cachedAt < ON_DEMAND_TTL_MS) {
      // Filter out any events already in the past — a cache hit near
      // the top of the tide cycle would otherwise show the event that
      // just occurred.
      return cached.predictions
        .filter(p => p.timestamp >= Date.now())
        .slice(0, count);
    }

    // On-demand fetch fallback — happens for non-default stations on
    // first query, or (rarely) for the default station queried before
    // the scheduler has run for the first time on this process.
    const fresh = await this.fetchAndCache(stationId);
    return fresh
      .filter(p => p.timestamp >= Date.now())
      .slice(0, count);
  }

  /**
   * Fetch predictions from NOAA and update the cache. Bypasses cache-
   * freshness checks — used both by the scheduler (which needs to
   * force a refresh regardless of cache state) and by getNextTides()
   * on a cache miss. Returns the newly-parsed predictions.
   */
  private async fetchAndCache(stationId: string): Promise<TidePrediction[]> {
    // Query for the next 48 hours to guarantee we get enough events
    // even at the tail of a tidal cycle. NOAA returns 4-6 events per
    // 48h window depending on the station's tidal type.
    const now = new Date();
    const later = new Date(now.getTime() + 48 * 3600_000);
    const beginDate = yyyymmdd(now);
    const endDate = yyyymmdd(later);

    const url = new URL('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter');
    url.searchParams.set('product', 'predictions');
    url.searchParams.set('station', stationId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('datum', 'MLLW');
    url.searchParams.set('units', 'english');
    url.searchParams.set('time_zone', 'lst_ldt');
    url.searchParams.set('interval', 'hilo');
    url.searchParams.set('begin_date', beginDate);
    url.searchParams.set('end_date', endDate);

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': NOAA_UA, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`NOAA CO-OPS HTTP ${res.status}`);
    }
    const data = await res.json() as NoaaPredictionsResponse;
    if (data.error) {
      // NOAA returns 200 OK with an error envelope for bad station IDs.
      throw new Error(`NOAA: ${data.error.message}`);
    }
    if (!Array.isArray(data.predictions) || data.predictions.length === 0) {
      throw new Error(`No tide predictions returned for station ${stationId}`);
    }

    const parsed: TidePrediction[] = data.predictions.map(p => ({
      // NOAA returns "YYYY-MM-DD HH:MM" in the station's local time.
      // We treat it as local-time-of-the-station and convert to an
      // absolute epoch for filtering, but preserve the original
      // string for display so the subscriber sees the tide's local
      // time (not the server's, and not UTC).
      timestamp: parseNoaaLocalTime(p.t),
      localTimeStr: p.t,
      heightFeet: parseFloat(p.v),
      type: p.type,
    })).filter(p => Number.isFinite(p.heightFeet));

    this.predictionCache.set(stationId, {
      predictions: parsed,
      cachedAt: Date.now(),
    });

    return parsed;
  }

  // ------------------------------------------------------------------
  // v3.0 Scheduler — refresh default station at 00:00, 06:00, 12:00,
  // 18:00 server-local. Retry every 20 min on failure (until next
  // scheduled tick supersedes).
  // ------------------------------------------------------------------

  /**
   * Start the scheduled-refresh loop for the operator's default tide
   * station. Called from api.ts at boot after BBS config is loaded.
   * Idempotent — calling twice is a no-op.
   *
   * The getDefaultStation callback is re-invoked on every scheduled
   * tick, so an operator changing the default station in Settings is
   * picked up automatically on the next tick (no restart needed).
   * For faster propagation, call refreshDefaultStationNow() from the
   * config-change handler.
   */
  startScheduler(getDefaultStation: () => string): void {
    if (this.scheduleTimer) return;
    this.getDefaultStation = getDefaultStation;
    const slotList = SCHEDULED_TICK_HOURS.map(h => `${String(h).padStart(2, '0')}:00`).join(', ');
    console.log(`[TideService] Starting scheduler — refresh at ${slotList} server-local, 20-min retry on failure`);
    // Bootstrap fetch a few seconds after boot so subscribers hitting
    // :tide immediately post-boot don't see an empty cache. The 5s
    // delay lets the rest of the server finish initializing so a
    // pathological NOAA-slow-response doesn't compete with startup.
    setTimeout(() => this.refreshDefaultStation('startup').catch(() => {}), STARTUP_BOOTSTRAP_DELAY_MS);
    this.scheduleNext();
  }

  stopScheduler(): void {
    if (this.scheduleTimer) { clearTimeout(this.scheduleTimer); this.scheduleTimer = null; }
    if (this.retryTimer)    { clearTimeout(this.retryTimer);    this.retryTimer = null; }
    this.getDefaultStation = null;
  }

  /** Force an immediate refresh of the current default station. Useful
   *  from a config-change handler so a freshly-set default gets its
   *  first fetch right away without waiting for the next scheduled
   *  tick. Silent no-op if no default is configured or scheduler is
   *  stopped. */
  async refreshDefaultStationNow(): Promise<void> {
    if (!this.getDefaultStation) return;
    return this.refreshDefaultStation('manual');
  }

  /** Compute the next of the SCHEDULED_TICK_HOURS strictly after
   *  `from` (defaults to now), in server-local time. Returns epoch ms. */
  private nextScheduledTick(from: number = Date.now()): number {
    const d = new Date(from);
    const currentHour = d.getHours();
    const nextHour = SCHEDULED_TICK_HOURS.find(h => h > currentHour);
    if (nextHour !== undefined) {
      d.setHours(nextHour, 0, 0, 0);
    } else {
      // Past the last slot — wrap to first slot tomorrow.
      d.setDate(d.getDate() + 1);
      d.setHours(SCHEDULED_TICK_HOURS[0], 0, 0, 0);
    }
    return d.getTime();
  }

  /** Compute + arm a setTimeout for the next scheduled tick. Idempotent. */
  private scheduleNext(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    const nextTickMs = this.nextScheduledTick();
    const delay = Math.max(1000, nextTickMs - Date.now());
    console.log(`[TideService] Next scheduled refresh in ${Math.round(delay / 60_000)} min (at ${new Date(nextTickMs).toLocaleString()})`);
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      // Cancel any pending retry — the scheduled tick supersedes it.
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      this.refreshDefaultStation('scheduled')
        .catch(() => { /* refreshDefaultStation already logs */ })
        .finally(() => this.scheduleNext());
    }, delay);
    this.scheduleTimer.unref?.();
  }

  /** Perform one refresh of the default station. On failure, schedules
   *  a 20-min retry (unless the next scheduled tick would arrive sooner). */
  private async refreshDefaultStation(cause: 'startup' | 'scheduled' | 'retry' | 'manual'): Promise<void> {
    const station = (this.getDefaultStation?.() ?? '').trim();
    if (!station) {
      // Not an error — operator hasn't set a default station. Skip
      // silently on scheduled ticks, log once on manual/startup so
      // the operator has a clue when they check docker logs.
      if (cause !== 'scheduled') {
        console.log(`[TideService] ${cause} refresh skipped — no default station configured`);
      }
      return;
    }
    try {
      const preds = await this.fetchAndCache(station);
      console.log(`[TideService] ${cause} refresh OK for ${station} (${preds.length} events)`);
      // Success cancels any pending retry.
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    } catch (err: any) {
      const now = Date.now();
      const nextTickMs = this.nextScheduledTick(now);
      // If the 20-min retry would arrive AFTER the next scheduled tick,
      // don't bother — the scheduled tick supersedes.
      if (now + RETRY_INTERVAL_MS < nextTickMs) {
        console.warn(`[TideService] ${cause} refresh FAILED for ${station}: ${err?.message}. Retrying in ${Math.round(RETRY_INTERVAL_MS / 60_000)} min.`);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.refreshDefaultStation('retry').catch(() => {});
        }, RETRY_INTERVAL_MS);
        this.retryTimer.unref?.();
      } else {
        console.warn(`[TideService] ${cause} refresh FAILED for ${station}: ${err?.message}. Not retrying — next scheduled tick at ${new Date(nextTickMs).toLocaleString()} will supersede.`);
      }
    }
  }

  /**
   * Look up station metadata (name + state + timezone) for pretty
   * reply formatting. Best-effort — returns null on failure so the
   * caller falls back to just the station ID in the reply.
   */
  async getStationMeta(stationId: string): Promise<StationMeta | null> {
    if (!/^\d{7}$/.test(stationId)) return null;
    const cached = this.stationCache.get(stationId);
    if (cached) return cached;

    try {
      const url = `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${stationId}.json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': NOAA_UA, 'Accept': 'application/json' },
      });
      if (!res.ok) return null;
      const data = await res.json() as NoaaStationResponse;
      const s = data.stations?.[0];
      if (!s) return null;
      const meta: StationMeta = {
        name: s.name,
        state: s.state,
        timeZoneAbbrev: s.timezone || 'LT', // "LT" = generic local time fallback
      };
      this.stationCache.set(stationId, meta);
      return meta;
    } catch {
      return null;
    }
  }

  /**
   * Compose the ≤200-char one-packet reply for the BBS `:tide` command.
   *
   * Sample: "Tide @ Baltimore MD: HIGH 3:45AM 1.8ft | LOW 10:12AM 0.2ft | HIGH 4:20PM 1.7ft"
   *
   * Falls back to station ID if metadata lookup fails.
   */
  formatTideSummary(
    stationId: string,
    tides: TidePrediction[],
    meta: StationMeta | null,
  ): string {
    const label = meta
      ? `${meta.name}${meta.state ? ' ' + meta.state : ''}`
      : `${stationId}`;
    // Build event list, trimming to fit 200 chars. NOAA time format
    // "2026-07-01 15:34" — we display "3:34PM" (12-hour, no leading
    // zero, no seconds) so each event is ~20 chars.
    const events = tides.map(t => {
      const hm = formatHm12(t.localTimeStr);
      return `${t.type === 'H' ? 'HIGH' : 'LOW'} ${hm} ${t.heightFeet.toFixed(1)}ft`;
    });
    let msg = `Tide @ ${label}: ${events.join(' | ')}`;
    if (msg.length > 200) {
      // Drop trailing events until it fits — subscribers still get
      // the next few events which are the ones they care about.
      while (events.length > 1 && msg.length > 200) {
        events.pop();
        msg = `Tide @ ${label}: ${events.join(' | ')}`;
      }
      // If a single event still doesn't fit, truncate the label.
      if (msg.length > 200) {
        msg = msg.slice(0, 197) + '...';
      }
    }
    return msg;
  }
}

/** YYYYMMDD for a Date, in the process's local timezone. NOAA accepts
 *  station-local dates for begin/end. */
function yyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Convert NOAA's "YYYY-MM-DD HH:MM" string (station-local time) into
 *  an absolute epoch ms. We use Date.parse with a T separator; since
 *  NOAA doesn't include a timezone offset in the string, JavaScript
 *  interprets it as local (server) time. For the operator's primary
 *  use case (a station near the server's own timezone, e.g. Baltimore
 *  MD served from a Maryland server) this is correct. For stations
 *  in a different timezone from the server, timestamps will be off
 *  by the UTC-offset difference — but only for filter/sort purposes;
 *  the DISPLAYED time is the original NOAA string, which stays
 *  correct regardless. */
function parseNoaaLocalTime(s: string): number {
  // "2026-07-01 15:34" → "2026-07-01T15:34"
  const iso = s.replace(' ', 'T');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

/** Extract 12-hour clock time from "YYYY-MM-DD HH:MM" → e.g. "3:45PM". */
function formatHm12(s: string): string {
  const [_ymd, hm] = s.split(' ');
  if (!hm) return s;
  const [hStr, m] = hm.split(':');
  const h = parseInt(hStr, 10);
  if (!Number.isFinite(h)) return hm;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m}${period}`;
}

export const tideService = new TideService();
export type { TidePrediction, StationMeta };
