# MeshView Sentinel v2.0 — Multi-Radio Roadmap

Target: **2.0.0 Beta 1**. 1.0.0rc03 is the final 1.0 release; everything here lands on a `v2` branch.

Last updated: 2026-05-26

---

## Core reframings (from planning round)

### 1. Frequency Slot ≠ Primary Channel

The setting that puts two radios on different RF channels within the same LoRa band is **`config.lora.channel_num`** — Meshtastic surfaces it as **"Frequency Slot"** in LoRa Config. It is independent of the primary channel name/PSK.

- Two radios can share the same **primary channel name** ("LongFast") and the same PSK and still never hear each other if their Frequency Slots differ.
- Frequency Slot `0` = auto-derive from the primary channel name hash. Non-zero = explicit slot.
- The operating RF frequency is a derived value of `(region, modem_preset, frequency_slot)`.

Reference radio config from the operator's mesh:

| Radio | Region | Preset | Frequency Slot | Primary Channel | Network |
|---|---|---|---|---|---|
| `MBNT` | US | LongFast | 0 (auto) | LongFast | DC Mesh |
| `WRTJ` | US | LongFast | 9 | LongFast | NOVA Mesh |

This is what we surface and what we let the operator change per radio.

### 2. Radio identity = 4-char `short_name`

Drop "Primary Radio" / "Secondary Radio" naming. The 4-char `short_name` (firmware `User.short_name`) becomes the `radio_id` everywhere: DB column, RadioBar pill, "Heard by" badge, log prefix. Uniqueness enforced at add-time.

### 3. Refresh becomes a split-button dropdown

Default action = refresh all enabled radios. Dropdown lists each radio individually.

### 4. Map overlap mitigation — iterate

Phase 3 ships basic per-radio pin coloring. Phase 5 adds cluster badges for spatial collisions and multi-color rings for the same node heard by multiple radios.

### 5. CUDA is a core capability, not an optional tier

**Platform assumption**: Sentinel always runs on NVIDIA hardware — Jetson Nano (Maxwell), Orin Nano/NX/AGX (Ampere), GB10 (Blackwell), or x86 hosts with NVIDIA discrete GPUs. **There is no non-NVIDIA target.** This is a firm constraint, not a "we test there first."

That changes the architecture:
- CUDA acceleration is built into the platform from day one — not deferred to a post-GA phase.
- "GPU available" is the expected state; CPU-only paths exist only as a developer-convenience fallback (working on a laptop without GPU passthrough) and a Maxwell-era graceful path for the lowest-tier Nano where some workloads aren't worth offloading.
- Specific Sentinel components are CUDA-accelerated by default — see the "What gets accelerated" section below.

**AI module is separate and possibly disposable**: The chat AI assistant is a standalone module that may be removed in a later release if it doesn't prove valuable. It is NOT the reason CUDA exists in the codebase. Treat the AI module's GPU use as orthogonal to the core platform's GPU use — losing the AI module should not affect any other GPU workload.

**What gets accelerated** (CUDA-first, CPU fallback only for dev/debug):

| Workload | Where it lives | Why GPU helps | Library |
|---|---|---|---|
| **Mesh topology graph** (connectivity, k-shortest-path, centrality) | Phase 4 — per-radio scoping | Scales to 1000+ node meshes without re-running graph algorithms on every SSE update | cuGraph |
| **Spatial clustering for map pins** (overlap collapse, density layers) | Phase 3 — unified dashboard | Sub-millisecond re-cluster on every zoom/pan instead of jank | cuML DBSCAN |
| **Signal coverage heatmap** (RSSI/SNR interpolation over a 2D grid — IDW or kriging) | Phase 5 — polish | Embarrassingly parallel; CPU implementation would be too slow to update live | cuPy / custom CUDA kernel |
| **Position history processing** (smoothing, downsampling, trajectory simplification) | Phase 5 — trace playback | Months of position_history with thousands of samples per node | cuDF |
| **Traceroute path analysis** (common-path detection, route stability) | Phase 5 | Pairwise comparison across all traces is O(n²); GPU makes it feasible | cuGraph |
| **AI chat (disposable module)** | optional add-on | Standard LLM acceleration | Ollama (external) |

**How CUDA actually plugs into a Node.js server**:

CUDA bindings for Node are immature. RAPIDS (cuGraph / cuML / cuDF / cuPy) is the right tool for our workloads but it's Python-native. So:

