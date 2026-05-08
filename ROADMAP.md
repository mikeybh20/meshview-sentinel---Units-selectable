# Roadmap

This document tracks features that are **partially implemented**, **deferred**, **needing real-radio validation**, or **future work** worth considering.

Updated: 2026-05-07

---

## Status legend

- ⚠️ **Partial** — works but with known limitations
- 🧪 **Needs validation** — implemented, but only verified against the simulator or stub data; should be tested against real hardware before being trusted
- 📋 **Deferred** — out of scope for this round; documented for later
- 💡 **Idea** — speculative, not yet committed

---

## Module configuration (admin writes)

A unified **Settings → Modules** section now exists with NeighborInfo as the first module configured end-to-end (enable/disable, interval, transmit-over-LoRa, with a Refresh-readback button). The `set_module_config` builder pattern in `server/meshtasticSerial.ts` (`buildAdminSetNeighborInfoConfig`) is reusable for any other `ModuleConfig.*` variant — adding the rest is mostly UI work plus a per-module config parser.

| Module | Status | Notes |
|---|---|---|
| **NeighborInfo** | ✅ Done | Enable/disable + interval + transmit-over-LoRa via Settings → Modules with authoritative readback. Quick-toggle button also lives in the topology banner |
| **Range Test** | 📋 Deferred | Read-only ingest works; no UI to configure sender mode/interval |
| **Store & Forward** | ⚠️ Partial | Detection + replay request work; no UI to configure local node *as* a router |
| **MQTT bridge** | ⚠️ Partial | Per-channel uplink/downlink toggles exist (write path through channel admin); broker URL/auth config not exposed. Inbound `via_mqtt` flag is now parsed and surfaced as a node badge |
| **Telemetry module** | 📋 Deferred | Receive works; configuring broadcast intervals not exposed |
| **External Notification** | 📋 Deferred | No UI |
| **Detection Sensor** | 📋 Deferred | No UI |
| **Audio module** | 📋 Deferred | No UI |
| **Position precision (per channel)** | ⚠️ Partial | Display-only in node popup (`precision_bits` field); no per-channel write |

---

## Module state readback

