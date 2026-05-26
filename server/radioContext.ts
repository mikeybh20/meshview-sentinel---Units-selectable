/**
 * v2.0 Multi-radio — per-radio context.
 *
 * Each configured radio gets one RadioContext, which owns:
 *   - the underlying RadioAdapter (transport)
 *   - per-radio in-memory caches (nodes, messages, pendingAcks)
 *   - per-radio memory caps (see [ROADMAP-v2.md](../ROADMAP-v2.md))
 *   - the radio's metadata row (RadioRow from database.ts)
 *
 * Phase 1 keeps this as a thin wrapper around the existing
 * `MeshtasticSerialBridge` singleton — there is exactly one RadioContext, the
 * `default` one, registered by BridgeManager on boot. Phase 2 will introduce
 * the second context and surface it in the UI.
 *
 * Memory caps (per [ROADMAP-v2.md](../ROADMAP-v2.md)):
 *   MAX_BUFFERED_MESSAGES_PER_RADIO = 500
 *   MAX_PENDING_ACKS_PER_RADIO      = 200
 *   nodes Map — unbounded (eviction by retention loop only; node count is
 *     naturally bounded by mesh size)
 */
import type { MeshtasticSerialBridge } from './meshtasticSerial.js';
import type { RadioRow } from './database.js';

export const MAX_BUFFERED_MESSAGES_PER_RADIO = 500;
export const MAX_PENDING_ACKS_PER_RADIO      = 200;

export class RadioContext {
  readonly radioId: string;
  meta: RadioRow;
  bridge: MeshtasticSerialBridge;

  constructor(radioId: string, meta: RadioRow, bridge: MeshtasticSerialBridge) {
    this.radioId = radioId;
    this.meta = meta;
    this.bridge = bridge;
  }

  /** Convenience: is this context's underlying transport connected? */
  get connected(): boolean {
    return this.bridge.connected;
  }

  /** Updates the cached meta row (after the radio has reported its identity). */
  updateMeta(patch: Partial<RadioRow>): void {
    this.meta = { ...this.meta, ...patch, updated_at: Date.now() };
  }
}