```
┌─────────────────────────────┐         ┌──────────────────────────┐
│  meshview-sentinel          │  HTTP   │  meshview-gpu (sidecar)  │
│  (Node.js, no GPU deps)     │ ◄─────► │  (Python + RAPIDS)       │
│                             │ :7100   │                          │
│  - GpuClient interface      │         │  - FastAPI               │
│  - CPU fallback for dev     │         │  - cuGraph / cuML / cuDF │
└─────────────────────────────┘         └──────────────────────────┘
        same docker-compose, both containers, localhost network
```

Two containers, one compose file:
- `meshview-sentinel` — current Node.js app, unchanged base image, no CUDA deps. Stays arch-portable and small.
- `meshview-gpu` — Python sidecar exposing a stable HTTP API for each accelerated workload. Built **multi-arch** with platform-specific base images selected by manifest:
  - **arm64 / Jetson (L4T)** → `nvcr.io/nvidia/l4t-ml:r36.x-py3` (includes CUDA, cuDNN, TensorRT, RAPIDS for Jetson)
  - **arm64 SBSA (GB10, Grace)** → `nvcr.io/nvidia/cuda:12.x-runtime-ubuntu22.04` + RAPIDS pip wheels
  - **x86_64 with NVIDIA GPU** → `nvcr.io/nvidia/rapidsai/rapidsai:24.x-cuda12.x-runtime-ubuntu22.04-py3.11`
- Sentinel calls the sidecar via `http://meshview-gpu:7100/...`. If the sidecar is unreachable (developer working without GPU passthrough), `GpuClient` falls back to a CPU implementation flagged "DEV — accuracy-equivalent, performance-degraded."

**End-to-end dev contract**:
- Every accelerated workload has TWO implementations: GPU (canonical, lives in `meshview-gpu`) and CPU (fallback, lives in Sentinel itself in TypeScript).
- Both implementations are tested against the same fixtures with identical numerical outputs (within float tolerance).
- Production deployments (Nano / Orin / GB10) always use the GPU path. Developers without an NVIDIA dev machine can still run the full app — they just get the CPU path and a startup banner saying so.
- The same `meshview-gpu` Docker image works across Nano, Orin, AGX, and GB10 thanks to multi-arch manifests. Operators don't need to know which variant they're pulling.

**Specifically for Jetson Nano 2GB**: the Maxwell GPU is real but VRAM-constrained. We gate which workloads run on-GPU per device:
- Topology graph: GPU (small mesh, small footprint, fast)
- Spatial clustering: GPU (small dataset, fast)
- Signal heatmap: GPU but downsampled grid (256×256 instead of 1024×1024)
- Position history processing: CPU (RAPIDS cuDF requires too much VRAM for any meaningful benefit at this scale)

Detection is automatic via `nvidia-smi --query-gpu=name,memory.total --format=csv` at sidecar boot; per-workload gating is a table in `meshview-gpu` config, not Sentinel's concern.

---

## DB schema changes (Phase 1)

All radio-scoped tables get `radio_id TEXT NOT NULL` (the 4-char short_name).

Affected tables:
- `nodes`, `messages`, `events`, `traceroutes`
- `bbs_mail`, `bbs_weather_subscribers`
- `position_history`, `node_sessions`
- `acks`, `channels`, `pending_acks`

New table:

```sql
CREATE TABLE radios (
  radio_id        TEXT PRIMARY KEY,        -- 4-char short_name
  long_name       TEXT NOT NULL,
  transport       TEXT NOT NULL,           -- 'serial' | 'tcp' | 'ble'
  target          TEXT NOT NULL,           -- /dev/ttyUSB0 | 192.168.x.x:4403
  region          TEXT,                    -- 'US' | 'EU_868' | ...
  modem_preset    TEXT,                    -- 'LONG_FAST' | ...
  frequency_slot  INTEGER,                 -- config.lora.channel_num
  primary_channel TEXT,                    -- e.g. 'LongFast', 'NOVA', 'DCMesh'
  num_hops        INTEGER DEFAULT 3,
  enabled         INTEGER DEFAULT 1,
  color_hex       TEXT,                    -- auto-assigned, editable
  network_label   TEXT,                    -- operator-friendly: 'DC Mesh', 'NOVA Mesh'
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

Migration on first 2.0 boot: detect the currently-connected radio, register it as `radio_id = <its short_name>`, backfill every existing row with that id.

---

## Architecture

```
                    ┌─────────────────────┐
                    │   BridgeManager     │   (singleton)
                    │                     │
                    │   Map<id, RadioCtx> │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌──────────┐     ┌──────────┐     ┌──────────┐
       │ MBNT ctx │     │ WRTJ ctx │     │ ... ctx  │
       │          │     │          │     │          │
       │ adapter  │     │ adapter  │     │ adapter  │
       │ (serial) │     │ (tcp)    │     │ (...)    │
       │ nodes    │     │ nodes    │     │ nodes    │
       │ pending  │     │ pending  │     │ pending  │
       │ buffer   │     │ buffer   │     │ buffer   │
       └──────────┘     └──────────┘     └──────────┘
              │                │                │
              └────────────────┴────────────────┘
                               │
                       Shared SQLite
                       Shared SSE bus (events tagged with radio_id)
