/**
 * v3.0 Subscriber Services — sun/moon almanac for the `:sun` BBS command.
 *
 * All computation is OFFLINE via SunCalc (npm) — sunrise/sunset,
 * twilight, moon phase, moon illumination, moon rise/set. Works
 * without an internet connection, which matters for the field-
 * deployment use case (operator on a Pi + solar with intermittent
 * WAN can still serve `:sun` to subscribers).
 *
 * SunCalc uses the standard astronomical formulas (Meeus, "Astronomical
 * Algorithms") — accurate to within seconds for civil use.
 *
 * Location resolution:
 *   - Explicit lat/lng or ZIP arg → resolve via weatherService.resolveZip
 *   - No arg → operator's configured sunLocationZip
 *   - No default → helpful error
 *
 * No caching — SunCalc is pure CPU math, faster than any cache lookup
 * would be. ZIP → lat/lng lookups get zippopotam.us caching from the
 * existing weatherService.
 */

import * as SunCalc from 'suncalc';
import { weatherService } from './weather.js';

interface SunAlmanac {
  /** Location label for the reply — usually "City ST" from the ZIP resolver. */
  label: string;
  /** Sunrise as station-local Date. */
  sunrise: Date;
  sunset: Date;
  /** Civil dawn / dusk — sun 6° below horizon. Practical "starting to see
   *  detail" / "streetlights come on" moment. */
  civilDawn: Date;
  civilDusk: Date;
  /** Solar noon (sun at highest point). Useful for solar-panel operators
   *  planning charge windows. */
  solarNoon: Date;
  /** Day length in hours (rounded to 1 decimal). */
  dayLengthH: number;
  /** Moon illumination fraction (0-1). */
  moonIllumFraction: number;
  /** Moon phase name (e.g. "waxing gibbous"). Derived from SunCalc's
   *  0-1 phase value. */
  moonPhaseName: string;
  /** Moon rise/set for the observer's day. Either can be null (moon
   *  doesn't rise/set on some days at some latitudes). */
  moonRise: Date | null;
  moonSet: Date | null;
}

class SunService {
  /**
   * Compute the almanac for a specific location. Pure function —
   * given the same lat/lng + date, returns the same result.
   */
  computeAlmanac(lat: number, lng: number, label: string, date: Date = new Date()): SunAlmanac {
    const times = SunCalc.getTimes(date, lat, lng);
    const moonIllum = SunCalc.getMoonIllumination(date);
    const moonTimes = SunCalc.getMoonTimes(date, lat, lng);

    const dayLengthMs = times.sunset.getTime() - times.sunrise.getTime();
    const dayLengthH = Math.round((dayLengthMs / 3600_000) * 10) / 10;

    return {
      label,
      sunrise:      times.sunrise,
      sunset:       times.sunset,
      civilDawn:    times.dawn,
      civilDusk:    times.dusk,
      solarNoon:    times.solarNoon,
      dayLengthH,
      moonIllumFraction: moonIllum.fraction,
      moonPhaseName:     phaseName(moonIllum.phase),
      // SunCalc's getMoonTimes returns .rise / .set (Date | undefined) plus
      // .alwaysUp / .alwaysDown flags. We normalize undefined to null.
      moonRise: moonTimes.rise ?? null,
      moonSet:  moonTimes.set  ?? null,
    };
  }

