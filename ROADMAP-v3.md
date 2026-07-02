# MeshView Sentinel — v3.0 Roadmap

> **Status:** in-progress on branch `v3.0-dev`. Forked from `v2.1.0` tag.

---

## Lineage

- **v1.0** — the inflection point from concept to working application.
  Co-authored by Michael Broadwater and Kit. Demo mode is a v1.0
  artifact that has carried forward through v2.x.
- **v2.0** — multi-radio support, workspaces, BBS subsystem, encrypted
  backup, real Meshtastic protocol implementation.
- **v2.1** — quality, polish, GPU sidecar foundation, mail
  categorisation, console subview, live bridge rebind on IP change.
- **v3.0** — this document.

---

## Theme

> **Field-ready EmComm, opened — with intelligence and services
> the official apps don't offer.**
>
> Sentinel runs cleanly on a Raspberry Pi 4/5 or a laptop, deploys
> reliably enough that an operator trusts it during a real storm,
> hands a Frederick-area SKYWARN spotter a `:spot` command that
> produces NWS-shaped Local Storm Reports, gives the operator
> mesh-ops visibility (traffic analytics, connectivity matrix,
> health signals) the official Meshtastic apps don't surface,
> anchors non-prepper subscribers with `:tide` / `:sun` / `:mdot`
> content services beyond weather, and ships under a license that
> lets amateur groups install it free while commercial forks owe
> royalty back to the co-authors.

One coherent story for a release, not a basket of bolt-ons —
though a wider one now that mesh-ops and subscriber services are
in v3.0. If scope pressure hits, the stretch items in each
inclusion (called out inline) are the release valves; the MVP
subsets stay in.

---

## v3.0 Inclusions

### 1. Raspberry Pi 4/5 first-class target
The GPU sidecar already auto-tiers to a CPU profile, but Pi support
has never been validated end-to-end. v3.0 makes Pi a tested deployment
path, with documentation calling out which features degrade gracefully
(coverage heatmap interpolation, cluster computation) and which are
unaffected.

**Why this matters:** most preppers and SKYWARN volunteers have a
Pi sitting in a drawer; they don't have a Jetson. A Jetson-only
target is an adoption ceiling on day one of open-source release.

### 2. SKYWARN spotter workflow — **shipped**
A new BBS command `:spot` for submitting Local Storm Reports via DM
from a subscriber node. Captures the NWS LSR shape:

