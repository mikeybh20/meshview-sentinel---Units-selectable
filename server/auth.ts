/**
 * v2.0 Beta 5 — authentication foundation.
 *
 * Local-account auth backed by the SQLite DB. Password hashing via scrypt
 * (Node stdlib, no external deps). Sessions stored as random opaque tokens
 * in the `sessions` table, delivered to the client as a signed cookie so
 * we can detect tampering server-side without a DB lookup for malformed
 * inputs.
 *
 * Threat model: Sentinel runs on a LAN (or behind an operator-controlled
 * proxy) and serves at most a handful of accounts — household / small
 * team. Not a public service, not subject to mass credential stuffing,
 * not handling regulated data. Decisions reflect that posture:
 *
 *   - scrypt N=16384 (~50ms on modern hardware) is plenty for an
 *     interactive login. Higher N would just delay the operator.
 *   - Session cookies are signed (HMAC-SHA256) for integrity but not
 *     encrypted — the value is a token, not a secret to hide.
 *   - sameSite=lax + httpOnly defaults provide reasonable CSRF/XSS
 *     mitigation for the common LAN deploy. `secure: false` by default
 *     because Sentinel often runs over plain HTTP on a LAN — operators
 *     with HTTPS in front flip MESHVIEW_COOKIE_SECURE=1.
 *
 * AUTH_SECRET: a 32-byte random key persisted to data/auth-secret on
 * first boot. Survives container rebuilds because the data volume is
 * preserved. Cookie + session signing both derive from it.
 */
import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Request, Response, NextFunction } from 'express';
import { meshDb } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// scrypt cost — N=16384 is ~50ms on modern hardware, comfortable for
// interactive login. Matches the backup.ts envelope key derivation cost.
const SCRYPT_N = 16384;
const SCRYPT_KEY_LEN = 64;
const SCRYPT_SALT_LEN = 16;

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_SLIDE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // refresh exp if within 24h of expiry
const SESSION_COOKIE_NAME = 'mvs_session';

// -------------------------------------------------------------------------
// AUTH_SECRET — loaded once at module import. Persisted to data/ so it
// survives container rebuilds (named volume is preserved). Generated on
// first boot if not present.
// -------------------------------------------------------------------------
const SECRET_PATH = process.env.MESHVIEW_DATA_DIR
  ? join(process.env.MESHVIEW_DATA_DIR, 'auth-secret')
  : join(__dirname, '..', 'data', 'auth-secret');

function loadOrGenerateSecret(): Buffer {
  try {
    if (existsSync(SECRET_PATH)) {
      const raw = readFileSync(SECRET_PATH);
      if (raw.length >= 32) return raw.subarray(0, 32);
    }
  } catch (err: any) {
    console.warn(`[Auth] reading existing secret failed: ${err.message} — regenerating`);
  }
  const fresh = crypto.randomBytes(32);
  try {
    mkdirSync(dirname(SECRET_PATH), { recursive: true });
    writeFileSync(SECRET_PATH, fresh);
    // Owner-only read — the file is sensitive but a passive secret, not a
    // private key. Best-effort; fails silently on filesystems that don't
    // honor chmod (e.g., some Docker volume drivers).
    try { chmodSync(SECRET_PATH, 0o600); } catch { /* best effort */ }
    console.log('[Auth] Generated fresh AUTH_SECRET');
  } catch (err: any) {
    console.error(`[Auth] could not persist AUTH_SECRET (${err.message}) — using ephemeral secret. Sessions will not survive restart.`);
  }
  return fresh;
}

const AUTH_SECRET = loadOrGenerateSecret();

// -------------------------------------------------------------------------
// Password hashing
// -------------------------------------------------------------------------

/** Hash a plaintext password. Returns "scrypt$<salt-b64>$<hash-b64>". */
export function hashPassword(plain: string): string {
  if (!plain || plain.length < 1) throw new Error('Password cannot be empty');
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Verify a password against a stored hash. Constant-time compare. */
export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const candidate = crypto.scryptSync(plain, salt, expected.length, { N: SCRYPT_N });
    return crypto.timingSafeEqual(expected, candidate);
  } catch { return false; }
}

// -------------------------------------------------------------------------
// Cookie signing
// -------------------------------------------------------------------------

/** HMAC-sign an opaque value. Output: "<value>.<sig-b64url>". */
function signValue(value: string): string {
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(value).digest('base64url');
  return `${value}.${sig}`;
}

/** Verify a signed value. Returns the original value or null. */
function unsignValue(signed: string): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const presented = signed.slice(dot + 1);
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(value).digest('base64url');
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? value : null;
}

