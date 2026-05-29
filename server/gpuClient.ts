/**
 * v2.0 — Sentinel-side HTTP client for the [meshview-gpu](../gpu/README.md)
 * Python sidecar.
 *
 * Contract:
 *   - Every accelerated workload has BOTH a GPU implementation (this client,
 *     calling the sidecar) and a CPU fallback (TypeScript, lives here).
 *   - When the sidecar is reachable + responds 200, the GPU result is used.
 *   - When the sidecar is unreachable OR responds 5xx/501, the CPU fallback
 *     runs and we log a one-shot startup banner so the operator knows.
 *   - Both implementations are tested against the same fixtures with
 *     identical numerical outputs (within float tolerance).
 *
 * Phase 1.5: the only working endpoint is /health. All compute endpoints
 * return 501; the client immediately uses CPU fallbacks. Per-phase work
 * (3/4/5) implements the GPU paths in the sidecar AND adds the matching
 * CPU fallbacks here so dev machines without a sidecar still work.
 */

const SIDECAR_URL = process.env.MESHVIEW_GPU_URL || 'http://meshview-gpu:7100';
const HEALTH_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 5000;

export interface GpuHealth {
  status: 'ok' | 'unreachable';
  gpu?: {
    gpu_present: boolean;
    name?: string;
    memory_total?: string;
    driver_version?: string;
  };
  error?: string;
}