- Time (auto-stamped)
- Location (auto from sender's last MeshNode.position at confirm time)
- Event type (HAIL / TSTM WND / TORNADO / FUNNEL / FLOOD / WALL CLOUD /
  OTHER — TEXT column, expandable without migration)
- Magnitude (hail size in inches, wind in mph, water depth in feet;
  sanity-clamped per unit)
- Spotter source (defaults to SPOTTER; TRAINED_SPOTTER promotion is a
  follow-up)
- Remarks (free text, length-capped)

Storm Reports tab on the dashboard:
- pigeon-maps view with severity-tinted markers (red=Tornado/Funnel,
  orange=Hail/Wind, blue=Flood, purple=Wall Cloud/Waterspout)
- Marker size scaled by magnitude when present
- Filter by event type + date range
- Table view with delete-per-row (operator correction path)
- NWS LSR-format CSV export
- SSE-live: new intake, edits, deletes fan out via stormReport event

**Slices shipped:** DB schema + API endpoints (dfd0054), BBS `:spot`
command (d8c43a6), dashboard tab (this).

**Deferred to v3.0.x follow-ups:** workspace_id backfill on intake
(currently null), `:spot source trained` shortcut for SKYWARN-cert
reporters, PATCH endpoint for corrections without full delete-and-
resubmit.

### 3. SKYWARN direct submission (built but gated)
Build the eSpotter/eSpotterChat API client + authentication scaffolding
in v3.0, but **ship it disabled** behind a feature flag
(`SKYWARN_DIRECT_SUBMIT=false` by default). Flipping the flag requires
the operator to enter a verified spotter ID and complete a one-time
eligibility check. Actual flag-flip + cert workflow ships in v3.1.

### 4. NWS feed depth
The existing weather alert poller covers issued alerts. v3.0 adds:
- Active watches/warnings rendered as map polygons (not just bbox
  approximations).
- Mesoscale discussions surfaced as a "context" pane on the Storm
  Reports tab.
- Radar overlay from Iowa Environmental Mesonet WMS.
- Hurricane track overlays during named-storm activity.

### 5. Field-deployment polish
- **Offline-first map tiles** — pre-cache an AOI (area of interest) so
  Sentinel renders the map even when the operator's link is down.
- **Power-aware feature degradation** — defer expensive jobs (heatmap
  recompute, cluster computation) when battery drops below 30%.
- **First-run wizard** — replaces the v1.0 demo-mode entry point.
  Walks new operators through radio pairing OR a session-only
  playground (synthetic nodes, fake telemetry, expires when operator
  pairs a radio or closes the session). Different from v1.0/v2.x
  demo mode: not a stored DB state, not a runtime configuration
  flag, just a one-shot evaluation path.

### 6. Multi-tenant cleanup
Quietly included as a credibility floor for open-source debut, not a
headline feature:
- Workspace isolation guarantees — tested with adversarial cases.
- Per-workspace audit log.
- Workspace invite/share flow (QR code for one-time join links).
- Role clarity — operator vs. member vs. observer permissions.

### 7. External-transport adapter interface (designed, not built)
Define the abstraction that a future HAM/APRS/Winlink bridge would
implement, including the interface surface in `server/transport/`
with a concrete stub. **No actual HAM bridge ships in v3.0** — the
intent is to make the addition in v3.1 (or as a community
contribution post-open-source) drop-in rather than architectural
rework.

### 8. Hardening pass — the "don't be the official app" tax
- Auto-recovery from malformed packets (no crashes on bad input).
- Idempotent migrations that can be re-applied safely.
- Clean update mechanism — `./update.sh` must never require
  force-kill on the running container; migrations apply, services
  restart, no manual cleanup.
- Bug-list discipline — every reported bug filed, triaged, and
  either fixed or documented as out-of-scope before v3.0 ships.

### 9. Demo mode sunset
The v1.0 demo-mode flag (`MESHTASTIC_DEMO_MODE` / equivalent) is
removed in v3.0. Replacement is the session-only playground in the
first-run wizard (Inclusion #5). Migration path: existing demo-mode
deployments see a one-time notice on update directing them to pair a
real radio or use the playground.

### 10. Co-author / dual-license release
- **License:** AGPL-3.0 for open-source / amateur / community use,
  separate commercial license available for revenue-generating use
  that cannot or will not comply with AGPL-3.0 copyleft.
- **Free Commercial License Policy** — public document enumerating
  the categories that receive the commercial license at $0 on
  request (SKYWARN, ARES/RACES, volunteer first-responder EmComm,
  amateur radio clubs, 501(c)(3) EmComm orgs).
- **Co-author agreement** — between Michael Broadwater and Kit;
  70/30 split on net commercial license revenue; both parties
  retain joint copyright ownership.

### 11. Mesh ops intelligence
Operator-side visibility into what the mesh is actually doing —
information the official Meshtastic apps don't surface, that a
regional operator managing a Frederick-area mesh needs to keep the
network healthy.

- **Per-channel traffic analytics** — packet counts / airtime /
  drop-rate breakdown by channel, per hour and per day. Answers
  "which channels are actually being used?" and catches a channel
  that a badly-configured node has flooded.
- **Route quality scoring** — per-hop success rate scored across
  observed traceroute + ACK history. Assigns each observed link a
  0-100 quality score derived from delivery ratio, SNR spread, and
  hop consistency over the last 24h. Surfaces which paths the
  mesh actually depends on and which ones are marginal.
- **"Who can hear whom" matrix** — grid view where rows and
  columns are nodes and cells are colored by observed direct-hop
  link presence (from NeighborInfo + hop-0 packet observations).
  Instantly shows the mesh's actual connectivity graph and where
  a new router node would break isolation between clusters.
- **Antenna orientation suggestions** — per-link, computes whether
  SNR asymmetry (A hears B strong, B hears A weak) points to
  antenna gain / polarization issues at one end. Surfaces "node X
  probably needs to rotate its antenna" as an actionable hint,
  not just a stat.
- **Firmware update reminders** — per-node tracked firmware
  version vs. current stable release from
  github.com/meshtastic/firmware. Flags nodes running >2 minor
  versions behind with an operator-visible reminder.
- **Configuration drift detection** — snapshot each node's LoRa /
  Radio / Position / Power config on first contact + on each
  ModuleConfig update, and flag when a node's TX power, region,
  or hop limit is inconsistent with the mesh consensus. Prevents
  a mis-flashed node from disrupting the mesh before it broadcasts
  a packet the operator has to chase down.

Data plane: new `mesh_ops` schema (channel_traffic, link_quality,
node_config_snapshots, firmware_current_lookup). Dashboard: new
"Mesh Ops" tab with three sub-panels (Analytics, Connectivity,
Health) so this doesn't collide with the operational Radios tab.

**Scope discipline:** the analytics + connectivity matrix are v3.0
MVP; the antenna-orientation and config-drift heuristics are
v3.0 stretch — they involve real signal processing and can slip
to v3.0.x if scope pressure hits. Firmware reminder ships v3.0
(mechanical).

### 12. Subscriber services / BBS content
Content services beyond weather so non-prepper subscribers have a
reason to be on the mesh day-to-day. Anchor: "why am I on the mesh
today?" Fits alongside the existing `:weather` / `:mail` subsystems
— each service is a new BBS command with the same one-packet
reply discipline.

- **`:tide` — tide tables.** NOAA CO-OPS API. Defaults to nearest
  station by operator's home ZIP, override with a station ID.
  Compact one-packet reply: next high/low with time + height.
  Coastal Maryland + Chesapeake Bay are the primary AOI.
- **`:pota` — POTA (Parks On The Air) spot lookup.** Queries
  api.pota.app for currently active park activations. Filters by
  band / mode / distance-from-operator. Reply: "AA1AA @ K-1234
  Cunningham Falls, 20m SSB, 15min ago." Helps licensed HAMs
  chase activations without an internet-connected radio.
- **`:sota` — SOTA (Summits On The Air) spot lookup.** Same shape
  as `:pota` against api2.sota.org.uk.
- **`:mdot` — MDOT (Maryland DoT) traffic.** Regional incidents
  from chart.maryland.gov + trafficinfo.md.gov. Filters by county
  (default: operator's home county). Reply: "I-70 EB @ MP 62 —
  crash, right lane blocked, delay 15min."
- **`:news` — light news digest.** RSS-aggregated compact
  headlines from a small operator-configurable feed list (default:
  NWS regional, USGS earthquakes, local news feeds). NOT a general
  news reader — deliberately narrow.
- **`:sun` — daily astronomy / sun-times.** Sunrise / sunset /
  civil twilight / moon phase / ISS pass predictions for
  operator's coordinates. Reply: "Sunrise 6:12, Sunset 20:34,
  Moon 78% waxing gibbous, ISS pass 21:04 NW→SE."

Each service:
- Ships with a sensible default AOI (operator's home ZIP or
  county) and a `<command> <override>` form for one-off queries.
- Has a `<command> help` / `<command> ?` catalog same shape as
  `:mail help` and `:spot help`.
- Uses HTTP client with 30s timeout + graceful "service unavailable"
  reply on upstream failure — no half-broken partial data.
- All services are opt-in per subscriber (registration flow
  parallels `:weather subscribe`) so a subscriber can pick which
  digests they want pushed vs. pulled.

**Scope discipline:** `:tide`, `:sun`, and `:mdot` are v3.0 MVP —
they solve real Maryland-area daily-use cases and their upstream
APIs are stable. `:pota` and `:sota` are v3.0 stretch — the API
shape is well-known but scope discipline for spot-filtering can
grow. `:news` is v3.0.x — the aggregation logic + per-subscriber
feed selection UI is bigger than it looks.

---

## Deliberately Deferred to v3.1+

These are valuable but explicitly out of v3.0 scope:

- **HAM bridge actual implementation** (APRS, AX.25, Winlink-over-VARA,
  CAT control). The adapter interface ships in v3.0; the first
  concrete adapter ships in v3.1 or later.
- **SKYWARN direct submission flag-flip + cert workflow** —
  v3.1 once submission API is verified.
- **ATAK/CivTAK CoT integration** — both produce-side (publishing
  mesh nodes as CoT) and consume-side (rendering ATAK markers in
  the mesh map). v3.1 or v3.2.
- **Home Assistant exposure** (MQTT / REST sensors). v3.1.
- **Discord/Matrix bridge** for off-mesh team coordination. v3.2.
- **Grafana data source** for long-haul metrics. v3.1.
- **Coordinator-side SKYWARN features** — dispatching a team,
  multi-spotter aggregation, event timeline reconstruction. v3.2.
- **AI features** — AiSection scaffold still deferred until the
  use case is concrete.
- **Plugin marketplace / extensibility system** — heavy
  architectural cost; defer until extension demand is validated.

---

## Pre-Launch Checklist (must complete before open-source publication)

- [x] **Corporate IP release / clearance** — confirmed clear per
      Broadwater. Sentinel is personal IP, not work-for-hire.
      (README Disclaimer section also memorializes this publicly.)
- [x] **Co-author agreement** — treated as resolved per Broadwater
      direction. Draft remains at `legal/co-author-agreement-draft.md`
      (private, gitignored) for attorney review + signature whenever
      formalisation is convenient.
- [x] **LICENSE file** added (canonical AGPL-3.0 text from FSF).
- [x] **COMMERCIAL-LICENSE.md** added (commercial license terms +
      contact for commercial license inquiries).
- [x] **FREE-USE-POLICY.md** added (categories eligible for free
      commercial license waiver, with edge-case examples).
- [x] **AUTHORS file** added (Kit Kim + Broadwater attribution).
- [x] **README updated** to show dual-license badges + replace MIT
      License section with AGPL-3.0 + Commercial dual-license
      explanation pointing at the three license files.
- [ ] **Source-code copyright headers** updated across all source
      files to reflect joint authorship. Done incrementally as files
      are touched in normal work; no big-bang sweep planned.
- [ ] **Public repository** spun up (or existing repo made public)
      with documentation, README, contributing guide.

---

## License Stance (final, locked)

**Dual-license: AGPL-3.0 + Commercial.**

- AGPL-3.0 is the primary license. Source-available + strong
  copyleft including §13 (remote network interaction — closes the
  SaaS hosting loophole).
- Commercial license available for parties that need exemption
  from AGPL-3.0 copyleft (proprietary integration, internal use
  without source distribution obligations, warranty/indemnification).
- Free Commercial License Policy enumerates categories that receive
  the commercial license at $0 on request.
- Royalty from net commercial license revenue split **70%
  Broadwater / 30% Kit** per the co-author agreement.

---

## Working Notes

- Branch: `v3.0-dev` forked from `v2.1.0` tag.
- Version in `.env.example`: `3.0.0-dev`.
- Demo mode sunset is a breaking change — operators with
  `MESHTASTIC_DEMO_MODE=true` need a clear migration message.
- Pi 4/5 work requires verifying the gpu sidecar's `cpu` tier
  actually delivers a usable experience on a 4GB Pi — possibly
  the first concrete v3.0 task.
