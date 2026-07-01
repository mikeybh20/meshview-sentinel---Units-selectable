/**
 * v3.0 SKYWARN — Storm Reports operator dashboard tab.
 *
 * Shows every Local Storm Report (LSR) intake from the BBS `:spot`
 * command. Three panels:
 *
 *   1. Header — filter bar (event type, date range) + CSV export
 *      + refresh. Scoped to the currently selected radio via
 *      useRadios() (matches WeatherView / MailView behavior).
 *
 *   2. Map — pigeon-maps with severity-tinted markers, one pin per
 *      report. Empty-state shows a hint when no reports exist.
 *
 *   3. Table — sortable list of reports with delete action per row.
 *      Delete uses the requireAuth-gated DELETE endpoint.
 *
 * Data flow: initial GET /api/mesh/bbs/storm-reports, re-fetch on
 * SSE 'stormReport' events (fired by the BBS `:spot` finalize path
 * and by operator deletes).
 */
import React from 'react';
import { CloudRain, RefreshCw, Download, Trash2, MapPin, Filter, AlertTriangle } from 'lucide-react';
import { Map, Overlay, ZoomControl } from 'pigeon-maps';
import { StormReport } from '../../types';
import { cn } from '../../lib/utils';
import { meshDataService } from '../../services/meshDataService';
import { useRadios } from '../../hooks/useRadios';

/** Event-type → marker color. Red = life-threatening (tornado/funnel
 *  imply the same threat pattern); orange = severe (hail/wind);
 *  blue = flooding; muted for observational events (wall cloud, other). */
function markerColorForEventType(t: string): string {
  const up = t.toUpperCase();
  if (up === 'TORNADO' || up === 'FUNNEL') return '#ef4444';       // red-500
  if (up === 'HAIL' || up === 'TSTM WND' || up === 'HIGH WIND') return '#f97316'; // orange-500
  if (up === 'FLOOD' || up === 'FLASH FLOOD') return '#3b82f6';    // blue-500
  if (up === 'WALL CLOUD' || up === 'WATERSPOUT') return '#a855f7'; // purple-500
  return '#6b7280';                                                // gray-500 for OTHER
}

/** Marker radius (px) — magnitude-scaled where present, base otherwise. */
function markerSizeFor(r: StormReport): number {
  if (r.magnitudeValue === null || r.magnitudeUnit === null) return 12;
  const v = r.magnitudeValue;
  if (r.magnitudeUnit === 'INCHES') return Math.min(24, 10 + v * 4);   // hail — 0.5" → 12px, 3" → 22px
  if (r.magnitudeUnit === 'MPH')    return Math.min(24, 8 + v / 12);   // wind — 40mph → 11px, 100mph → 16px
  if (r.magnitudeUnit === 'FEET')   return Math.min(24, 10 + v * 2);   // flood — 1ft → 12px, 5ft → 20px
  return 12;
}

