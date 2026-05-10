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
| **Range Test** | ✅ Done | Enable/disable + sender interval (presets + custom) + save-to-flash via Settings → Modules. Full readback / optimistic-update pattern matches NeighborInfo. UI warns operators that active sending consumes airtime; default is receive-only |
| **Store & Forward** | ✅ Done | Settings → Modules now exposes the local S&F module: enable + client/router toggle, plus heartbeat / buffer size / replay-cap / time-window when router mode is on. Router parameters collapse-hide unless the operator opts in. Same readback / optimistic-update pattern as the other modules. (Detecting peer routers and CLIENT_HISTORY requests were already done) |
| **MQTT bridge** | ✅ Done | Settings → Modules → MQTT: enable/disable, broker address (with username/password + TLS), topic root, channel encryption, JSON publish, proxy-to-client, map reporting. Same readback / optimistic-update pattern as the other modules. The `MapReportSettings` sub-message is captured opaquely on readback and echoed verbatim on save so unmodelled fields survive. Per-channel uplink/downlink toggles still live in Channels. Header pill is now state-aware (`ACTIVE` if module enabled, `OBSERVED` if any peer was seen via MQTT in the last 30 min, `OFF` otherwise) |
| **Telemetry module** | ✅ Done | Settings → Modules now has a Telemetry card with device-metrics interval (battery / voltage / channel utilization), plus per-feature toggles + intervals for environment sensors (BME280 etc.) and power monitors (INA219 / INA260). Same readback / optimistic-update / Refresh-button pattern as the other modules; intervals collapse-hide when their feature is disabled |
| **External Notification** | ✅ Done | Settings → Modules has an External Notification card with master enable, "alert on any text", "alert on bell character only", alert duration (preset + custom), and nag timeout. Board-specific GPIO pin assignments (output / buzzer / vibra / PWM / I2S) are read on connect, displayed read-only, and passed straight back through on save so the board's factory configuration survives a behavior edit |
| **Detection Sensor** | ✅ Done | Settings → Modules card with master enable, sensor name (≤20 chars), monitor pin, min/state broadcast intervals, active-high vs active-low, internal pullup, send-bell toggle. Same readback / optimistic-update pattern as the other modules |
| **Audio module** | ✅ Done | Settings → Modules card for Codec2 voice over LoRa: master enable, PTT pin, bitrate selector (Codec2 default / 3200 / 2400 / 1600 / 1400 / 1300 / 1200 / 700B bps), and the four I2S pins (WS / SD / DIN / SCK). UI carries an explicit experimental warning since most off-the-shelf boards lack the required mic+speaker hardware |
| **Position precision (per channel)** | ✅ Done | ChannelsModal now exposes a per-channel precision picker with operator-friendly presets (Full / ~1.6 km / ~6.4 km / ~51 km / ~410 km / Disabled) plus a custom-bits fallback. Server reads `ChannelSettings.module_settings.position_precision` (field 7 → 1) on inbound channels and writes it back via the existing `set_channel` admin path. Persisted to the `channels` SQLite table via additive migration |

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

### ✅ Channel-wide mention parsing — done
`@everyone`, `@all`, and `@channel` now parse as channel-wide mentions. They render in the warning palette (distinct from regular accent-colored `@shortname`/`@!hex` mentions), are non-clickable (no specific node target), and `isMentioned` returns true for every recipient — so notification routing fires for everyone in the channel, not just the local node. UI-only convention (still not part of the Meshtastic wire protocol), but matches Slack/Discord etiquette and what most operators expect when they type `@everyone`.

### ✅ Search-result highlight — done
Search results now scroll the matched bubble into view (centered) and flash a soft accent ring around it for 2 seconds. The auto-scroll-to-bottom effect is suppressed while the highlight is active so it doesn't fight the anchor. Refs are tracked per message id; defer-to-RAF lets the chat switch + re-render before the scroll fires.

---

## Radio module / packet handling

### ✅ Range Test — sender configurable, coverage tracked
✅ The local sender is operator-configurable from Settings → Modules (enable/disable, sender interval, save-to-flash) — see "Module configuration" above.