// -------------------------------------------------------------------------
// Session lifecycle
// -------------------------------------------------------------------------

export interface SessionUser {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
}

/** Create a session for a user, persist to DB, return the signed cookie value. */
export function createSession(userId: number, ip: string | null): { token: string; cookie: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_DURATION_MS;
  meshDb().createSession({ token, userId, createdAt: now, expiresAt, ipFirstSeen: ip });
  return { token, cookie: signValue(token), expiresAt };
}

/** Look up a session by cookie value. Validates signature + expiry. Slides
 *  the expiry forward if close to expiring so active users don't get
 *  logged out mid-day. Returns the user or null. */
export function resolveSession(cookieValue: string | undefined): SessionUser | null {
  if (!cookieValue) return null;
  const token = unsignValue(cookieValue);
  if (!token) return null;
  const row = meshDb().getSession(token);
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt < now) {
    meshDb().deleteSession(token);
    return null;
  }
  // Sliding expiry: if we're within the slide threshold of expiring,
  // push the expiry out by another full duration. Avoids the "user logs
  // in at 9am, gets logged out at 9am next day" experience.
  if (row.expiresAt - now < SESSION_SLIDE_THRESHOLD_MS) {
    meshDb().updateSessionExpiry(token, now + SESSION_DURATION_MS);
  }
  return { id: row.userId, username: row.username, role: row.role };
}

export function destroySession(cookieValue: string | undefined): void {
  if (!cookieValue) return;
  const token = unsignValue(cookieValue);
  if (token) meshDb().deleteSession(token);
}

/** Cookie attributes for setSession. secure flag follows env override. */
export function sessionCookieAttrs(expiresAt: number): string {
  const secure = String(process.env.MESHVIEW_COOKIE_SECURE ?? '').trim() === '1';
  const parts = [
    `${SESSION_COOKIE_NAME}=__VALUE__`,
    `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

// -------------------------------------------------------------------------
// Cookie parsing
// -------------------------------------------------------------------------

/** Tiny cookie header parser. Doesn't pull in cookie-parser as a dep. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSessionCookieValue(req: Request): string | undefined {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME];
}

// -------------------------------------------------------------------------
// Express middleware
// -------------------------------------------------------------------------

/** Augments Express's Request with the resolved user. */
declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

/** Resolves the session cookie and attaches req.user. Does NOT reject —
 *  endpoints decide via requireAuth / requireAdmin whether to enforce. */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const cookie = getSessionCookieValue(req);
  const user = resolveSession(cookie);
  if (user) req.user = user;
  next();
}

/** Reject with 401 if not authenticated. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) return void res.status(401).json({ error: 'Not authenticated' });
  next();
}

/** Reject with 403 if not authenticated as an admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) return void res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return void res.status(403).json({ error: 'Admin role required' });
  next();
}

/** Idempotent prune of expired sessions. Call from a periodic timer. */
export function pruneExpiredSessions(): number {
  return meshDb().pruneExpiredSessions(Date.now());
}

// Schedule a daily-ish prune so the sessions table doesn't grow unboundedly.
setInterval(() => {
  try {
    const n = pruneExpiredSessions();
    if (n > 0) console.log(`[Auth] Pruned ${n} expired session(s)`);
  } catch (err: any) {
    console.warn('[Auth] session prune failed:', err.message);
  }
}, 6 * 60 * 60 * 1000).unref?.();

// -------------------------------------------------------------------------
// Validation helpers (used by user-management endpoints + bootstrap)
// -------------------------------------------------------------------------

/** Username rules: 2..32 chars, [a-zA-Z0-9._-], no leading dot/dash. */
export function validateUsername(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string') return { error: 'Username must be a string' };
  const u = raw.trim();
  if (u.length < 2 || u.length > 32) return { error: 'Username must be 2..32 characters' };
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) return { error: 'Username may contain letters, digits, dot, underscore, hyphen only' };
  if (/^[.-]/.test(u)) return { error: 'Username cannot start with "." or "-"' };
  return u;
}

/** Password rules: 8+ chars, no upper bound (scrypt handles arbitrary length). */
export function validatePassword(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string') return { error: 'Password must be a string' };
  if (raw.length < 8) return { error: 'Password must be at least 8 characters' };
  if (raw.length > 1024) return { error: 'Password is unreasonably long' };
  return raw;
}

/** Allowed roles. */
export function isValidRole(raw: unknown): raw is 'admin' | 'viewer' {
  return raw === 'admin' || raw === 'viewer';
}
