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
import { meshBridge, type MeshtasticSerialBridge } from './meshtasticSerial.js';
import { meshDb, type RadioRow } from './database.js';
import { RadioContext } from './radioContext.js';

class BridgeManager {
  private contexts: Map<string, RadioContext> = new Map();
  private defaultRadioId: string | null = null;
  /** True once the default radio's identity has been observed + persisted. */
  private defaultRegistered = false;

  constructor() {
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

  list(): RadioContext[] {
    return Array.from(this.contexts.values());
  }

  get(radioId: string): RadioContext | null {
    return this.contexts.get(radioId) ?? null;
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
      created_at:      now,
      updated_at:      now,
    };

    db.upsertRadio(row);

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

    // Tell the bridge its radio_id so every upserted node carries this
    // bridge as a "heard by" entry. Backfills existing nodes too.
    bridge.setRadioId(shortName);

    console.log(`[BridgeManager] default radio registered: ${shortName} (${row.long_name}) via ${row.transport}:${row.target}`);

    // Kick off a LoRa config readback so the radios row gets stamped with
    // the firmware's real region / preset / frequency slot / hops.
    bridge.requestLoraConfig().catch(err => {
      console.warn('[BridgeManager] initial LoRa readback failed:', err?.message ?? err);
    });
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
