/**
 * v2.0 Multi-radio — BridgeManager singleton.
 *
 * Owns the registry of RadioContexts and routes per-radio queries/operations.
 * Replaces the implicit "one global bridge" assumption of 1.x.
 *
 * Phase 1 behavior:
 *   - On boot, reads the radios table from the DB.
 *   - Watches the existing `meshBridge` singleton; the first time we learn
 *     the radio's local short_name, the singleton is registered as a
 *     RadioContext (either inserted as the default if no rows exist, or
 *     matched to an existing row if its short_name is already in the DB).
 *   - When the default radio is auto-inserted, runs the one-time
 *     `backfillRadioId()` so legacy 1.x rows pick up the radio_id.
 *
 * Phase 2+ will add CRUD endpoints, second-context support, and the
 * `RadioAdapter` extraction. The public `getDefault()` / `list()` API is
 * stable from Phase 1 onward — new code should use it instead of
 * importing `meshBridge` directly.
 */
import { EventEmitter } from 'events';
import { meshBridge, MeshtasticSerialBridge, type MeshNode, type MeshMessage, type MeshEvent } from './meshtasticSerial.js';
import { meshDb, type RadioRow } from './database.js';
import { RadioContext } from './radioContext.js';
import { BbsService } from './bbs.js';
import type { BbsConfig } from './bbsConfig.js';

// Bridge events the API SSE layer cares about. BridgeManager re-broadcasts
// these from every connected bridge so api.ts only has to subscribe once.
const FORWARDED_EVENTS = [
  'connected', 'disconnected', 'data', 'nodeUpdate', 'event',
  'channelUpdate', 'waypointsChanged', 'traceUpdate',
  'neighborInfoUpdate', 'storeForwardUpdate',
  'localModuleConfigUpdate', 'loraConfigUpdate',
  'networkConfigUpdate', 'powerConfigUpdate', 'cannedMessagesUpdate',
  'deviceConfigUpdate', 'positionConfigUpdate', 'displayConfigUpdate', 'bluetoothConfigUpdate',
  // v2.0.0 Web Push: 'message' carries the parsed MeshMessage object
  // so the api.ts push-dispatcher hook can fire on DM-to-local-node
  // without re-parsing the underlying packet.
  'message',
  'ackUpdate', 'bbsMail', 'bbsSubscriber',
] as const;

class BridgeManager extends EventEmitter {
  private contexts: Map<string, RadioContext> = new Map();
  private defaultRadioId: string | null = null;
  /** True once the default radio's identity has been observed + persisted. */
  private defaultRegistered = false;
  /** Track per-bridge forwarder cleanup so disconnect tears them down. */
  private forwarders: Map<string, Array<() => void>> = new Map();
  /** Shared BBS config applied to every BbsService instance. api.ts pushes
   *  updates here whenever the operator saves new BBS settings. */
  private bbsConfig: BbsConfig | null = null;

  constructor() {
    super();
    // Pre-load any radios already in the DB (Phase 2+ will have rows here).
    const rows = meshDb().listRadios();
    for (const row of rows) {
      if (row.is_default) this.defaultRadioId = row.radio_id;
    }

    // Watch the singleton for its first identity reveal. The bridge emits
    // 'nodeUpdate' for every node it learns about — we wait for the local
    // one (`bridge.getLocalNodeId()` matches the updated node's id).
    meshBridge.on('nodeUpdate', () => this.tryAutoRegisterDefault(meshBridge));
    meshBridge.on('connected', () => this.tryAutoRegisterDefault(meshBridge));

    // After a LoRa config readback lands, update the cached radios row so
    // Settings → Radios stays in lockstep with the firmware's authoritative
    // state. Triggered the first time after auto-registration kicks off the
    // readback, then again on every successful read.
    meshBridge.on('loraConfigUpdate', (snap) => this.applyLoraReadback(snap));

    // Forward every event the singleton emits so api.ts only has to
    // subscribe to BridgeManager instead of every bridge instance.
    this.attachForwarders('__default__', meshBridge);
  }

  /**
   * Re-broadcast every interesting event from `bridge` through this
   * EventEmitter, prefixing the event name with no change (keeps the
   * existing SSE contract) and adding `radio_id` as a trailing arg so
   * subscribers know which bridge fired it.
   */
  private attachForwarders(label: string, bridge: MeshtasticSerialBridge): void {
    const handlers: Array<() => void> = [];
    for (const evt of FORWARDED_EVENTS) {
      const handler = (...args: any[]) => {
        const rid = bridge.getRadioId();
        this.emit(evt, ...args, rid);
      };
      bridge.on(evt, handler);
      handlers.push(() => bridge.off(evt, handler));
    }
    this.forwarders.set(label, handlers);
  }

  private detachForwarders(label: string): void {
    const tears = this.forwarders.get(label);
    if (!tears) return;
    for (const t of tears) t();
    this.forwarders.delete(label);
  }

