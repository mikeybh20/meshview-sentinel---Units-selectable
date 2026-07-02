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

const PREDICTION_CACHE_MS = 15 * 60_000;
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

  /**
   * Fetch the next `count` high/low tide events for the given station,
   * starting from now. NOAA's `hilo` interval returns events, not
   * observations, so `count=4` typically covers a ~24-hour window
   * (roughly two full tidal cycles).
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
    if (cached && Date.now() - cached.cachedAt < PREDICTION_CACHE_MS) {
      // Filter out any events already in the past — a cache hit near
      // the top of the tide cycle would otherwise show the event that
      // just occurred.
      return cached.predictions
        .filter(p => p.timestamp >= Date.now())
        .slice(0, count);
    }

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

    return parsed
      .filter(p => p.timestamp >= Date.now())
      .slice(0, count);
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
