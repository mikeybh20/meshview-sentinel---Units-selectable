/**
 * Weather service for the BBS — backs the `:weather` command and the home-area
 * alert poller.
 *
 * Two external dependencies, both free + no-auth:
 *   - api.zippopotam.us  — US ZIP → lat/lng/city/state (CC0 data)
 *   - api.weather.gov    — NWS forecast and active alerts (US government)
 *
 * NWS requires a User-Agent identifying the calling app + contact email per
 * https://www.weather.gov/documentation/services-web-api . We use the
 * MESHVIEW_NWS_UA env var if set, otherwise a generic identifier with the app
 * version. The default works fine for personal use; operators self-hosting
 * for an org should set their own.
 *
 * Caching:
 *   - ZIP lookups cached for the process lifetime (zip→lat/lng never changes)
 *   - Forecasts cached for 15 minutes per location (forecasts update hourly
 *     in practice; 15 min keeps `:weather` snappy without thrashing NWS)
 *   - Grid metadata cached for 24h (rarely changes)
 */

const NWS_UA = process.env.MESHVIEW_NWS_UA || 'MeshViewSentinel/1.0 (https://github.com/mikeybh20/meshview-sentinel)';
const FORECAST_CACHE_MS = 15 * 60_000;
const GRID_CACHE_MS = 24 * 3600_000;

interface ZipLocation {
  lat: number;
  lng: number;
  city: string;
  state: string; // 2-letter postal abbreviation
}

interface NwsGrid {
  forecastUrl: string;
  forecastHourlyUrl: string;
  cachedAt: number;
}

interface ForecastCache {
  summary: string;
  cachedAt: number;
}

export interface NwsAlert {
  id: string;            // NWS-assigned identifier; stable across polls
  event: string;         // e.g. "Severe Thunderstorm Warning"
  severity: string;      // "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown"
  headline: string;      // Full headline (long)
  effective: string;     // ISO timestamp
  expires: string;       // ISO timestamp
}

class WeatherService {
  private zipCache = new Map<string, ZipLocation>();
  private gridCache = new Map<string, NwsGrid>();           // key = "lat,lng"
  private forecastCache = new Map<string, ForecastCache>(); // key = zip

