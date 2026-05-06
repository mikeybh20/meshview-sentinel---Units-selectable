# Roadmap

This document tracks features that are **partially implemented**, **deferred**, **needing real-radio validation**, or **future work** worth considering.

Updated: 2026-05-06

---

## Status legend

- ⚠️ **Partial** — works but with known limitations
- 🧪 **Needs validation** — implemented, but only verified against the simulator or stub data; should be tested against real hardware before being trusted
- 📋 **Deferred** — out of scope for this round; documented for later
- 💡 **Idea** — speculative, not yet committed

---

## Module configuration (admin writes)

Only NeighborInfo currently has a UI-driven enable/disable. The same `AdminMessage.set_module_config` plumbing could expose the others.

| Module | Status | Notes |
|---|---|---|
| **NeighborInfo** | ✅ Done | Enable/Disable from topology banner with state inference |
| **Range Test** | 📋 Deferred | Read-only ingest works; no UI to configure sender mode/interval |
| **Store & Forward** | ⚠️ Partial | Detection + replay request work; no UI to configure local node *as* a router |
| **MQTT bridge** | ⚠️ Partial | Per-channel uplink/downlink toggles exist (write path through channel admin); broker URL/auth config not exposed |
| **Telemetry module** | 📋 Deferred | Receive works; configuring broadcast intervals not exposed |
| **External Notification** | 📋 Deferred | No UI |
| **Detection Sensor** | 📋 Deferred | No UI |
| **Audio module** | 📋 Deferred | No UI |
| **Position precision (per channel)** | ⚠️ Partial | Display-only in node popup (`precision_bits` field); no per-channel write |

