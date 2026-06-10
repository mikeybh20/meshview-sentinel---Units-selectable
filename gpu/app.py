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
# Host probe — v2.1 multi-arch.
#
# Sentinel runs on three classes of hardware that need different code
# paths:
#
#   - x86_64 desktop / server with NVIDIA GPU (cuML, cuGraph, cuPy)
#   - Jetson AGX Orin / Orin Nano  (Ampere SM 8.7 — full RAPIDS stack
#                                    via L4T-ML container)
#   - Jetson Nano (original) / Nano 2GB  (Maxwell SM 5.3 — RAPIDS
#                                    DOES NOT support this architecture)
#
# The sidecar's per-endpoint backend selection has to know which tier
# it's on. probe_gpu() now returns enough info that:
#
#   - tier="cuda-rapids" → cuML / cuGraph / cuPy paths usable
#   - tier="cuda-basic"  → cuPy maybe, RAPIDS off-limits
#                          (Nano + Nano 2GB; cuPy 9 still supports SM 5.3)
#   - tier="cpu"         → no GPU; pure-Python fallbacks everywhere
#
# Each endpoint chooses its backend based on tier, so an operator can
# move the same container between an Orin and the original Nano
# without code changes and the right path lights up automatically.
# ---------------------------------------------------------------------

def _read_text_file(path: str, default: str = "") -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except (FileNotFoundError, PermissionError):
        return default


def _jetson_model() -> str | None:
    """Read /proc/device-tree/model on Jetson. Returns the model string
    ('NVIDIA Jetson Nano 2GB Developer Kit', 'Jetson AGX Orin',
    'NVIDIA Orin Nano Developer Kit', …) or None on non-Jetson hosts."""
    raw = _read_text_file("/proc/device-tree/model")
    if not raw:
        return None
    return raw.replace("\0", "").strip() or None


def _classify_jetson(model: str) -> str:
    """Map a /proc/device-tree/model string to one of:
      'orin'    — Ampere SM 8.7, full RAPIDS works
      'xavier'  — Volta SM 7.2, RAPIDS works in principle
      'nano'    — Maxwell SM 5.3, RAPIDS DOES NOT work; cuPy is limited
      'tk1'/'tx1'/'tx2'/'unknown' — historical / unrecognised
    """
    m = model.lower()
    if "orin" in m:
        return "orin"
    if "xavier" in m:
        return "xavier"
    if "nano" in m or "tx1" in m:
        return "nano"
    if "tx2" in m:
        return "tx2"
    return "unknown"