  /**
   * Resolve a location argument to lat/lng + display label. Accepts:
   *   - "" / undefined → use operator's default ZIP
   *   - "21701"        → 5-digit US ZIP
   *   - "39.42,-77.41" → explicit lat,lng
   *
   * Throws on invalid input with a message safe to show to a
   * subscriber over DM.
   */
  async resolveLocation(arg: string | null, defaultZip: string): Promise<{ lat: number; lng: number; label: string }> {
    const raw = (arg ?? '').trim();

    // Lat/lng form: "39.42,-77.41"
    if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(raw)) {
      const [latStr, lngStr] = raw.split(',');
      const lat = parseFloat(latStr.trim());
      const lng = parseFloat(lngStr.trim());
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw new Error(`Coordinates out of range: ${raw}`);
      }
      return { lat, lng, label: `${lat.toFixed(3)},${lng.toFixed(3)}` };
    }

    // ZIP form: "21701"
    const zip = raw || defaultZip;
    if (!zip) {
      throw new Error('No default location set. Send 5-digit ZIP or lat,lng.');
    }
    if (!/^\d{5}$/.test(zip)) {
      throw new Error(`ZIP must be 5 digits — got "${zip}"`);
    }
    const loc = await weatherService.resolveZip(zip);
    return { lat: loc.lat, lng: loc.lng, label: `${loc.city} ${loc.state}` };
  }

  /**
   * Compose the ≤200-char one-packet reply. Sample (Frederick MD in
   * summer):
   *
   *   "Sun @ Frederick MD: rise 5:47AM set 8:37PM (14.8h). Civil twi 5:15AM/9:10PM. Moon 78% wax gib, rise 9:45PM set 6:12AM."
   *
   * Auto-trims moon rise/set if the packet would exceed 200 chars.
   */
  formatSunSummary(alm: SunAlmanac): string {
    const rise = fmtHm12(alm.sunrise);
    const set  = fmtHm12(alm.sunset);
    const dawn = fmtHm12(alm.civilDawn);
    const dusk = fmtHm12(alm.civilDusk);
    const illumPct = Math.round(alm.moonIllumFraction * 100);
    const phase = shortPhase(alm.moonPhaseName);
    let msg =
      `Sun @ ${alm.label}: rise ${rise} set ${set} (${alm.dayLengthH}h). ` +
      `Civil twi ${dawn}/${dusk}. Moon ${illumPct}% ${phase}`;

    // Append moon rise/set only if they fit (they usually do).
    const moonTail =
      (alm.moonRise ? `, rise ${fmtHm12(alm.moonRise)}` : '') +
      (alm.moonSet  ? ` set ${fmtHm12(alm.moonSet)}`  : '') +
      '.';
    const full = msg + moonTail;
    if (full.length <= 200) return full;
    // Trim moon detail if it doesn't fit.
    return msg + '.';
  }
}

/**
 * Map SunCalc's continuous 0-1 phase value to the standard 8 phase
 * names. SunCalc's `phase`:
 *    0    = new moon
 *    0.25 = first quarter
 *    0.5  = full moon
 *    0.75 = last quarter
 * Everything else lands in one of the four intermediate phases.
 */
function phaseName(phase: number): string {
  // Snap to the nearest of 8 bins centered on {0, .125, .25, ..., .875}.
  // Phase is a fraction of the lunar cycle so 1.0 wraps back to new.
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.0625 || p >= 0.9375) return 'new';
  if (p < 0.1875) return 'waxing crescent';
  if (p < 0.3125) return 'first quarter';
  if (p < 0.4375) return 'waxing gibbous';
  if (p < 0.5625) return 'full';
  if (p < 0.6875) return 'waning gibbous';
  if (p < 0.8125) return 'last quarter';
  return 'waning crescent';
}

/** Ultra-compact phase abbreviation for the reply string. Same 8 buckets
 *  as phaseName, but trimmed to fit the 200-char packet cap. */
function shortPhase(name: string): string {
  switch (name) {
    case 'new':              return 'new';
    case 'waxing crescent':  return 'wax cres';
    case 'first quarter':    return '1st qtr';
    case 'waxing gibbous':   return 'wax gib';
    case 'full':             return 'full';
    case 'waning gibbous':   return 'wan gib';
    case 'last quarter':     return 'last qtr';
    case 'waning crescent':  return 'wan cres';
    default:                 return name;
  }
}

/** Format a Date as "3:45PM" in the SERVER'S local timezone.
 *
 * SunCalc returns Date objects at absolute epoch — the sunrise event
 * itself. Rendering it via the server's local time is correct for the
 * operator's primary use case (server + subscribers in the same zone,
 * which is by far the most common). For cross-zone queries (subscriber
 * asks about a location in a different zone) the time shown is the
 * event's time in the SERVER's zone — which is a reasonable "when will
 * this happen from your perspective" reading. */
function fmtHm12(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')}${period}`;
}

export const sunService = new SunService();
export type { SunAlmanac };