  /** v2.0: create + wire a BbsService for the given context's bridge. The
   *  service is stamped with the context's radio_id so every mail insert /
   *  weather subscription routes to the right radio's row.
   */
  private attachBbs(ctx: RadioContext): void {
    const svc = new BbsService(ctx.bridge);
    svc.setRadioId(ctx.radioId);
    if (this.bbsConfig) svc.setConfig(this.bbsConfig);
    // v2.0 Beta 4: per-radio BBS-only mode. Pulled from the radios row's
    // bbs_only column so the operator's preference (set via the Radios UI)
    // survives across reconnects. updateRadioBbsOnly() below re-applies it
    // at runtime when the operator toggles.
    svc.setBbsOnlyMode(!!ctx.meta.bbs_only);
    // v2.0 Beta 5 Phase 2 (Services Pattern): mark THIS bridge's
    // BbsService as the install's BBS service node if the radios row
    // says so. Only this BbsService's isCommand() returns true; other
    // bridges' BBSes stay inert. refreshBbsServiceFlags below
    // recomputes this across all contexts when the operator picks a
    // different BBS radio at runtime.
    svc.setIsBbsServiceNode(!!ctx.meta.is_bbs_node);
    ctx.bridge.setBbs(svc);
    ctx.bbs = svc;
  }

  /**
   * Re-read radios.is_bbs_node for every connected radio and set the
   * matching BbsService flag. Called from the API endpoint that
   * changes the BBS designation so the gate flips instantly without
   * a reconnect.
   *
   * Idempotent — safe to call after every setBbsNodeRadio.
   */
  refreshBbsServiceFlags(): void {
    const designated = meshDb().getBbsNodeRadioId();
    for (const ctx of this.contexts.values()) {
      ctx.bbs?.setIsBbsServiceNode(ctx.radioId === designated);
    }
  }

  /** v2.0 Beta 4: flip the bbs-only flag on an already-attached radio.
   *  Updates the in-memory BbsService + the cached meta on RadioContext so
   *  a subsequent listRadios()/getRadio() reflects the change. The DB
   *  write happens in the API layer. */
  updateRadioBbsOnly(radioId: string, on: boolean): boolean {
    const ctx = this.contexts.get(radioId);
    if (!ctx) return false;
    ctx.bbs?.setBbsOnlyMode(on);
    ctx.meta = { ...ctx.meta, bbs_only: on ? 1 : 0 };
    return true;
  }

  /** api.ts calls this once on boot + on every BBS settings save. */
  setBbsConfig(cfg: BbsConfig): void {
    this.bbsConfig = cfg;
    for (const ctx of this.contexts.values()) {
      ctx.bbs?.setConfig(cfg);
    }
  }

  /** Get the BBS service for a specific radio (null if not connected). */
  getBbs(radioId: string): BbsService | null {
    return this.contexts.get(radioId)?.bbs ?? null;
  }

  /**
   * v2.0 Beta 5 Phase 2 (Services Pattern): return the context for the
   * radio currently designated as the BBS service node (radios.
   * is_bbs_node = 1). Used by:
   *   - meshtasticSerial TEXT handler to gate BBS command interception
   *     (only this bridge invokes BbsService.handleInboundDm)
   *   - WeatherAlertPoller to route alerts + the daily forecast push
   *     through this bridge specifically
   *
   * Returns null when no BBS node is designated (admin hasn't picked
   * one yet, OR they explicitly cleared the designation). In that
   * state BBS commands are silently ignored — `:mail` lands as a
   * plain DM, the weather poller skips its tick.
   */
  getBbsNode(): RadioContext | null {
    const radioId = meshDb().getBbsNodeRadioId();
    if (!radioId) return null;
    return this.contexts.get(radioId) ?? null;
  }

  /** Bridge form of getBbsNode() — convenience for the (very common)
   *  case of "give me the bridge to route through, or null." */
  getBbsNodeBridge(): MeshtasticSerialBridge | null {
    return this.getBbsNode()?.bridge ?? null;
  }

  private applyLoraReadback(snap: { region: number; modemPreset: number; frequencySlot: number; hopLimit: number }): void {
    const id = this.defaultRadioId;
    if (!id) return;
    const ctx = this.contexts.get(id);
    if (!ctx) return;

    const region        = REGION_LABELS[snap.region]       ?? null;
    const modem_preset  = MODEM_PRESET_LABELS[snap.modemPreset] ?? null;
    const frequency_slot = snap.frequencySlot;
    const num_hops      = snap.hopLimit;

    // No-op if nothing changed (avoid pointless DB writes).
    if (
      ctx.meta.region === region &&
      ctx.meta.modem_preset === modem_preset &&
      ctx.meta.frequency_slot === frequency_slot &&
      ctx.meta.num_hops === num_hops
    ) return;

    ctx.updateMeta({ region, modem_preset, frequency_slot, num_hops });
    meshDb().upsertRadio(ctx.meta);
    console.log(`[BridgeManager] radio ${id} meta updated from LoRa readback: region=${region} preset=${modem_preset} slot=${frequency_slot} hops=${num_hops}`);
  }

