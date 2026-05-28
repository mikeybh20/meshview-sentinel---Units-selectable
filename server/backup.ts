/**
 * v2.0 Beta 2 — Encrypted config backup / restore.
 *
 * Bundles the Sentinel-side configuration that's painful to re-enter on a
 * fresh install — the radios registry, channel definitions (including PSKs),
 * and BBS config — into a single passphrase-encrypted envelope.
 *
 * Why encrypted: the bundle contains channel PSKs. A plaintext JSON dump of
 * those would be a credential leak if it ended up in a backup folder, a
 * git repo, or a shared drive. We derive a key from an operator passphrase
 * (scrypt) and seal the payload with AES-256-GCM so the export is useless
 * without the passphrase, and tampering is detected via the GCM auth tag.
 *
 * Restore is Sentinel-side only — it rewrites the DB + config file. It does
 * NOT push anything to radio firmware; the devices keep their own config,
 * and the operator can re-apply channels via the Channels modal if a radio
 * was reflashed.
 */
import crypto from 'crypto';

const ENVELOPE_VERSION = 1;
const SCRYPT_N = 16384; // CPU/memory cost — ~50ms on modern hardware
const KEY_LEN = 32;     // AES-256

export interface BackupEnvelope {
  v: number;          // envelope format version
  alg: 'aes-256-gcm';
  salt: string;       // base64 — scrypt salt
  iv: string;         // base64 — GCM nonce
  tag: string;        // base64 — GCM auth tag
  data: string;       // base64 — ciphertext
  createdAt: number;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N });
}

/** Seal an arbitrary JSON-serializable payload into an encrypted envelope. */
export function sealBackup(payload: unknown, passphrase: string): BackupEnvelope {
  if (!passphrase || passphrase.length < 6) {
    throw new Error('Passphrase must be at least 6 characters');
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
    createdAt: Date.now(),
  };
}

/** Open an encrypted envelope. Throws on wrong passphrase / tampering. */
export function openBackup<T = unknown>(envelope: BackupEnvelope, passphrase: string): T {
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported backup version ${envelope.v} (expected ${ENVELOPE_VERSION})`);
  }
  if (envelope.alg !== 'aes-256-gcm') {
    throw new Error(`Unsupported cipher ${envelope.alg}`);
  }
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf-8')) as T;
  } catch {
    // GCM auth failure = wrong passphrase OR corrupted/tampered data.
    throw new Error('Decryption failed — wrong passphrase or corrupted backup');
  }
}