/** Compact time formatter — mm/dd HH:MM local, no year for a scannable table. */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString([], {
    month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/** Compose the display label for a magnitude value, or "—" if none. */
function fmtMagnitude(r: StormReport): string {
  if (r.magnitudeValue === null || r.magnitudeUnit === null) return '—';
  const unit = r.magnitudeUnit === 'INCHES' ? '"'
    : r.magnitudeUnit === 'MPH'    ? ' mph'
    : r.magnitudeUnit === 'FEET'   ? ' ft'
    : ' ' + r.magnitudeUnit.toLowerCase();
  return `${r.magnitudeValue}${unit}`;
}

/** Human location — coords when present, "no fix" fallback otherwise. */
function fmtLocation(r: StormReport): string {
  if (r.lat !== null && r.lng !== null) return `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`;
  if (r.locationDescription) return r.locationDescription;
  return '<no fix>';
}

const EVENT_FILTER_OPTIONS = [
  { value: '',            label: 'All events' },
  { value: 'HAIL',        label: 'Hail' },
  { value: 'TSTM WND',    label: 'Thunderstorm Wind' },
  { value: 'TORNADO',     label: 'Tornado' },
  { value: 'FUNNEL',      label: 'Funnel Cloud' },
  { value: 'FLOOD',       label: 'Flood' },
  { value: 'WALL CLOUD',  label: 'Wall Cloud' },
  { value: 'OTHER',       label: 'Other' },
];

const DATE_RANGE_OPTIONS = [
  { value: 0,       label: 'All time' },
  { value: 3600e3,  label: 'Last hour' },
  { value: 6*3600e3, label: 'Last 6h' },
  { value: 24*3600e3, label: 'Last 24h' },
  { value: 7*24*3600e3, label: 'Last 7 days' },
] as const;

export function StormReportsView() {
  const { selectedRadioId, radios } = useRadios();
  const [reports, setReports] = React.useState<StormReport[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);
  const [eventFilter, setEventFilter] = React.useState<string>('');
  const [dateRangeMs, setDateRangeMs] = React.useState<number>(0);
  const [focusedReportId, setFocusedReportId] = React.useState<number | null>(null);
  // Map camera state — re-centred on the newest report when reports
  // land or the filter changes. Default center: Frederick, MD (the
  // operator's primary AOI per the v3.0 roadmap).
  const [center, setCenter] = React.useState<[number, number]>([39.4143, -77.4105]);
  const [zoom, setZoom] = React.useState<number>(9);

  const radioColorFor = React.useCallback((radioId: string | null) => {
    if (!radioId) return null;
    return radios.find(r => r.radio_id === radioId)?.color_hex || null;
  }, [radios]);

  const reload = React.useCallback(async () => {
    setLoading(true);
    const since = dateRangeMs > 0 ? Date.now() - dateRangeMs : undefined;
    const r = await meshDataService.listStormReports({
      radioId: selectedRadioId ?? undefined,
      eventType: eventFilter || undefined,
      since,
      limit: 500,
    });
    setLoading(false);
    setReports(r?.reports ?? []);
  }, [selectedRadioId, eventFilter, dateRangeMs]);

  React.useEffect(() => { reload(); }, [reload]);

  // Live-refresh on SSE 'stormReport' — a new :spot intake, a
  // correction, or an operator delete elsewhere. The debounced-poll
  // stack in meshDataService coalesces bursts so we don't refetch on
  // every keystroke of a mid-flow reporter.
  React.useEffect(() => {
    return meshDataService.onStormReport(reload);
  }, [reload]);

  // Auto-focus / re-center on the newest report when the list grows.
  // Skip on subsequent filter changes so operator's chosen zoom is
  // preserved during scanning.
  const prevCountRef = React.useRef(reports.length);
  React.useEffect(() => {
    if (reports.length > prevCountRef.current && reports.length > 0) {
      const newest = reports[0]; // list is sorted received_at DESC server-side
      if (newest.lat !== null && newest.lng !== null) {
        setCenter([newest.lat, newest.lng]);
      }
    }
    prevCountRef.current = reports.length;
  }, [reports]);

  const handleDelete = async (id: number) => {
    if (!confirm(`Delete storm report #${id}?  This cannot be undone.`)) return;
    setDeletingId(id);
    const r = await meshDataService.deleteStormReport(id);
    setDeletingId(null);
    if (!r.ok) {
      console.error('deleteStormReport failed:', r.error);
      alert(`Delete failed: ${r.error || 'unknown error'}`);
    }
    // SSE 'stormReport' event will reload us; explicit call anyway
    // in case the operator has server-side auth issues that mute SSE.
    reload();
  };

  const focusReport = (r: StormReport) => {
    if (r.lat !== null && r.lng !== null) {
      setCenter([r.lat, r.lng]);
      setZoom(Math.max(zoom, 12));
    }
    setFocusedReportId(r.id);
  };

  const csvHref = React.useMemo(() => {
    const p = new URLSearchParams();
    if (selectedRadioId) p.set('radio_id', selectedRadioId);
    if (eventFilter) p.set('event_type', eventFilter);
    if (dateRangeMs > 0) p.set('since', String(Date.now() - dateRangeMs));
    const qs = p.toString();
    return `/api/mesh/bbs/storm-reports/export.csv${qs ? '?' + qs : ''}`;
  }, [selectedRadioId, eventFilter, dateRangeMs]);

  // Reports with coordinates — only these render on the map. A report
  // with no fix still shows in the table (with "<no fix>") but has no
  // marker.
  const mappable = reports.filter(r => r.lat !== null && r.lng !== null);

  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AlertTriangle size={20} className="text-orange-400" />
          <div>
            <h2 className="text-base font-bold uppercase tracking-tight">Storm Reports</h2>
            <p className="text-[10px] text-brand-muted mt-0.5">
              SKYWARN Local Storm Reports submitted via <span className="mono-text">:spot</span>
              {selectedRadioId && <span> · scoped to <span className="mono-text">{selectedRadioId}</span></span>}
              {' · '}
              {reports.length} report{reports.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={csvHref}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-brand-line hover:bg-brand-line/40 transition-colors"
            title="Download visible reports as NWS LSR-shaped CSV"
            download
          >
            <Download size={11} />
            EXPORT CSV
          </a>
          <button
            onClick={reload}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-brand-line hover:bg-brand-line/40 disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            REFRESH
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 text-xs">
        <Filter size={12} className="text-brand-muted" />
        <select
          value={eventFilter}
          onChange={e => setEventFilter(e.target.value)}
          className="bg-brand-line/40 border border-brand-line rounded px-2 py-1 text-xs"
        >
          {EVENT_FILTER_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={dateRangeMs}
          onChange={e => setDateRangeMs(parseInt(e.target.value, 10))}
          className="bg-brand-line/40 border border-brand-line rounded px-2 py-1 text-xs"
        >
          {DATE_RANGE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Map + Table split */}
      <div className="flex-1 flex gap-4 overflow-hidden">
        {/* Map panel */}
        <div className="flex-1 technical-panel relative overflow-hidden min-w-0">
          <Map
            center={center}
            zoom={zoom}
            onBoundsChanged={({ center: c, zoom: z }) => { setCenter(c); setZoom(z); }}
            dprs={[1, 2]}
          >
            <ZoomControl />
            {mappable.map(r => {
              const color = markerColorForEventType(r.eventType);
              const size = markerSizeFor(r);
              const focused = focusedReportId === r.id;
              return (
                <Overlay
                  key={`sr-${r.id}`}
                  anchor={[r.lat!, r.lng!]}
                  offset={[size / 2, size / 2]}
                >
                  <button
                    onClick={() => focusReport(r)}
                    className={cn(
                      'block rounded-full border-2 transition-all cursor-pointer',
                      focused ? 'border-white shadow-lg scale-125' : 'border-brand-bg hover:scale-110',
                    )}
                    style={{
                      width: size,
                      height: size,
                      backgroundColor: color,
                    }}
                    title={`${r.eventType}${r.magnitudeValue ? ' ' + fmtMagnitude(r) : ''} — ${r.reporterShortName} ${fmtTime(r.receivedAt)}`}
                  />
                </Overlay>
              );
            })}
          </Map>
          {mappable.length === 0 && reports.length > 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-brand-bg/60 pointer-events-none">
              <div className="text-brand-muted text-xs">
                No reports have coordinates — reporters had no GPS fix. See table below.
              </div>
            </div>
          )}
          {reports.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-brand-bg/60 pointer-events-none">
              <div className="text-brand-muted text-xs text-center max-w-xs">
                <MapPin size={20} className="mx-auto mb-2 opacity-40" />
                No storm reports yet. When a subscriber DMs
                <span className="mono-text mx-1">:spot</span>
                during a storm, reports appear here in real time.
              </div>
            </div>
          )}
        </div>

        {/* Table panel */}
        <div className="w-[560px] technical-panel overflow-hidden flex flex-col">
          <div className="p-3 border-b border-brand-line text-[10px] uppercase font-bold tracking-widest text-brand-muted flex items-center gap-2">
            Reports
            {loading && <RefreshCw size={10} className="animate-spin" />}
          </div>
          <div className="flex-1 overflow-y-auto">
            {reports.length === 0 && !loading && (
              <div className="p-8 text-center text-brand-muted text-xs">
                No reports match the current filters.
              </div>
            )}
            {reports.map(r => {
              const color = markerColorForEventType(r.eventType);
              const radioColor = radioColorFor(r.radioId);
              const focused = focusedReportId === r.id;
              return (
                <div
                  key={r.id}
                  onClick={() => focusReport(r)}
                  className={cn(
                    'p-3 border-b border-brand-line/40 cursor-pointer transition-colors',
                    focused ? 'bg-brand-accent/10' : 'hover:bg-brand-line/30',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="text-xs font-bold uppercase tracking-tight">
                          {r.eventType}
                        </span>
                        <span className="text-xs mono-text text-brand-muted">
                          {fmtMagnitude(r)}
                        </span>
                        {r.spotterSource === 'TRAINED_SPOTTER' && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 uppercase tracking-widest">
                            Trained
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-brand-muted mono-text truncate">
                        {fmtLocation(r)}
                      </div>
                      {r.remarks && (
                        <div className="text-[11px] text-brand-ink mt-1 line-clamp-2">
                          {r.remarks}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-brand-muted">
                        <span>#{r.id}</span>
                        <span>·</span>
                        <span className="mono-text">{r.reporterShortName}</span>
                        {radioColor && (
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: radioColor }}
                            title={`Received by ${r.radioId}`}
                          />
                        )}
                        <span>·</span>
                        <span>{fmtTime(r.receivedAt)}</span>
                        {r.submittedToNws && (
                          <>
                            <span>·</span>
                            <span className="text-emerald-400" title={`Submitted to NWS ${r.nwsSubmissionId}`}>
                              NWS ✓
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(r.id); }}
                      disabled={deletingId === r.id}
                      className="p-1 rounded hover:bg-brand-error/20 text-brand-muted hover:text-brand-error transition-colors disabled:opacity-30"
                      title="Delete this report"
                    >
                      {deletingId === r.id ? (
                        <RefreshCw size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="p-2 border-t border-brand-line text-[10px] text-brand-muted flex items-center justify-between">
            <span>
              <CloudRain size={9} className="inline mr-1" />
              Live via SSE
            </span>
            <span>
              Legend: <span className="inline-block w-2 h-2 rounded-full mr-1" style={{backgroundColor:'#ef4444'}} />Tornado/Funnel
              <span className="inline-block w-2 h-2 rounded-full ml-2 mr-1" style={{backgroundColor:'#f97316'}} />Hail/Wind
              <span className="inline-block w-2 h-2 rounded-full ml-2 mr-1" style={{backgroundColor:'#3b82f6'}} />Flood
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