  /**
   * Returns the current default radio's context, or null if no radio has
   * been registered yet (transient state on cold boot before the radio's
   * identity packet has arrived).
   */
  getDefault(): RadioContext | null {
    if (!this.defaultRadioId) return null;
    return this.contexts.get(this.defaultRadioId) ?? null;
  }

  /** ID of the default radio (4-char short_name), or null. */
  getDefaultRadioId(): string | null {
    return this.defaultRadioId;
  }

  /**
   * v2.0 Beta 5 Radios (fix): wipe the cached default so a subsequent
   * identity exchange (next time the singleton bridge receives
   * MyNodeInfo) can claim primary freely.
   *
   * Called from the radios DELETE endpoint when the operator deletes a
   * DISCONNECTED row that happens to be the cached default. Without
   * this, defaultRadioId would point at a row that no longer exists in
   * the DB, and the next auto-register would refuse to write because
   * `defaultRegistered` is still true. Result: silently-dead default
   * pointer, no live primary, surprises operator on the next reconnect.
   *
   * Safe to call when there's no live singleton: tryAutoRegisterDefault
   * is idempotent and will re-arm next time it sees an identity packet.
   */
  clearDefault(): void {
    if (this.defaultRadioId) {
      console.log(`[BridgeManager] clearing cached default radio_id="${this.defaultRadioId}"`);
    }
    this.defaultRadioId = null;
    this.defaultRegistered = false;
  }

  list(): RadioContext[] {
    return Array.from(this.contexts.values());
  }

  get(radioId: string): RadioContext | null {
    return this.contexts.get(radioId) ?? null;
  }

  /**
   * v2.0 Beta 4: rebind the singleton bridge to a new TCP endpoint while
   * keeping BridgeManager.contexts coherent.
   *
   * Replaces the old "just call meshBridge.connectTcp() and hope for the
   * best" path that the legacy /api/mesh/connect/tcp endpoint was using.
   * Symptoms of that bug class: the snapshot endpoint returns one radio's
   * channels while /api/mesh/channels?radio_id=X returns another's,
   * because meshBridge's actual identity diverged from
   * contexts[defaultRadioId].bridge over a reconnect cycle.
   *
   * What this does, in order:
   *   1. Disconnects whatever transport meshBridge currently holds.
   *   2. Deletes the stale default context (so the identity exchange
   *      after step 3 produces a fresh entry).
   *   3. Resets defaultRegistered so tryAutoRegisterDefault fires.
   *   4. Reconnects meshBridge to the new (host, port).
   *
   * The natural follow-up flow (nodeUpdate → tryAutoRegisterDefault →
   * setRadioId → contexts.set) then re-establishes a clean default
   * context with the right radio_id, matching the actual transport.
   */
  async rebindSingletonTcp(host: string, port: number): Promise<void> {
    try { await meshBridge.disconnect(); } catch { /* best-effort */ }
    if (this.defaultRadioId) {
      this.contexts.delete(this.defaultRadioId);
    }
    this.defaultRadioId = null;
    this.defaultRegistered = false;
    await meshBridge.connectTcp(host, port);
    // tryAutoRegisterDefault runs on the next nodeUpdate / connected event;
    // the singleton-on-event listeners attached in this class's constructor
    // (line 62-63) keep firing across reconnects, so no rewiring needed.
  }