  /**
   * Lookup ZIP → lat/lng/city/state via zippopotam.us. Cached for process
   * lifetime since this mapping is effectively static.
   */
  async resolveZip(zip: string): Promise<ZipLocation> {
    if (!/^\d{5}$/.test(zip)) throw new Error(`Invalid ZIP: ${zip}`);
    const cached = this.zipCache.get(zip);
    if (cached) return cached;

    const res = await fetch(`https://api.zippopotam.us/us/${zip}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      if (res.status === 404) throw new Error(`ZIP ${zip} not found`);
      throw new Error(`zippopotam HTTP ${res.status}`);
    }
    const data = await res.json() as {
      'post code': string;
      country: string;
      places: Array<{
        'place name': string;
        state: string;
        'state abbreviation': string;
        latitude: string;
        longitude: string;
      }>;
    };
    const place = data.places?.[0];
    if (!place) throw new Error(`No places returned for ZIP ${zip}`);
    const loc: ZipLocation = {
      lat: parseFloat(place.latitude),
      lng: parseFloat(place.longitude),
      city: place['place name'],
      state: place['state abbreviation'],
    };
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
      throw new Error(`Bad coordinates for ZIP ${zip}`);
    }
    this.zipCache.set(zip, loc);
    return loc;
  }

  /** Resolve lat/lng → NWS forecast grid metadata. Cached for 24h. */
  private async resolveGrid(lat: number, lng: number): Promise<NwsGrid> {
    // NWS rounds to 4 decimals; we do the same so the cache key is stable.
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const cached = this.gridCache.get(key);
    if (cached && Date.now() - cached.cachedAt < GRID_CACHE_MS) return cached;

    const res = await fetch(`https://api.weather.gov/points/${key}`, {
      headers: { 'User-Agent': NWS_UA, 'Accept': 'application/geo+json' },
    });
    if (!res.ok) throw new Error(`NWS /points HTTP ${res.status}`);
    const data = await res.json() as {
      properties?: { forecast?: string; forecastHourly?: string };
    };
    const forecastUrl = data.properties?.forecast;
    const forecastHourlyUrl = data.properties?.forecastHourly;
    if (!forecastUrl) throw new Error('NWS /points returned no forecast URL');
    const grid: NwsGrid = {
      forecastUrl,
      forecastHourlyUrl: forecastHourlyUrl || forecastUrl,
      cachedAt: Date.now(),
    };
    this.gridCache.set(key, grid);
    return grid;
  }

  /**
   * Build a compact one-line weather summary for the operator-facing reply.
   * Format: "City, ST: 42°F now, Sunny. High 48°/Low 31° today."
   * Always ≤200 chars so it fits a single Meshtastic packet without splitting.
   */
  async getCurrentSummary(zip: string): Promise<string> {
    const cached = this.forecastCache.get(zip);
    if (cached && Date.now() - cached.cachedAt < FORECAST_CACHE_MS) {
      return cached.summary;
    }

    const loc = await this.resolveZip(zip);
    const grid = await this.resolveGrid(loc.lat, loc.lng);

    // The /forecast endpoint returns 7 days of 12-hour periods (e.g. "Today",
    // "Tonight", "Wednesday", ...). /forecastHourly returns 156 hourly periods
    // with current temperature. We pull both: hourly for "now", regular for
    // today's high/low + condition.
    const [hourlyRes, dailyRes] = await Promise.all([
      fetch(grid.forecastHourlyUrl, {
        headers: { 'User-Agent': NWS_UA, 'Accept': 'application/geo+json' },
      }),
      fetch(grid.forecastUrl, {
        headers: { 'User-Agent': NWS_UA, 'Accept': 'application/geo+json' },
      }),
    ]);
    if (!hourlyRes.ok) throw new Error(`NWS hourly HTTP ${hourlyRes.status}`);
    if (!dailyRes.ok) throw new Error(`NWS daily HTTP ${dailyRes.status}`);

    const hourly = await hourlyRes.json() as {
      properties?: { periods?: Array<{ temperature: number; temperatureUnit: string; shortForecast: string }> };
    };
    const daily = await dailyRes.json() as {
      properties?: { periods?: Array<{ name: string; isDaytime: boolean; temperature: number; temperatureUnit: string; shortForecast: string }> };
    };

    const now = hourly.properties?.periods?.[0];
    if (!now) throw new Error('NWS hourly returned no periods');

    // Find today's daytime and nighttime periods for high/low. Periods are
    // ordered earliest-first; we want the first daytime and first nighttime
    // entries that haven't fully passed.
    const periods = daily.properties?.periods ?? [];
    const todayDay = periods.find(p => p.isDaytime);
    const todayNight = periods.find(p => !p.isDaytime);
    const high = todayDay?.temperature;
    const low = todayNight?.temperature;
    const unit = now.temperatureUnit || 'F';

    const condition = compactCondition(now.shortForecast || todayDay?.shortForecast || 'Unknown');

    let summary = `${loc.city}, ${loc.state}: ${now.temperature}°${unit} now, ${condition}.`;
    if (typeof high === 'number' && typeof low === 'number') {
      summary += ` High ${high}°/Low ${low}° today.`;
    } else if (typeof high === 'number') {
      summary += ` High ${high}° today.`;
    }

    // Hard cap at 200 chars — the configured bodyMaxChars cap.
    if (summary.length > 200) summary = summary.slice(0, 197) + '…';

    this.forecastCache.set(zip, { summary, cachedAt: Date.now() });
    return summary;
  }

  /** Active NWS alerts for the given ZIP. Returns an empty array when there
   *  are none. Not cached — alerts are time-sensitive and the poller calls
   *  this every 20 minutes. */
  async getActiveAlerts(zip: string): Promise<NwsAlert[]> {
    const loc = await this.resolveZip(zip);
    const url = `https://api.weather.gov/alerts/active?point=${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': NWS_UA, 'Accept': 'application/geo+json' },
    });
    if (!res.ok) throw new Error(`NWS alerts HTTP ${res.status}`);
    const data = await res.json() as {
      features?: Array<{
        id: string;
        properties?: {
          id?: string;
          event?: string;
          severity?: string;
          headline?: string;
          effective?: string;
          expires?: string;
        };
      }>;
    };
    return (data.features ?? []).map(f => ({
      id: f.properties?.id || f.id,
      event: f.properties?.event || 'Weather Alert',
      severity: f.properties?.severity || 'Unknown',
      headline: f.properties?.headline || '',
      effective: f.properties?.effective || '',
      expires: f.properties?.expires || '',
    }));
  }

  /** Render an alert into a ≤200-char one-liner suitable for the event log
   *  or for transmission over a single Meshtastic packet. */
  formatAlertCompact(alert: NwsAlert, locationLabel: string): string {
    const sev = alert.severity && alert.severity !== 'Unknown' ? ` (${alert.severity})` : '';
    // headline already starts with the event name in NWS data; if it doesn't,
    // prepend the event for context.
    const headline = alert.headline
      ? alert.headline.replace(/\s+/g, ' ').trim()
      : alert.event;
    let msg = `⚠ ${locationLabel}${sev}: ${headline}`;
    if (msg.length > 200) msg = msg.slice(0, 197) + '…';
    return msg;
  }
}

/**
 * Squash a verbose NWS shortForecast into the 2-3 word labels the user asked
 * for ("Rain", "Partly Cloudy", "Sunny"). NWS strings vary — "Mostly Sunny
 * then Slight Chance of Rain Showers" gets normalized to the dominant first
 * condition.
 */
function compactCondition(raw: string): string {
  const s = raw.trim();
  if (!s) return 'Unknown';
  // Take the part before " then " / " and " / "/" — that's the current
  // condition rather than the trailing forecast.
  const head = s.split(/ then | and |\//i)[0].trim();

  // Map common verbose strings to the canonical labels.
  const lower = head.toLowerCase();
  if (lower.includes('thunderstorm')) return 'Thunderstorms';
  if (lower.includes('snow') && lower.includes('rain')) return 'Wintry Mix';
  if (lower.includes('snow')) return 'Snow';
  if (lower.includes('sleet') || lower.includes('freezing rain')) return 'Sleet';
  if (lower.includes('rain') || lower.includes('showers') || lower.includes('drizzle')) return 'Rain';
  if (lower.includes('fog')) return 'Foggy';
  if (lower.includes('haze')) return 'Hazy';
  if (lower.includes('smoke')) return 'Smoky';
  if (lower.includes('mostly sunny')) return 'Mostly Sunny';
  if (lower.includes('partly sunny')) return 'Partly Sunny';
  if (lower.includes('partly cloudy')) return 'Partly Cloudy';
  if (lower.includes('mostly cloudy')) return 'Mostly Cloudy';
  if (lower.includes('cloudy') || lower.includes('overcast')) return 'Cloudy';
  if (lower.includes('clear')) return 'Clear';
  if (lower.includes('sunny')) return 'Sunny';
  if (lower.includes('windy')) return 'Windy';

  // Fall back to the raw head, capped for length.
  return head.length > 24 ? head.slice(0, 21) + '…' : head;
}

export const weatherService = new WeatherService();
