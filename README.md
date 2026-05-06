# meshview-sentinel

A web-based dashboard, control center, and diagnostic tool for [Meshtastic](https://meshtastic.org/) LoRa mesh networks. Connect to a real radio over USB serial or TCP, or run against a built-in simulator for development.

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)

---

## Features

### Mesh awareness
- **Live node directory** with online/offline status, telemetry (RSSI, SNR, battery, sensors), short-name labels, position source (GPS vs fixed), and PKC public keys
- **Map view** with labeled markers (Meshtastic-style short-name circles), signal-quality links, message trace overlays, and right-click waypoint drops
- **Topology** and **Route Intelligence** views with relay statistics
- **Comm Matrix** heatmap and **Event Log** stream

### Messaging
- Channels and direct messages with per-message ack/error status, hop visualization, and message retry
- **Replies** and **emoji reactions** (Meshtastic `Data.reply_id` / `Data.emoji` protocol)
- **@mentions** with notifications
- **Read status** with unread badges per chat
- **Full-text search** (SQLite FTS5) across all persisted messages

### Radio modules
- **Traceroute** — request a path to any node, see hop-by-hop SNR
- **NeighborInfo** — surface each node's directly-observed neighbors with SNR
- **Store & Forward** — detect router nodes and request replay of missed traffic
- **Range Test** logging
- **Waypoints** — drop, edit, and broadcast `WAYPOINT_APP` packets with emoji icons and expiration

### Operator features
- **TCP transport** alongside serial (firmware 2.7.4+)
- **QR contact sharing** producing `meshtastic.org/v/#` URLs compatible with mobile clients
- **Deep linking** for incoming contact and chat URLs
- **Block list** for hiding noisy nodes
- **Browser notifications** for DMs, mentions, and lost favorites
- **Configurable event log retention** (6h / 24h / 36h / 48h / 72h)
- **CSV import/export** of messages, events, and telemetry
- **AI assistant** (Anthropic Claude or Google Gemini) with full mesh context
- **Multi-client live sync** — open the dashboard in multiple tabs/browsers, share state

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

- **Frontend**: React 19 + Vite + Tailwind v4, [pigeon-maps](https://pigeon-maps.js.org/) for mapping, [emoji-picker-react](https://github.com/ealush/emoji-picker-react) for waypoint icons and reactions
- **Backend**: Node.js + Express + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), with raw protobuf encoding/decoding for Meshtastic packets (no `@meshtastic/js` dependency — the protocol is implemented directly to keep the dependency surface small)
- **Persistence**: SQLite at `data/mesh.sqlite` with tables for nodes, messages (FTS5-indexed), events, channels, waypoints, neighbor info, S&F routers, and per-node telemetry history. All schema changes are forward-compatible additive migrations
- **Real-time**: 3-second polling on `/api/mesh/snapshot` plus an SSE stream at `/api/mesh/stream` for ack updates, traceroute results, and waypoint changes

---

## License

This project is licensed under the [MIT License](LICENSE) — free for personal and commercial use, modification, and redistribution.

---

## Disclaimer

**meshview-sentinel is the personal open-source work of Michael Broadwater. It is not a product, project, or work-for-hire of Government Acquisitions, Inc. or any of its affiliates.** No employer time, resources, intellectual property, trademarks, or proprietary information were used in its development. The opinions, code, and design choices expressed here are mine alone and do not reflect those of any current or former employer.

Meshtastic® is a registered trademark of Meshtastic LLC. This project is not affiliated with, endorsed by, or sponsored by Meshtastic LLC. It is an independent third-party tool that interoperates with the Meshtastic open firmware and protocol.

---

## Contributing

Issues and pull requests welcome. Before submitting:
- Run `npm run lint` (strict TypeScript check)
- Run `npm run build` to verify the production build succeeds

---

## Acknowledgements

- The [Meshtastic](https://meshtastic.org/) project for the firmware, protocol, and ecosystem
- [pigeon-maps](https://pigeon-maps.js.org/) for a tiny dependency-free map component
- The Meshtastic community for documentation and protocol guidance