✅ Coverage tracking shipped: every inbound Range Test packet is persisted to a new `range_test_observations` SQLite table with sender id, sender's last-known position, parsed seq number, SNR (dB), RSSI (dBm), and timestamp. Bound to the most recent 5,000 observations. The Map view has a new floating **Range Test Coverage** panel (top-right) with a window selector (1h / 6h / 24h / 7d / All time) showing per-sender aggregates: count, avg/best/worst SNR, avg RSSI, time since last seen. Each row is color-coded by avg SNR (emerald ≥ 5 dB, amber 0–5 dB, red < 0 dB) and clicking centers the map on that sender's last-known position. Auto-refreshes every 30 s while open.

Still 💡: a true heatmap overlay where individual marker color/intensity reflects coverage strength visually on the map. The current panel + click-to-focus is the operator-facing MVP.

### ⚠️ Store & Forward — most control shipped, polish pending
✅ Configuring the local node *as* a router is now wired through Settings → Modules — see the Module configuration table above.

Still pending:
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

**✅ Inline group rename — done**
- Double-click any user group in the sidebar to edit its name in place
- Enter commits, Escape cancels, blur commits, empty/unchanged values are no-ops
- Wired through the existing `PATCH /api/mesh/groups/:id` endpoint (`meshDataService.updateGroup`); fans out via SSE so multi-tab clients re-sync within ~250 ms

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
| Bundle size | ✅ Done (Round 1) | Initial JS dropped 1.07 MB → 843 KB (gzip 304 → 252 KB, ~22%) by lazy-loading `recharts` (TelemetryChart), `emoji-picker-react` (WaypointEditorModal + reaction picker via a tiny `lazy/ReactionPicker` shim). Heavy chunks now load on-demand only when operators open the relevant feature |
| Settings → Modules section | ✅ Done | Unified Settings modal hosts the module config UI (NeighborInfo first; expandable to others as admin write paths land) |
| Settings hub consolidation | ✅ Done | Connection / Modules / Notifications / Display / Blocked / Data / AI all in one tabbed modal — replaces the previous 6-button rail |
| Comm Matrix usability at scale | ✅ Done | Time filter + top-N + channels-as-columns + success-rate coloring + sticky axes — see "Comm Matrix" section above |
| Per-node telemetry charts | ✅ Done | Three-tab (Signal · Power · Environment) chart in the dashboard NODE_DETAILS widget; auto-refreshes every 30 s |
| Topology zoom-to-fit | ✅ Done | Auto-fits ~800 ms after layout settles; manual ⛶ button in the camera-controls cluster |
| Topology layout persistence | ✅ Done | Drag-positions saved to `localStorage` (`mesh.topologyLayout`); restored before simulation runs. "Reset" button clears all pinned positions and re-runs the layout |
| Group color on map + topology | ✅ Done | Assigned group's hex color overrides the default emerald/amber/slate ring + fill + label. Priority: group > favorite > online > offline |
| App version in header | ✅ Done | Header now reads from `package.json` at build time via `__APP_VERSION__` Vite define (was hardcoded to a stale `v2.4.0-STABLE`). Bumped from 0.1.0 → 0.2.0 to reflect the work shipped |
| Node tooltip hover | ✅ Done | Hovering any topology node now shows a cursor-following HTML overlay with name/short, id, hardware model, role, license, last-seen, battery / SNR / RSSI, group, MQTT-via, and favorite — flips to the cursor's other side near edges so it stays visible |
| Mobile / responsive layout | 📋 Deferred | App works on desktop and tablet; phone screens will be cramped |
| Dark/light theme toggle | ✅ Done | Settings → Display has Auto / Light / Dark. Auto follows OS `prefers-color-scheme` and live-flips. Brand-* CSS-variable palette swaps via `:root[data-theme="light"]`; all hardcoded `slate-*`/`emerald-*`/`amber-*`/`red-*`/`cyan-*` classes were migrated to brand-* tokens (~478 references, 22 files). Inline `style={{ background: '#020617' }}` modal backgrounds switched to `var(--color-brand-bg)` so popups also flip |
| Time-based message retention | ✅ Done | Settings → Display now has a Message Retention dropdown (Keep all / 1d / 3d / 7d / 30d / 90d). Default is "Keep all" so existing behavior is unchanged; selecting a window prunes older messages on a 5-min timer (parallel to events). Count cap of 5,000 still applies as a safety net |
| Block list sync across server instances | ✅ Done | Block list is now persisted server-side in a new `blocked_nodes` SQLite table, served via `GET /api/mesh/blocked`, mutated via `POST /api/mesh/blocked` and `DELETE /api/mesh/blocked/:id`, and fanned out via a new `blocked` SSE event (multi-tab sync within ~250 ms). `useBlockList` migrated from localStorage to the server with optimistic UI + revert-on-failure; legacy localStorage entries are pushed up on first mount and then kept as a stale-cache fallback for offline reads |
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
| AI prompts include node IDs and message text | ✅ Done | Settings → AI has a **Redact PII from AI prompts** toggle. When on, the system prompt drops all node identifiers, names, positions, and message contents — the provider only sees aggregate counts (total / online / offline / favorites / positioned / telemetry-reporting / RPi-bridges / temperature avg) plus event-type histogram from the last 50 events. Persisted server-side at `data/ai-config.json` and applied client-side in [src/services/geminiService.ts](src/services/geminiService.ts) before the request leaves the browser. AIAssistant header shows a `REDACTED` pill when active so the operator always knows which mode is in effect |

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

