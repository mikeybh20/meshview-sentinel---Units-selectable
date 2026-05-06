/**
 * Build a Meshtastic-compatible contact-sharing URL for a node.
 *
 * The URL format is the same one produced by the official mobile clients:
 *   https://meshtastic.org/v/#<urlsafe-b64 of SharedContact proto>
 *
 * SharedContact proto (mesh.proto):
 *   uint32 node_num = 1;       // wire type 0
 *   User user = 2;             // wire type 2 (length-delimited submessage)
 *
 * User proto fields we include:
 *   1=id (string), 2=long_name (string), 3=short_name (string),
 *   8=public_key (bytes, Curve25519)
 *
 * Receivers (Apple/Android Meshtastic clients) decode the fragment and import
 * the contact directly into their address book.
 */
import { Node } from '../types';

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  value = value >>> 0;
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return bytes;
}

function encodeTagVarint(field: number, value: number): number[] {
  return [(field << 3) | 0, ...encodeVarint(value)];
}

function encodeTagLenDelim(field: number, payload: number[]): number[] {
  return [(field << 3) | 2, ...encodeVarint(payload.length), ...payload];
}

function encodeStringField(field: number, value: string): number[] {
  if (!value) return [];
  const bytes = Array.from(new TextEncoder().encode(value));
  return encodeTagLenDelim(field, bytes);
}

function encodeBytesField(field: number, value: Uint8Array): number[] {
  if (value.length === 0) return [];
  return encodeTagLenDelim(field, Array.from(value));
}

function base64UrlEncode(bytes: Uint8Array): string {
  // Browsers don't have a built-in base64url, so we go through standard b64
  // and translate. Skip padding to match the official URL format.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Build the public contact URL for a node, or null if we can't (e.g. no public key). */
export function buildSharedContactUrl(node: Node): string | null {
  if (!node.publicKey) return null;

  const nodeNum = parseInt(node.id.replace('!', ''), 16) >>> 0;
  if (!Number.isFinite(nodeNum) || nodeNum === 0) return null;

  // User submessage
  const userParts: number[] = [
    ...encodeStringField(1, node.id),
    ...encodeStringField(2, node.name || node.id),
    ...encodeStringField(3, node.shortName || node.id.slice(-4)),
    ...encodeBytesField(8, base64Decode(node.publicKey)),
  ];

  // SharedContact { node_num=1 (varint), user=2 (length-delim) }
  const contactBytes = new Uint8Array([
    ...encodeTagVarint(1, nodeNum),
    ...encodeTagLenDelim(2, userParts),
  ]);

  return `https://meshtastic.org/v/#${base64UrlEncode(contactBytes)}`;
}
