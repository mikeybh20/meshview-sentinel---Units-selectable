export const INSTALLATION_GUIDE_DELL_GB10 = `# Recipe: Meshview Sentinel — Dell GB10 Gateway Deployment

A step-by-step recipe for deploying **Meshview Sentinel** on a Dell GB10 Edge Gateway running Linux, with a Meshtastic radio attached over USB (or reachable via TCP).

> Meshview Sentinel is an open-source, self-hosted operator console for Meshtastic mesh-radio networks. The whole stack runs as a single Docker container, auto-discovers serial-attached radios, and exposes a dashboard on port 3000. There are no cloud dependencies; the only outbound traffic is to your AI provider (Anthropic / Google Gemini), and only if you opt in.

---

## System Requirements

- **Device**: Dell GB10 Edge Gateway, or any Linux x86_64 / ARM64 host with USB
- **OS**: Ubuntu Server 22.04 / 24.04 LTS, Debian 12+, or any modern distro that supports Docker
- **Container runtime**: Docker Engine 24+ with the \`docker compose\` plugin
- **Radio**: A Meshtastic-compatible LoRa radio (BroadH20, T-Beam, Heltec v3, RAK4631, LilyGo T-Echo, etc.) connected over USB *or* reachable on the network via TCP
- **Network**: Outbound HTTPS is **only** required if you plan to use the in-app AI assistant. Otherwise the stack is fully offline.

---

## Phase 1: Gateway Preparation

### 1. Update the system

\`\`\`bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
\`\`\`

### 2. Install Docker Engine + Compose plugin

\`\`\`bash
# Docker's official convenience script (Ubuntu / Debian)
curl -fsSL https://get.docker.com | sudo sh

# Allow the current user to run docker without sudo
sudo usermod -aG docker $USER
newgrp docker      # or log out and back in
\`\`\`

Verify:

\`\`\`bash
docker --version
docker compose version
\`\`\`

### 3. (Optional) Add yourself to \`dialout\` for direct radio access

The Meshview container has the necessary cgroup rules to access \`/dev/ttyUSB*\` and \`/dev/ttyACM*\` directly without \`--privileged\`. If you also want to run the Meshtastic CLI from your shell against the same radio (for diagnostics), add yourself to \`dialout\`:

\`\`\`bash
sudo usermod -aG dialout $USER
\`\`\`

> **Important:** only one process can hold a serial port at a time. Don't run a non-containerized API server *and* the docker container against the same \`/dev/ttyUSB0\` — frame parsing will silently corrupt.

---

## Phase 2: Install Meshview Sentinel

### 1. Clone the repository

\`\`\`bash
git clone https://github.com/<your-org>/meshview-sentinel.git
cd meshview-sentinel
\`\`\`

### 2. Build & start

\`\`\`bash
docker compose up --build -d
\`\`\`

That's it. The container builds, exposes the API + web UI on host port \`3000\` (mapped to container \`3001\`), bind-mounts \`/dev\` so it can see the radio when you plug one in, and persists data to a named volume (\`meshview-data\`) at \`/app/data\` inside the container.

### 3. Verify

\`\`\`bash
docker compose ps
docker compose logs -f meshview
\`\`\`

You should see lines like:
- \`[SerialDiscovery] LoRa device found: /dev/ttyUSB0\`
- \`[MeshtasticSerial] Connected to /dev/ttyUSB0\`
- \`API server running on http://localhost:3001\`

---

## Phase 3: Open the Dashboard

Browse to:

\`\`\`
http://<dell-gb10-ip>:3000
\`\`\`

On first load you land on the Dashboard. Open **Settings** (gear icon, sidebar) for first-time setup:

- **Connection** — confirms the radio is detected. Switches between serial auto-discover and a TCP endpoint (\`host:port\`, default Meshtastic TCP port is \`4403\`).
- **Modules** — enable / disable / tune modules on the local radio without leaving the browser. Currently shipped: NeighborInfo, Range Test, Telemetry, Store & Forward, External Notification.
- **Notifications** — desktop notifications for new messages, mentions, and node-lost events.
- **Display** — light / dark / auto theme, message retention window, unit system (metric / imperial).
- **AI** — drop in your Anthropic or Google Gemini API key if you want the AI assistant. Keys are stored server-side at \`data/ai-config.json\`; nothing about them ever reaches the browser.

---

## Phase 4: Plug in the Radio

The container watches \`/dev\` and \`/run/udev\`, so devices are picked up live:

1. Connect the Meshtastic node to a USB port on the Dell GB10.
2. Within ~5 seconds, the \`[SerialDiscovery]\` log line should report it.
3. The dashboard's status pill flips from \`OFFLINE\` to \`RADIO CONNECTED\`.

If your radio sits on another machine and is reachable via TCP, open **Settings → Connection → TCP** and enter \`<host>:<port>\` (default \`4403\`). The endpoint is persisted to \`data/tcp-endpoint.json\` and re-attempted on container restart until you explicitly disconnect.

---

## Phase 5: Day-2 Operations

### Persistent storage

Your mesh state — nodes, messages, events, telemetry, NeighborInfo, traceroute history, channel configs, groups, AI settings, retention preferences, Range Test observations — lives in the \`meshview-data\` Docker volume. Nothing is reset by \`docker compose restart\` or by rebuilding the image.

To wipe everything and start fresh:

\`\`\`bash
docker compose down -v   # ⚠ deletes the data volume — irreversible
\`\`\`

### Updates

Pull new code and rebuild:

\`\`\`bash
git pull
docker compose up --build -d
\`\`\`

The container restarts in place; the data volume survives.

### Backups

The data volume is at \`/var/lib/docker/volumes/meshview-sentinel_meshview-data/_data\` on the host. The most important file is \`mesh.sqlite\`. Snapshot it periodically:

\`\`\`bash
docker compose stop meshview
sudo tar czf meshview-backup-$(date +%F).tgz \\
  /var/lib/docker/volumes/meshview-sentinel_meshview-data/_data
docker compose start meshview
\`\`\`

### Restoring from a backup

\`\`\`bash
docker compose down
sudo tar xzf meshview-backup-YYYY-MM-DD.tgz -C /
docker compose up -d
\`\`\`

---

## Phase 6: Troubleshooting

### Radio not detected

\`\`\`bash
# Host-side: confirm the kernel sees the USB serial
dmesg | tail -20

# Inside the container
docker exec meshview-sentinel-meshview-1 ls -l /dev/ttyUSB* /dev/ttyACM*
\`\`\`

If the host sees it but the container doesn't, the bind-mount of \`/dev\` is broken. Restarting Docker (\`sudo systemctl restart docker\`) usually fixes it.

### Bridge appears stuck

\`\`\`bash
docker compose restart meshview
\`\`\`

A clean restart re-opens the serial port and clears any stuck framing state. If it happens repeatedly, check whether another process on the host is also holding \`/dev/ttyUSB0\`:

\`\`\`bash
sudo lsof /dev/ttyUSB0
\`\`\`

### "NeighborInfo: NOT BROADCASTING" badge

Open **Settings → Modules → NeighborInfo → Enabled**. The bridge issues an admin write + readback; the badge flips to authoritative state within a few seconds.

### Telemetry / messages not arriving over LoRa

- Confirm the relevant **modules** are enabled on each radio in your mesh — Telemetry needs the Telemetry module, range tests need Range Test, etc.
- Check the **Logs** tab (event stream) for \`pkt from=…\` lines from non-local nodes.
- If the only inbound traffic is from your own node, you may have an antenna or RF-environment issue, not a software one.

---

## What this stack actually is

| Component | Path | Notes |
|---|---|---|
| API + bridge | \`server/api.ts\` + \`server/meshtasticSerial.ts\` | Express + a hand-rolled raw-protobuf Meshtastic decoder/encoder. Tiny dependency tree, full visibility into parser bugs. |
| Web UI | \`src/\` | React 19 + Vite + Tailwind v4 |
| Storage | SQLite via better-sqlite3 | Single \`mesh.sqlite\` file in the data volume; FTS5 over messages |
| Real-time sync | Server-Sent Events | Multi-tab live updates within ~250 ms |
| Container | \`Dockerfile\` + \`docker-compose.yml\` | Single-service stack; data in a named volume |

---

*Generated for Meshview Sentinel. See the project's README + ROADMAP for current feature status.*
`;