  /**
   * One-shot: when the singleton bridge knows its local node id + short_name,
   * register/refresh the corresponding RadioContext. Idempotent — safe to call
   * on every event emission.
   */
  private tryAutoRegisterDefault(bridge: MeshtasticSerialBridge): void {
    if (this.defaultRegistered) return;

    const localId = bridge.getLocalNodeId();
    if (!localId) return;

    const localNode = bridge.getNodes().find(n => n.id === localId);
    const shortName = localNode?.shortName;
    if (!shortName) return;  // Identity not yet known — wait for next event.

    const db = meshDb();
    const existingRow = db.getRadio(shortName);
    const now = Date.now();

    const t = bridge.getTransport();
    const row: RadioRow = existingRow ?? {
      radio_id:        shortName,
      long_name:       localNode?.name ?? shortName,
      transport:       (t.mode === 'tcp' ? 'tcp' : 'serial') as 'serial' | 'tcp',
      target:          this.guessTarget(bridge),
      region:          null,
      modem_preset:    null,
      frequency_slot:  null,
      primary_channel: null,
      num_hops:        3,
      enabled:         1,
      color_hex:       null,
      network_label:   null,
      is_default:      1,
      bbs_only:        0,
      // is_bbs_node: never auto-set on radio creation. Operator
      // explicitly picks one in Settings → BBS. Default off keeps the
      // install consistent across radio-add events.
      is_bbs_node:     0,
      // workspace_id left NULL — bootstrapWorkspaces() (called from
      // MeshDb's constructor on every boot) backfills any unassigned
      // radio to the Household workspace. New radios spawned post-boot
      // get assigned via the same backfill on the next constructor pass,
      // or explicitly by an admin via setRadioWorkspace().
      workspace_id:    null,
      created_at:      now,
      updated_at:      now,
    };

    db.upsertRadio(row);
    // v2.0 Beta 5 Workspaces: backfill workspace assignment for a
    // brand-new radio so it shows up in the Household workspace right
    // away rather than waiting for the next boot's bootstrapWorkspaces.
    if (!existingRow) {
      const firstWs = db.listWorkspaces()[0];
      if (firstWs) db.setRadioWorkspace(shortName, firstWs.id);
      // v2.0 Beta 5 Radios (logging): surface the auto-register event in
      // the same [Radios] stream as explicit Add/Edit/Delete actions so
      // grepping `docker logs | grep '[Radios]'` answers "where did this
      // row come from?" — previously the auto-register was invisible to
      // anyone but a code reader, and operators kept hitting "already
      // exists" on Add Radio without realizing the system had inserted
      // the row for them on first identity exchange.
      const wsName = firstWs?.name ?? 'no workspace';
      console.log(`[Radios] AUTO_REGISTER radio_id="${shortName}" by user=<singleton-identity> target="${row.transport}:${row.target}" assigned_workspace="${wsName}" long_name="${row.long_name}"`);
    }

    // If this is the first radio ever (no rows previously), backfill legacy
    // NULL radio_id rows to attribute the 1.x data to this radio.
    if (!existingRow) {
      const backfill = db.backfillRadioId(shortName);
      const summary = Object.entries(backfill).map(([t, n]) => `${t}=${n}`).join(', ');
      if (summary) {
        console.log(`[BridgeManager] backfilled radio_id=${shortName} on legacy rows: ${summary}`);
      } else {
        console.log(`[BridgeManager] registered first radio ${shortName} (no legacy rows to backfill)`);
      }
    }

    const ctx = new RadioContext(shortName, row, bridge);
    this.contexts.set(shortName, ctx);
    this.defaultRadioId = shortName;
    this.defaultRegistered = true;

    // v2.0 bugfix: ensure the DB's is_default reflects the auto-connected
    // radio. Without this, hot-swapping radios leaves the DB column pinned
    // to the original default, causing spawnSecondary to refuse legitimate
    // Connect requests on the previously-default radio.
    if (!row.is_default) {
      meshDb().setDefaultRadio(shortName);
      ctx.meta = { ...ctx.meta, is_default: 1 };
    }

    // Tell the bridge its radio_id so every upserted node carries this
    // bridge as a "heard by" entry. Backfills existing nodes too.
    bridge.setRadioId(shortName);

    // v2.0: spin up a per-radio BbsService and wire it to the bridge.
    this.attachBbs(ctx);

    console.log(`[BridgeManager] default radio registered: ${shortName} (${row.long_name}) via ${row.transport}:${row.target}`);

    // Kick off a LoRa config readback so the radios row gets stamped with
    // the firmware's real region / preset / frequency slot / hops.
    bridge.requestLoraConfig().catch(err => {
      console.warn('[BridgeManager] initial LoRa readback failed:', err?.message ?? err);
    });
    // v2.0 Beta 2: also ask for Network + Power configs + canned messages so
    // the Radios view + quick-send palette have them on first paint without
    // the operator clicking Refresh.
    bridge.requestNetworkConfig().catch(() => {});
    bridge.requestPowerConfig().catch(() => {});
    bridge.requestCannedMessages().catch(() => {});
    // v2.0 Beta 3: Device / Position / Display / Bluetooth config readback.
    bridge.requestDeviceConfig().catch(() => {});
    bridge.requestPositionConfig().catch(() => {});
    bridge.requestDisplayConfig().catch(() => {});
    bridge.requestBluetoothConfig().catch(() => {});
  }

  private guessTarget(bridge: MeshtasticSerialBridge): string {
    // The bridge doesn't expose its current target directly today; Phase 2
    // will surface this via a RadioAdapter API. For now, use whatever the
    // current transport object tells us.
    const t = bridge.getTransport();
    if (t.mode === 'tcp' && t.tcp) return `${t.tcp.host}:${t.tcp.port}`;
    if (t.mode === 'serial' && t.serial) return t.serial.port;
    return 'auto';
  }

