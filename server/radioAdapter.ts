/**
 * v2.0 Multi-radio — transport abstraction.
 *
 * Every radio (whether serial, TCP, or future BLE) presents the same shape
 * to the rest of the app: a connection lifecycle, a packet emitter, a way
 * to send admin/data, and identity metadata.
 *
 * Phase 1 ships the interface only. The existing `MeshtasticSerialBridge`
 * class in [meshtasticSerial.ts](./meshtasticSerial.ts) already implements
 * a superset of this shape; later phases will extract the per-radio state
 * into RadioContext and have RadioContext own one RadioAdapter per radio.
 */
import type { EventEmitter } from 'events';

export type RadioTransport = 'serial' | 'tcp' | 'ble';

export interface RadioAdapterTarget {
  transport: RadioTransport;
  /** Serial: device path (/dev/ttyUSB0). TCP: host:port. BLE: MAC or UUID. */
  target: string;
}

export interface RadioAdapterIdentity {
  /** 4-char Meshtastic short_name — the canonical `radio_id`. */
  shortName: string;
  longName: string;
  nodeNumHex: string;
  firmwareVersion?: string;
}

/**
 * Minimal contract a radio adapter must satisfy. The current bridge satisfies
 * this implicitly via structural typing; Phase 2+ will refactor it into a
 * formal implementor.
 */
export interface RadioAdapter extends EventEmitter {
  readonly target: RadioAdapterTarget;

  /** True once the underlying transport handshake completes. */
  readonly connected: boolean;

  /** Identity, populated after the radio's User config is received. */
  identity(): RadioAdapterIdentity | null;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /**
   * Refresh the radio's node DB (request NodeInfo + Config). Equivalent of the
   * dashboard's existing Refresh button, scoped to this radio.
   */
  refreshNodeDb(): void;
}

/** Adapter constructor signature each transport module exports. */
export type RadioAdapterFactory = (target: RadioAdapterTarget) => RadioAdapter;
