export const JETSON_NANO_GUIDE = `# Deploying Meshview Sentinel on a Jetson Nano 2GB

The Jetson Nano 2GB is a reasonable host for an always-on Sentinel gateway: low power (~5 W), quiet, ARM64-native, with built-in USB serial support. This guide covers what you'll want to know before standing one up, what's safe to ignore, and what to monitor once it's running.

> **TL;DR**: yes it works. Run headless, cap container memory at ~800 MB, and put the data volume on a USB SSD or endurance microSD — not the kit's bargain card. Expect ~4-5 W idle, ~1.0-1.2 GB RAM total once the v2.0 GPU sidecar is also running (~400 MB extra for Python + RAPIDS); 1.x deployments without the sidecar stay closer to 600-800 MB.

---

## What works out of the box

- **ARM64 architecture** — \`node:22-slim\`, \`better-sqlite3\`, \`serialport\`, and every other dependency we use ships ARM64 prebuilds. No native rebuilds needed during \`docker compose up --build\`.
- **USB serial radio** — Jetson L4T includes the standard CH340 / CP210x drivers. Plug in a Meshtastic radio and \`/dev/ttyUSB0\` appears within a few seconds.
- **Docker device passthrough** — the \`device_cgroup_rules\` in \`docker-compose.yml\` (\`c 188:* rmw\` for ttyUSB) work identically on aarch64.
- **CPU** — Cortex-A57 quad at 1.43 GHz is plenty. The hand-rolled protobuf parser, SQLite, and Express are all low single-digit percent CPU even on a busy 100-node mesh.
- **Networking** — Gigabit ethernet, no issue.

---

## What needs attention

### RAM (2 GB) — biggest constraint

Rough budget for a typical 2GB Jetson:

| Component | Approx. RAM |
|---|---|
| Linux base + L4T services | ~500 MB |
| Docker daemon | ~80 MB |
| Sentinel container (Node + SQLite + caches) | ~250-400 MB |
| **\`meshview-gpu\` sidecar** (v2.0+: Python + FastAPI; +RAPIDS if installed) | **~400 MB** |
| **Headroom for everything else** | **~600 MB** |

That's tight but workable **for headless operation** — Jetson runs the server only; you browse from a laptop or phone over the LAN. It becomes a problem if you also run a desktop browser on the Jetson: Chromium will push into swap and eventually OOM-kill.

### Don't need GPU workloads on a Nano?

If you don't want the GPU sidecar running (the Nano's Maxwell GPU only meaningfully accelerates the smaller workloads — clustering, topology — and we run those on the CPU on Nano anyway), comment out the \`meshview-gpu\` service in \`docker-compose.yml\`. Sentinel detects the sidecar's absence at boot and transparently falls back to its TypeScript CPU implementations:

\`\`\`
[GpuClient] sidecar unreachable — using CPU fallback (dev mode)
\`\`\`

Reclaiming the ~400 MB the sidecar would have used is the easiest single win for headroom on a 2GB Nano.

**Mitigations**:

1. **Go headless** — connect via SSH only. Browse the dashboard from another device on your LAN.

2. **Cap the container's memory** so Sentinel can't accidentally eat into host territory. Add this to your \`docker-compose.yml\` under the \`meshview\` service:

\`\`\`yaml
services:
  meshview:
    # ... existing config ...
    deploy:
      resources:
        limits:
          memory: 800M
\`\`\`

If Sentinel ever grows past 800M (it shouldn't, but defensive), Docker OOM-kills just the container instead of the whole system.

3. **Verify zram is active** for graceful pressure handling:

\`\`\`bash
swapon --show
# Empty? Install:
sudo apt install zram-config
sudo systemctl enable --now zram-config
\`\`\`

JetPack 5+ usually ships zram already configured.

---

### Storage — second-biggest concern

SQLite WAL mode + our retention loops write **constantly** — every NodeInfo, every Telemetry, every Position. On a busy mesh that's thousands of writes per hour.

| Storage | Expected lifetime under Sentinel load |
|---|---|
| Cheap microSD (Class 10, ~$10) | **3-6 months** before unrecoverable errors |
| Endurance microSD (SanDisk High Endurance, Samsung PRO Endurance) | 2-3 years |
| External USB SSD (any 64-128 GB stick) | Effectively unlimited + ~5× faster queries |

**Strong recommendation**: spend ~$20 on a USB SSD and put Docker on it. Either:

**Option A — move all of \`/var/lib/docker\`** (simplest, also benefits any other containers):

\`\`\`bash
sudo systemctl stop docker
sudo rsync -aHAX /var/lib/docker/ /mnt/ssd/docker/
sudo mv /var/lib/docker /var/lib/docker.old
sudo ln -s /mnt/ssd/docker /var/lib/docker
sudo systemctl start docker
# Verify Sentinel comes back up cleanly, then:
sudo rm -rf /var/lib/docker.old
\`\`\`

**Option B — bind-mount just the Sentinel data volume** (surgical):

Edit \`docker-compose.yml\`:

\`\`\`yaml
    volumes:
      - /dev:/dev
      - /sys:/sys:ro
      - /run/udev:/run/udev:ro
      # Was: - meshview-data:/app/data
      - /mnt/ssd/meshview-data:/app/data
\`\`\`

The SQLite DB is the hot file; everything else is cold. Either option removes microSD wear from the equation.

---

### One-time build performance

\`docker compose up --build\` runs \`npm ci\` + \`npm run build\` (Vite). On a development laptop this is ~3 seconds. **On a 2GB Nano, expect 1-3 minutes.** Not an issue — just don't think the build is hung when it sits at the Vite step for a while.

If you'll be doing frequent rebuilds: build the image once on a faster ARM64 machine (Pi 5, M-series Mac in ARM emulation, AWS Graviton instance), then transfer:

\`\`\`bash
# On the fast machine:
docker save meshview-sentinel-meshview:latest | gzip > sentinel.tar.gz
scp sentinel.tar.gz jetson:~

# On the Jetson:
gunzip -c sentinel.tar.gz | docker load
docker compose up -d  # (no --build needed)
\`\`\`

---

## Pre-deployment checklist

Run these on a fresh Jetson before \`docker compose up\` for the first time:

\`\`\`bash
# 1. Check JetPack version — JetPack 5+ recommended (glibc 2.31+)
cat /etc/nv_tegra_release
ldd --version | head -1
# JetPack 4.x (L4T 32.x) ships glibc 2.27 which can't run Node 22 prebuilds.
# Upgrade to JetPack 5 or 6 if you're on 4.x.

# 2. Modern Docker (24+ with the compose v2 plugin)
docker --version
docker compose version
# If "docker compose" errors out, install the modern Docker:
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker

# 3. Storage destination ready
mount | grep -E 'ssd|nvme'
# Confirm your USB SSD is mounted (e.g., /mnt/ssd)

# 4. zram active for memory pressure
swapon --show

# 5. Right power supply
# Use the 5V/3A USB-C, not a phone charger.
# Underpowered = unpredictable throttling / brownouts.
\`\`\`

---

## Once running

Monitor these for the first week to catch surprises early:

\`\`\`bash
# Memory pressure (should stay well under 1.5 GB total)
free -h

# Per-container resource usage
docker stats --no-stream

# Sentinel storage growth (plateaus around 100-150 MB on a typical mesh)
du -sh /var/lib/docker/volumes/meshview-sentinel_meshview-data/_data
# Or, if you bind-mounted: du -sh /mnt/ssd/meshview-data

# microSD wear tracking (skip this if you moved to SSD)
cat /sys/block/mmcblk0/stat
# Last column trending up rapidly = high write load
\`\`\`

The dashboard's **Settings → Disk** panel is the easiest visibility into DB growth and per-table row counts. If the database climbs past ~200 MB on a typical mesh, something's misbehaving and worth investigating (most likely auto-prune isn't running).

---

## Common Jetson-specific gotchas

### "permission denied" opening /dev/ttyUSB0

Your user needs to be in the \`dialout\` group, AND Docker needs the device cgroup rules (already in our \`docker-compose.yml\`).

\`\`\`bash
sudo usermod -aG dialout $USER
# Log out and back in
\`\`\`

### Container crashes with "Illegal instruction" on startup

You're on JetPack 4.x with glibc 2.27 and Node 22 won't run. Either:
- Upgrade to JetPack 5+ (recommended; Ubuntu 20.04 with glibc 2.31)
- Pin to an older Node image (Node 18 still supports glibc 2.27)

### Build runs out of memory during \`npm ci\`

Free up RAM before the build:

\`\`\`bash
sudo systemctl stop docker.service.d/snap* 2>/dev/null
sudo systemctl stop bluetooth NetworkManager-wait-online
# Then retry the build
docker compose up -d --build
\`\`\`

If it still OOMs, build the image on another machine and transfer (see "One-time build performance" above).

### Container running but dashboard unreachable from LAN

See the **Installation Guide → Phase 7: Troubleshooting → Bridge appears stuck** section. The same diagnostic steps apply on Jetson.

### Sentinel using a lot of CPU at idle

Usually not Sentinel itself — check what else is running:

\`\`\`bash
top -b -n 1 | head -20
# Common offenders on Jetson: jetson_clocks daemon, NVIDIA OTA services,
# automatic updates downloading in the background
\`\`\`

Sentinel's steady-state CPU should be under 5% on a Nano.

---

## What you get

A standalone, low-power, always-on Meshtastic gateway:

- **Power**: 4-5 W idle, 6-7 W under active mesh traffic
- **Network**: Gigabit ethernet
- **Storage**: ~150 MB SQLite + 50 MB Docker logs (with our log rotation)
- **Uptime**: tested for months at a time without intervention if storage is on SSD/endurance media

Plug in a Meshtastic radio over USB, point your phone or laptop browser at \`http://<jetson-ip>:3000/\`, and you've got the full Sentinel dashboard — same features as any other deployment, just running on a $59 board.

---

*Generated for Meshview Sentinel. See the Installation Guide for general deployment steps — this document only covers what's different on the Jetson Nano.*
`;