  // -------------------------------------------------------------------
  // v2.0 Phase 3b: secondary-bridge spawn / connect / disconnect.
  //
  // The default radio (the auto-discovered hardware Sentinel boots with) is
  // managed by the singleton `meshBridge`. Secondary radios are explicitly
  // configured by the operator via Settings → Radios and connected here.
  //
  // Lifecycle:
  //   spawn(radioId)      → creates a new bridge instance + connects its
  //                         transport + sets radioId + registers a context
  //   disconnectRadio(id) → tears down the transport and removes the context
  //
  // The default radio's row never goes through spawn(); it auto-registers in
  // tryAutoRegisterDefault(). spawn() refuses to operate on the default id.
  // -------------------------------------------------------------------

  async spawnSecondary(radioId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = meshDb().getRadio(radioId);
    if (!row) return { ok: false, error: `radio "${radioId}" not found` };
    // v2.0 Beta 3 bugfix: gate on the singleton bridge's *registered* radio
    // id (post-identity) rather than `this.defaultRadioId` (DB `is_default`).
    //
    // Why this matters: at boot, `this.defaultRadioId` is initialised from
    // the DB. The singleton, meanwhile, gets whichever port SerialDiscovery
    // finds first — which may NOT match the DB's default row. Until identity
    // exchange completes, the two diverge. Gating on `this.defaultRadioId`
    // would then refuse spawn for the DB-default radio even though the
    // singleton is physically on a different port. The target-collision
    // check below catches the actually-conflicting case independently.
    //
    // `meshBridge.getRadioId()` returns the singleton's confirmed radio_id
    // once `tryAutoRegisterDefault` has run (i.e., after identity arrived),
    // and null before that — so we only refuse once we're sure the singleton
    // really is serving this radio.
    const singletonRadio = meshBridge.getRadioId();
    if (singletonRadio && radioId === singletonRadio) {
      return { ok: false, error: `"${radioId}" is the currently auto-connected default radio (held by the singleton bridge)` };
    }
    if (this.contexts.has(radioId)) return { ok: false, error: `radio "${radioId}" is already connected` };
    if (row.transport === 'ble') return { ok: false, error: 'BLE transport not yet implemented' };

    // v2.0 Beta 3 bugfix: target-collision detection.
    //
    // A pre-fix Connect call against a radio whose row points at the same
    // physical port the singleton bridge already holds would spawn a second
    // bridge here, fail open() with EAGAIN forever, and leave the operator
    // staring at "Cannot lock port" with no path forward. This commonly
    // happens after auto-discovery: SerialDiscovery picks whichever tty
    // enumerates first (often /dev/ttyACM0), the singleton claims it, and
    // the DB row for the OTHER registered radio also has that same target —
    // either because both radios share a target slot historically, or
    // because the operator hadn't updated targets after re-flashing /
    // moving cables.
    //
    // Refuse early and tell the operator what to do instead. "Make Primary"
    // is the hot-swap path — disconnects the current singleton and rebinds
    // it to the requested radio's transport.
    const singletonTarget = this.guessTarget(meshBridge);
    if (meshBridge.connected && singletonTarget && singletonTarget === row.target) {
      const held = this.defaultRadioId ?? 'the default radio';
      return {
        ok: false,
        error: `target "${row.target}" is already held by "${held}" (the singleton bridge). Use Make Primary on "${radioId}" to hot-swap which radio owns this port.`,
      };
    }
    for (const [otherId, otherCtx] of this.contexts) {
      if (otherId === radioId) continue;
      const otherTarget = this.guessTarget(otherCtx.bridge);
      if (otherCtx.bridge.connected && otherTarget && otherTarget === row.target) {
        return {
          ok: false,
          error: `target "${row.target}" is already held by radio "${otherId}". Disconnect that one first, or update "${radioId}" to a different target.`,
        };
      }
    }

    const bridge = new MeshtasticSerialBridge();
    try {
      if (row.transport === 'tcp') {
        const { host, port } = parseTcpTarget(row.target);
        await bridge.connectTcp(host, port);
      } else {
        await bridge.connect(row.target); // serial path
      }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'connect failed' };
    }

    bridge.setRadioId(radioId);
    const ctx = new RadioContext(radioId, row, bridge);
    this.contexts.set(radioId, ctx);
    this.attachForwarders(radioId, bridge);
    this.attachBbs(ctx);

    // Wire LoRa-readback so the secondary's row gets stamped with its
    // firmware's authoritative state when it arrives. Logs the apply step
    // for parity with the default radio's applyLoraReadback() path.
    bridge.on('loraConfigUpdate', (snap) => {
      const region        = REGION_LABELS[snap.region]       ?? null;
      const modem_preset  = MODEM_PRESET_LABELS[snap.modemPreset] ?? null;
      // No-op if nothing changed (avoid pointless DB writes + log spam).
      if (
        ctx.meta.region === region &&
        ctx.meta.modem_preset === modem_preset &&
        ctx.meta.frequency_slot === snap.frequencySlot &&
        ctx.meta.num_hops === snap.hopLimit
      ) return;
      ctx.updateMeta({ region, modem_preset, frequency_slot: snap.frequencySlot, num_hops: snap.hopLimit });
      meshDb().upsertRadio(ctx.meta);
      console.log(`[BridgeManager] radio ${radioId} meta updated from LoRa readback: region=${region} preset=${modem_preset} slot=${snap.frequencySlot} hops=${snap.hopLimit}`);
    });

