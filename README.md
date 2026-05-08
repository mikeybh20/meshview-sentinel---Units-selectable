# meshview-sentinel

A web-based dashboard, control center, and diagnostic tool for [Meshtastic](https://meshtastic.org/) LoRa mesh networks. Connect to a real radio over USB serial or TCP, or run against a built-in simulator for development.

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)

---

## Features

### Mesh awareness
- **Live node directory** with online/offline status, telemetry (RSSI, SNR, battery, sensors), short-name labels, position source (GPS vs fixed), PKC public keys, role (Router/Tracker/TAK/etc.), hardware model, licensed-operator flag, and last-observed transport (LoRa-direct vs MQTT-bridged)
- **Map view** with Meshtastic-style labeled markers (short-name inside each circle, color priority **group → favorite → online → offline**), signal-quality links, message trace overlays, and right-click / long-press waypoint drops
- **Topology** view with edges built from real `NeighborInfo` observations (home-base-radial fallback when no NeighborInfo data yet), force-directed layout, focus-neighborhood mode, **zoom-to-fit + persistent drag positions**, and one-click NeighborInfo module enable/disable on the local radio
- **Per-node telemetry charts** (Signal · Power · Environment tabs) on the dashboard's node-details panel — battery / SNR / RSSI / temp / humidity / pressure time-series with auto-refresh
- **Comm Matrix** — filtered cross-tab of who-talks-to-whom with time range (1h / 6h / 24h / all), top-N senders, channel columns, and Count vs Success-rate coloring
- **Route Intelligence** view with relay statistics
- **Event Log** stream with configurable retention (6 h / 24 h / 36 h / 48 h / 72 h)

### Messaging
- Channels and direct messages with per-message ack/error status, hop visualization, and message retry
- **Replies** and **emoji reactions** (Meshtastic `Data.reply_id` / `Data.emoji` protocol)
- **@mentions** parsed by short-name and node ID, click-to-jump-to-chat, with notifications
- **Read status** with unread badges per chat
- **Full-text search** (SQLite FTS5) across all persisted messages

### Radio modules (with admin write where supported)
- **NeighborInfo** — surface each node's directly-observed neighbors with SNR; **enable/disable on the local radio** with one click from the topology view (admin write via `set_module_config`)
- **Traceroute** — request a path to any node, see hop-by-hop SNR
- **Store & Forward** — automatic detection of router nodes via heartbeats, surface their stats, and **request replay** of the last 15 min – 24 hr of missed traffic from any router
- **Range Test** packet logging
- **Waypoints** — drop, edit, and broadcast `WAYPOINT_APP` packets with emoji icons and expiration

### Operator features
- **TCP transport** alongside serial (firmware 2.7.4+); persists last endpoint and auto-reconnects on server restart
- **Settings hub** — unified Connection / Modules / Notifications / Display / Blocked / Data / AI sections (replaces the cluttered six-button rail)
- **Favorite nodes** with a single click from the popup, dashboard list, or detail panel — favorites get amber rings on the map and topology graph
- **Node groups** with operator-defined names + colors, persistent server-side; per-node assignment dropdown plus **bulk-select multi-assign** (checkbox column, shift-click ranges, floating action bar) in the dashboard node list; **group color overrides marker/topology color** so groupings are obvious at a glance
- **QR contact sharing** producing `meshtastic.org/v/#` URLs compatible with mobile clients
- **Deep linking** for incoming contact (`#v/`) and chat (`#chat=`) URLs
- **Block list** for hiding noisy nodes (purely local UI filter)
- **Browser notifications** for DMs, mentions, and lost favorites — mention notifications resolve to the actual channel and click-to-open the right chat
- **CSV import/export** of messages, events, and telemetry
- **AI assistant** (Anthropic Claude or Google Gemini) with full mesh context
- **Multi-client live sync** — open the dashboard in multiple tabs/browsers; SSE pushes ack updates, traceroute results, waypoints, node updates, events, S&F router heartbeats, NeighborInfo packets, module config, and group changes (~250 ms cross-client latency)

---

## Run locally