def _probe_nvidia_smi() -> dict[str, Any] | None:
    """Try `nvidia-smi` (x86 + Orin). Returns None when not present."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version,compute_cap",
             "--format=csv,noheader"],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0 and result.stdout.strip():
            line = result.stdout.strip().split("\n")[0]
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                name, mem, driver = parts[0], parts[1], parts[2]
                compute_cap = parts[3] if len(parts) >= 4 else None
                return {
                    "name": name,
                    "memory_total": mem,
                    "driver_version": driver,
                    "compute_cap": compute_cap,
                }
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


def _rapids_importable() -> bool:
    """Cheap import probe — does this Python env have the RAPIDS stack
    installed? Used as the final gate before declaring 'cuda-rapids'
    so we don't promise capability the container can't deliver."""
    try:
        import cuml  # type: ignore  # noqa: F401
        import cupy  # type: ignore  # noqa: F401
        return True
    except ImportError:
        return False


def _cupy_importable() -> bool:
    try:
        import cupy  # type: ignore  # noqa: F401
        return True
    except ImportError:
        return False


def probe_gpu() -> dict[str, Any]:
    """Boot-time hardware + library probe. Result is cached in GPU_INFO
    and returned verbatim by /health so the dashboard can render a
    capability badge."""
    info: dict[str, Any] = {"gpu_present": False, "tier": "cpu"}

    # 1. Try nvidia-smi (works on x86 + Orin L4T 35+).
    smi = _probe_nvidia_smi()
    if smi:
        info.update({"gpu_present": True, **smi})

    # 2. Jetson identification (works for Nano without nvidia-smi too).
    jetson_model = _jetson_model()
    if jetson_model:
        klass = _classify_jetson(jetson_model)
        info["gpu_present"] = True
        info["jetson_model"] = jetson_model
        info["jetson_class"] = klass
        # nvidia-smi on older L4T may have returned nothing; fill name.
        info.setdefault("name", jetson_model)

    if not info["gpu_present"]:
        log.info("GPU probe: no GPU detected — sidecar will use CPU paths only")
        return info

    # 3. Decide the acceleration tier from class + library availability.
    klass = info.get("jetson_class")
    if klass == "nano":
        # Original Jetson Nano / Nano 2GB — SM 5.3. RAPIDS doesn't ship
        # for this arch; cuPy 9.x still supports it.
        info["tier"] = "cuda-basic" if _cupy_importable() else "cpu"
        info["note"] = "Jetson Nano (Maxwell SM 5.3) — RAPIDS unsupported; cuPy-only paths"
    elif klass in ("orin", "xavier", "tx2"):
        info["tier"] = "cuda-rapids" if _rapids_importable() else (
            "cuda-basic" if _cupy_importable() else "cpu"
        )
        if info["tier"] == "cuda-rapids":
            info["note"] = f"Jetson {klass.upper()} — full RAPIDS stack active"
        else:
            info["note"] = (
                f"Jetson {klass.upper()} detected but RAPIDS not importable; "
                "install via L4T-ML container for full acceleration"
            )
    else:
        # x86_64 desktop — RAPIDS if compute capability >= 6.0.
        info["tier"] = "cuda-rapids" if _rapids_importable() else (
            "cuda-basic" if _cupy_importable() else "cpu"
        )

    log.info(
        "GPU probe: tier=%s gpu=%s rapids=%s cupy=%s",
        info["tier"], info.get("name", "?"),
        _rapids_importable(), _cupy_importable(),
    )
    return info


GPU_INFO = probe_gpu()


def gpu_tier() -> str:
    """Cheap accessor used by endpoint handlers. Returns one of
    'cuda-rapids' | 'cuda-basic' | 'cpu'."""
    return GPU_INFO.get("tier", "cpu")


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
    """cuML DBSCAN with Haversine metric. Gated on the 'cuda-rapids'
    tier — cuML doesn't support Maxwell SM 5.3 (Jetson Nano original).
    Returns None when the tier or library makes this path unavailable;
    caller falls through to the CPU path."""
    if gpu_tier() != "cuda-rapids":
        return None
    try:
        import numpy as np  # type: ignore
        from cuml.cluster import DBSCAN  # type: ignore
    except ImportError:
        return None
    if not points:
        return []
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
    """v2.1: vectorized IDW heatmap on GPU via cuPy.

    Available on EITHER 'cuda-rapids' or 'cuda-basic' tier — cuPy 9.x
    supports the original Jetson Nano's Maxwell SM 5.3 just fine,
    unlike RAPIDS. Result is byte-identical (within float rounding)
    to _idw_cpu so the CPU fallback is interchangeable.

    Performance characteristics:
      grid 64×64 (4096 cells) × 100 obs  → ~70 ms CPU, ~3 ms cuPy on Orin
      grid 256×256 (65K cells) × 100 obs → ~4 s CPU, ~25 ms cuPy
    The bigger the grid, the bigger the win; CPU loop is O(W·H·N)
    Python interpretation, GPU is a single vectorized broadcast.

    The kernel:
      1. Build a (H, W) lat/lng meshgrid for cell centers
      2. Broadcast against the (N,) observation array → (H, W, N) deltas
      3. Haversine all distances in one call
      4. Mask cells outside max_radius_m and avoid 0-distance singularities
      5. Per-cell weighted sum / sum of weights
    """
    if gpu_tier() not in ("cuda-rapids", "cuda-basic"):
        return None
    try:
        import cupy as cp  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        return None

    s, w, n, e = req.bbox
    if n <= s or e <= w:
        return {"grid": [], "bbox": req.bbox, "stats": None,
                "backend": "cupy", "method": req.method}

    obs = req.observations
    if not obs:
        return {
            "grid": [[None] * req.grid_width for _ in range(req.grid_height)],
            "bbox": req.bbox,
            "stats": None,
            "backend": "cupy",
            "method": req.method,
        }

    H = req.grid_height
    W = req.grid_width
    R = 6371000.0
    p = float(req.power)
    max_r = float(req.max_radius_m)

    # Observation arrays (N,)
    obs_lat = cp.asarray([math.radians(o.lat) for o in obs], dtype=cp.float32)
    obs_lng = cp.asarray([math.radians(o.lng) for o in obs], dtype=cp.float32)
    obs_rssi = cp.asarray([float(o.rssi) for o in obs], dtype=cp.float32)

    # Cell-center arrays (H,), (W,) — matches _idw_cpu's frac_y / frac_x
    row_idx = cp.arange(H, dtype=cp.float32)
    col_idx = cp.arange(W, dtype=cp.float32)
    frac_y = (H - 1 - row_idx + 0.5) / H   # row 0 = top = north
    frac_x = (col_idx + 0.5) / W
    lat_grid = cp.radians(cp.asarray(s) + cp.asarray(n - s) * frac_y)  # (H,)
    lng_grid = cp.radians(cp.asarray(w) + cp.asarray(e - w) * frac_x)  # (W,)

    # Broadcast to (H, W, N)
    lat_b = lat_grid[:, None, None]                                    # (H, 1, 1)
    lng_b = lng_grid[None, :, None]                                    # (1, W, 1)
    olat_b = obs_lat[None, None, :]                                    # (1, 1, N)
    olng_b = obs_lng[None, None, :]                                    # (1, 1, N)
    rssi_b = obs_rssi[None, None, :]                                   # (1, 1, N)

    dp = lat_b - olat_b
    dl = lng_b - olng_b
    a = cp.sin(dp / 2) ** 2 + cp.cos(lat_b) * cp.cos(olat_b) * cp.sin(dl / 2) ** 2
    # Clamp for asin domain safety against tiny float overruns
    a = cp.clip(a, 0.0, 1.0)
    d = 2 * R * cp.arcsin(cp.sqrt(a))                                  # (H, W, N)

    # Per-cell nearest-sample distance — drives "outside max_radius" cells to null
    min_d = cp.min(d, axis=2)                                          # (H, W)

    # Mask: include only samples within max_r
    within = d <= max_r                                                # (H, W, N)

    # Singularity handling: if any sample is within 1 m of a cell,
    # use that sample's rssi directly (matches CPU loop semantics).
    # CPU short-circuits at the FIRST < 1 m sample; here we pick the
    # nearest qualifying one. Order-equivalent in the rare case it matters.
    near_mask = d < 1.0                                                # (H, W, N)
    any_near = cp.any(near_mask, axis=2)                               # (H, W)
    nearest_idx = cp.argmin(d, axis=2)                                 # (H, W)
    nearest_rssi = cp.take_along_axis(rssi_b.repeat(H, axis=0).repeat(W, axis=1),
                                      nearest_idx[:, :, None], axis=2).squeeze(2)

    # IDW: weight = 1 / d**p, summed over `within` samples
    safe_d = cp.where(d == 0, cp.float32(1e-9), d)                     # avoid div-by-0
    weights = cp.where(within, 1.0 / (safe_d ** p), 0.0)               # (H, W, N)
    total_w = cp.sum(weights, axis=2)                                  # (H, W)
    total_v = cp.sum(weights * rssi_b, axis=2)                         # (H, W)

    has_neighbors = total_w > 0
    interp = cp.where(has_neighbors, total_v / cp.maximum(total_w, 1e-12),
                                    cp.float32(0.0))

    # Combine: cells outside max_r → NaN; cells with a sub-1m sample → that rssi;
    # everything else → interp.
    out = cp.where(min_d > max_r,
                   cp.float32(cp.nan),
                   cp.where(any_near, nearest_rssi, interp))           # (H, W)

    # Back to host. NaNs become None in the JSON output.
    out_np = cp.asnumpy(out)
    grid: list[list[float | None]] = []
    valid_mask = ~np.isnan(out_np)
    has_valid = bool(np.any(valid_mask))
    rssi_min = float(np.min(out_np[valid_mask])) if has_valid else math.inf
    rssi_max = float(np.max(out_np[valid_mask])) if has_valid else -math.inf
    for r in range(H):
        row_out: list[float | None] = []
        for c in range(W):
            v = out_np[r, c]
            row_out.append(None if math.isnan(float(v)) else float(v))
        grid.append(row_out)

    stats = (
        {"min": rssi_min, "max": rssi_max, "samples": len(obs)}
        if has_valid else None
    )
    return {"grid": grid, "bbox": req.bbox, "stats": stats,
            "backend": "cupy", "method": req.method}


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


# ---- Beta 2: traceroute route-stability analysis -----------------------------

class RouteStabilityTrace(BaseModel):
    target: str
    origin: str | None = None
    completed_at: int | None = None
    # Full ordered node path, origin..target inclusive, as the server reconstructed it.
    path: list[str]


class RouteStabilityRequest(BaseModel):
    traces: list[RouteStabilityTrace]
    max_segments: int = 30


def _route_stability_cpu(req: RouteStabilityRequest) -> dict[str, Any]:
    """Group traceroute history by target and score how consistent the chosen
    path is over time. Also tallies the most-used directed links ("segments")
    across every trace so the operator can see the mesh backbone.

    stability = (count of the single most common path) / (total traces to that
    target). 1.0 = the route never changed; lower = the mesh kept re-routing.
    """
    by_target: dict[str, list[RouteStabilityTrace]] = {}
    for t in req.traces:
        if not t.target or not t.path:
            continue
        by_target.setdefault(t.target, []).append(t)

    seg_count: dict[tuple[str, str], int] = {}
    seg_targets: dict[tuple[str, str], set[str]] = {}

    pairs: list[dict[str, Any]] = []
    for target, traces in by_target.items():
        total = len(traces)
        variant_count: dict[str, int] = {}
        variant_nodes: dict[str, list[str]] = {}
        variant_last: dict[str, int | None] = {}
        hop_sum = 0
        first_seen: int | None = None
        last_seen: int | None = None
        origin: str | None = None

        for t in traces:
            origin = origin or t.origin
            sig = ">".join(t.path)
            variant_count[sig] = variant_count.get(sig, 0) + 1
            variant_nodes[sig] = t.path
            if t.completed_at is not None:
                prev = variant_last.get(sig)
                variant_last[sig] = t.completed_at if prev is None else max(prev, t.completed_at)
                first_seen = t.completed_at if first_seen is None else min(first_seen, t.completed_at)
                last_seen = t.completed_at if last_seen is None else max(last_seen, t.completed_at)
            hop_sum += max(0, len(t.path) - 1)
            # Tally directed links for the backbone view.
            for a, b in zip(t.path, t.path[1:]):
                if a == b:
                    continue
                key = (a, b)
                seg_count[key] = seg_count.get(key, 0) + 1
                seg_targets.setdefault(key, set()).add(target)

        variants = sorted(
            (
                {"nodes": variant_nodes[sig], "count": cnt, "last_seen": variant_last.get(sig)}
                for sig, cnt in variant_count.items()
            ),
            key=lambda v: (-v["count"], -(v["last_seen"] or 0)),
        )
        dominant = variants[0]
        pairs.append({
            "target": target,
            "origin": origin,
            "total": total,
            "distinct_paths": len(variants),
            "dominant_path": dominant["nodes"],
            "dominant_count": dominant["count"],
            "stability": dominant["count"] / total if total else 0.0,
            "avg_hops": hop_sum / total if total else 0.0,
            "first_seen": first_seen,
            "last_seen": last_seen,
            "variants": variants,
        })

    # Most-traced first, then least-stable so churny routes surface near the top.
    pairs.sort(key=lambda p: (-p["total"], p["stability"]))

    segments = sorted(
        (
            {"a": a, "b": b, "count": cnt, "targets": sorted(seg_targets[(a, b)])}
            for (a, b), cnt in seg_count.items()
        ),
        key=lambda s: (-s["count"], s["a"], s["b"]),
    )[: max(1, req.max_segments)]

    return {"pairs": pairs, "segments": segments, "backend": "cpu"}


def _try_cugraph_route_stability(req: RouteStabilityRequest) -> dict[str, Any] | None:
    """Future GPU path. Returns None until cuGraph is on the import path; the
    CPU grouping is trivially fast for the trace volumes we keep (<=500)."""
    try:
        import cugraph  # type: ignore
        import cudf  # type: ignore
    except ImportError:
        return None
    _ = (cugraph, cudf)
    return None


@app.post("/route/stability")
def route_stability(req: RouteStabilityRequest) -> dict[str, Any]:
    gpu = _try_cugraph_route_stability(req)
    return gpu if gpu is not None else _route_stability_cpu(req)


# ---------------------------------------------------------------------
# Local dev: `python app.py` boots uvicorn directly. Production uses
# the CMD in Dockerfile.
# ---------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("MESHVIEW_GPU_PORT", "7100"))
    uvicorn.run(app, host="0.0.0.0", port=port)