    // v2.0 bugfix: don't fire requestLoraConfig() immediately — at this
    // point the transport is open but the radio hasn't yet sent its local
    // NodeInfo, so bridge.localNodeNum is still 0 and requestLoraConfig
    // silently returns without sending. Defer until the first nodeUpdate
    // where identity is known; deregister the listener after the first
    // successful trigger so we don't request on every node update.
    const fireOnIdentityKnown = () => {
      if (!bridge.getLocalNodeId()) return;
      bridge.off('nodeUpdate', fireOnIdentityKnown);
      bridge.requestLoraConfig().catch(err => {
        console.warn(`[BridgeManager] LoRa readback failed for ${radioId}:`, err?.message ?? err);
      });
      // v2.0 Beta 2: same Network + Power + canned-message readbacks as the
      // default radio path.
      bridge.requestNetworkConfig().catch(() => {});
      bridge.requestPowerConfig().catch(() => {});
      bridge.requestCannedMessages().catch(() => {});
      // v2.0 Beta 3: Device / Position / Display / Bluetooth config readback.
      bridge.requestDeviceConfig().catch(() => {});
      bridge.requestPositionConfig().catch(() => {});
      bridge.requestDisplayConfig().catch(() => {});
      bridge.requestBluetoothConfig().catch(() => {});
    };
    bridge.on('nodeUpdate', fireOnIdentityKnown);

