"""
meshview-gpu — Python sidecar for GPU-accelerated workloads.

Phase 4 lights up /topology/build alongside Phase 3's /cluster/dbscan. Other
endpoints remain stubs until their phase lands:

  Phase 3 ✓ /cluster/dbscan        — spatial clustering for map pins
  Phase 4 ✓ /topology/build        — mesh topology graph (cuGraph if installed)
  Phase 5   /heatmap/coverage      — RSSI/SNR interpolation (cuPy)
  Phase 5   /trace/playback        — position history processing (cuDF)

Sentinel talks to this service via HTTP (see [../server/gpuClient.ts](../server/gpuClient.ts)).
When unreachable, Sentinel falls back to CPU implementations in TS, prints a
one-shot startup banner, and the developer keeps working.

Implementation strategy: each endpoint tries cuML/cuGraph/cuPy first and
falls back to a pure-Python implementation when those aren't installed. This
keeps the sidecar functional on minimal hosts (the python:3.11-slim base
image used by Phase 1.5) and lets a Dockerfile.gpu drop in RAPIDS for real
acceleration without code changes.

Boot probe: this module logs what GPU and how much VRAM the host has so it's
obvious in the container log which acceleration tier is active. See README.md.
"""
from __future__ import annotations

import logging
import math
import os
import subprocess
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(
    level=os.getenv("MESHVIEW_GPU_LOG_LEVEL", "INFO"),
    format="[meshview-gpu] %(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("meshview-gpu")


# ---------------------------------------------------------------------
# Host probe — logs detected GPU at startup so operators / CI know what
# acceleration tier is active. Falls back gracefully on dev machines.
# ---------------------------------------------------------------------
def probe_gpu() -> dict[str, Any]:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version",
             "--format=csv,noheader"],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0 and result.stdout.strip():
            line = result.stdout.strip().split("\n")[0]
            name, mem, driver = [p.strip() for p in line.split(",")]
            return {
                "gpu_present": True,
                "name": name,
                "memory_total": mem,
                "driver_version": driver,
            }
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Jetson without nvidia-smi (older L4T) — check device-tree
    try:
        with open("/proc/device-tree/compatible", "rb") as f:
            compat = f.read().decode("utf-8", errors="ignore")
            if "tegra" in compat.lower() or "jetson" in compat.lower():
                return {"gpu_present": True, "name": f"Tegra/Jetson ({compat.split(chr(0))[0]})"}
    except FileNotFoundError:
        pass

    return {"gpu_present": False}


GPU_INFO = probe_gpu()
log.info("GPU probe: %s", GPU_INFO)


# ---------------------------------------------------------------------
# FastAPI app + endpoint stubs.
# ---------------------------------------------------------------------
app = FastAPI(
    title="meshview-gpu",
    version="0.1.0",
    description="GPU-accelerated workloads for MeshView Sentinel v2.0",
)


@app.get("/health")
def health() -> dict[str, Any]:
    """Liveness + GPU info. Sentinel polls this on boot to log capability."""
    return {"status": "ok", "gpu": GPU_INFO}


# ---- Phase 3: spatial clustering ------------------------------------------------

class ClusterPoint(BaseModel):
    lat: float
    lng: float
    radio_id: str | None = None
    node_id: str | None = None


