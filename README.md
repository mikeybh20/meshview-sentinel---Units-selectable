# meshview-sentinel

A self-hosted, web-based operator console for [Meshtastic](https://meshtastic.org/) LoRa mesh networks. Connect to a real radio over USB serial or TCP, run against the built-in simulator, or use both. Eight firmware modules can be configured end-to-end without leaving the browser.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-emerald.svg)](LICENSE) [![Commercial License Available](https://img.shields.io/badge/Commercial%20License-Available-blue.svg)](COMMERCIAL-LICENSE.md)

---

## Features

### Mesh awareness
- **Live node directory** with online/offline status, telemetry (RSSI, SNR, battery, sensors), short-name labels, position source (GPS vs fixed), PKC public keys, role (Router / Tracker / TAK / etc.), hardware model, licensed-operator flag, and last-observed transport (LoRa-direct vs MQTT-bridged).
- **Map view** with Meshtastic-style labeled markers (short-name inside each circle, color priority **group → favorite → online → offline**), signal-quality links, message trace overlays, and right-click / long-press waypoint drops. Right-side **slide-out info panel** with mesh stats (total / online / offline / routers / base stations / favorites), **Range Test coverage panel** with per-sender SNR aggregates and a **heatmap mode** that recolors map markers by avg SNR, waypoints list, and an inline color legend.
- **Topology** view with edges built from real `NeighborInfo` observations (home-base-radial fallback when no NeighborInfo data has arrived yet), force-directed layout (tuned for 100+ nodes), focus-neighborhood mode, **zoom-to-fit + persistent drag positions**, hover-tooltip showing each node's id / hardware / role / battery / SNR / RSSI, and one-click NeighborInfo module enable/disable on the local radio.
- **Comm Matrix** — filtered cross-tab of who-talks-to-whom with time range (1h / 6h / 24h / all), top-N senders, channel columns, and Count vs Success-rate coloring. **Click any populated cell to drill down** into per-pair relay analysis: most-common route, delivery rate, avg latency, and a per-relay frequency table.
- **Per-node telemetry charts** (Signal · Power · Environment tabs) plus a **per-node uptime panel** (uptime %, sessions count, avg session, peak-hours histogram) on the dashboard's NODE_DETAILS widget.
- **Event Log** stream with configurable retention (6 h / 24 h / 36 h / 48 h / 72 h).
- **Time-based message retention** in addition to the count cap (configurable per deployment).

### Messaging
- Channels and direct messages with per-message ack/error status, **failure-mode tag** (`TIMEOUT` / `NO ROUTE` / `PKI FAIL` / `DUTY CYCLE` / `NO RESPONSE` / etc.), hop visualization, and message retry.
- **Replies** and **emoji reactions** (Meshtastic `Data.reply_id` / `Data.emoji` protocol).
- **@mentions** parsed by short-name and node ID, plus channel-wide `@everyone` / `@all` / `@channel` conventions; click-to-jump-to-chat, with notifications.
- **Read status** with unread badges per chat.
- **Full-text search** (SQLite FTS5) with scroll-to-and-flash highlight on the matched bubble.

### Radio modules — admin-write end-to-end
Eight Meshtastic firmware modules can be configured directly from **Settings → Modules**. Every module follows the same pattern: authoritative readback on connect, optimistic update on save, persisted to disk so the dashboard's view of the radio survives container rebuilds even when the firmware doesn't reply to admin readbacks.

- **NeighborInfo** — enable / disable, broadcast interval, transmit-over-LoRa toggle. Plus a one-shot **Site Survey** that temporarily speeds up cadence for N minutes then auto-restores.
- **Range Test** — sender enable / interval / save-to-flash, plus a **Coverage Survey** with auto-restore. The bridge persists every inbound Range Test packet to a `range_test_observations` table; the Map view's coverage panel aggregates them.
- **Telemetry** — device-metrics interval, environment-sensor enable + interval, power-monitor enable + interval.
- **Store & Forward** — enable / disable, client / router-server toggle, heartbeat, buffer size, replay-cap, time-window. Detect peer routers and request history replays from any of them.
- **External Notification** — buzzer / LED / vibra alerts on incoming text or bell character; alert duration; nag timeout. Board-specific GPIO pin assignments are read on connect, displayed read-only, and round-tripped on save so factory wiring survives an operator edit.
- **MQTT** — broker address, username, password, TLS, channel encryption, JSON publish, proxy-to-client, topic root, map reporting. Header pill flips between `MQTT: ACTIVE` (module enabled) / `MQTT: OBSERVED` (peers seen via MQTT bridges) / `MQTT: OFF`.
- **Detection Sensor** — GPIO state-change broadcasts (door sensors, mailbox flags, PIR motion, reed switches).
- **Audio** — Codec2 voice over LoRa (experimental — most off-the-shelf boards lack the required hardware).

Plus **per-channel position precision** (privacy control: 0 = disabled, 32 = full precision, intermediate values fuzz to a coarser grid) and **per-channel uplink/downlink toggles** for MQTT bridging.

### Operator features
- **TCP transport** alongside serial (Meshtastic firmware 2.7.4+); persists last endpoint and auto-reconnects.
- **Multi-radio**: bridge two or more Meshtastic radios simultaneously, even on different RF channels. Per-radio Connect/Disconnect/Make-Primary controls live in the top-level **Radios** tab — single source of truth.
- **Workspaces**: tenant scopes for radios + messages + nodes. Each user lands in their own workspace; per-workspace primary radio choice routes status, channels, and sends to the right bridge.
- **Local-account auth**: admin/viewer roles, scrypt-hashed passwords, signed session cookies. First-run bootstrap creates the install admin.
- **Settings hub** — unified Mode / Modules / Notifications / Display / BBS / Users / Workspaces / Blocked / Data / AI sections.
- **Light / Dark / Auto theme** with OS `prefers-color-scheme` watching.
- **Favorite nodes** with one-click toggle; favorites get amber rings on the map and topology graph.
- **Node groups** with operator-defined names + colors, persistent server-side; per-node assignment dropdown plus **bulk-select multi-assign** in the dashboard node list; group color overrides marker/topology color so groupings are obvious at a glance. Inline rename via double-click in the sidebar.
- **Channel sharing via QR** producing standard `https://meshtastic.org/e/#…` URLs that any Meshtastic mobile client can scan and import.
- **QR contact sharing** producing `meshtastic.org/v/#…` URLs with the same compatibility.
- **Deep linking** for incoming contact (`#v/…`) and chat (`#chat=…`) URLs.
- **Block list** for hiding noisy nodes — server-side, synced across browser tabs and machines.
- **Browser notifications** for DMs, mentions, and lost favorites — mention notifications resolve to the actual channel and click-to-open the right chat.
- **CSV import/export** of messages, events, and telemetry.
- **AI assistant** — Anthropic Claude, Google Gemini, **or a self-hosted Ollama** (any model that exposes the OpenAI-compatible `/v1/chat/completions` endpoint). Includes a **PII-redaction toggle** for cloud providers: when on, only aggregate counts go in the prompt, never node IDs / names / message text.
- **Multi-client live sync** — open the dashboard in multiple tabs/browsers; SSE pushes ack updates, traceroute results, waypoints, node updates, events, S&F router heartbeats, NeighborInfo packets, module config, group changes, and block-list changes (~250 ms cross-client latency).

---

## Run locally (development)

**Prerequisites:** Node.js 18+ and a Meshtastic radio connected via USB (optional — there's a simulator).

```bash
git clone <your-fork-url>.git meshview-sentinel
cd meshview-sentinel
npm install

# Frontend (Vite dev server, port 5173 by default)
npm run dev

# Backend (Express + SQLite + serial bridge, port 3001)
npm run dev:server
```

For radio auto-discovery over USB, set the env var before running the backend:

```bash
SERIAL_AUTO_DISCOVER=true npm run dev:server
```

Or specify a port directly: `SERIAL_PORT=/dev/ttyUSB0 npm run dev:server`.

For TCP-mode radios, leave both env vars unset — the server will reconnect to the last endpoint stored in `data/tcp-endpoint.json`, or you can configure one in the **Radios** tab (Add Radio → transport `tcp` → `<host>:<port>`).

---

## Production deployment (recommended: Docker)

```bash
docker compose up --build -d
```

Browse to `http://<host>:3000`. The container exposes the API + UI on host `:3000` (mapped to container `:3001`), bind-mounts `/dev` for hot-plug USB radio access, and persists data to a named volume (`meshview-data`).

For a step-by-step Dell GB10 Edge Gateway recipe, see the in-app **Recipe Guide** (`Recipe` tab in the sidebar) or [src/constants/installationGuide.ts](src/constants/installationGuide.ts).

### AI providers

Configure under **Settings → AI**. Keys are stored server-side at `data/ai-config.json` and never reach the browser.

- **Anthropic Claude** — drop in an `sk-ant-…` key.
- **Google Gemini** — drop in an `AIza…` key.
- **Ollama (self-hosted, recommended for privacy)** — point at any OpenAI-compatible Ollama instance. The Settings panel includes per-OS setup help (Ubuntu / macOS / Windows) for exposing Ollama to the Docker bridge via `OLLAMA_HOST=0.0.0.0:11434`.

If you're on a third-party cloud provider and don't want mesh PII (node IDs / names / message text) leaving your network, enable the **Redact PII from AI prompts** toggle. The assistant header will show a `REDACTED` pill when active.

---

## Security defaults

The HTTP API has **no built-in authentication**. This is fine for `localhost`-only deployments and for an isolated home LAN, but it means **anyone with network access to the server can read/send mesh traffic and modify radio config**.

If you need to expose the dashboard beyond localhost, **terminate TLS and basic auth at a reverse proxy in front of the container.** Two minimal patterns:

### Caddy

```caddy
mesh.example.com {
    reverse_proxy localhost:3000
    basicauth /* {
        operator $2a$14$...   # `caddy hash-password -plaintext "your-password"`
    }
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name mesh.example.com;

    ssl_certificate     /etc/letsencrypt/live/mesh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mesh.example.com/privkey.pem;

    auth_basic           "Mesh Operator";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        # SSE keepalive — the dashboard's /api/mesh/stream endpoint is long-lived
        proxy_buffering off;
        proxy_read_timeout 24h;
    }
}
```

The `proxy_buffering off` and the long `proxy_read_timeout` are important — the dashboard uses Server-Sent Events for live multi-client sync, and aggressive proxy buffering breaks the SSE stream.

A few other security notes:

- **AI prompts** include node IDs and message text by default. If your provider is a third-party cloud (Anthropic / Gemini), enable the **Redact PII from AI prompts** toggle — or use a self-hosted Ollama, which never sends data off your LAN.
- **Block lists** are persisted server-side now; deploying behind auth means they're effectively per-operator across browsers.
- **Channel PSKs** displayed in the Channels modal are sensitive. The QR / share-URL feature includes them — treat the resulting URL like a password.

---

## Architecture

- **Frontend**: React 19 + Vite + Tailwind v4. [pigeon-maps](https://pigeon-maps.js.org/) for mapping (no Leaflet/Mapbox dependency), [recharts](https://recharts.org/) for telemetry time-series, [emoji-picker-react](https://github.com/ealush/emoji-picker-react) for waypoint icons and reactions, [qrcode.react](https://github.com/zpao/qrcode.react) for contact + channel QR codes, [d3-force](https://github.com/d3/d3-force) for the topology graph.
- **Backend**: Node.js + Express + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), with a hand-rolled raw-protobuf encoder/decoder for the Meshtastic wire protocol (no `@meshtastic/js` dependency — keeps the dependency surface tight and the parser visible).
- **Persistence**: SQLite at `data/mesh.sqlite`. Tables for nodes, messages (FTS5-indexed, with `delivery_ms` for latency stats), events, channels (incl. per-channel `position_precision`), waypoints, neighbor info, S&F routers, groups, blocked nodes, trace results, range test observations, and node sessions (online/offline transition history). All schema changes are forward-compatible additive migrations. Plus a `data/local-module-config.json` for round-tripping the radio's module-config snapshot across container rebuilds.
- **Real-time**: 3-second polling on `/api/mesh/snapshot` as a safety net, plus an SSE stream at `/api/mesh/stream` carrying named events (`ack`, `trace`, `waypoints`, `node`, `eventLog`, `storeForward`, `neighborInfo`, `moduleConfig`, `groups`, `blocked`). Bursts of high-frequency events are coalesced via a 250 ms client-side debounce.
- **Module config writes**: `AdminMessage` packets to the local radio over the existing serial/TCP link (no LoRa airtime cost for self-admin), with authoritative readback via `get_module_config_response` plus optimistic-update fallback for firmware that doesn't reply to self-admin reads.

---

## License

MeshView Sentinel is **dual-licensed**:

1. **[GNU Affero General Public License v3.0](LICENSE)** — the default
   license. Free for personal use, amateur radio operators, mesh-network
   community groups, SKYWARN spotters, ARES/RACES, volunteer first
   responders, registered 501(c)(3) EmComm organizations, and academic
   use. Strong copyleft including AGPL §13 (the "network use" clause)
   — if you modify and host the Software for users, you must offer
   them the corresponding source.

2. **[Commercial License](COMMERCIAL-LICENSE.md)** — available for
   commercial entities that need exemption from AGPL-3.0 copyleft
   (proprietary integration, closed-source redistribution, hosted
   commercial services without source disclosure). Categories
   enumerated in the [Free Commercial License Policy](FREE-USE-POLICY.md)
   receive the Commercial License at $0 on request — the dual-license
   model exists to ensure for-profit deployments contribute back, not
   to charge volunteers and community groups.

Copyright (c) 2024-2026 Kit Kim and Michael Broadwater. See
[AUTHORS](AUTHORS) for attribution details.

---

## Disclaimer

**meshview-sentinel is the personal open-source work of Kit Kim and Michael Broadwater. It is not a product, project, or work-for-hire of Government Acquisitions, Inc. or any of its affiliates.** No employer time, resources, intellectual property, trademarks, or proprietary information were used in its development. The opinions, code, and design choices expressed here are ours alone and do not reflect those of any current or former employer.

Meshtastic® is a registered trademark of Meshtastic LLC. This project is not affiliated with, endorsed by, or sponsored by Meshtastic LLC. It is an independent third-party tool that interoperates with the Meshtastic open firmware and protocol.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the current list of features that are partially implemented, deferred, or could use polish. Major-version planning (multi-radio support, mesh playback timeline, mobile-first layout) lives there too.

---

## Contributing

Issues and pull requests welcome. Before submitting:
- Run `npx tsc --noEmit` (strict TypeScript check across both server and client)
- Run `npm run build` to verify the production build succeeds

---

## Acknowledgements

- The [Meshtastic](https://meshtastic.org/) project for the firmware, protocol, and ecosystem
- [pigeon-maps](https://pigeon-maps.js.org/) for a tiny dependency-free map component
- [recharts](https://recharts.org/) for the telemetry time-series charts
- [emoji-picker-react](https://github.com/ealush/emoji-picker-react) for the waypoint and reaction emoji picker
- [qrcode.react](https://github.com/zpao/qrcode.react) for QR rendering
- [d3-force](https://github.com/d3/d3-force) for the topology graph layout
- The Meshtastic community for documentation and protocol guidance