✅ **Done** — the bridge now issues `AdminMessage.get_module_config_request` for NeighborInfo on connect and after every write. The response (`get_module_config_response` carrying a `ModuleConfig`) is parsed by a new `handleAdminResponse` dispatcher case (PORT_ADMIN_APP) and stored on `localModuleConfig.neighborInfo`. The topology banner uses this authoritative state when available and falls back to inferred state otherwise (with an "inferred" hint badge so operators know which they're seeing). Local admin only — no mesh airtime cost.

A new **Settings → Modules** section exposes the full editor: enable/disable, update interval (with presets from 10 min to 12 hr plus a manual-input field), and transmit-over-LoRa toggle. Includes a Refresh button to re-read the firmware state on demand. Changes auto-trigger a readback so the UI re-syncs to the radio's actual saved state.

**Robustness:** some firmware versions don't reply to self-admin readback requests (session-passkey gating, etc.). To prevent the Save button from being stuck on "No changes" forever, the bridge now **optimistically populates `localModuleConfig.neighborInfo`** with the values it just sent right after the admin write. If the actual readback arrives, it overwrites the optimistic state with authoritative values; if it never arrives, the optimistic state at least represents the operator's intent. The Save button is also enabled when there's no baseline yet so the form can apply values on a cold start.

---

## Real-time sync gaps

✅ **Done** — every server-side bridge event now fans out to connected SSE clients, which trigger a debounced (250 ms) poll on receipt to coalesce bursts.

| Event | SSE? | Latency between clients |
|---|---|---|
| Message ack/status | ✅ | instant (direct payload) |
| Traceroute results | ✅ | instant (direct payload) |
| Waypoint changes | ✅ | instant (re-poll) |
| New nodes discovered | ✅ | ~250 ms (debounced re-poll) |
| New events (NODE_JOINED, etc.) | ✅ | ~250 ms (debounced re-poll) |
| New S&F router heartbeats | ✅ | ~250 ms (debounced re-poll) |
| New NeighborInfo packets | ✅ | ~250 ms (debounced re-poll) |
| Node telemetry refresh | ✅ | ~250 ms (debounced re-poll, via `nodeUpdate`) |
| Favorite toggles | ✅ | ~250 ms (debounced re-poll, via `nodeUpdate`) |

The 3-second background poll still runs as a safety net in case the SSE stream drops. The browser's EventSource auto-reconnects on disconnect, so a lost SSE just degrades temporarily to the 3 s cadence.

---

## Messaging features with limitations

### ⚠️ Reply / React on pre-existing messages
The Reply and React buttons on hover only appear on messages that have a `packetId` (the radio's MeshPacket id). Messages persisted *before* the `packet_id` schema column was added don't have one. **Resolution**: as new traffic arrives, every new message has a packetId. Old messages stay reaction-less. Acceptable.

### ⚠️ Reactions are add-only
Tapping an existing reaction chip adds another reaction with the same emoji rather than removing yours. Removal would require a tombstone-reaction protocol the firmware doesn't currently expose. **📋 Deferred** — matches behavior of most Meshtastic clients today.

### ✅ Mention notification routing — done
Notifications now resolve `m.channel` (e.g. "LongFast", "Channel 2") to the correct `chan:N` chat id via the same matching rules `useReadStatus` uses. Clicking a mention notification jumps to the actual channel where the mention happened. As a bonus, the notification body is now prefixed with `[channel name]` for context, and focus-suppression works for channel mentions too (no notification fires if you're already viewing that channel).

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

### ✅ MQTT inbound visualization
The bridge now parses `MeshPacket.via_mqtt` (field 14) and tracks it as `lastVia: 'lora' | 'mqtt'` per node. NodePopup shows a cyan **MQTT** badge when the last received packet came in via the bridge. SNR/RSSI are no longer overwritten with synthetic zeros from MQTT relays — we only refresh signal strength on LoRa-direct observations.

### ✅ Inbound NodeInfo: licensed flag, role, hardware
`User.is_licensed` (field 6), `User.role` (field 7), and `User.hw_model` (field 5) are now parsed in `parseUser()` and stored on each node. Visible in the NodePopup as small badges (`ROUTER`, `TRACKER`, `TAK`, `SENSOR`, etc.) plus a `LIC` badge for licensed operators, with the hardware model name appended to the node-id row (`!aabbccdd · Heltec v3`). Full enum mappings live in [src/lib/meshEnums.ts](src/lib/meshEnums.ts) — covers ~60 hardware models and all Role enum values.

### 📋 PKC encryption verification
We surface "PKC capable" when a node has a public key, but don't yet **verify** that DMs to that node actually used PKC vs PSK fallback. The firmware sets a flag on inbound packets indicating which key was used. **📋 Deferred** — operationally low impact since the firmware handles the choice transparently.

---

## Comm Matrix — ✅ rewritten

The previous N×N matrix collapsed all broadcasts into one column, hardcoded "RELAY SCORE: HIGH", and was unusable at 134 nodes. Replaced with a filtered cross-tab:

- **Time range filter**: Last 1h / 6h / 24h / All — defaults to 24h
- **Top-N senders** (10 / 15 / 25 / 50, default 15) instead of every node
- **Channels become real columns** (`#LongFast`, `#BH20Private`) — broadcasts are no longer hidden in `!ffffffff`. DMs appear as `@OPS`-style columns alongside, top-N most-DM'd by traffic
- **Two color modes**:
  - **Count**: emerald-intensity by traffic density (the old behavior)
  - **Success**: emerald for ≥85% acked, amber for 50–85%, red for <50%, intensity scaled by total messages
- **Real tooltip** with per-status breakdown (acked / sent-no-ack / pending / errored) and computed success rate — replaces the hardcoded "RELAY SCORE: HIGH" stub
- **Sticky header + sticky sender column** so you can scroll a wide matrix without losing axis labels
- **"X senders hidden / X DM peers hidden"** counter in the subtitle so you know when filtering trimmed real data
- Computation moved out of `App.tsx` into the view itself (filter state lives where it's used)

---

## Real-radio validation status

Items that have been **field-tested** against the operator's BroadH20 radio vs only **smoke-tested locally**. For each 🧪 item, a few minutes of real-mesh observation should confirm the parser correctly handles real packets.

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
| User.role / hw_model / is_licensed | 🧪 Parser only | Medium |
| MeshPacket.via_mqtt | 🧪 Parser only | Medium |
| Traceroute request/response | 🧪 Send path only | Medium |
| NeighborInfo ingest | 🧪 Parser tested with stubs | Medium |
| NeighborInfo enable/disable admin write | 🧪 Packet builder validated | Medium |
| NeighborInfo `get_module_config` readback | 🧪 Parser tested with stubs | Medium |
| Store & Forward heartbeat parse | 🧪 Parser only | Medium |
| Store & Forward CLIENT_HISTORY admin write | 🧪 Packet builder validated | Medium |
| Waypoint broadcast | 🧪 Parser only | Medium |
| Range Test ingest | 🧪 Parser only | Medium |
| Reactions / replies (`reply_id`, `emoji`) | 🧪 Parser only | Medium |
| Channel admin writes | ✅ Real radio | High |
| QR contact URL (Meshtastic mobile compat) | 🧪 Encoder only | Medium |

---

## Node Groups — ✅ persistence + assignment UI shipped

**Persistence**: new `groups` SQLite table; node `groupId` round-trips via the existing `raw_json` column. Seed simulator groups removed (groups now start empty for a fresh radio install).

**API**: `GET / POST / PATCH / DELETE /api/mesh/groups` plus `POST /api/mesh/nodes/:id/group { groupId | null }`. All CRUD paths smoke-tested (creation with hex-color validation, update, delete-with-cascade-unassign, snapshot inclusion).

**SSE**: new `groups` event channel fans out group changes to every connected client → multi-tab updates within ~250 ms.

**UI**:
- **Group create modal** now has a color picker (8 swatches + custom hex input), Enter-to-create, disabled-when-empty Save button. The previously-random HSL color is gone
- **Sidebar** GroupItems show a delete × on hover (with a confirm dialog) for non-favorites/non-all groups
- **NodePopup** has a Group dropdown above the action grid — assign / unassign in one click; matching color dot displayed when assigned
- **Dashboard NODE_DETAILS** has the same Group dropdown right under the node title

**Still deferred:**
- Inline group rename — currently you'd delete and recreate. A double-click-to-edit on the GroupItem would close that gap

**✅ Multi-select bulk-assign — done**
- Per-row checkbox in the dashboard NODE_LIST table (subtle, brightens on hover)
- Shift-click to extend a range to the destination row's new state
- Header checkbox toggles select-all / clear-all
- Floating action bar appears when ≥1 row is selected with `Move to group ▾` (dropdown of groups + Unassigned), `Star`, `Unstar`, and `Clear` actions
- Bulk apply runs in parallel via `Promise.all` of the existing per-node API calls; loading spinner on the Move button while in flight
- Selection auto-prunes when the visible filter changes (e.g. switching to a different group filter)

**✅ Done in a follow-up round:**
- Group color now overrides node coloring on **map markers** (Meshtastic-style labeled circles) AND **topology graph nodes** (ring + fill + label color). Color priority: assigned group > favorite > online > offline. Star icon on the popup still indicates favorite as a separate signal so neither is hidden

---

## UI / UX polish

| Item | Type | Notes |
|---|---|---|
| Bundle size | ⚠️ Partial | ~1.2 MB total; `emoji-picker-react` (~140 KB) and `recharts` (~120 KB) are the largest single contributors. Lazy-load either via dynamic import to shrink initial load |
| Settings → Modules section | ✅ Done | Unified Settings modal hosts the module config UI (NeighborInfo first; expandable to others as admin write paths land) |
| Settings hub consolidation | ✅ Done | Connection / Modules / Notifications / Display / Blocked / Data / AI all in one tabbed modal — replaces the previous 6-button rail |
| Comm Matrix usability at scale | ✅ Done | Time filter + top-N + channels-as-columns + success-rate coloring + sticky axes — see "Comm Matrix" section above |
| Per-node telemetry charts | ✅ Done | Three-tab (Signal · Power · Environment) chart in the dashboard NODE_DETAILS widget; auto-refreshes every 30 s |
| Topology zoom-to-fit | ✅ Done | Auto-fits ~800 ms after layout settles; manual ⛶ button in the camera-controls cluster |
| Topology layout persistence | ✅ Done | Drag-positions saved to `localStorage` (`mesh.topologyLayout`); restored before simulation runs. "Reset" button clears all pinned positions and re-runs the layout |
| Group color on map + topology | ✅ Done | Assigned group's hex color overrides the default emerald/amber/slate ring + fill + label. Priority: group > favorite > online > offline |
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
- ~~**Per-node graphs** — RSSI/SNR/battery time-series for a single node~~ ✅ Done — three-tab chart (Signal · Power · Environment) inline in the NODE_DETAILS dashboard widget, auto-refreshes every 30 s, uses `recharts` (was already in deps but unused)
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