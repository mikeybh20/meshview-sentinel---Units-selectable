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