```

**Key invariants**:
- One `RadioAdapter` per transport. Same packet parser, same admin builder, same channel parser — all current code in [server/meshtasticSerial.ts](server/meshtasticSerial.ts) moves into a per-context method.
- `BridgeManager` owns the registry, lifecycle (connect/disconnect/reconnect), and the SSE fan-out.
- **Memory caps per RadioContext**: `MAX_BUFFERED_MESSAGES_PER_RADIO = 500`, `MAX_PENDING_ACKS_PER_RADIO = 200`, `nodes` Map unbounded (eviction by retention loop only — node count is naturally bounded by mesh size).
- Boot-time RAM check: if `os.totalmem() < 2 GB` and `radios.length > 1`, log a warning and surface a Settings → Radios advisory.

---

## Implementation phases

### Phase 1 — Foundation (DB + Registry + BridgeManager)

- Migrate DB: add `radio_id` everywhere, create `radios` table, backfill
- Implement `RadioAdapter` interface (extract from current `meshtasticSerial.ts`)
- Implement `RadioContext` (per-radio state + admin queue)
- Implement `BridgeManager` (singleton, replaces today's `meshBridge` export)
- All existing single-radio code paths keep working — the auto-discovered radio is registered as `radio_id = <short_name>`
- **No UI changes yet** — purely structural. App should be functionally identical to 1.0rc03 after Phase 1 lands.

### Phase 1.5 — GPU sidecar foundation

Lands in parallel with Phase 1 because Phases 3/4/5 will depend on it.

- New `meshview-gpu` container in `docker-compose.yml` alongside `meshview-sentinel`
- Multi-arch Dockerfile (L4T for Jetson arm64, RAPIDS for x86_64 + Grace arm64 SBSA)
- FastAPI service on port 7100 with endpoints stubbed for every Phase 3/4/5 workload (returns 501 until each phase fills it in)
- `GpuClient` TypeScript module in Sentinel:
  - HTTP client to the sidecar
  - Health-check + reconnect logic
  - **CPU fallback per call** when sidecar unreachable, with a one-shot startup banner: `"GPU sidecar unreachable — running with CPU fallback (dev mode)"`
- Sidecar boot logs which GPU it detected (`nvidia-smi`), what VRAM it has, and which workloads it enables/disables on this hardware
- CI matrix: build and smoke-test the sidecar image for arm64-l4t, arm64-sbsa, x86_64-cuda
- Jetson Nano guide updated with the new container's RAM footprint (~400 MB resident for the Python+RAPIDS process)

### Phase 2 — Radio CRUD UI

- **Settings → Radios** tab (new)
- List of configured radios with connection status (✓ connected / ✗ disconnected / ⟳ connecting)
- Add Radio: pick transport (serial port dropdown / TCP host:port / BLE TBD), test connection, auto-fill short_name + long_name from the radio's User config on connect
- Edit Radio: rename network_label, edit color, enable/disable
- Per-radio **LoRa Config editor**:
  - Region (US, EU_433, EU_868, CN, JP, ANZ, KR, TW, RU, IN, NZ_865, TH, LORA_24, UA_433, UA_868, MY_433, MY_919, SG_923)
  - Modem Preset (LONG_FAST, LONG_SLOW, MEDIUM_FAST, MEDIUM_SLOW, SHORT_FAST, SHORT_SLOW, SHORT_TURBO, LONG_MODERATE, VERY_LONG_SLOW)
  - **Frequency Slot** (numeric input with "0 = auto" hint, validated against region's slot count)
  - Computed operating frequency display (read-only, derived client-side)
  - Number of hops (1–7)
  - Transmit Enabled toggle
- 4-char short_name uniqueness validation on add (offer rename via admin if collision detected)
- Auto color palette: 8-color cycle, manually overridable
- Test connection button per radio

### Phase 3 — Unified dashboard

- **RadioBar** component below header. Per radio pill: `[WRTJ] US · LongFast · slot9 · 12 nodes ✓`
- Filter chips at the top of node-scoped views: "All radios" + one chip per enabled radio
- Node list "Heard by" column with colored 4-char badges (most-recent-first)
- Map pins: border color = most-recent hearing radio
- **Refresh button → split-button dropdown**:
  - Click main: refresh all enabled radios
  - Click chevron: dropdown lists each radio + "Refresh all"
- SSE events now include `radio_id` field; client-side filters drop events from non-selected radios
- All existing per-node detail panels work unchanged — they aggregate across radios that heard the node
- **GPU-accelerated workload**: spatial clustering for map pins. `meshview-gpu` exposes `POST /cluster/dbscan` taking `{lat, lng, radio_id}[]` and a zoom-derived eps; returns cluster assignments. Re-clusters on every map view change without jank even at 1000+ pins.

### Phase 4 — Per-radio scoping

- Messages: inbox/outbox tagged by `radio_id`; "Send" picker chooses which radio sends a DM/broadcast
- BBS: per-radio mail + weather subscribers (already designed this way in 1.0 — Phase 4 just wires up the `radio_id` filter)
- Stats cards: aggregate by default, per-radio when a radio filter is active
- Channel-share URL parsing: now asks "Apply to which radio?" before writing the new channel slot
- Recipe Guide + Install Guide updated for multi-radio walkthrough
- Jetson Nano guide updated with multi-radio memory implications
- **GPU-accelerated workload**: mesh topology graph. `meshview-gpu` exposes `POST /topology/build` taking heard-by events and returns connectivity edges + computed metrics (centrality, k-shortest-paths between any pair, partition detection). Recomputed incrementally as the SSE stream updates the heard-by table.

### Phase 5 — Polish + accelerated visualizations + leftover 1.0 items

**Multi-radio polish**:
- Map cluster badges for spatial overlap (`+N` indicator with click-to-expand) — uses Phase 3's `/cluster/dbscan` output
- Multi-color rings on pins for same-node-heard-by-multiple-radios
- Boot-time RAM advisory surfaced in Settings → Radios when host is tight on RAM

**GPU-accelerated visualizations** (the headline 2.0 features):
- **Signal coverage heatmap**: `meshview-gpu` exposes `POST /heatmap/coverage` taking observed RSSI/SNR points and a bounding box; returns a rasterized interpolation (IDW or kriging) overlaid on the map. Live-updated on every new packet without burning CPU.
- **Position trace playback** + trajectory smoothing for `position_history` data accumulated since 1.0rc03. GPU-side downsampling and Ramer-Douglas-Peucker simplification for long traces. On Nano: CPU path (RAPIDS VRAM cost not worth it at this dataset size).
- **Traceroute path analysis**: identify common path segments across many traceroutes, surface route-stability scores per pair. Phase 5 ships the analysis API + a "Route Stability" panel.

**Leftover 1.0 items rolled in**:
- Outage detection / "radio went silent" alerts
- Backup/restore for `bbs-config.json` + `radios` table + channel PSKs (encrypted export)
- Per-channel uplink/downlink editing (currently read-only in some flows)
- Complete the remaining modules in Settings → Modules: Power, Serial, Canned Messages, Ambient Lighting, Paxcounter (carried over from 1.0 ROADMAP)
- PKI/ECDH for true DM encryption — still parked, documented why it's parked (Curve25519 client-side implementation is non-trivial and firmware behavior is inconsistent; revisit when there's a stable upstream client lib)

### Phase 6 — AI assistant evaluation + GPU sidecar expansion (post-Beta 1, target 2.0 GA)

The AI chat module is treated as **standalone and possibly disposable**. Phase 6 is a decision point — keep, evolve, or remove — based on actual operator usage during Beta 1.

If kept:
- Move AI module to use the GPU sidecar pattern (Python + transformers/vLLM) instead of external Ollama, so the GPU runtime is unified
- Tier-aware model selection (small model on Nano, larger on Orin/AGX/GB10) driven by sidecar's startup probe
- Optional RAG over mesh logs (cuDF for ingest, vector search via cuVS)

If removed:
- Drop the AI Assistant tab and related routes
- Reclaim ~250 MB of container baseline on Nano
- The decision to remove doesn't affect any other GPU workload — they all live in `meshview-gpu` already

**Other Phase 6 expansion items**:
- Anomaly detection on node behavior (joining/leaving patterns, RSSI drift) — exposed as a "Network Health" panel
- AGX Orin deployment guide
- GB10 development setup guide (separate from edge deployment — this is the dev box, not a target)

---

## Open decisions made (auto-mode defaults — flag any to revisit)

| Question | Default chosen |
|---|---|
| Channel slot PSK edit UX | Warn that it disconnects from peers on the old PSK; offer to broadcast a fresh channel-share QR after save |
| Color palette | Auto-assign on add from an 8-color palette, editable in the per-radio editor |
| Default refresh-dropdown click action | Refresh all enabled radios |
| CUDA scope | NVIDIA-always platform assumption. Core workloads (topology, clustering, heatmap, trace analysis) are GPU-accelerated via the `meshview-gpu` sidecar from Phase 1.5 onward. AI module is standalone and evaluated for keep/remove in Phase 6. |
| Plan file location | New `ROADMAP-v2.md` (this file); preserve `ROADMAP.md` as the 1.0 historical record |

---

## Risks

1. **Two radios on overlapping frequency slots** — operator could misconfigure both to slot 0 with the same primary channel name, getting duplicate hearings of the same packets. Detect at add-time and warn.
2. **Admin queue contention** — admin writes are serialized per radio today; multi-radio means the BridgeManager must route admin replies back to the right context by `from` field. Build this routing carefully or replies get cross-attributed.
3. **SSE event volume** — two radios doubles the inbound packet stream. Verify the 250 ms client-side debounce holds up under 2× load before claiming Phase 3 is done.
4. **Channel PSK leak via export** — backup/restore (Phase 5) must encrypt PSKs at rest. Don't write them to a plain JSON dump.
5. **BLE transport** — listed as TBD in Phase 2 transport picker. Beta 1 ships serial + TCP only; BLE is a Phase 5 stretch.

---

## What 2.0.0 Beta 1 includes (success criteria) — ✅ TAGGED `v2.0.0-beta.1`

- [x] Two radios connected simultaneously (one serial, one TCP) via Settings → Radios (`spawnSecondary` in [bridgeManager.ts](server/bridgeManager.ts), Connect/Disconnect buttons in [SettingsModal.tsx](src/components/SettingsModal.tsx))
- [x] Each radio shows its real Frequency Slot, modem preset, and primary channel in the RadioBar (LoRa admin readback wired in [meshtasticSerial.ts](server/meshtasticSerial.ts))
- [x] Node list shows "Heard by [MBNT][WRTJ]" badges; filtering by radio works ([DashboardView.tsx](src/components/views/DashboardView.tsx) `HeardByBadges`, `filteredNodes` in [App.tsx](src/App.tsx))
- [x] Map renders pins with per-radio color borders; overlap clustering present (GPU DBSCAN with TS fallback; click-to-expand popover; multi-color dot strip for multi-radio nodes)
- [x] Refresh dropdown lets operator refresh one radio at a time ([RefreshSplitButton.tsx](src/components/RefreshSplitButton.tsx))
- [x] BBS mail and weather subscribers are scoped per radio (per-context `BbsService` from [bridgeManager.ts](server/bridgeManager.ts), DB radio_id stamping, WeatherAlertPoller routing per subscriber)
- [x] Memory advisory in Settings → Radios warns when host is tight (`/api/system/info` + `RamAdvisory` component)
- [x] `meshview-gpu` sidecar reachable + GPU detection (verified on NVIDIA GB10); CPU fallback works on dev machines with startup banner
- [x] Three core workloads verified end-to-end against the GPU sidecar: spatial clustering (Phase 3c), topology graph (Phase 4), signal coverage heatmap (Phase 5)
- [x] Migration from 1.0rc03 → 2.0.0 Beta 1 is non-destructive (DB backfill + auto-register the existing radio)

**Bonus features that landed in Beta 1** (not in the original success criteria):
- GPU position trace simplification (RDP) — `/api/gpu/trace-simplify` endpoint ready for the future playback UI
- Detect Identity + Test Connection buttons in Settings → Radios
- Enabled/disabled toggle for radios
- Multi-radio sections added to Install Guide + Jetson Nano guide

---

## 2.0.0 Beta 2 scope (deferred from Beta 1)

These items were explicitly scoped out of Beta 1 to keep the multi-radio core focused. Each is its own focused work session.

> **Status key:** ✅ done · 🔲 open · ⏸ parked · 🚧 blocked on hardware

### ✅ Closed in the Beta 2 WIP commit (`57e1a0f`, 2026-05-27)

Critical Beta 1 bugs that meant LoRa readback never actually worked, plus a wave of multi-radio polish and board-capability surfacing:

- ✅ **LoRa readback bugs** — `CFG_LORA` enum was 6 (Bluetooth) not 5 (LoRa); `FromRadio.config`/`moduleConfig` (fields 5/9) weren't parsed; secondary readback fired before identity was known; per-radio LoRa endpoints routed to the singleton instead of the target bridge. All fixed.
- ✅ **Make Primary** — hot-swap which radio holds the singleton bridge (replaced the no-op "Set Default")
- ✅ **Radios → top-level nav** — moved out of Settings into its own page
- ✅ **Per-message `radioId`** + smart reply routing + per-message radio chip
- ✅ **MQTT awareness** — RF/MQTT filter chips, stats card RF/MQTT split, per-channel `MQTT ↑↓` badge
- ✅ **Per-channel uplink/downlink editing** — was already editable in 1.x; the MQTT badge made the state glanceable
- ✅ **Settings → Modules: Power** — full editor (sleep / battery shutdown / wake)
- ✅ **Network config readback** (WiFi/Eth/NTP) — read-only display (bonus, wasn't originally scoped)
- ✅ **Radio Health line** — firmware / reboots / battery / voltage per radio (bonus)
- ✅ **Detect Identity / Test Connection** live-state fallback when the port is already held

### 🔲 Still open — feature work

- 🔲 **Canned Messages module** — admin builder + parser + Settings card + a dashboard quick-send palette. Lets operators preload short broadcasts and one-click send.
- 🔲 **Position-trace playback UI** — the backend RDP simplifier shipped in Beta 1 (`/api/gpu/trace-simplify`); this is the slider + map polyline overlay on the Node Detail panel.
- 🔲 **Outage detection / "radio went silent" alerts** — event-based, per-radio. Fires when a previously-heard node misses its expected reporting interval.
- 🔲 **Backup / restore** — encrypted export of `bbs-config.json` + `radios` table + channel PSKs. Read at config time to bootstrap a fresh install.
- 🚧 **Detection Sensor event timeline** — blocked on wiring a physical GPIO sensor; firmware triggers arrive as plain text broadcasts, so the timeline design needs a real signal to match against.
- 🔲 **Traceroute route-stability analysis** — `/api/gpu/route-stability` (cuGraph in the sidecar; pure-Python fallback). Common path segments + per-pair stability scores + a "Route Stability" panel.

### 🔲 Still open — remaining Settings → Modules

Each mirrors the Power module pattern (admin builder + parser + readback + UI card):

- 🔲 **Serial** — UART-based external device integration
- 🔲 **Ambient Lighting** — WS2812 LED control (boards with the strip)
- 🔲 **Paxcounter** — BLE/WiFi device counting (foot-traffic estimation)

### 🔲 Still open — infrastructure / cleanup

- 🔲 **`RadioAdapter` formal extraction** — the interface in [radioAdapter.ts](server/radioAdapter.ts) exists but `MeshtasticSerialBridge` doesn't formally `implements` it. Fold this in when BLE transport lands.
- 🔲 **Multi-arch `Dockerfile.gpu`** with `nvcr.io/nvidia/l4t-ml` (Jetson arm64), `nvidia/cuda` (x86_64), and SBSA-arm64 variants installing RAPIDS so the sidecar can actually use cuML / cuGraph / cuPy in production. Plus a **CI matrix** smoke-testing the image per arch.

### ⏸ Parked

- ⏸ **PKI / ECDH** for true DM encryption — Curve25519 client-side impl is non-trivial + firmware behavior is inconsistent. Revisit when a stable upstream client library exists.

### Phase 6 — AI + sidecar expansion (target 2.0 GA, after Beta 2 stabilizes)
Unchanged from original plan. AI evaluation + decision point (keep / evolve / remove), anomaly detection, AGX Orin + GB10 deployment guides.

---

*See [ROADMAP.md](ROADMAP.md) for the 1.0 historical roadmap. Beta 1 git tag: `v2.0.0-beta.1` on the `v2-dev` branch.*
