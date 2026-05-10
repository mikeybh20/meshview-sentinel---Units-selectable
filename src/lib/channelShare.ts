/**
 * Build a Meshtastic channel-share URL from a list of channels.
 *
 * The URL format the official Meshtastic mobile clients share is:
 *
 *   https://meshtastic.org/e/#<base64url(ChannelSet)>
 *
 * Where `ChannelSet` is a protobuf with `settings: ChannelSettings[]` (field 1,
 * repeated) and an optional `lora_config` (field 2). We omit `lora_config` so the
 * receiving radio keeps its own region/modem settings — only channels are shared.
 *
 * `ChannelSettings` mirrors what the bridge writes via `set_channel`:
 *   field 2  psk (bytes)
 *   field 3  name (string)
 *   field 5  uplink_enabled (bool)
 *   field 6  downlink_enabled (bool)
 *   field 7  module_settings (ModuleSettings) — only emitted when position_precision is set
 *
 * The base64url alphabet is `[A-Z][a-z][0-9]-_` with no padding (Meshtastic
 * convention; padding-stripped standard base64).
 */
import { Channel } from '../types';

function encodeVarint(value: number): Uint8Array {
  const out: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
}

function tagLen(field: number, payload: Uint8Array): Uint8Array {
  return concat([new Uint8Array([(field << 3) | 2]), encodeVarint(payload.length), payload]);
}

function tagBool(field: number, value: boolean): Uint8Array {
  return new Uint8Array([(field << 3) | 0, value ? 1 : 0]);
}

function tagVarint(field: number, value: number): Uint8Array {
  return concat([new Uint8Array([(field << 3) | 0]), encodeVarint(value)]);
}

function pskFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function buildChannelSettings(ch: Channel): Uint8Array {
  const parts: Uint8Array[] = [];
  if (ch.pskBase64) {
    parts.push(tagLen(2, pskFromBase64(ch.pskBase64)));
  }
  if (ch.name) {
    parts.push(tagLen(3, new TextEncoder().encode(ch.name)));
  }
  parts.push(tagBool(5, ch.uplinkEnabled));
  parts.push(tagBool(6, ch.downlinkEnabled));
  if (typeof ch.positionPrecision === 'number') {
    const moduleSettings = tagVarint(1, Math.max(0, Math.min(32, Math.floor(ch.positionPrecision))));
    parts.push(tagLen(7, moduleSettings));
  }
  return concat(parts);
}

function buildChannelSet(channels: Channel[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const ch of channels) {
    parts.push(tagLen(1, buildChannelSettings(ch)));
  }
  return concat(parts);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const std = btoa(bin);
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the Meshtastic-compatible share URL for the given channels.
 *
 * Pass only channels you want to share (typically all `role !== 'DISABLED'`).
 * The receiving app will prompt the operator before applying the channel set.
 */
export function buildChannelShareUrl(channels: Channel[]): string {
  const set = buildChannelSet(channels);
  return `https://meshtastic.org/e/#${toBase64Url(set)}`;
}