- ✅ **Coverage heatmap** — done. The Range Test Coverage panel now has a "Heatmap mode" toggle that recolors every map marker by avg SNR (emerald ≥ 5 dB / amber 0–5 / red < 0 / muted for senders we haven't heard via Range Test in the active window). Inline color legend in the panel; the existing list + click-to-focus works alongside
- **Mesh playback** — scrub through historical events on a timeline, replay the mesh state at any point
- ✅ **Channel sharing via QR** — done. ChannelsModal now has a "Share via QR" button that opens a modal with a QR + copyable URL in the standard Meshtastic `https://meshtastic.org/e/#<base64url>` format. Encodes the active channel set's PSKs, names, uplink/downlink flags, and per-channel position-precision. Compatible with the official Meshtastic mobile clients. Live in [src/lib/channelShare.ts](src/lib/channelShare.ts) with a hand-rolled `ChannelSet` protobuf encoder
- ✅ **Range Test scheduler** — done. Settings → Modules → Range Test now has a "Coverage Survey" panel with a duration picker (5–60 min) and a survey cadence picker (30 s – 5 min). Captures the current Range Test config before starting, applies a faster sender cadence, and auto-restores when the timer fires. Active surveys show a live countdown with a Cancel button
- ✅ **Site survey mode** — done. Same pattern for NeighborInfo: Settings → Modules → NeighborInfo has a "Site Survey" panel that temporarily speeds up the NeighborInfo broadcast cadence (1–10 min options) for 5–60 minutes, then restores the previous config. Useful right after deploying a new node so the topology fills in within minutes instead of hours. Both surveys share a `SurveyControl` helper component and surface their expiry via `LocalModuleConfigSnapshot.activeSurveys`
- ✅ **Node firmware version surfacing** — done. Settings → Connection now surfaces `firmwareVersion`, `localNodeId`, and `rebootCount` once the radio reports them. Bridge captures from MyNodeInfo (older firmware path: field 4 string) AND FromRadio.metadata → DeviceMetadata (newer firmware path: field 1 string). Whichever arrives first wins
- ~~**Per-node graphs** — RSSI/SNR/battery time-series for a single node~~ ✅ Done — three-tab chart (Signal · Power · Environment) inline in the NODE_DETAILS dashboard widget, auto-refreshes every 30 s, uses `recharts` (was already in deps but unused)
- **Node ignore (firmware-level)** — combine block list with the firmware's actual ignore list for nodes that are spamming
- **Channel sharing via QR** — the per-channel PSK + name URL format for sharing a whole channel config
- **Camera scan for incoming contact QR** — currently we only generate QRs; can't read them in
- **CSV → mesh import** — bulk-add favorite contacts or pre-seed nodes from a roster
- **Webhook on important events** — fire an HTTP POST when a favorite goes offline / battery drops below X / specific keyword arrives in a channel
- **Voice/audio channel monitoring** if the audio module sees use

---

## v2.0 — explicitly out of scope for 1.0

These items are documented for the next major version. **Not** going into the 1.0 release codebase.

### Multi-radio support (two or more USB modems on the same host)

The current architecture is single-radio end to end. Two radios on different LoRa frequencies, on different bands, or on the same band but different channels would need a substantial refactor — order of 1–2 weeks, real schema + API surface changes, and is the kind of work that justifies a major version bump.

**What's baked in to single-radio assumptions today:**

| Layer | Assumption |
|---|---|
| Bridge | `export const meshBridge = new MeshtasticSerialBridge()` — one singleton instance per process |
| Serial discovery | `serialDiscovery` attaches the *first* LoRa device on `/dev/ttyUSB*` / `/dev/ttyACM*` and ignores any others |
| State | Nodes, messages, events, NeighborInfo, traceroutes, range-test observations, node_sessions, channels, local_module_config — all in-memory + SQLite tables keyed by node id with no `source_radio_id` column |
| API | `POST /api/mesh/send`, `POST /api/mesh/modules/*`, `POST /api/mesh/traceroute/:id` etc. all hit the singleton — no `?radio=` parameter |
| UI | One header pill, one topology graph, one Comm Matrix, one Settings → Modules section, one Channels modal. No radio selector anywhere |
| MQTT module | A single broker URL on `localModuleConfig.mqtt`. Two radios would each have their own |

**What it would take for v2.0:**

1. Multi-bridge: `Map<radioId, MeshtasticSerialBridge>` with per-radio ACK tracker, pendingAcks, packet-id sequence
2. Source-tagged data: `source_radio_id` column on every relevant table, with an additive migration that defaults existing rows to a single seed radio
3. API parameterization: every write endpoint takes a `radio` parameter; reads either filter by radio or aggregate
4. UI radio selector: dropdown in the header that scopes topology / matrix / messaging / modules / channels to one radio (plus an "All radios" aggregate view)
5. Discovery rewrite: enumerate all attached LoRa devices and auto-attach each

**1.0 workaround for operators who need it now:** run two independent dashboard instances. Copy `docker-compose.yml` to a second directory, remap the host port (`3000:3001` → `3001:3001`), use a different volume name so each instance has its own `mesh.sqlite`. Two browser tabs, two completely independent dashboards. No cross-radio aggregation, but each works correctly with zero code changes.

---

## Known minor bugs / rough edges

- ✅ **Reaction notification suppression** — done. Primary skip on `m.isReaction` plus a defensive secondary heuristic: any message with `replyTo` set whose text is ≤8 chars and contains no whitespace is treated as a reaction-equivalent for notification purposes (catches the edge case where firmware variants emit `Data.emoji` in a way the parser misses). Chat UI still renders the message normally; only the notification path is suppressed
- ✅ **Topology force-graph performance** — done. `forceManyBody.distanceMax(350)` cuts the per-tick O(N²) cost; `alphaDecay(0.045)` cuts settle time roughly in half (~150 ticks vs ~300); `velocityDecay(0.55)` damps oscillation. Final layout is visually identical at any reasonable mesh size; settle time on a 134-node mesh drops from ~4-5 s to ~1.5-2 s
- ✅ **`localNodeId` resolution timing** — done. The topology banner now shows an "IDENTIFYING…" amber state for the first 6 s after a connect (or until `localNodeId` arrives, whichever comes first), so a healthy radio doesn't flash the wrong "NOT BROADCASTING" badge during the initial NodeInfo handshake
- ~~**Trace results don't persist**~~ ✅ Done — new `trace_results` table in SQLite with up-to-500 rolling history; bridge upserts on every state transition (`pending` → `response` / `timeout` / `error`) and rehydrates on boot