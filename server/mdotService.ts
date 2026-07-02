/**
 * v3.0 Subscriber Services — Maryland traffic incidents for the
 * `:mdot` BBS command.
 *
 * Backs by MDOT / CHART (Coordinated Highways Action Response Team) —
 * the state's live traveler-info system. The public JSON export lives
 * at:
 *
 *   https://chartexp1.sha.maryland.gov/CHARTExportClientService/getEventMapDataJSON.do
 *
 * Free, no auth. Endpoint discovered from chart.maryland.gov's own
 * DataFeeds page. Returns 30-100+ live incidents statewide with
 * county / description / direction / lat-lng / severity fields.
 *
 * Caching: 5-minute TTL per statewide fetch. Traffic changes faster
 * than tide predictions, but subscribers hitting `:mdot` in bursts
 * during a rush hour shouldn't each trigger a fresh call. A single
 * 5-minute cached snapshot serves every subscriber and every county
 * filter in that window.
 */

const CACHE_TTL_MS = 5 * 60_000;
const CHART_URL = 'https://chartexp1.sha.maryland.gov/CHARTExportClientService/getEventMapDataJSON.do';
const CHART_UA = process.env.MESHVIEW_CHART_UA
  || 'MeshViewSentinel/1.0 (https://github.com/mikeybh20/meshview-sentinel)';

/** Cleaned incident shape — subset of the CHART payload with only the
 *  fields the BBS reply needs. */
interface CleanedIncident {
  id: string;
  county: string;
  description: string;
  direction: string | null;
  lat: number | null;
  lng: number | null;
  incidentType: string;
  /** Epoch ms when CHART's operations center opened this incident. */
  startedAt: number;
  /** Whether CHART flags this as a live "traffic alert" (raised
   *  priority — major incident that operators want highlighted). */
  isAlert: boolean;
}

interface CachedFetch {
  incidents: CleanedIncident[];
  fetchedAt: number;
}

/** Raw shape as returned by CHART's getEventMapDataJSON.do. Only the
 *  fields we care about are typed; the payload has more. */
interface RawChartIncident {
  id?: string;
  county?: string;
  description?: string;
  name?: string;
  direction?: string;
  lat?: number;
  lon?: number;
  incidentType?: string;
  startDateTime?: number;
  createTime?: number;
  trafficAlert?: boolean;
  closed?: boolean;
}
interface RawChartResponse {
  success?: boolean;
  data?: RawChartIncident[];
  totalCount?: number;
}

class MdotService {
  private cache: CachedFetch | null = null;

  /**
   * Fetch all currently-active CHART incidents statewide. Returns a
   * cleaned/filtered list — closed incidents are dropped, and lat/lng
   * are normalized to null if CHART returned 0/0 or nonsense.
   *
   * Cache-first: 5-min TTL. Subscribers hitting `:mdot` in a burst all
   * see the same cached snapshot; county filtering is applied
   * downstream in listByCounty(), not at fetch time.
   */
  async fetchIncidents(): Promise<CleanedIncident[]> {
    const now = Date.now();
    if (this.cache && (now - this.cache.fetchedAt) < CACHE_TTL_MS) {
      return this.cache.incidents;
    }

    const res = await fetch(CHART_URL, {
      headers: { 'User-Agent': CHART_UA, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`CHART HTTP ${res.status}`);
    }
    const data = await res.json() as RawChartResponse;
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error(`CHART returned success=false or malformed data`);
    }

    const cleaned: CleanedIncident[] = data.data
      // Drop closed incidents — they're historical and confuse the
      // "what's happening RIGHT NOW" question.
      .filter(r => r.closed === false)
      .map(r => ({
        id:            String(r.id ?? ''),
        county:        String(r.county ?? '').trim(),
        // CHART sometimes returns the same string in description AND
        // name; sometimes only one is set. Take whichever has content.
        description:   String(r.description || r.name || '').trim(),
        direction:     r.direction ? String(r.direction) : null,
        // CHART uses 0/0 or nulls for incidents without a fix; normalize
        // to null so downstream code doesn't render "0.0000, 0.0000".
        lat: Number.isFinite(r.lat) && r.lat !== 0 ? Number(r.lat) : null,
        lng: Number.isFinite(r.lon) && r.lon !== 0 ? Number(r.lon) : null,
        incidentType:  String(r.incidentType ?? 'Other').trim(),
        // CHART timestamps are epoch ms. startDateTime is when it opened;
        // createTime is when it was created in the system. Prefer
        // startDateTime for "how old is this?" filtering.
        startedAt:     Number.isFinite(r.startDateTime) ? Number(r.startDateTime)
                       : Number.isFinite(r.createTime) ? Number(r.createTime)
                       : now,
        isAlert:       !!r.trafficAlert,
      }))
      // Drop rows with no usable description — we can't render them.
      .filter(i => i.description.length > 0)
      // Sort newest-first so the operator's short-list picks the most
      // recent incidents, which are usually the most useful.
      .sort((a, b) => b.startedAt - a.startedAt);

    this.cache = { incidents: cleaned, fetchedAt: now };
    return cleaned;
  }