let _fallbackBannerShown = false;
function bannerOnce(reason: string): void {
  if (_fallbackBannerShown) return;
  _fallbackBannerShown = true;
  console.warn(`[GpuClient] sidecar unreachable — using CPU fallback (dev mode): ${reason}`);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function health(): Promise<GpuHealth> {
  try {
    const r = await fetchWithTimeout(`${SIDECAR_URL}/health`, { method: 'GET' }, HEALTH_TIMEOUT_MS);
    if (!r.ok) return { status: 'unreachable', error: `HTTP ${r.status}` };
    return await r.json() as GpuHealth;
  } catch (err: any) {
    return { status: 'unreachable', error: err?.message ?? String(err) };
  }
}

/**
 * Generic JSON POST wrapper. Returns null on any failure (network, 5xx, 501);
 * callers run their CPU fallback when null is returned.
 */
export async function callSidecar<TReq, TRes>(
  path: string,
  body: TReq,
): Promise<TRes | null> {
  try {
    const r = await fetchWithTimeout(
      `${SIDECAR_URL}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS,
    );
    if (!r.ok) {
      bannerOnce(`POST ${path} returned ${r.status}`);
      return null;
    }
    return await r.json() as TRes;
  } catch (err: any) {
    bannerOnce(`POST ${path} failed: ${err?.message ?? String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------
// Phase 3: spatial clustering for map pins (DBSCAN).
// ---------------------------------------------------------------------

export interface ClusterPoint {
  lat: number;
  lng: number;
  radio_id?: string | null;
  node_id?: string | null;
}

export interface ClusterRequest {
  points: ClusterPoint[];
  eps_meters: number;
  min_samples?: number;
}

export interface ClusterSummary {
  id: number;
  count: number;
  lat: number;
  lng: number;
  node_ids: string[];
  radio_ids: string[];
}

export interface ClusterResponse {
  labels: number[];
  clusters: ClusterSummary[];
  /** Where the work ran: `cuml` (GPU), `cpu` (pure-Python sidecar), or `cpu_ts` (fallback in this process). */
  backend: 'cuml' | 'cpu' | 'cpu_ts' | 'noop';
}

/**
 * Cluster lat/lng points via the GPU sidecar. Falls back to a TS DBSCAN
 * implementation when the sidecar is unreachable. Functionally equivalent;
 * the TS path is slower but accurate enough for the dev path.
 */
export async function clusterDbscan(req: ClusterRequest): Promise<ClusterResponse> {
  if (req.points.length === 0) {
    return { labels: [], clusters: [], backend: 'noop' };
  }
  const remote = await callSidecar<ClusterRequest, ClusterResponse>('/cluster/dbscan', {
    points: req.points,
    eps_meters: req.eps_meters,
    min_samples: req.min_samples ?? 2,
  });
  if (remote) return remote;
  return clusterDbscanCpu(req);
}

// ---- CPU fallback in TS (pure-JS DBSCAN) ----

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function clusterDbscanCpu(req: ClusterRequest): ClusterResponse {
  const pts = req.points;
  const n = pts.length;
  const eps = req.eps_meters;
  const minSamples = req.min_samples ?? 2;
  const labels: number[] = new Array(n).fill(-1);
  let clusterId = 0;

  const neighborsOf = (i: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (haversineMeters(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) <= eps) out.push(j);
    }
    return out;
  };

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    const nbrs = neighborsOf(i);
    if (nbrs.length + 1 < minSamples) continue;
    labels[i] = clusterId;
    const queue = [...nbrs];
    while (queue.length) {
      const q = queue.pop()!;
      if (labels[q] !== -1) continue;
      labels[q] = clusterId;
      const qn = neighborsOf(q);
      if (qn.length + 1 >= minSamples) queue.push(...qn);
    }
    clusterId++;
  }

  // Promote noise to singleton clusters so the client treats each as its own marker.
  let nextId = labels.some(l => l >= 0) ? Math.max(...labels) + 1 : 0;
  const outLabels = labels.map(l => {
    if (l === -1) {
      const v = nextId++;
      return v;
    }
    return l;
  });

  const cmap = new Map<number, { id: number; count: number; latSum: number; lngSum: number; nodeIds: string[]; radioIds: Set<string> }>();
  for (let i = 0; i < n; i++) {
    const lbl = outLabels[i];
    let c = cmap.get(lbl);
    if (!c) { c = { id: lbl, count: 0, latSum: 0, lngSum: 0, nodeIds: [], radioIds: new Set() }; cmap.set(lbl, c); }
    c.count++;
    c.latSum += pts[i].lat;
    c.lngSum += pts[i].lng;
    if (pts[i].node_id) c.nodeIds.push(pts[i].node_id!);
    if (pts[i].radio_id) c.radioIds.add(pts[i].radio_id!);
  }
  const clusters: ClusterSummary[] = Array.from(cmap.values())
    .map(c => ({
      id: c.id, count: c.count,
      lat: c.latSum / c.count, lng: c.lngSum / c.count,
      node_ids: c.nodeIds, radio_ids: Array.from(c.radioIds).sort(),
    }))
    .sort((a, b) => a.id - b.id);

  return { labels: outLabels, clusters, backend: 'cpu_ts' };
}

// ---------------------------------------------------------------------
// Phase 5: position trace simplification (Ramer-Douglas-Peucker).
// ---------------------------------------------------------------------

export interface TracePoint {
  node_id: string;
  timestamp: number;
  lat: number;
  lng: number;
}

export interface TraceSimplifyRequest {
  points: TracePoint[];
  simplify_tolerance_m?: number;
}

export interface TraceSimplifyResponse {
  /** Indexes of points kept after RDP. Pair with the original timestamps to render. */
  keep: number[];
  count: number;
  input_count: number;
  bbox: [number, number, number, number] | null;
  backend: 'cpu' | 'cpu_ts';
}

export async function simplifyTrace(req: TraceSimplifyRequest): Promise<TraceSimplifyResponse> {
  if (req.points.length === 0) {
    return { keep: [], count: 0, input_count: 0, bbox: null, backend: 'cpu_ts' };
  }
  const remote = await callSidecar<TraceSimplifyRequest, TraceSimplifyResponse>('/trace/playback', {
    ...req,
    simplify_tolerance_m: req.simplify_tolerance_m ?? 5,
  });
  if (remote) return remote;
  return simplifyTraceCpu(req);
}

// Local equirectangular projection — fine for the short distances RDP cares about.
function _perpDistanceM(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const midLat = (aLat + bLat) / 2;
  const cosMid = Math.cos((midLat * Math.PI) / 180);
  const MPDL = 111320;
  const toXY = (lat: number, lng: number): [number, number] => [lng * MPDL * cosMid, lat * MPDL];
  const [px, py] = toXY(pLat, pLng);
  const [ax, ay] = toXY(aLat, aLng);
  const [bx, by] = toXY(bLat, bLng);
  const dx = bx - ax, dy = by - ay;
  const seg2 = dx * dx + dy * dy;
  if (seg2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / seg2));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

export function simplifyTraceCpu(req: TraceSimplifyRequest): TraceSimplifyResponse {
  const points = req.points;
  const tol = req.simplify_tolerance_m ?? 5;
  const n = points.length;
  if (n === 0) return { keep: [], count: 0, input_count: 0, bbox: null, backend: 'cpu_ts' };
  if (n <= 2) {
    const lats = points.map(p => p.lat);
    const lngs = points.map(p => p.lng);
    return {
      keep: points.map((_, i) => i),
      count: n,
      input_count: n,
      bbox: [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)],
      backend: 'cpu_ts',
    };
  }
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;
    let maxD = -1;
    let maxI = -1;
    const a = points[start];
    const b = points[end];
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      const d = _perpDistanceM(p.lat, p.lng, a.lat, a.lng, b.lat, b.lng);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol && maxI > 0) {
      keep[maxI] = true;
      stack.push([start, maxI]);
      stack.push([maxI, end]);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  const lats = points.map(p => p.lat);
  const lngs = points.map(p => p.lng);
  return {
    keep: idx,
    count: idx.length,
    input_count: n,
    bbox: [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)],
    backend: 'cpu_ts',
  };
}

// ---------------------------------------------------------------------
// Phase 5: signal coverage heatmap (IDW interpolation over a 2D grid).
// ---------------------------------------------------------------------

export interface HeatmapObservation {
  lat: number;
  lng: number;
  rssi: number;
  snr?: number | null;
}

export interface HeatmapRequest {
  observations: HeatmapObservation[];
  /** (south, west, north, east) */
  bbox: [number, number, number, number];
  grid_width?: number;
  grid_height?: number;
  method?: 'idw';
  power?: number;
  max_radius_m?: number;
}

export interface HeatmapResponse {
  /** `grid_height` rows × `grid_width` cols, north → south top to bottom. null = no sample within max_radius_m. */
  grid: (number | null)[][];
  bbox: [number, number, number, number];
  stats: { min: number; max: number; samples: number } | null;
  backend: 'cupy' | 'cpu' | 'cpu_ts' | 'noop';
  method: string;
}

export async function buildHeatmap(req: HeatmapRequest): Promise<HeatmapResponse> {
  if (req.observations.length === 0) {
    const h = req.grid_height ?? 64;
    const w = req.grid_width ?? 64;
    return {
      grid: Array.from({ length: h }, () => Array(w).fill(null) as (number | null)[]),
      bbox: req.bbox, stats: null, backend: 'noop', method: req.method ?? 'idw',
    };
  }
  const remote = await callSidecar<HeatmapRequest, HeatmapResponse>('/heatmap/coverage', {
    ...req,
    grid_width:  req.grid_width  ?? 64,
    grid_height: req.grid_height ?? 64,
    method:      req.method      ?? 'idw',
    power:       req.power       ?? 2,
    max_radius_m: req.max_radius_m ?? 5000,
  });
  if (remote) return remote;
  return buildHeatmapCpu(req);
}

export function buildHeatmapCpu(req: HeatmapRequest): HeatmapResponse {
  const [s, w, n, e] = req.bbox;
  const gw = req.grid_width  ?? 64;
  const gh = req.grid_height ?? 64;
  const p  = req.power ?? 2;
  const maxR = req.max_radius_m ?? 5000;
  const method = req.method ?? 'idw';

  if (n <= s || e <= w) {
    return { grid: [], bbox: req.bbox, stats: null, backend: 'cpu_ts', method };
  }

  const obs = req.observations.map(o => ({
    latRad: (o.lat * Math.PI) / 180,
    lngRad: (o.lng * Math.PI) / 180,
    rssi: o.rssi,
  }));
  const R = 6371000;

  const grid: (number | null)[][] = [];
  let rssiMin = Infinity;
  let rssiMax = -Infinity;

  for (let row = 0; row < gh; row++) {
    const fracY = (gh - 1 - row + 0.5) / gh;
    const lat = s + (n - s) * fracY;
    const latRad = (lat * Math.PI) / 180;
    const rowOut: (number | null)[] = [];
    for (let col = 0; col < gw; col++) {
      const fracX = (col + 0.5) / gw;
      const lng = w + (e - w) * fracX;
      const lngRad = (lng * Math.PI) / 180;
      let totalW = 0;
      let totalV = 0;
      let minD = Infinity;
      let cellValue: number | null = null;
      for (const ob of obs) {
        const dp = latRad - ob.latRad;
        const dl = lngRad - ob.lngRad;
        const a = Math.sin(dp / 2) ** 2 + Math.cos(latRad) * Math.cos(ob.latRad) * Math.sin(dl / 2) ** 2;
        const d = 2 * R * Math.asin(Math.sqrt(a));
        if (d < minD) minD = d;
        if (d > maxR) continue;
        if (d < 1) { cellValue = ob.rssi; break; }
        const weight = 1 / Math.pow(d, p);
        totalW += weight;
        totalV += weight * ob.rssi;
      }
      if (cellValue != null) {
        rowOut.push(cellValue);
        rssiMin = Math.min(rssiMin, cellValue); rssiMax = Math.max(rssiMax, cellValue);
      } else if (minD > maxR) {
        rowOut.push(null);
      } else if (totalW > 0) {
        const v = totalV / totalW;
        rowOut.push(v);
        rssiMin = Math.min(rssiMin, v); rssiMax = Math.max(rssiMax, v);
      } else {
        rowOut.push(null);
      }
    }
    grid.push(rowOut);
  }

  const stats = rssiMin !== Infinity
    ? { min: rssiMin, max: rssiMax, samples: obs.length }
    : null;
  return { grid, bbox: req.bbox, stats, backend: 'cpu_ts', method };
}

// ---------------------------------------------------------------------
// Phase 4: mesh topology graph (undirected, edge-deduped, BFS components).
// ---------------------------------------------------------------------

export interface TopologyEdgeIn {
  src: string;
  dst: string;
  snr?: number | null;
  rssi?: number | null;
  last_seen?: number | null;
}

export interface TopologyEdgeOut {
  src: string;
  dst: string;
  snr: number | null;
  rssi: number | null;
  last_seen: number | null;
}

export interface TopologyResponse {
  nodes: string[];
  degrees: Record<string, number>;
  edges: TopologyEdgeOut[];
  components: string[][];
  centrality: Record<string, number> | null;
  backend: 'cugraph' | 'cpu' | 'cpu_ts';
}

export interface TopologyRequest {
  edges: TopologyEdgeIn[];
  compute_centrality?: boolean;
  k_shortest?: number;
}

export async function buildTopology(req: TopologyRequest): Promise<TopologyResponse> {
  if (req.edges.length === 0) {
    return { nodes: [], degrees: {}, edges: [], components: [], centrality: null, backend: 'cpu_ts' };
  }
  const remote = await callSidecar<TopologyRequest, TopologyResponse>('/topology/build', req);
  if (remote) return remote;
  return buildTopologyCpu(req);
}

// ---- CPU fallback in TS (mirrors the Python implementation) ----

export function buildTopologyCpu(req: TopologyRequest): TopologyResponse {
  const adj = new Map<string, Set<string>>();
  type EdgeMeta = { snr: number | null; rssi: number | null; last_seen: number | null };
  const edgeMeta = new Map<string, EdgeMeta>();

  const keyOf = (a: string, b: string) => `${a}|${b}`;
  const mergeMax = (prev: number | null | undefined, next: number | null | undefined): number | null => {
    if (prev == null && next == null) return null;
    if (prev == null) return next ?? null;
    if (next == null) return prev;
    return Math.max(prev, next);
  };

  for (const e of req.edges) {
    if (!e.src || !e.dst || e.src === e.dst) continue;
    const [a, b] = e.src < e.dst ? [e.src, e.dst] : [e.dst, e.src];
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
    const k = keyOf(a, b);
    const prev = edgeMeta.get(k);
    edgeMeta.set(k, {
      snr:       mergeMax(prev?.snr,       e.snr),
      rssi:      mergeMax(prev?.rssi,      e.rssi),
      last_seen: mergeMax(prev?.last_seen, e.last_seen),
    });
  }

  const nodes = Array.from(adj.keys()).sort();
  const degrees: Record<string, number> = {};
  for (const n of nodes) degrees[n] = adj.get(n)!.size;

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const n of nodes) {
    if (visited.has(n)) continue;
    const comp: string[] = [];
    const stack = [n];
    while (stack.length) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      comp.push(cur);
      for (const x of adj.get(cur) ?? []) {
        if (!visited.has(x)) stack.push(x);
      }
    }
    components.push(comp.sort());
  }

  let centrality: Record<string, number> | null = null;
  if (req.compute_centrality && nodes.length > 1) {
    const maxPossible = nodes.length - 1;
    centrality = {};
    for (const n of nodes) centrality[n] = degrees[n] / maxPossible;
  }

  const edgesOut: TopologyEdgeOut[] = Array.from(edgeMeta.entries())
    .map(([k, meta]) => {
      const [src, dst] = k.split('|');
      return { src, dst, snr: meta.snr, rssi: meta.rssi, last_seen: meta.last_seen };
    })
    .sort((a, b) => (a.src + a.dst).localeCompare(b.src + b.dst));

  return { nodes, degrees, edges: edgesOut, components, centrality, backend: 'cpu_ts' };
}