**Prerequisites:** Node.js 18+ and a Meshtastic radio connected via USB (optional — there's a simulator).

```bash
git clone <your-fork-url>.git meshview-sentinel
cd meshview-sentinel
npm install

# Frontend (Vite dev server, port 3000)
npm run dev

# Backend (Express + SQLite + serial bridge, port 3001)
npm run dev:server
```

For radio auto-discovery over USB, set the env var before running the backend:

```bash
SERIAL_AUTO_DISCOVER=true npm run dev:server
```

Or specify a port directly: `SERIAL_PORT=/dev/ttyUSB0 npm run dev:server`.

For TCP-mode radios, leave both env vars unset — the server will reconnect to the last endpoint stored in `data/tcp-endpoint.json`, or you can configure one in **Settings → Connection** in the UI.

### AI features

If you want the in-app AI assistant, configure an API key under **Settings → AI**. Keys are stored server-side at `data/ai-config.json` and never sent to the browser.

### Production deployment

See [INSTALLATION_GUIDE_DELL_GB10.md](INSTALLATION_GUIDE_DELL_GB10.md) for a step-by-step deployment recipe targeted at the Dell GB10 Edge Gateway. The same recipe works on any Linux host with Node.js 18+ and a USB Meshtastic node.

A `Dockerfile` and `docker-compose.yml` are also included for containerized deployment.

---

## Architecture

- **Frontend**: React 19 + Vite + Tailwind v4, [pigeon-maps](https://pigeon-maps.js.org/) for mapping, [recharts](https://recharts.org/) for telemetry time-series, [emoji-picker-react](https://github.com/ealush/emoji-picker-react) for waypoint icons and reactions, [qrcode.react](https://github.com/zpao/qrcode.react) for contact-sharing QR codes
- **Backend**: Node.js + Express + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), with raw protobuf encoding/decoding for Meshtastic packets (no `@meshtastic/js` dependency — the protocol is implemented directly to keep the dependency surface small)
- **Persistence**: SQLite at `data/mesh.sqlite` with tables for nodes, messages (FTS5-indexed), events, channels, waypoints, neighbor info, S&F routers, groups, and per-node telemetry history. All schema changes are forward-compatible additive migrations
- **Real-time**: 3-second polling on `/api/mesh/snapshot` as a safety net, plus an SSE stream at `/api/mesh/stream` carrying named events (`ack`, `trace`, `waypoints`, `node`, `eventLog`, `storeForward`, `neighborInfo`, `moduleConfig`, `groups`). Bursts of high-frequency events are coalesced via a 250 ms client-side debounce
- **Module config writes**: Admin messages to the local radio (no LoRa airtime cost) for things like enabling/disabling NeighborInfo, with authoritative readback via `get_module_config_response`

---

## License

This project is licensed under the [MIT License](LICENSE) — free for personal and commercial use, modification, and redistribution.

---

## Disclaimer

**meshview-sentinel is the personal open-source work of Kit Kim and Michael Broadwater. It is not a product, project, or work-for-hire of Government Acquisitions, Inc. or any of its affiliates.** No employer time, resources, intellectual property, trademarks, or proprietary information were used in its development. The opinions, code, and design choices expressed here are ours alone and do not reflect those of any current or former employer.

Meshtastic® is a registered trademark of Meshtastic LLC. This project is not affiliated with, endorsed by, or sponsored by Meshtastic LLC. It is an independent third-party tool that interoperates with the Meshtastic open firmware and protocol.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the current list of features that are partially implemented, deferred, or could use polish — including notes on what's been validated against real radio hardware vs what still needs field testing.

---

## Contributing

Issues and pull requests welcome. Before submitting:
- Run `npm run lint` (strict TypeScript check)
- Run `npm run build` to verify the production build succeeds

---

## Acknowledgements

- The [Meshtastic](https://meshtastic.org/) project for the firmware, protocol, and ecosystem
- [pigeon-maps](https://pigeon-maps.js.org/) for a tiny dependency-free map component
- [recharts](https://recharts.org/) for the telemetry time-series charts
- [emoji-picker-react](https://github.com/ealush/emoji-picker-react) for the waypoint and reaction emoji picker
- [qrcode.react](https://github.com/zpao/qrcode.react) for contact-sharing QR code rendering
- [d3-force](https://github.com/d3/d3-force) for the topology graph layout
- The Meshtastic community for documentation and protocol guidance