  /**
   * List incidents filtered to a specific county (case-insensitive
   * exact match on the CHART `county` field). County names in CHART
   * are proper case ("Frederick", "Baltimore", "Montgomery") without
   * "County" suffix.
   *
   * Special value "" (empty string) returns all statewide incidents.
   *
   * Result is capped at `limit` (default 4) newest-first — designed to
   * fit the 200-char single-packet reply.
   */
  async listByCounty(county: string, limit: number = 4): Promise<CleanedIncident[]> {
    const all = await this.fetchIncidents();
    const target = county.trim().toLowerCase();
    const filtered = target
      ? all.filter(i => i.county.toLowerCase() === target)
      : all;
    return filtered.slice(0, limit);
  }

  /**
   * Compose the ≤200-char one-packet reply. Sample (Frederick County):
   *
   *   "MDOT Frederick (3): US 15 NB Mountville — Signal Green Arrow Out; I-70 EB @ MP 62 crash; MD 85 @ Buckeystown lane closure"
   *
   * Auto-trims trailing incidents if the packet would exceed 200
   * chars. Description strings are already short from CHART; we
   * further trim each to ~60 chars so we can fit 3-4 items.
   */
  formatIncidentSummary(county: string, incidents: CleanedIncident[]): string {
    const label = county || 'MD';
    if (incidents.length === 0) {
      return `MDOT ${label}: no active incidents. Drive safe.`;
    }
    // Compact each incident to a short summary line. Prefer routes/
    // mile markers up front — the CHART description usually already
    // leads with that.
    const items = incidents.map(i => this.compactIncident(i));
    let msg = `MDOT ${label} (${incidents.length}): ${items.join('; ')}`;
    if (msg.length > 200) {
      while (items.length > 1 && msg.length > 200) {
        items.pop();
        msg = `MDOT ${label} (${incidents.length}): ${items.join('; ')}`;
      }
      if (msg.length > 200) {
        msg = msg.slice(0, 197) + '...';
      }
    }
    return msg;
  }

  /**
   * Turn one incident row into a compact line for the packet. CHART
   * descriptions tend to look like:
   *
   *   "Action Event @ US 15 (CATOCTIN MOUNTAIN HWY) @ MOUNTVILLE RD [Traffic Control Signal] (MM 5.0)"
   *
   * — which is too verbose. Strip the leading category (Action Event,
   * Incident, etc.), the parenthetical alternate route names, and the
   * bracketed status detail. Leaves the route + intersection + mile
   * marker, which is what a driver needs.
   */
  private compactIncident(i: CleanedIncident): string {
    let d = i.description;
    // Strip a leading "Action Event @ " / "Incident @ " / etc.
    d = d.replace(/^(Action Event|Incident|Event|Weather Event|Disabled Vehicle|Construction) @\s*/i, '');
    // Strip parenthetical route-name annotations "(CATOCTIN MOUNTAIN HWY)".
    d = d.replace(/\s*\([A-Z0-9 \-\/&.]+\)/g, '');
    // Strip bracketed status "[Traffic Control Signal]".
    d = d.replace(/\s*\[[^\]]+\]/g, '');
    // Collapse repeated whitespace.
    d = d.replace(/\s+/g, ' ').trim();
    // Cap at 60 chars so we can fit 3-4 items in the 200-char envelope.
    if (d.length > 60) d = d.slice(0, 57) + '...';
    return d;
  }
}

export const mdotService = new MdotService();
export type { CleanedIncident };
