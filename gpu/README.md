# meshview-gpu

GPU-accelerated workloads for MeshView Sentinel v2.0. Runs as a Python sidecar
alongside the main Node.js Sentinel container in `docker-compose.yml`.

## Why a separate container?

The TypeScript ecosystem has no mature CUDA bindings. The NVIDIA RAPIDS stack
(cuML, cuGraph, cuDF, cuPy) is Python-native. Instead of reimplementing those
in JS, Sentinel calls this sidecar over HTTP.

See [../ROADMAP-v2.md](../ROADMAP-v2.md) → "CUDA is a core capability" for the
full strategy.

## Endpoints (Phase 1.5)

All endpoints are stubs that return `501 Not Implemented`. Each phase fills
in its corresponding endpoint:

| Endpoint | Phase | Library | Purpose |
|---|---|---|---|
| `POST /cluster/dbscan` | 3 | cuML | Spatial clustering for map pins |
| `POST /topology/build` | 4 | cuGraph | Mesh topology graph + metrics |
| `POST /heatmap/coverage` | 5 | cuPy | RSSI/SNR interpolation grid |
| `POST /trace/playback` | 5 | cuDF | Position history smoothing + simplification |
| `GET /health` | 1.5 | — | Liveness + detected GPU info |

## Local development

```bash
cd gpu
pip install -r requirements.txt
python app.py
# Sidecar listening on http://localhost:7100
curl http://localhost:7100/health
```

## CPU fallback in Sentinel

When the sidecar is unreachable (developer not running `docker compose up`,
sidecar crashed, etc.), Sentinel's [GpuClient](../server/gpuClient.ts) falls
back to CPU implementations and logs:

```
[GpuClient] sidecar unreachable — using CPU fallback (dev mode)
```

This means the app keeps working without GPU acceleration. Production
deployments should always have the sidecar healthy.