A unified **Settings → Modules** section would group all of these. The `set_module_config` builder pattern in [meshtasticSerial.ts](server/meshtasticSerial.ts#L2585) (`buildAdminSetNeighborInfoConfig`) is reusable for any other `ModuleConfig.*` variant.

---

## Module state readback

The current "Active / Not Broadcasting" indicator on the NeighborInfo control is **inferred from observed traffic** — we look for the local node in the `neighborInfo` array. This works well in practice but has two caveats:

- After enabling, status shows "Not Broadcasting" until the first packet (~1 broadcast interval)
- After disabling, the previous observation has to age out before the indicator updates

A proper fix would be to issue an `AdminMessage.get_module_config_request` and parse the response to read the firmware's actual setting. **📋 Deferred** — the inferred state is good enough for day-to-day toggling.

---

## Real-time sync gaps

Multi-client sync is implemented, but only some events are broadcast via SSE — the rest fall through the 3-second poll.

| Event | SSE? | Latency between clients |
|---|---|---|
| Message ack/status | ✅ | instant |
| Traceroute results | ✅ | instant |
| Waypoint changes | ✅ | instant |
| New nodes discovered | ❌ | up to 3 s |
| New events (NODE_JOINED, etc.) | ❌ | up to 3 s |
| New S&F router heartbeats | ❌ | up to 3 s |
| New NeighborInfo packets | ❌ | up to 3 s |
| Node telemetry refresh | ❌ | up to 3 s |
| Favorite toggles | ❌ | up to 3 s |

**⚠️ Partial** — extending SSE to the missing events is a small change. The bridge already emits `nodeUpdate`, `event`, `storeForwardUpdate`, `neighborInfoUpdate` — the API just doesn't forward them yet.

---

## Messaging features with limitations

### ⚠️ Reply / React on pre-existing messages
The Reply and React buttons on hover only appear on messages that have a `packetId` (the radio's MeshPacket id). Messages persisted *before* the `packet_id` schema column was added don't have one. **Resolution**: as new traffic arrives, every new message has a packetId. Old messages stay reaction-less. Acceptable.

### ⚠️ Reactions are add-only
Tapping an existing reaction chip adds another reaction with the same emoji rather than removing yours. Removal would require a tombstone-reaction protocol the firmware doesn't currently expose. **📋 Deferred** — matches behavior of most Meshtastic clients today.

### ⚠️ Mention notification routing
Clicking a mention notification jumps to `chan:0` instead of resolving the actual channel from the message's `m.channel` string. **TODO comment in [useMeshNotifications.ts](src/hooks/useMeshNotifications.ts#L75)** — needs a name → channel-index lookup using the channels list. ~10 LOC fix.

### ⚠️ Mention parsing edge cases
`@everyone`, `@all`, or channel-wide mentions aren't recognized. Only `@shortname` and `@!hex` resolve. **📋 Deferred** — none of these are part of the Meshtastic protocol; would be UI-only conventions.

### 💡 Search-result highlight
Search results jump to the right chat but don't scroll to or highlight the matched message. The chat just opens at the latest message. **💡 Idea** — would need message-id-based scroll anchoring in the messages list.

---

## Radio module / packet handling

### ⚠️ Range Test — no coverage map
Range Test packets get logged to the event stream as `Range test "seq N" (snr=X dB rssi=Y dBm)` but nothing aggregates them into a coverage map (originator + position + SNR/RSSI over time). **📋 Deferred** — would need a dedicated `range_test` table and a "coverage" view that pairs each test packet with its sender's last known position.

### ⚠️ Store & Forward — minimal control
We detect routers, surface their stats, and request replays. Things missing:
- Configuring the local node *as* a router (admin write, similar to NeighborInfo)
- Decoding `ROUTER_TEXT_BROADCAST` / `ROUTER_TEXT_DIRECT` (currently we ignore these — replays come back as ordinary `TEXT_MESSAGE_APP` packets which is the firmware's actual behavior, but the variant case isn't handled if encountered)
- Periodic "ping" to verify a router is alive
- Stats request (`CLIENT_STATS`) UI

### 📋 MQTT inbound visualization
We surface uplink/downlink config per channel, but don't visualize **which packets came in via MQTT** vs LoRa. The Meshtastic firmware sets a `via_mqtt` flag on incoming `MeshPacket` (field 14) we currently don't parse. **📋 Deferred** — would let you distinguish "LoRa-direct" peers from "MQTT-bridged" ones in the UI.

### 📋 Inbound NodeInfo: licensed flag, role, hardware
The User proto has `is_licensed` (bool), `role` (Router / Client / TAK / etc.), `hw_model` (HardwareModel enum) that we currently ignore. Surfacing role and hardware would help operators identify routers and TAK clients at a glance. **📋 Deferred**.

### 📋 PKC encryption verification
We surface "PKC capable" when a node has a public key, but don't yet **verify** that DMs to that node actually used PKC vs PSK fallback. The firmware sets a flag on inbound packets indicating which key was used. **📋 Deferred** — operationally low impact since the firmware handles the choice transparently.

---

## Real-radio validation status

Items that have been **field-tested** vs only **smoke-tested locally**:

| Feature | Validated against | Confidence |
|---|---|---|
| Serial transport | ✅ Real radio (BroadH20) | High |
| TCP transport | 🧪 Stub server only | Medium |
| Inbound text messages | ✅ Real radio | High |
| Outbound text messages | ✅ Real radio | High |
| Sent message persistence (DMs) | ✅ Real radio | High |
| Position parsing (lat/lng/alt) | ✅ Real radio | High |
| Position source (GPS/fixed) | 🧪 Parser only | Medium |
| Telemetry (battery/SNR/RSSI) | ✅ Real radio | High |
| NodeInfo + public_key | ✅ Real radio | High |
| Traceroute request/response | 🧪 Send path only | Medium |
| NeighborInfo ingest | 🧪 Parser tested with stubs | Medium |
| NeighborInfo enable/disable admin write | 🧪 Packet builder validated | Medium |
| Store & Forward heartbeat parse | 🧪 Parser only | Medium |
| Store & Forward CLIENT_HISTORY admin write | 🧪 Packet builder validated | Medium |
| Waypoint broadcast | 🧪 Parser only | Medium |
| Range Test ingest | 🧪 Parser only | Medium |
| Reactions / replies (`reply_id`, `emoji`) | 🧪 Parser only | Medium |
| Channel admin writes | ✅ Real radio | High |
| QR contact URL (Meshtastic mobile compat) | 🧪 Encoder only | Medium |

For each 🧪 item, a few minutes of real-mesh observation should confirm the parser correctly handles real packets.

---

## UI / UX polish

| Item | Type | Notes |
|---|---|---|
| Bundle size | ⚠️ Partial | 1.08 MB total, ~140 KB of which is `emoji-picker-react`. Lazy-load via dynamic import would shrink initial load |
| Settings → Modules section | 💡 Idea | Currently NeighborInfo is in the topology banner. Pulling all module config into a unified Settings tab would be more discoverable |
| Topology zoom-to-fit | 💡 Idea | After layout settles, auto-fit the camera to all nodes. Would help with 100+ node meshes |
| Topology layout persistence | 💡 Idea | Drag-positions reset on every refresh; could persist `fx/fy` in localStorage |
| Node tooltip hover | 💡 Idea | On topology, hover-tooltip with node info (currently you have to click) |
| Mobile / responsive layout | 📋 Deferred | App works on desktop and tablet; phone screens will be cramped |
| Dark/light theme toggle | 📋 Deferred | Currently dark only |
| Time-based message retention | 📋 Deferred | Events have it (Settings → Display has retention control); messages still cap by count (5000 rows) |
| Block list sync across server instances | 📋 Deferred | Stored in browser `localStorage`; doesn't follow the user across machines |
| Node ignore from radio side | 💡 Idea | Block list is local-only. Firmware also has node-level ignore — could be wired through |

---

## Security / privacy

| Item | Status | Notes |
|---|---|---|
| AI API keys not in browser | ✅ Done | Stored server-side at `data/ai-config.json` |
| TCP endpoint persistence | ✅ Done | Saved to `data/tcp-endpoint.json`; cleared on explicit disconnect |
| No outbound telemetry | ✅ Done | The app makes no third-party calls except to the user-configured AI provider |
| Server auth | 📋 Deferred | The HTTP API has no auth — anyone with network access to the server can read/send. Fine for `localhost`-only deployments; needs reverse-proxy + basic auth for anything broader |
| HTTPS / WSS | 📋 Deferred | Not configured by default — terminate at a reverse proxy |
| AI prompts include node IDs and message text | ⚠️ Partial | Be aware: when the AI assistant is invoked, the system prompt includes a snapshot of mesh state. If you don't want that data going to Anthropic/Google, leave keys unset |

---

## Architecture

| Item | Notes |
|---|---|
| Custom raw-bytes protobuf encoder/decoder | The bridge implements Meshtastic's wire protocol directly instead of pulling in `@meshtastic/js`. **Pro**: tiny dependency tree, full visibility into parser bugs. **Con**: every new module/proto field is a hand-written addition. If the protocol evolves significantly, switching to the official JS SDK could be worthwhile |
| SQLite as source of truth | Multi-client works because the server is the single source of truth. If you ever need horizontal scaling, this would need a different approach |
| No tests | There's no automated test suite. Type check + Vite build are the smoke tests |
| Schema migrations are additive ALTER TABLE only | Works for the current low-write-volume use case. A more formal migration framework would help if the schema grows |

---

## Future feature ideas (💡)

These haven't been requested but seem natural fits:

- **Coverage heatmap** — combine Range Test + position data into a colored overlay on the map showing where reception is strong/weak
- **Mesh playback** — scrub through historical events on a timeline, replay the mesh state at any point
- **Per-node graphs** — RSSI/SNR/battery time-series for a single node (telemetry table is already populated, just needs a chart)
- **Node ignore (firmware-level)** — combine block list with the firmware's actual ignore list for nodes that are spamming
- **Channel sharing via QR** — the per-channel PSK + name URL format for sharing a whole channel config
- **Camera scan for incoming contact QR** — currently we only generate QRs; can't read them in
- **CSV → mesh import** — bulk-add favorite contacts or pre-seed nodes from a roster
- **Webhook on important events** — fire an HTTP POST when a favorite goes offline / battery drops below X / specific keyword arrives in a channel
- **Voice/audio channel monitoring** if the audio module sees use
- **Range Test scheduler** — kick off a range test session that runs for N minutes and produces a coverage report
- **Node firmware version surfacing** (the radio reports it in MyNodeInfo)
- **Site survey mode** — temporarily increase NeighborInfo broadcast frequency for faster topology mapping during deployment

---

## Known minor bugs / rough edges

- **Reaction notification suppression** — added a skip for `m.isReaction` in [useMeshNotifications.ts](src/hooks/useMeshNotifications.ts), but reactions to your own messages may still trigger notifications in edge cases. Worth eyeballing once with a real mesh
- **Topology force-graph performance** — at 134+ nodes the layout takes a few seconds to settle. Acceptable but could be tuned
- **`localNodeId` resolution timing** — on first connect, NodeInfo for the local node arrives a few seconds after serial open. Brief window where the topology banner shows "NeighborInfo: NOT BROADCASTING" before the local node's own ID is known
- **Trace results don't persist** — they live in memory on the server; a server restart clears them. Easy DB-add if needed