    console.log(`[BridgeManager] secondary radio ${radioId} connected via ${row.transport}:${row.target}`);
    return { ok: true };
  }

  /**
   * v2.0 Beta 2: hot-swap which radio is the singleton bridge. Disconnects
   * the current singleton, releases the target radio's secondary bridge (if
   * connected as a secondary), and reconnects meshBridge to the target's
   * transport. The new radio's NodeInfo will fire tryAutoRegisterDefault on
   * arrival and promote it to the runtime default. The previous singleton
   * is left disconnected; the operator can click Connect on its row to
   * re-attach it as a secondary.
   *
   * Replaces the old "Set Default" which only flipped a DB column without
   * actually affecting which radio held the singleton bridge.
   */
  async promoteToSingleton(radioId: string): Promise<{ ok: true; previousSingleton?: string } | { ok: false; error: string }> {
    const row = meshDb().getRadio(radioId);
    if (!row) return { ok: false, error: `radio "${radioId}" not found` };
    if (radioId === this.defaultRadioId) return { ok: true };
    if (row.transport === 'ble') return { ok: false, error: 'BLE transport not supported' };

    const previousSingleton = this.defaultRadioId;

    // 1. If the target is currently connected as a secondary, tear that
    //    bridge down so its serial port (or TCP socket) is free for the
    //    singleton's connect call to grab.
    if (this.contexts.has(radioId) && radioId !== previousSingleton) {
      const ctx = this.contexts.get(radioId)!;
      try { await ctx.bridge.disconnect(); } catch { /* best-effort */ }
      this.detachForwarders(radioId);
      this.contexts.delete(radioId);
    }

    // 2. Disconnect the current singleton (frees its serial port too, in
    //    case promotion is happening in the opposite direction next).
    try { await meshBridge.disconnect(); } catch { /* best-effort */ }
    if (previousSingleton) {
      // Remove the old singleton's context entry so the radios list and
      // /api/mesh/radios/connections both stop reporting it as connected
      // until the operator chooses to re-spawn it as a secondary.
      this.contexts.delete(previousSingleton);
    }

    // 3. Reset the singleton-registration latches so tryAutoRegisterDefault
    //    fires fresh for the new radio's NodeInfo arrival.
    this.defaultRadioId = null;
    this.defaultRegistered = false;

    // 4. Reconnect the singleton bridge to the new target.
    try {
      if (row.transport === 'tcp') {
        const { host, port } = parseTcpTarget(row.target);
        await meshBridge.connectTcp(host, port);
      } else {
        await meshBridge.connect(row.target);
      }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'singleton reconnect failed' };
    }

    console.log(`[BridgeManager] promoted ${radioId} to singleton; previous = ${previousSingleton ?? '<none>'}`);
    return { ok: true, previousSingleton: previousSingleton ?? undefined };
  }

  async disconnectRadio(radioId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (radioId === this.defaultRadioId) {
      return { ok: false, error: 'cannot disconnect the default radio from here — use the Connection panel' };
    }
    const ctx = this.contexts.get(radioId);
    if (!ctx) return { ok: false, error: `radio "${radioId}" is not connected` };
    try {
      await ctx.bridge.disconnect();
    } catch { /* best-effort */ }
    this.detachForwarders(radioId);
    this.contexts.delete(radioId);
    console.log(`[BridgeManager] radio ${radioId} disconnected`);
    return { ok: true };
  }

  /**
   * Per-radio connection state, for the UI. Default radio always present
   * even before its identity arrives. v2.0 Beta 2: includes radio health
   * fields (firmware, reboot count, battery, voltage) so the Radios view
   * can render a compact health summary per row without a separate fetch.
   */
  connectionStates(): Record<string, {
    connected: boolean;
    transport: 'serial' | 'tcp' | 'ble' | null;
    firmwareVersion: string | null;
    rebootCount: number | null;
    battery: number | null;
    voltage: number | null;
    localNodeId: string | null;
  }> {
    const out: Record<string, {
      connected: boolean;
      transport: 'serial' | 'tcp' | 'ble' | null;
      firmwareVersion: string | null;
      rebootCount: number | null;
      battery: number | null;
      voltage: number | null;
      localNodeId: string | null;
    }> = {};
    for (const ctx of this.contexts.values()) {
      // Pull battery/voltage off the local node's latest telemetry. Both
      // Heltec V3 and V4 report these via the firmware's battery_level
      // pin (GPIO 37 on V3, similar on V4). Boards without monitoring
      // return null.
      const localId = ctx.bridge.getLocalNodeId();
      const localNode = localId ? ctx.bridge.getNodes().find(n => n.id === localId) : undefined;
      out[ctx.radioId] = {
        connected:       ctx.bridge.connected,
        transport:       (ctx.meta.transport as 'serial' | 'tcp' | 'ble') ?? null,
        firmwareVersion: ctx.bridge.getLocalFirmwareVersion(),
        rebootCount:     ctx.bridge.getLocalRebootCount(),
        battery:         localNode?.telemetry?.battery ?? null,
        voltage:         localNode?.telemetry?.voltage ?? null,
        localNodeId:     localId,
      };
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Aggregators — merge state across all connected bridges so the API and
  // UI see one unified mesh (each item retains heardByRadios so the
  // operator knows attribution). Currently only nodes need merging; messages
  // and events are inherently per-radio (each row originated at one radio)
  // so the API can either return them all or filter on radio_id.
  // -------------------------------------------------------------------

  /**
   * Returns nodes seen by any connected bridge, deduplicated by node id.
   * When the same node appears in multiple bridges, the more recently
   * heard observation wins (by lastSeen), and heardByRadios is unioned.
   */
  getAllNodes(): MeshNode[] {
    const merged = new Map<string, MeshNode>();
    for (const ctx of this.contexts.values()) {
      for (const n of ctx.bridge.getNodes()) {
        const existing = merged.get(n.id);
        if (!existing) {
          merged.set(n.id, n);
          continue;
        }
        // Pick the more recent observation as the base
        const base = (n.lastSeen ?? 0) >= (existing.lastSeen ?? 0) ? n : existing;
        const other = base === n ? existing : n;
        const unionHeard = unionOrdered(base.heardByRadios ?? [], other.heardByRadios ?? []);
        const unionAt: Record<string, number> = { ...(other.lastHeardAtPerRadio ?? {}) };
        for (const [k, v] of Object.entries(base.lastHeardAtPerRadio ?? {})) {
          unionAt[k] = Math.max(unionAt[k] ?? 0, v);
        }
        merged.set(n.id, {
          ...base,
          heardByRadios: unionHeard,
          lastHeardAtPerRadio: unionAt,
          online: base.online || other.online,
        });
      }
    }
    return Array.from(merged.values());
  }

  /** Concatenated messages from every connected bridge, newest first, deduped by id. */
  getAllMessages(): MeshMessage[] {
    const map = new Map<string, MeshMessage>();
    for (const ctx of this.contexts.values()) {
      for (const m of ctx.bridge.getMessages()) {
        if (!map.has(m.id)) map.set(m.id, m);
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }

  /** Concatenated events from every connected bridge, newest first, deduped by id. */
  getAllEvents(): MeshEvent[] {
    const map = new Map<string, MeshEvent>();
    for (const ctx of this.contexts.values()) {
      for (const e of ctx.bridge.getEvents()) {
        if (!map.has(e.id)) map.set(e.id, e);
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }
}

// Helper: union-keep-order. First arg wins for duplicates.
function unionOrdered(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...a, ...b]) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

// Helper: split "host:port" into typed parts. Accepts plain host (port=4403).
function parseTcpTarget(target: string): { host: string; port: number } {
  const t = target.trim();
  const m = t.match(/^(.+?):(\d+)$/);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: t, port: 4403 };
}

/**
 * v2.0 Phase 2 polish: dry-run connect that opens a transient bridge against
 * the given transport+target, waits up to `timeoutMs` for the radio's identity
 * (its User config carries short_name + long_name), then tears down. Used by:
 *   - Add Radio "Detect Identity" auto-fill
 *   - Edit Radio "Test Connection" button
 *
 * Never persists state; the temporary bridge is created outside BridgeManager
 * so it doesn't pollute the contexts map.
 */
export async function testTransportConnection(opts: {
  transport: 'serial' | 'tcp';
  target: string;
  timeoutMs?: number;
}): Promise<{
  ok: true;
  identity?: { shortName: string; longName: string; nodeId: string };
  lora?: { region: number; modemPreset: number; frequencySlot: number; hopLimit: number };
} | { ok: false; error: string }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const bridge = new MeshtasticSerialBridge();
  let identity: { shortName: string; longName: string; nodeId: string } | undefined;
  let lora: { region: number; modemPreset: number; frequencySlot: number; hopLimit: number } | undefined;

  // Resolve as soon as we have identity (lora is best-effort within the window).
  const identityResolved = new Promise<void>((resolve) => {
    const handler = () => {
      const localId = bridge.getLocalNodeId();
      if (!localId) return;
      const node = bridge.getNodes().find(n => n.id === localId);
      if (!node?.shortName) return;
      identity = { shortName: node.shortName, longName: node.name ?? '', nodeId: localId };
      resolve();
    };
    bridge.on('nodeUpdate', handler);
  });
  const loraResolved = new Promise<void>((resolve) => {
    bridge.on('loraConfigUpdate', (snap: any) => {
      lora = {
        region: snap.region, modemPreset: snap.modemPreset,
        frequencySlot: snap.frequencySlot, hopLimit: snap.hopLimit,
      };
      resolve();
    });
  });

  const tearDown = async () => { try { await bridge.disconnect(); } catch { /* ignore */ } };

  try {
    if (opts.transport === 'tcp') {
      const { host, port } = parseTcpTarget(opts.target);
      await bridge.connectTcp(host, port);
    } else {
      await bridge.connect(opts.target);
    }
  } catch (err: any) {
    await tearDown();
    return { ok: false, error: err?.message ?? 'connect failed' };
  }

  // Try to get a LoRa readback alongside identity (best-effort).
  bridge.requestLoraConfig().catch(() => {});

  // Wait for identity OR timeout.
  const timer = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), timeoutMs));
  const winner = await Promise.race([identityResolved.then(() => 'identity' as const), timer]);
  // Give LoRa readback a little extra time after identity if it hasn't arrived yet.
  if (winner === 'identity' && !lora) {
    const loraTimer = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), Math.min(1500, timeoutMs / 2)));
    await Promise.race([loraResolved, loraTimer]);
  }

  await tearDown();

  if (winner === 'timeout' && !identity) {
    return { ok: false, error: `connected but radio did not report its identity within ${timeoutMs}ms — wrong port or firmware unresponsive?` };
  }
  return { ok: true, identity, lora };
}