class ClusterRequest(BaseModel):
    points: list[ClusterPoint]
    eps_meters: float = 50.0
    min_samples: int = 2


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in meters between two lat/lng pairs."""
    R = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _dbscan_cpu(points: list[ClusterPoint], eps: float, min_samples: int) -> list[int]:
    """Pure-Python DBSCAN. O(n²) — fine for the mesh sizes we expect (≤1000)."""
    n = len(points)
    labels = [-1] * n  # -1 = noise/unclassified
    cluster_id = 0

    def neighbors_of(i: int) -> list[int]:
        out: list[int] = []
        pi = points[i]
        for j in range(n):
            if i == j:
                continue
            if _haversine_m(pi.lat, pi.lng, points[j].lat, points[j].lng) <= eps:
                out.append(j)
        return out

    for i in range(n):
        if labels[i] != -1:
            continue
        nbrs = neighbors_of(i)
        if len(nbrs) + 1 < min_samples:
            continue  # leave as noise (will be a singleton "cluster" in output)
        labels[i] = cluster_id
        # Expand
        queue = list(nbrs)
        while queue:
            q = queue.pop()
            if labels[q] != -1:
                continue
            labels[q] = cluster_id
            qn = neighbors_of(q)
            if len(qn) + 1 >= min_samples:
                queue.extend(qn)
        cluster_id += 1

    return labels


def _try_cuml_dbscan(points: list[ClusterPoint], eps: float, min_samples: int) -> list[int] | None:
    """If cuML is installed (real GPU host), use cuML DBSCAN with Haversine metric."""
    try:
        import numpy as np  # type: ignore
        from cuml.cluster import DBSCAN  # type: ignore
    except ImportError:
        return None
    if not points:
        return []
    # cuML DBSCAN wants radians for Haversine
    coords = np.array([[math.radians(p.lat), math.radians(p.lng)] for p in points])
    eps_rad = eps / 6371000.0
    model = DBSCAN(eps=eps_rad, min_samples=min_samples, metric="haversine")
    labels = model.fit_predict(coords)
    return [int(x) for x in labels.tolist()]


@app.post("/cluster/dbscan")
def cluster_dbscan(req: ClusterRequest) -> dict[str, Any]:
    """
    Cluster lat/lng points by spatial proximity using DBSCAN. Noise points
    (those without enough neighbors within `eps_meters`) are assigned to
    singleton clusters in the output so the client can still render them
    individually — labels are >=0 always.

    Implementation prefers cuML when available, falls back to pure-Python.
    """
    if not req.points:
        return {"labels": [], "clusters": [], "backend": "noop"}

    # Try GPU first
    labels = _try_cuml_dbscan(req.points, req.eps_meters, req.min_samples)
    backend = "cuml"
    if labels is None:
        labels = _dbscan_cpu(req.points, req.eps_meters, req.min_samples)
        backend = "cpu"

    # Re-pack noise (-1) into singleton clusters so the client gets one
    # marker per noise point + one per real cluster.
    next_id = (max(labels) + 1) if any(l >= 0 for l in labels) else 0
    out_labels: list[int] = []
    for l in labels:
        if l == -1:
            out_labels.append(next_id)
            next_id += 1
        else:
            out_labels.append(l)

    # Build cluster summary: count + centroid + heard-by-radios set.
    clusters: dict[int, dict[str, Any]] = {}
    for i, lbl in enumerate(out_labels):
        c = clusters.setdefault(lbl, {
            "id": lbl, "count": 0, "lat_sum": 0.0, "lng_sum": 0.0,
            "node_ids": [], "radio_ids": set(),
        })
        c["count"] += 1
        c["lat_sum"] += req.points[i].lat
        c["lng_sum"] += req.points[i].lng
        if req.points[i].node_id:
            c["node_ids"].append(req.points[i].node_id)
        if req.points[i].radio_id:
            c["radio_ids"].add(req.points[i].radio_id)

    summary = [
        {
            "id": c["id"],
            "count": c["count"],
            "lat": c["lat_sum"] / c["count"],
            "lng": c["lng_sum"] / c["count"],
            "node_ids": c["node_ids"],
            "radio_ids": sorted(c["radio_ids"]),
        }
        for c in clusters.values()
    ]
    summary.sort(key=lambda c: c["id"])

    return {"labels": out_labels, "clusters": summary, "backend": backend}


# ---- Phase 4: topology graph ----------------------------------------------------

class TopologyEdge(BaseModel):
    src: str
    dst: str
    snr: float | None = None
    rssi: float | None = None
    last_seen: int | None = None


class TopologyRequest(BaseModel):
    edges: list[TopologyEdge]
    compute_centrality: bool = False
    k_shortest: int | None = None  # Reserved — future per-pair k-shortest paths


def _topology_cpu(req: TopologyRequest) -> dict[str, Any]:
    """Pure-Python topology builder. Computes:
      - the deduplicated edge set (undirected)
      - per-node degree
      - connected components via union-find
      - optional degree-centrality (sorted desc)
    """
    # Normalize: undirected edges, canonical (a, b) where a < b string-wise.
    adj: dict[str, set[str]] = {}
    edge_meta: dict[tuple[str, str], dict[str, Any]] = {}
    for e in req.edges:
        if not e.src or not e.dst or e.src == e.dst:
            continue
        a, b = (e.src, e.dst) if e.src < e.dst else (e.dst, e.src)
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)
        prev = edge_meta.get((a, b))
        # Keep the strongest signal we've seen for this pair.
        snr = e.snr if prev is None else (max(prev.get("snr", -1e9), e.snr) if e.snr is not None else prev.get("snr"))
        rssi = e.rssi if prev is None else (max(prev.get("rssi", -1e9), e.rssi) if e.rssi is not None else prev.get("rssi"))
        last_seen = e.last_seen if prev is None else (max(prev.get("last_seen", 0), e.last_seen) if e.last_seen is not None else prev.get("last_seen"))
        edge_meta[(a, b)] = {"snr": snr, "rssi": rssi, "last_seen": last_seen}

    nodes = sorted(adj.keys())
    degrees = {n: len(adj[n]) for n in nodes}

    # Connected components via iterative BFS (avoid recursion blowups on long chains).
    visited: set[str] = set()
    components: list[list[str]] = []
    for n in nodes:
        if n in visited:
            continue
        comp: list[str] = []
        stack = [n]
        while stack:
            cur = stack.pop()
            if cur in visited:
                continue
            visited.add(cur)
            comp.append(cur)
            stack.extend(x for x in adj.get(cur, ()) if x not in visited)
        components.append(sorted(comp))

    centrality: dict[str, float] | None = None
    if req.compute_centrality and len(nodes) > 1:
        max_possible = len(nodes) - 1
        centrality = {n: degrees[n] / max_possible for n in nodes}

    out_edges = [
        {"src": a, "dst": b, **edge_meta[(a, b)]}
        for (a, b) in sorted(edge_meta.keys())
    ]

    return {
        "nodes": nodes,
        "degrees": degrees,
        "edges": out_edges,
        "components": components,
        "centrality": centrality,
        "backend": "cpu",
    }


def _try_cugraph_topology(req: TopologyRequest) -> dict[str, Any] | None:
    """Future GPU path. Returns None until cuGraph is on the import path."""
    try:
        import cugraph  # type: ignore
        import cudf  # type: ignore
    except ImportError:
        return None
    # cuGraph is available — but the CPU path is fast enough for mesh sizes
    # we expect (<10k nodes). Leaving this as the integration seam for when
    # someone needs to scale; until then we return None and use _topology_cpu.
    _ = (cugraph, cudf)  # mark imports as used so the type checker stops fretting
    return None


@app.post("/topology/build")
def topology_build(req: TopologyRequest) -> dict[str, Any]:
    """
    Build an undirected mesh topology from heard-by edges. Phase 4 ships the
    pure-Python implementation; cuGraph detection is a no-op until a
    deployment actually has it installed (the Phase 1.5 base image doesn't).
    """
    gpu = _try_cugraph_topology(req)
    return gpu if gpu is not None else _topology_cpu(req)


# ---- Phase 5: signal coverage heatmap ------------------------------------------

class HeatmapObservation(BaseModel):
    lat: float
    lng: float
    rssi: float
    snr: float | None = None


class HeatmapRequest(BaseModel):
    observations: list[HeatmapObservation]
    bbox: tuple[float, float, float, float]  # (south, west, north, east)
    grid_width: int = 64
    grid_height: int = 64
    method: str = "idw"          # only "idw" today; kriging is a future option
    power: float = 2.0           # IDW exponent — 2 = inverse-square (default)
    max_radius_m: float = 5000   # cells with no sample within this radius become null


def _idw_cpu(req: HeatmapRequest) -> dict[str, Any]:
    """Pure-Python IDW with a max-radius cutoff so distant cells are null
    instead of getting smeared values from the nearest sample. Output is a
    `grid_width × grid_height` 2D array of either floats (RSSI dBm) or None.
    """
    s, w, n, e = req.bbox
    if n <= s or e <= w:
        return {"grid": [], "bbox": req.bbox, "stats": None, "backend": "cpu", "method": req.method}

    obs = req.observations
    if not obs:
        return {
            "grid": [[None] * req.grid_width for _ in range(req.grid_height)],
            "bbox": req.bbox,
            "stats": None,
            "backend": "cpu",
            "method": req.method,
        }

    # Pre-compute observation positions in radians for haversine.
    obs_pts = [(math.radians(o.lat), math.radians(o.lng), float(o.rssi)) for o in obs]
    R = 6371000.0
    max_r = req.max_radius_m
    p = req.power

    grid: list[list[float | None]] = []
    rssi_min = math.inf
    rssi_max = -math.inf
    for row in range(req.grid_height):
        # Cell-center latitude
        frac_y = (req.grid_height - 1 - row + 0.5) / req.grid_height  # north → south rows top → bottom
        lat = s + (n - s) * frac_y
        lat_rad = math.radians(lat)
        row_out: list[float | None] = []
        for col in range(req.grid_width):
            frac_x = (col + 0.5) / req.grid_width
            lng = w + (e - w) * frac_x
            lng_rad = math.radians(lng)

            # IDW with cutoff
            total_w = 0.0
            total_v = 0.0
            min_d = math.inf
            for plat, plng, prssi in obs_pts:
                dp = lat_rad - plat
                dl = lng_rad - plng
                a = math.sin(dp / 2) ** 2 + math.cos(lat_rad) * math.cos(plat) * math.sin(dl / 2) ** 2
                d = 2 * R * math.asin(math.sqrt(a))
                if d < min_d: min_d = d
                if d > max_r: continue
                # Avoid singularity when grid cell sits on top of an observation
                if d < 1.0:
                    total_w = float("inf")
                    total_v = prssi
                    break
                weight = 1.0 / (d ** p)
                total_w += weight
                total_v += weight * prssi
            if min_d > max_r:
                row_out.append(None)
            elif total_w == float("inf"):
                row_out.append(total_v)
                rssi_min = min(rssi_min, total_v)
                rssi_max = max(rssi_max, total_v)
            elif total_w > 0:
                v = total_v / total_w
                row_out.append(v)
                rssi_min = min(rssi_min, v)
                rssi_max = max(rssi_max, v)
            else:
                row_out.append(None)
        grid.append(row_out)

    stats = (
        {"min": rssi_min, "max": rssi_max, "samples": len(obs)}
        if rssi_min != math.inf else None
    )
    return {"grid": grid, "bbox": req.bbox, "stats": stats, "backend": "cpu", "method": req.method}


def _try_cupy_heatmap(req: HeatmapRequest) -> dict[str, Any] | None:
    """GPU path stub. cuPy + a vectorized IDW kernel would land here when
    we're on a host that has CuPy in the image. Phase 1.5 base image doesn't,
    so we return None and the CPU path runs."""
    try:
        import cupy  # type: ignore
    except ImportError:
        return None
    _ = cupy
    return None


@app.post("/heatmap/coverage")
def heatmap_coverage(req: HeatmapRequest) -> dict[str, Any]:
    """
    Inverse-distance-weighted signal coverage heatmap. Each cell of the
    output grid is either the IDW-interpolated RSSI (dBm) or null when no
    sample falls within `max_radius_m`. Used by the Dashboard map's coverage
    overlay toggle.
    """
    gpu = _try_cupy_heatmap(req)
    return gpu if gpu is not None else _idw_cpu(req)


# ---- Phase 5: trace playback & analysis ----------------------------------------

class TracePoint(BaseModel):
    node_id: str
    timestamp: int
    lat: float
    lng: float


class TracePlaybackRequest(BaseModel):
    points: list[TracePoint]
    simplify_tolerance_m: float = 5.0


def _perpendicular_distance_m(
    px_lat: float, px_lng: float,
    a_lat: float, a_lng: float,
    b_lat: float, b_lng: float,
) -> float:
    """Distance in meters from point P to the line segment AB. Treats lat/lng
    as a local planar projection — fine for the short distances RDP cares
    about (≤ a few hundred km of trace data per node)."""
    # Local equirectangular projection at the segment midpoint
    mid_lat = (a_lat + b_lat) / 2
    cos_mid = math.cos(math.radians(mid_lat))
    M_PER_DEG_LAT = 111320.0
    def to_xy(lat: float, lng: float) -> tuple[float, float]:
        return (lng * M_PER_DEG_LAT * cos_mid, lat * M_PER_DEG_LAT)
    px, py = to_xy(px_lat, px_lng)
    ax, ay = to_xy(a_lat, a_lng)
    bx, by = to_xy(b_lat, b_lng)
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    if seg2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)


def _rdp(points: list[TracePoint], tolerance_m: float) -> list[int]:
    """Iterative Ramer-Douglas-Peucker. Returns the indexes of the points
    that survive simplification. Iterative to avoid recursion depth on long
    traces. Tolerance is in meters."""
    n = len(points)
    if n <= 2:
        return list(range(n))
    keep = [False] * n
    keep[0] = True
    keep[n - 1] = True
    stack: list[tuple[int, int]] = [(0, n - 1)]
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        max_d = -1.0
        max_i = -1
        a = points[start]
        b = points[end]
        for i in range(start + 1, end):
            p = points[i]
            d = _perpendicular_distance_m(p.lat, p.lng, a.lat, a.lng, b.lat, b.lng)
            if d > max_d:
                max_d = d
                max_i = i
        if max_d > tolerance_m and max_i > 0:
            keep[max_i] = True
            stack.append((start, max_i))
            stack.append((max_i, end))
    return [i for i, k in enumerate(keep) if k]


@app.post("/trace/playback")
def trace_playback(req: TracePlaybackRequest) -> dict[str, Any]:
    """
    Ramer-Douglas-Peucker simplification of a position trace. Returns the
    indexes of surviving points (so the client can keep its timestamps + alt
    around without resampling) plus a count, and the bounding box.
    """
    if not req.points:
        return {"keep": [], "count": 0, "bbox": None, "backend": "cpu"}
    keep = _rdp(req.points, req.simplify_tolerance_m)
    lats = [p.lat for p in req.points]
    lngs = [p.lng for p in req.points]
    return {
        "keep": keep,
        "count": len(keep),
        "input_count": len(req.points),
        "bbox": [min(lats), min(lngs), max(lats), max(lngs)],
        "backend": "cpu",
    }


# ---------------------------------------------------------------------
# Local dev: `python app.py` boots uvicorn directly. Production uses
# the CMD in Dockerfile.
# ---------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("MESHVIEW_GPU_PORT", "7100"))
    uvicorn.run(app, host="0.0.0.0", port=port)
