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

That's it. The container builds, exposes the API + web UI on host port \`3000\` (mapped to container \`3001\` internally), bind-mounts \`/dev\` so it can see the radio when you plug one in, and persists data to a named volume (\`meshview-data\`) at \`/app/data\` inside the container.

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

- **Mode** — sim vs. live data source toggle.
- **Modules** — enable / disable / tune the eight Meshtastic firmware modules from the browser: NeighborInfo, Range Test, Telemetry, Store & Forward, External Notification, MQTT, Detection Sensor, Audio. Admin writes go directly to the local radio; nothing crosses the mesh.
- **Notifications** — desktop notifications for new messages, mentions, and node-lost events.
- **Display** — light / dark / auto theme, message retention window, unit system (metric / imperial).
- **BBS** — bulletin-board state machine that handles \`:mail\` and \`:weather\`/\`:wx\` DMs from other nodes (see Phase 6 for the full feature set).
- **Users** — local user accounts (admin/viewer roles). First-run bootstrap creates the install admin.
- **Workspaces** — tenant scopes for radios + messages + nodes. Per-user landing space; see Phase 6.5.
- **Blocked** — node-level mute list; blocked senders are dropped before reaching the UI.
- **Data** — retention windows + DB stats; export / import for backup.
- **AI** — drop in your Anthropic or Google Gemini API key (or point at a local Ollama instance) if you want the AI assistant. Keys are stored server-side at \`data/ai-config.json\`; nothing about them ever reaches the browser.

> **Note:** the legacy *Settings → Connection* panel has been retired in Beta 5. Adding, editing, connecting, disconnecting, hot-swapping primary, and deleting radios all live in the top-level **Radios** tab — single source of truth.

---

## Phase 4: Plug in the Radio

The container watches \`/dev\` and \`/run/udev\`, so devices are picked up live:

1. Connect the Meshtastic node to a USB port on the Dell GB10.
2. Within ~5 seconds, the \`[SerialDiscovery]\` log line should report it.
3. The dashboard's status pill flips from \`OFFLINE\` to \`RADIO CONNECTED\`.

If your radio sits on another machine and is reachable via TCP, open the **Radios** tab → **Add Radio** → set transport to \`tcp\` and target to \`<host>:<port>\` (default \`4403\`). Click **Detect Identity** to auto-fill the radio's short_name + long_name from its firmware, then Add. The first radio added becomes the install primary; subsequent radios connect on demand via the per-row Connect button.

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

### Disk retention — what auto-prunes vs. what doesn't

Sentinel runs a 5-minute retention loop that bounds every growing table so the SQLite database stays small over time:

| Data | Bound | Operator-tunable? |
|---|---|---|
| Chat messages | 5000-row cap + configurable time window | Settings → Data |
| Event log | 1000-row cap + 24h time window (default) | Settings → Data |
| Telemetry samples | 500 per node | No |
| Trace results | 500 total | No |
| Range test observations | 5000 total | No |
| BBS mail | 30 days | No |
| Position history | 30 days | No |
| Node sessions | 100k rows | No |
| Per-node Mail / Subscribers / Channels / Groups / Waypoints | Operator-controlled, one row each | n/a |

For a 100-node mesh with active position broadcasts, expect the SQLite DB to plateau around 50-150 MB.

### Docker log rotation (important for long-running deployments)

Sentinel's container writes a lot of useful diagnostic lines to stdout (every packet, every BBS interaction, every retry). Docker's default \`json-file\` log driver has **no built-in size cap** — left alone, \`/var/lib/docker/containers/<id>/<id>-json.log\` will grow indefinitely and can swallow gigabytes over a few months.

Two options, pick one:

**A. Rotate per-container in your compose file** (recommended for single-host setups):

\`\`\`yaml
# docker-compose.yml — under the meshview service
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "5"
\`\`\`

Cap is then 50 MB total per container, with old chunks rotated out automatically.

**B. Set host-wide defaults** in \`/etc/docker/daemon.json\` (applies to every container on this host):

\`\`\`json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "5"
  }
}
\`\`\`

Restart Docker (\`sudo systemctl restart docker\`) after editing. Existing containers keep their old behavior until recreated; new ones inherit the new defaults.

Either way, you should never see Docker logs grow past tens of megabytes for the meshview container.

---

## Phase 6: BBS Mail & Weather

The BBS subsystem turns your Sentinel node into a self-service bulletin board reachable from any other node on the mesh. Remote operators interact entirely over Direct Messages — no special client needed; the stock Meshtastic phone app or any \`meshtastic --send-text\` invocation works.

There are two subsystems, both triggered by lowercase \`:\`-prefixed keywords:

### Mail (\`:mail\`)

A persistent store-and-forward inbox for short text messages. Body cap is 200 chars (≈one Meshtastic packet) and mail is retained for 30 days regardless of read state.

**Sender flow (from a remote node):**

\`\`\`text
DM ":mail"                  →  "MAIL: no new. Reply S=send, X=exit."
DM "S"                      →  "Send TO: short name (4 chars) or X."
DM "BH20"                   →  "TO BH20 (Mike Broadwater). Send body, max 200, X to cancel."
DM "Hey can you grab milk?" →  "✉ Sent to BH20 (id=1)."
\`\`\`

The recipient gets a push DM notification (\`✉ Mail from <SENDER>. DM :mail R to read.\`) and a row in their inbox they can pull later.

**Reader flow:**

\`\`\`text
DM ":mail"        →  "MAIL: 45 new (WX:5 FX:35 Other:5). :mail r other = real mail. R=all, S=send, X=exit."
DM "R"            →  "From BH20 2m ago: Hey can you grab milk?  N=next D=delete X=exit"
DM "D"            →  deletes; serves next unread (or "No unread mail.")
DM "X"            →  exits the session.
\`\`\`

v2.1 — **category filters**, useful when weather pushes pile up alongside real mail:

\`\`\`text
DM ":mail r other"  →  next unread real mail; N/D stay scoped to Other
DM ":mail r wx"     →  next unread NWS alert (urgent)
DM ":mail r fx"     →  next unread daily forecast (routine)
DM ":mail d wx"     →  bulk-deletes EVERY weather alert in your inbox; reports count
DM ":mail d fx"     →  bulk-deletes EVERY daily forecast in your inbox; reports count
DM ":mail ?"        →  one-line command catalog (also ":mail help")
\`\`\`

\`d other\` is intentionally not provided — wiping real mail in bulk is too easy to misfire. Delete those one at a time via the per-message D in the read session.

The \`:mail\` entry response also includes \`?=help\` as a tail hint, so a subscriber meeting the BBS for the first time can discover the catalog without it being documented anywhere they can see.

Shortcuts: \`:mail send\`, \`:mail read\`, \`:mail BH20\` (skip the menu and prompt for body), \`!02eb3bec\` instead of a short name (hex form bypasses short-name lookup), reply-by-typing during a read session.

### Storm Reports — SKYWARN (\`:spot\`) — **v3.0**

Multi-step form for submitting a Local Storm Report (NWS LSR shape) via DM. Designed for SKYWARN volunteers reporting to a Sentinel operator during a storm; the operator sees each report land in the "Storm Reports" tab and (in v3.1) can flip a flag to auto-submit them to the NWS eSpotter API.

\`\`\`text
DM ":spot"                → "SPOT: what happened? H=HAIL T=TSTM_WND TR=TORNADO F=FUNNEL FL=FLOOD W=WALL_CLOUD O=OTHER X=cancel."
DM "H"                    → "HAIL — inches? Type a number (e.g. 1.5), .=skip, X=cancel."
DM "1.5"                  → "Remarks? Describe what you saw, or .=skip, X=cancel."
DM "golf-ball, still falling"
                          → "SPOT: HAIL 1.5in at 39.4213,-77.4103. Rmks: golf-ball, still falling. Y=send N=cancel."
DM "Y"                    → "SPOT logged #17. Thanks — stay safe."
\`\`\`

- Location is auto-populated from the reporter's most recent Meshtastic Position packet (\`location_source = AUTO_LAST_POSITION\`). If the reporter has no position (fresh node, GPS unavailable), the report goes in with lat/lng null — the remarks field becomes the geographic description.
- Events without a natural magnitude (\`TORNADO\`, \`FUNNEL\`, \`WALL CLOUD\`, \`OTHER\`) skip the magnitude step and go straight to remarks.
- \`:spot ?\` returns the flow catalog. In-session \`?\` restates the current step's prompt so a confused reporter can recover without cancelling.
- The confirm step accepts \`Y\` (send), \`N\` (cancel), or anything else (interpreted as an edit of the remarks field — keeps event and magnitude, re-prompts for remarks).

Operator side: the Storm Reports tab (v3.0 slice 3, upcoming) shows all reports on a map with severity-tinted markers, a filterable table view, and an NWS LSR-format CSV export for the operator to copy/paste into eSpotter until v3.1 wires direct submission. Reports API is live now at \`GET /api/mesh/bbs/storm-reports\`.

### Tides — NOAA CO-OPS (\`:tide\`) — **v3.0**

Compact tide-prediction lookup against the free NOAA CO-OPS (Tides and Currents) API. Returns next 3-4 high/low events in station-local time with heights in feet (MLLW datum). Fits in one Meshtastic packet.

\`\`\`text
DM ":tide"           → "Tide @ Baltimore MD: HIGH 3:45AM 1.8ft | LOW 10:12AM 0.2ft | HIGH 4:20PM 1.7ft"
DM ":tide 8575512"   → "Tide @ Annapolis MD: HIGH 4:02AM 1.5ft | LOW 10:29AM 0.1ft | HIGH 4:37PM 1.4ft"
DM ":tide ?"         → command catalog + current default station
\`\`\`

Operator configures a **default station** in Settings → BBS (\`defaultTideStation\`). Empty disables the no-arg form (subscribers can still query specific stations by id). Chesapeake / Maryland station ids:

| Station ID | Name                          |
|---         |---                            |
| 8574680    | Baltimore                     |
| 8575512    | Annapolis                     |
| 8577330    | Solomons Island               |
| 8638863    | Chesapeake Bay Bridge Tunnel  |
| 8632200    | Kiptopeke, VA                 |

Full station index: [tidesandcurrents.noaa.gov/stations.html](https://tidesandcurrents.noaa.gov/stations.html).

**Cache policy** (NOAA computes these predictions years in advance, so refreshing every 15 minutes would be wasteful):

- **Default station:** refreshed on a fixed daily schedule at **00:00, 06:00, 12:00, 18:00** server-local time. If a scheduled fetch fails (upstream down, network glitch), retries every **20 min** until success — or until the next scheduled tick, whichever comes first (a scheduled tick supersedes a pending retry).
- **Non-default station** (subscriber types \`:tide 8632200\` for some other station): fetched on demand, cached for **6h**. Aligns the on-demand cache with the scheduled cadence — a station queried at 10am gets re-fetched at ~4pm if queried again.
- **Bootstrap:** ~5s after server start, the default station is fetched once so subscribers hitting \`:tide\` immediately post-boot see data instead of an empty cache.
- **Config-change refresh:** setting a new default station in Settings triggers an immediate refresh instead of waiting for the next scheduled tick.

Net result: at most 4 NOAA calls/day/station for the default (+ retries on failure), plus a handful for whatever ad-hoc stations subscribers ask about. Versus the ~96/day/station ceiling a naive 15-min TTL would allow.

- Reply auto-truncates trailing events if the packet would exceed 200 chars.
- On upstream failure the reply is a user-friendly "try again later" fallback, not a silent BBS.

### Weather (\`:weather\` or \`:wx\`)

On-demand US weather lookup against the National Weather Service + zippopotam.us. Both \`:weather\` and \`:wx\` are accepted everywhere — built-in aliases for each other regardless of which one the operator has saved as the configured Weather trigger in Settings → BBS. Returns ≤200-char compact summary:

\`\`\`text
DM ":wx"           →  "WX: send 5-digit US ZIP or X to cancel."
DM "21001"         →  "Aberdeen, MD: 42°F now, Sunny. High 48°/Low 31° today."

# Shortcut form (skips the prompt) — both aliases work
DM ":weather 60601" →  "Chicago, IL: 58°F now, Partly Cloudy. High 64°/Low 49° today."
DM ":wx 60601"      →  same
\`\`\`

### Weather subscriptions

Remote nodes can opt in to **proactive alerts** for the operator's configured home ZIP:

\`\`\`text
DM ":wx subscribe"      →  "Subscribed to Aberdeen, MD alerts. Reply :wx stop to unsubscribe."
DM ":wx status"          →  "Subscribed to Aberdeen, MD alerts. :wx stop to opt out."
DM ":wx unsubscribe"     →  "Unsubscribed. You'll no longer receive weather alerts."
                            # Also accepted: ":wx stop", ":wx off". And ":weather …" still works.
\`\`\`

When a new NWS alert (warning / watch / advisory) fires for the home ZIP, every subscriber receives **both**:

1. A **DM** with the compact alert text on the channel they subscribed via
2. A **mail row** in their inbox with sender_short_name = \`WX\` (persistent — survives offline periods)

The poller runs every 20 minutes. Alerts active at container start are silently absorbed (no spam after restart); only newly-issued alerts trigger fanout.

**Daily forecast push** — Beta 5: subscribers also receive the current NWS forecast at every time configured in Settings → BBS → *Daily forecast push times* (default \`07:30, 12:00, 17:30\` server-local time = morning / midday / evening). Each slot fires independently — missing one doesn't suppress the next. The sender_short_name on these is \`FX\` to distinguish "scheduled forecast" from \`WX\` (issued alert) in subscribers' mail histories.

### Operator-side dashboard surfaces

**Mail nav item** (left sidebar) — badge shows unread count for the local node. Four tabs:

- **Inbox / Outbox** — view threads with read-receipt indicators ("Read 30s ago" vs "Unread by recipient")
- **Compose** — send mail to any node from the dashboard (recipient picker with online status, 200-char body counter)
- **Users** — every distinct node that has used the BBS, with sent / received / unread counts and last-activity timestamp

**Settings → BBS** — all configuration plus a live **Subscribers** panel showing each subscribed node, the channel they subscribed via, subscribe time, last alert delivered, and a per-row Remove button.

### Configuration knobs (Settings → BBS)

| Setting | Default | Range | Notes |
|---|---|---|---|
| **Enabled** | on | toggle | Master switch. When off, all \`:\`-prefixed DMs flow through to the normal message log instead of the BBS state machine. |
| **Mail trigger** | \`:mail\` | colon + 1-15 chars, lowercase | Validated client-side. Custom triggers let you match a network convention. |
| **Weather trigger** | \`:wx\` | colon + 1-15 chars, lowercase | Must differ from the mail trigger. \`:wx\` and \`:weather\` are built-in aliases regardless of which is configured. |
| **Command index** | \`:cmd\` | colon + 1-15 chars, lowercase | DMing this returns a one-packet list of every active root trigger. |
| **Body cap** | 200 chars | 50-228 | Hard limit on mail body length. 228 = the firmware payload ceiling. |
| **Retention** | 30 days | 1-365 | Mail older than this is pruned automatically, regardless of read state. |
| **Reply pace** | 2000 ms | 0-10000 | Minimum gap between successive BBS replies to the same destination. Prevents tripping the firmware's per-destination rate limiter. |
| **Session timeout** | 300 s | 30-1800 | How long a half-finished mail session stays alive before the reaper sweeps it. |
| **Home ZIP** | (empty) | 5 digits or empty | When set, the alert poller runs every 20 min for this ZIP. Subscribers receive alerts from here. Leave empty to disable the proactive alert path (the on-demand \`:wx\` command is unaffected). |
| **Daily forecast push times** | \`07:30, 12:00, 17:30\` | comma-separated HH:MM list | Each entry fires once per day in server-local time (\`TZ\` env). Subscribers receive the current NWS forecast as a DM + persistent mail row (\`FX\` sender). Empty list disables daily push; NWS alerts still fire. |

All changes apply immediately — no radio restart needed.

### Conflicts and routing

- **AI assistant DMs**: any DM whose text starts with \`:\` and matches a configured trigger is consumed by BBS first and never reaches the AI. Non-prefixed DMs flow to the AI as before.
- **Self-DMs to local node**: blocked at the UI layer; the Messages view shows a "you can't DM your own node" notice instead of the compose input. Self-DMs would otherwise consume rate-limit budget without going on-air.
- **Per-destination rate limit (err=38)**: the bridge auto-retries with a 10-second backoff if the firmware throttles us. Combined with the 2-second BBS reply pacing, this is rarely visible in practice.

---

## Phase 6.5: Multi-Radio (v2.0+)

Sentinel v2.0 can bridge two or more Meshtastic radios simultaneously, even when they're on different RF channels (different Frequency Slot in LoRa Config). This is the right setup for an operator running both a local mesh (e.g., DC Mesh on slot 0) and a regional mesh (NOVA on slot 9) from the same gateway.

### Concepts

- **Install primary** (★ in Radios tab): the radio Sentinel auto-discovers on boot via USB serial. It's the singleton bridge — no manual configuration needed. Hot-swap which radio is primary via the per-row **Make Primary** button.
- **Secondary radio(s)**: any additional radio you connect via TCP (or another serial port). Configured in the **Radios** tab and connected on demand with the **Connect** button per row.
- **radio_id**: the 4-character \`short_name\` from each radio's firmware. Used as the identity for that radio everywhere: pill in the RadioBar, "Heard By" badge on nodes it has heard, log prefix on its events. Must be unique across your configured radios.
- **Frequency Slot ≠ Primary Channel**: the slot (\`config.lora.channel_num\`) is the physical RF channel. Two radios with the same primary-channel name (\`LongFast\`) but different slots will never hear each other.
- **Workspace primary** (Beta 5+): each workspace can mark one of its radios as its primary. Status footer, MQTT pill, channels, and \`Send\` routing in that workspace all follow this choice. Set via the layers-icon button on each radio row in the **Radios** tab. All radios stay connected install-wide regardless of which workspace anyone is viewing — switching is a view/routing change, not a connect/disconnect.

### Adding a secondary radio

1. Make sure the second radio is reachable. For TCP: it must be running with \`Meshtastic IP\` enabled (typically on port 4403). For serial: it must be on a port that the Sentinel container's \`/dev\` mount can see (the existing \`device_cgroup_rules\` cover \`ttyUSB*\` and \`ttyACM*\`).
2. Open the **Radios** tab and click **Add Radio**.
3. Pick \`tcp\` or \`serial\` transport and enter the target (\`192.168.1.50:4403\` for TCP, \`/dev/ttyUSB1\` for serial).
4. Click **Detect Identity** — Sentinel opens a transient connection, reads the radio's \`User\` config (short_name + long_name) and \`LoRaConfig\` (region / preset / slot / hops), disconnects, and pre-fills the form.
5. Optional: add a **Network Label** like "NOVA Mesh" so the RadioBar pill carries human context, and pick a different palette color than your default radio's.
6. Click **Add Radio**. The row appears in the registry but is not yet connected.
7. Click **Connect** on that row. The RadioBar's connection chip flips to green when the second bridge attaches and starts ingesting packets.

### What changes once a second radio is connected

- The **RadioBar** below the header shows a pill per radio. Clicking a pill scopes the node list, map, stats cards, and the message send target to that radio's mesh. Clicking **All Radios** returns to the unified view.
- The **Refresh** button becomes a split-button — its dropdown lets you refresh a single radio's NodeDB instead of every connected radio at once.
- Each node row in the node list gains a **Heard By** badge showing which of your radios has heard it (most-recent first). A node bridged by both meshes will carry both badges.
- The **Map** colors each node's pin border by the most-recent hearing radio so you can see at a glance which mesh each peer belongs to. The **+N** cluster badges still collapse spatial overlap.
- The **Compose** field sends through whichever radio the RadioBar filter is currently scoped to. With "All Radios" selected, sends go through the default radio.
- The **Channels modal** grows a **Target Radio** picker when more than one radio is configured. The channel list shown and any save (including a channel-share URL import) is scoped to that picker's selection.
- The dashboard **Stats cards** scope to the filtered radio's nodes when a pill is active, and aggregate across all radios when "All" is selected.

### Memory implications

Each connected radio adds ~150–250 MB of resident memory to the Sentinel container (its own packet buffer, pending-ACK tracker, and in-memory node Map). On a Jetson Nano 2GB that's the difference between "1 radio fits" and "2 radios push into swap." Mitigation:

- Cap the container's memory in \`docker-compose.yml\` (see Phase 5 → Persistent storage)
- Disable the GPU sidecar if you don't need its workloads (\`meshview-gpu\` service in \`docker-compose.yml\`) — that reclaims ~400 MB
- Use an Orin Nano or AGX if you plan to run >2 radios

### Disconnect / disable

- **Disconnect**: click the **Disconnect** button on the secondary radio's row. The bridge shuts down cleanly; the row stays in the registry so you can reconnect with one click.
- **Disable**: toggle the **Enabled** checkbox off in the per-radio editor. Disabled radios stay in the registry but are skipped by Refresh and won't auto-connect on next boot.
- **Delete**: allowed for any radio that isn't the actively-connected install primary. A *disconnected* install primary (stale auto-registered row from a renamed/replaced radio) can be deleted — the next live identity exchange will auto-claim primary cleanly.

To hot-swap which radio is the install primary, click the **Make Primary** (★) button on a different row instead of disconnecting the current primary directly.

---

## Phase 7: Troubleshooting

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
| BBS state machine | \`server/bbs.ts\` + \`server/bbsConfig.ts\` | In-process state machine handling \`:mail\` / \`:weather\` DMs. Config persisted to \`data/bbs-config.json\`. |
| Weather + alerts | \`server/weather.ts\` + \`server/weatherAlertPoller.ts\` | NWS forecast / alerts client; 20-min background poller dedupes by NWS alert id. |
| Web UI | \`src/\` | React 19 + Vite + Tailwind v4 |
| Storage | SQLite via better-sqlite3 | Single \`mesh.sqlite\` file in the data volume; FTS5 over messages. BBS adds \`bbs_mail\` + \`bbs_weather_subscribers\` tables. |
| Real-time sync | Server-Sent Events | Multi-tab live updates within ~250 ms |
| Container | \`Dockerfile\` + \`docker-compose.yml\` | Single-service stack; data in a named volume |

---

*Generated for Meshview Sentinel. See the project's README + ROADMAP for current feature status.*
`;
