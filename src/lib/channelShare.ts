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

// -------- Inverse: parse a Meshtastic channel-share URL/string --------

function fromBase64Url(input: string): Uint8Array {
  // Tolerate either base64url ('-_') or standard base64 ('+/') and the
  // optional '=' padding the spec drops.
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readVarint(buf: Uint8Array, off: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (off + bytesRead < buf.length) {
    const byte = buf[off + bytesRead++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: value >>> 0, bytesRead };
}

function pskBytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Parse a Meshtastic channel-share string (full URL `https://meshtastic.org/e/#...`,
 * the short form `meshtastic.org/e/#...`, or the bare base64url payload) into
 * the channel list it encodes. Returns `null` if the input doesn't look like a
 * channel-share string at all (rather than throwing) so callers can show a
 * friendly "doesn't look right" message.
 *
 * Slot indices are assigned 0..N-1 in the order the URL lists them, matching
 * the iOS/Android behavior. Role is inferred as PRIMARY for index 0 and
 * SECONDARY for the rest. The caller is responsible for confirming with the
 * operator before writing this to the radio — channel imports overwrite the
 * existing set.
 */
export function parseChannelShareUrl(input: string): Channel[] | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  // Extract the payload after the `#`. Tolerate full URL, host-only, or raw.
  let payload: string;
  if (trimmed.includes('#')) {
    payload = trimmed.split('#').slice(1).join('#'); // everything after first '#'
  } else if (/^[A-Za-z0-9_+/=-]+$/.test(trimmed)) {
    payload = trimmed; // bare base64url body
  } else {
    return null;
  }
  if (!payload) return null;

  let buf: Uint8Array;
  try {
    buf = fromBase64Url(payload);
  } catch {
    return null;
  }

  const channels: Channel[] = [];
  let off = 0;
  // ChannelSet: repeated ChannelSettings @ field 1 (length-delimited). lora_config
  // (field 2) is intentionally ignored — we never want a shared URL to clobber
  // the receiving radio's regional/modem settings.
  while (off < buf.length) {
    const tag = buf[off++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType !== 2) {
      // Unknown wire type at the top level — skip the rest rather than fail.
      // Most fields we care about are length-delimited.
      break;
    }
    const { value: len, bytesRead } = readVarint(buf, off);
    off += bytesRead;
    const sub = buf.subarray(off, off + len);
    off += len;
    if (fieldNumber !== 1) continue; // not ChannelSettings — skip

    // Parse ChannelSettings: psk=2, name=3, uplink=5, downlink=6, module_settings=7
    let name = '';
    let pskBase64 = '';
    let uplinkEnabled = true;
    let downlinkEnabled = true;
    let positionPrecision: number | undefined;
    let so = 0;
    while (so < sub.length) {
      const sTag = sub[so++];
      const sFn = sTag >> 3;
      const sWt = sTag & 0x07;
      if (sWt === 0) {
        const { value, bytesRead: sbr } = readVarint(sub, so);
        so += sbr;
        if (sFn === 5) uplinkEnabled = !!value;
        else if (sFn === 6) downlinkEnabled = !!value;
      } else if (sWt === 2) {
        const { value: subLen, bytesRead: sbr } = readVarint(sub, so);
        so += sbr;
        const inner = sub.subarray(so, so + subLen);
        so += subLen;
        if (sFn === 2) pskBase64 = pskBytesToBase64(inner);
        else if (sFn === 3) name = new TextDecoder().decode(inner);
        else if (sFn === 7) {
          // ModuleSettings.position_precision (field 1, varint)
          let mo = 0;
          while (mo < inner.length) {
            const mTag = inner[mo++];
            const mFn = mTag >> 3;
            const mWt = mTag & 0x07;
            if (mWt === 0) {
              const { value: mv, bytesRead: mbr } = readVarint(inner, mo);
              mo += mbr;
              if (mFn === 1) positionPrecision = mv;
            } else {
              break;
            }
          }
        }
      } else {
        break;
      }
    }

    const index = channels.length;
    channels.push({
      index,
      name,
      role: index === 0 ? 'PRIMARY' : 'SECONDARY',
      pskBase64,
      uplinkEnabled,
      downlinkEnabled,
      ...(positionPrecision !== undefined ? { positionPrecision } : {}),
    });
  }

  return channels.length > 0 ? channels : null;
}
