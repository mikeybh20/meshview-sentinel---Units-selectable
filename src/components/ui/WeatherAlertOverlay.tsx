/**
 * v3.0 NWS feed depth — active alert polygons rendered on the map.
 *
 * Sits as a child of pigeon-maps `<Map>` so it receives the
 * latLngToPixel callback that projects (lat, lng) tuples to on-screen
 * pixel coordinates. Renders each alert as an SVG polygon (or
 * MultiPolygon → multiple polygons) with severity-tinted fill.
 *
 * Data source: /api/mesh/weather/active-alerts. Auto-refreshes every
 * 5 minutes while mounted — NWS updates alerts as frequently as
 * severe weather warrants, but polling faster than that just
 * generates load.
 *
 * Rendering conventions:
 *   Extreme (EXT)     — red, semi-opaque fill
 *   Severe            — orange
 *   Moderate          — amber
 *   Minor / Unknown   — sky blue (informational)
 * Border is the same color darkened; fill opacity ~15% so the
 * underlying map tiles + node markers stay readable underneath.
 *
 * Click / hover behavior: cell-level onClick surfaces alert
 * headlines in a popover — but that's a future enhancement.
 * MVP renders the polygon plus a small severity label at the
 * polygon centroid.
 */
import React from 'react';
import { meshDataService } from '../../services/meshDataService';
import type { NwsAlertWithGeometry, NwsAlertGeometry } from '../../types';

interface WeatherAlertOverlayProps {
  /** Provided by pigeon-maps <Map> to its children — projects a
   *  [lat, lng] pair to on-screen pixel coordinates relative to
   *  the map viewport. */
  latLngToPixel?: (latLng: [number, number]) => [number, number];
  /** Explicit ZIP override — otherwise the server uses the
   *  operator's configured homeZipCode. */
  zip?: string | null;
}

/** Auto-refresh cadence. NWS updates alerts fast during severe
 *  weather but polling faster than 5 min just generates load. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

function severityColor(severity: string): { stroke: string; fill: string } {
  switch (severity) {
    case 'Extreme':  return { stroke: '#dc2626', fill: 'rgba(239,68,68,0.18)' };  // red
    case 'Severe':   return { stroke: '#ea580c', fill: 'rgba(249,115,22,0.18)' }; // orange
    case 'Moderate': return { stroke: '#d97706', fill: 'rgba(245,158,11,0.15)' }; // amber
    case 'Minor':    return { stroke: '#0284c7', fill: 'rgba(14,165,233,0.13)' }; // sky
    default:         return { stroke: '#0284c7', fill: 'rgba(14,165,233,0.10)' }; // sky, softer
  }
}

/** Extract polygon rings from a GeoJSON Polygon or MultiPolygon.
 *  Returns a flat array of rings; each ring is an array of
 *  [lng, lat] pairs (NWS-native / GeoJSON axis order). */
function extractRings(geom: NwsAlertGeometry): number[][][] {
  if (geom.type === 'Polygon') return geom.coordinates;
  // MultiPolygon → flatten one level to get all rings across all
  // constituent polygons.
  const rings: number[][][] = [];
  for (const poly of geom.coordinates) {
    for (const ring of poly) rings.push(ring);
  }
  return rings;
}

/** Compute the centroid of a ring for placing the severity label.
 *  Simple average — good enough for weather-alert polygons which
 *  are usually convex-ish (NWS-warned counties/regions). */
function ringCentroid(ring: number[][]): [number, number] {
  if (ring.length === 0) return [0, 0];
  let sx = 0, sy = 0;
  for (const [lng, lat] of ring) { sx += lng; sy += lat; }
  return [sx / ring.length, sy / ring.length];
}

/** Compact severity label — full words are too big for the tiny
 *  map placement, so we abbreviate. */
function severityAbbrev(severity: string): string {
  switch (severity) {
    case 'Extreme':  return 'EXT';
    case 'Severe':   return 'SEV';
    case 'Moderate': return 'MOD';
    case 'Minor':    return 'MIN';
    default:         return '?';
  }
}

export function WeatherAlertOverlay({ latLngToPixel, zip }: WeatherAlertOverlayProps) {
  const [alerts, setAlerts] = React.useState<NwsAlertWithGeometry[]>([]);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const r = await meshDataService.activeWeatherAlerts(zip);
    // Filter to alerts with actual polygon geometry — the rest
    // are zone-only alerts we can't render on the map.
    setAlerts((r?.alerts ?? []).filter(a => a.geometry !== null));
  }, [zip]);

  React.useEffect(() => { reload(); }, [reload]);
  React.useEffect(() => {
    const t = setInterval(reload, REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [reload]);

  if (!latLngToPixel || alerts.length === 0) return null;

  return (
    <svg className="absolute inset-0 pointer-events-none z-[5] w-full h-full">
      {alerts.map(alert => {
        if (!alert.geometry) return null;
        const rings = extractRings(alert.geometry);
        const colors = severityColor(alert.severity);
        const isHovered = hoveredId === alert.id;

        // Project each ring into an SVG points string.
        const pathData = rings.map(ring => {
          const pts = ring.map(([lng, lat]) => latLngToPixel([lat, lng]));
          if (pts.length === 0) return '';
          const [x0, y0] = pts[0];
          const rest = pts.slice(1).map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
          return `M${x0.toFixed(1)},${y0.toFixed(1)} ${rest} Z`;
        }).join(' ');

        // Label position — centroid of the largest ring.
        const largestRing = rings.reduce((best, r) => r.length > best.length ? r : best, rings[0] || []);
        const [labelLng, labelLat] = ringCentroid(largestRing);
        const [labelX, labelY] = latLngToPixel([labelLat, labelLng]);

        return (
          <g key={alert.id}>
            <path
              d={pathData}
              fill={colors.fill}
              stroke={colors.stroke}
              strokeWidth={isHovered ? 2.5 : 1.5}
              strokeOpacity={isHovered ? 1 : 0.7}
              style={{ pointerEvents: 'auto', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredId(alert.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <title>{alert.event} ({alert.severity}) — {alert.headline}</title>
            </path>

            {/* Severity abbreviation label at the centroid — reads
                even when the polygon covers a small area. */}
            <g transform={`translate(${labelX}, ${labelY})`} pointerEvents="none">
              <rect
                x={-14} y={-8} width={28} height={16}
                rx={3}
                fill={colors.stroke}
                fillOpacity={0.85}
              />
              <text
                x={0} y={0}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9}
                fontWeight="bold"
                fill="white"
                fontFamily="monospace"
                letterSpacing={0.5}
              >
                {severityAbbrev(alert.severity)}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