// Stringified labels for Meshtastic enums. Keep these in sync with the
// canonical config.proto values; new firmware releases occasionally add
// regions or presets so the unknown-value fallback in applyLoraReadback()
// stores null rather than a stale string.
const REGION_LABELS: Record<number, string> = {
  0: 'UNSET',
  1: 'US',
  2: 'EU_433',
  3: 'EU_868',
  4: 'CN',
  5: 'JP',
  6: 'ANZ',
  7: 'KR',
  8: 'TW',
  9: 'RU',
  10: 'IN',
  11: 'NZ_865',
  12: 'TH',
  13: 'LORA_24',
  14: 'UA_433',
  15: 'UA_868',
  16: 'MY_433',
  17: 'MY_919',
  18: 'SG_923',
  19: 'PH_433',
  20: 'PH_868',
  21: 'PH_915',
  22: 'ANZ_433',
  23: 'KZ_433',
  24: 'KZ_863',
  25: 'NP_865',
  26: 'BR_902',
};

const MODEM_PRESET_LABELS: Record<number, string> = {
  0: 'LONG_FAST',
  1: 'LONG_SLOW',
  2: 'VERY_LONG_SLOW', // deprecated in newer firmware
  3: 'MEDIUM_SLOW',
  4: 'MEDIUM_FAST',
  5: 'SHORT_SLOW',
  6: 'SHORT_FAST',
  7: 'LONG_MODERATE',
  8: 'SHORT_TURBO',
};

export const REGION_LABEL_BY_VALUE = REGION_LABELS;
export const MODEM_PRESET_LABEL_BY_VALUE = MODEM_PRESET_LABELS;

export const bridgeManager = new BridgeManager();
