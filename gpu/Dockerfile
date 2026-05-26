# meshview-gpu — sidecar for GPU-accelerated workloads.
#
# Phase 1.5 base: python:3.11-slim. No CUDA dependencies yet — the endpoints
# are stubs returning 501. This keeps the image small (~150 MB) and runnable
# on any Linux/arm/amd64 host so developers without GPU passthrough still
# get a working sidecar for the HTTP contract.
#
# Phase 3+ will switch the base image per platform (multi-arch manifest):
#   linux/amd64 (x86 + NVIDIA GPU) → nvcr.io/nvidia/rapidsai/rapidsai
#   linux/arm64 + Jetson L4T       → nvcr.io/nvidia/l4t-ml
#   linux/arm64 SBSA (GB10/Grace)  → nvcr.io/nvidia/cuda + RAPIDS pip wheels
#
# To switch a deployment to the GPU-enabled image, override the build target
# in docker-compose.yml: `build: { context: ./gpu, dockerfile: Dockerfile.gpu }`
# (Dockerfile.gpu lands with Phase 3).

FROM python:3.11-slim

WORKDIR /app

# Install Python deps first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV MESHVIEW_GPU_PORT=7100
EXPOSE 7100

# nvidia-smi probe will gracefully return gpu_present=false in this base
# image. Phase 3+ Dockerfiles will land it on a CUDA base where the probe
# actually finds a GPU.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7100"]
