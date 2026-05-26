"""
meshview-gpu — Python sidecar for GPU-accelerated workloads.

Phase 3 lights up /cluster/dbscan. Other endpoints remain stubs until their
phase lands:

  Phase 3 ✓ /cluster/dbscan        — spatial clustering for map pins
  Phase 4   /topology/build        — mesh topology graph (cuGraph)
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
    k_shortest: int | None = None


@app.post("/topology/build")
def topology_build(_req: TopologyRequest) -> dict[str, Any]:
    """Phase 4 will implement using cuGraph. Returns 501 until then."""
    raise HTTPException(status_code=501, detail="topology_build not implemented (Phase 4)")


# ---- Phase 5: signal coverage heatmap ------------------------------------------

class HeatmapObservation(BaseModel):
    lat: float
    lng: float
    rssi: float
    snr: float | None = None


class HeatmapRequest(BaseModel):
    observations: list[HeatmapObservation]
    bbox: tuple[float, float, float, float]  # (south, west, north, east)
    grid_width: int = 256
    grid_height: int = 256
    method: str = "idw"  # "idw" | "kriging"


@app.post("/heatmap/coverage")
def heatmap_coverage(_req: HeatmapRequest) -> dict[str, Any]:
    """Phase 5 will implement using cuPy. Returns 501 until then."""
    raise HTTPException(status_code=501, detail="heatmap_coverage not implemented (Phase 5)")


# ---- Phase 5: trace playback & analysis ----------------------------------------

class TracePoint(BaseModel):
    node_id: str
    timestamp: int
    lat: float
    lng: float


class TracePlaybackRequest(BaseModel):
    points: list[TracePoint]
    simplify_tolerance_m: float = 5.0


@app.post("/trace/playback")
def trace_playback(_req: TracePlaybackRequest) -> dict[str, Any]:
    """Phase 5 will implement using cuDF + Ramer-Douglas-Peucker. Returns 501 until then."""
    raise HTTPException(status_code=501, detail="trace_playback not implemented (Phase 5)")


# ---------------------------------------------------------------------
# Local dev: `python app.py` boots uvicorn directly. Production uses
# the CMD in Dockerfile.
# ---------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("MESHVIEW_GPU_PORT", "7100"))
    uvicorn.run(app, host="0.0.0.0", port=port)