// ---------------------------------------------------------------------
// Beta 2: traceroute route-stability analysis.
// ---------------------------------------------------------------------

export interface RouteStabilityTraceIn {
  target: string;
  origin?: string | null;
  completed_at?: number | null;
  /** Full ordered node path origin..target inclusive. */
  path: string[];
}

export interface RouteStabilityVariant {
  nodes: string[];
  count: number;
  last_seen: number | null;
}

export interface RouteStabilityPair {
  target: string;
  origin: string | null;
  total: number;
  distinct_paths: number;
  dominant_path: string[];
  dominant_count: number;
  stability: number;
  avg_hops: number;
  first_seen: number | null;
  last_seen: number | null;
  variants: RouteStabilityVariant[];
}

export interface RouteStabilitySegment {
  a: string;
  b: string;
  count: number;
  targets: string[];
}

export interface RouteStabilityRequest {
  traces: RouteStabilityTraceIn[];
  max_segments?: number;
}

export interface RouteStabilityResponse {
  pairs: RouteStabilityPair[];
  segments: RouteStabilitySegment[];
  backend: 'cugraph' | 'cpu' | 'cpu_ts';
}

export async function routeStability(req: RouteStabilityRequest): Promise<RouteStabilityResponse> {
  if (req.traces.length === 0) {
    return { pairs: [], segments: [], backend: 'cpu_ts' };
  }
  const remote = await callSidecar<RouteStabilityRequest, RouteStabilityResponse>('/route/stability', req);
  if (remote) return remote;
  return routeStabilityCpu(req);
}

