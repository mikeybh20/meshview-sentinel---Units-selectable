/**
 * Lightweight deep-link handling for the app.
 *
 * Two URL forms are recognised:
 *
 *   1. Contact import:   /#v/<urlsafe-b64 SharedContact>
 *      Mirrors the official meshtastic.org/v/# fragment. When the app loads
 *      with this fragment, we parse the contact and surface it for import.
 *
 *   2. Chat shortcut:    /#chat=<!hex>     or   /#chat=chan:<n>
 *      Opens the messages tab with that conversation active.
 *
 * The handler returns a typed result; the caller (App.tsx) dispatches it.
 */

export type DeepLink =
  | { type: 'contact'; nodeId: string; nodeNum: number; longName: string; shortName: string; publicKey?: string }
  | { type: 'chat'; chatId: string }
  | null;

function base64UrlDecode(s: string): Uint8Array | null {
  try {
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function readVarint(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value, bytesRead };
}

function nodeNumToHex(num: number): string {
  return `!${num.toString(16).padStart(8, '0')}`;
}

/** Parse a SharedContact protobuf into a plain object. */
function parseSharedContact(buf: Uint8Array): {
  nodeNum: number; nodeId: string; longName: string; shortName: string; publicKey?: string;
} | null {
  let nodeNum = 0;
  let userBuf: Uint8Array | null = null;
  let offset = 0;

  while (offset < buf.length) {
    const tag = buf[offset++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      const { value, bytesRead } = readVarint(buf, offset);
      offset += bytesRead;
      if (fieldNumber === 1) nodeNum = value >>> 0;
    } else if (wireType === 2) {
      const { value: len, bytesRead } = readVarint(buf, offset);
      offset += bytesRead;
      if (offset + len > buf.length) return null;
      if (fieldNumber === 2) userBuf = buf.subarray(offset, offset + len);
      offset += len;
    } else {
      return null;
    }
  }

  if (!userBuf || !nodeNum) return null;

  // Parse User submessage
  let id = '';
  let longName = '';
  let shortName = '';
  let publicKey: string | undefined;
  let uo = 0;
  while (uo < userBuf.length) {
    const tag = userBuf[uo++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) {
      const { value: len, bytesRead } = readVarint(userBuf, uo);
      uo += bytesRead;
      const slice = userBuf.subarray(uo, uo + len);
      uo += len;
      if (fieldNumber === 1) id = new TextDecoder().decode(slice);
      else if (fieldNumber === 2) longName = new TextDecoder().decode(slice);
      else if (fieldNumber === 3) shortName = new TextDecoder().decode(slice);
      else if (fieldNumber === 8) {
        // base64-encode bytes for storage
        let binary = '';
        for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
        publicKey = btoa(binary);
      }
    } else if (wireType === 0) {
      const { bytesRead } = readVarint(userBuf, uo);
      uo += bytesRead;
    } else {
      break;
    }
  }

  return {
    nodeNum,
    nodeId: id || nodeNumToHex(nodeNum),
    longName,
    shortName,
    publicKey,
  };
}

/**
 * Inspect the current URL fragment for a deep link. Call once on app boot,
 * and again whenever the fragment changes (hashchange event).
 */
export function parseDeepLinkFromHash(hash: string): DeepLink {
  if (!hash || hash === '#') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;

  // Contact share: 'v/<base64>'
  if (raw.startsWith('v/')) {
    const bytes = base64UrlDecode(raw.slice(2));
    if (!bytes) return null;
    const parsed = parseSharedContact(bytes);
    if (!parsed) return null;
    return {
      type: 'contact',
      nodeId: parsed.nodeId,
      nodeNum: parsed.nodeNum,
      longName: parsed.longName,
      shortName: parsed.shortName,
      publicKey: parsed.publicKey,
    };
  }

  // Chat shortcut: 'chat=<id>'
  if (raw.startsWith('chat=')) {
    const chatId = decodeURIComponent(raw.slice(5));
    if (chatId) return { type: 'chat', chatId };
  }

  return null;
}

/** Strip the hash from the URL without reloading. */
export function clearHash() {
  if (typeof window === 'undefined') return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
}