// ---- CPU fallback in TS (mirrors the Python implementation) ----

export function routeStabilityCpu(req: RouteStabilityRequest): RouteStabilityResponse {
  const maxSegments = Math.max(1, req.max_segments ?? 30);
  const byTarget = new Map<string, RouteStabilityTraceIn[]>();
  for (const t of req.traces) {
    if (!t.target || !t.path || t.path.length === 0) continue;
    if (!byTarget.has(t.target)) byTarget.set(t.target, []);
    byTarget.get(t.target)!.push(t);
  }

  const segCount = new Map<string, number>();
  const segTargets = new Map<string, Set<string>>();
  const segKey = (a: string, b: string) => `${a} ${b}`;

  const pairs: RouteStabilityPair[] = [];
  for (const [target, traces] of byTarget) {
    const total = traces.length;
    const variantCount = new Map<string, number>();
    const variantNodes = new Map<string, string[]>();
    const variantLast = new Map<string, number | null>();
    let hopSum = 0;
    let firstSeen: number | null = null;
    let lastSeen: number | null = null;
    let origin: string | null = null;

    for (const t of traces) {
      origin = origin ?? t.origin ?? null;
      const sig = t.path.join('>');
      variantCount.set(sig, (variantCount.get(sig) ?? 0) + 1);
      variantNodes.set(sig, t.path);
      if (t.completed_at != null) {
        const prev = variantLast.get(sig);
        variantLast.set(sig, prev == null ? t.completed_at : Math.max(prev, t.completed_at));
        firstSeen = firstSeen == null ? t.completed_at : Math.min(firstSeen, t.completed_at);
        lastSeen = lastSeen == null ? t.completed_at : Math.max(lastSeen, t.completed_at);
      }
      hopSum += Math.max(0, t.path.length - 1);
      for (let i = 0; i + 1 < t.path.length; i++) {
        const a = t.path[i], b = t.path[i + 1];
        if (a === b) continue;
        const k = segKey(a, b);
        segCount.set(k, (segCount.get(k) ?? 0) + 1);
        if (!segTargets.has(k)) segTargets.set(k, new Set());
        segTargets.get(k)!.add(target);
      }
    }

    const variants: RouteStabilityVariant[] = Array.from(variantCount.entries())
      .map(([sig, count]) => ({ nodes: variantNodes.get(sig)!, count, last_seen: variantLast.get(sig) ?? null }))
      .sort((a, b) => (b.count - a.count) || ((b.last_seen ?? 0) - (a.last_seen ?? 0)));
    const dominant = variants[0];

    pairs.push({
      target,
      origin,
      total,
      distinct_paths: variants.length,
      dominant_path: dominant.nodes,
      dominant_count: dominant.count,
      stability: total ? dominant.count / total : 0,
      avg_hops: total ? hopSum / total : 0,
      first_seen: firstSeen,
      last_seen: lastSeen,
      variants,
    });
  }

  pairs.sort((a, b) => (b.total - a.total) || (a.stability - b.stability));

  const segments: RouteStabilitySegment[] = Array.from(segCount.entries())
    .map(([k, count]) => {
      const [a, b] = k.split(' ');
      return { a, b, count, targets: Array.from(segTargets.get(k) ?? []).sort() };
    })
    .sort((s1, s2) => (s2.count - s1.count) || s1.a.localeCompare(s2.a) || s1.b.localeCompare(s2.b))
    .slice(0, maxSegments);

  return { pairs, segments, backend: 'cpu_ts' };
}

// ---------------------------------------------------------------------
// Boot probe — logs the sidecar status at startup so the operator knows
// what acceleration tier they have. Non-blocking; sidecar may not be up
// yet when this runs.
// ---------------------------------------------------------------------
export function probeGpuOnBoot(): void {
  health().then(h => {
    if (h.status === 'ok') {
      const g = h.gpu;
      if (g?.gpu_present) {
        console.log(`[GpuClient] sidecar healthy. GPU=${g.name ?? '?'} mem=${g.memory_total ?? '?'}`);
      } else {
        console.log('[GpuClient] sidecar healthy. No GPU detected (CPU-only sidecar mode).');
      }
    } else {
      console.warn(`[GpuClient] sidecar not reachable at ${SIDECAR_URL}: ${h.error ?? 'unknown'}`);
      console.warn('[GpuClient] Sentinel will use CPU fallbacks for all GPU workloads.');
    }
  }).catch(() => {
    // Should never throw because health() catches internally.
  });
}
