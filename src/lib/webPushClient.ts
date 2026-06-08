/**
 * Web Push — browser-side helpers.
 *
 * Wraps the ugly bits of the Push API (base64url → Uint8Array, the
 * service worker registration dance, the subscribe / unsubscribe
 * promises) behind a small synchronous-feeling API so the Settings UI
 * stays readable.
 *
 * Permission model:
 *   - browserPushSupported()  : feature detection
 *   - getCurrentSubscription(): returns the live SW subscription, or null
 *   - enableBrowserPush()     : ensure permission, register SW, subscribe,
 *                                POST to /api/push/subscribe
 *   - disableBrowserPush()    : unsubscribe + DELETE on the server
 *   - sendTestPush()          : kick the server /api/push/test endpoint
 *
 * The service worker file lives at /push-sw.js (served from public/).
 */

const API_BASE = (import.meta as any).env?.VITE_API_URL ?? '';
const SW_URL = '/push-sw.js';

export function browserPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!browserPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    if (!reg) return null;
    return (await reg.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

async function fetchVapidPublicKey(): Promise<string> {
  const r = await fetch(`${API_BASE}/api/push/vapid-public`, { credentials: 'include' });
  if (!r.ok) throw new Error(`vapid key fetch failed: HTTP ${r.status}`);
  const body = await r.json();
  if (!body.publicKey) throw new Error('vapid response missing publicKey');
  return body.publicKey;
}

/** Standard base64url → Uint8Array conversion required by
 *  pushManager.subscribe's applicationServerKey field. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface EnableResult {
  ok: boolean;
  /** Server-side subscription id on success. */
  id?: number;
  error?: string;
  /** Permission state at the time of the call — useful for the UI
   *  to render "Blocked — enable in browser settings" when the user
   *  has explicitly denied. */
  permission?: NotificationPermission;
}

export async function enableBrowserPush(opts?: { categories?: string[] }): Promise<EnableResult> {
  if (!browserPushSupported()) {
    return { ok: false, error: 'Web Push not supported in this browser' };
  }
  // 1. Ensure permission. We always ask — Notification.permission
  // tells us the current state but doesn't refresh it; only
  // requestPermission triggers the OS prompt.
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'permission request failed' };
  }
  if (permission !== 'granted') {
    return { ok: false, permission, error: `Notification permission ${permission}` };
  }

  // 2. Register the service worker. Repeated calls return the
  // existing registration — idempotent.
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(SW_URL);
  } catch (err: any) {
    return { ok: false, permission, error: `service worker register failed: ${err?.message}` };
  }

  // 3. Get VAPID public key + subscribe.
  let publicKey: string;
  try {
    publicKey = await fetchVapidPublicKey();
  } catch (err: any) {
    return { ok: false, permission, error: err?.message ?? 'vapid key unavailable' };
  }
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true, // required by Chrome; we'll always show a notification anyway
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  } catch (err: any) {
    return { ok: false, permission, error: `subscribe failed: ${err?.message}` };
  }

  // 4. POST the subscription to the server. The PushSubscription's
  // toJSON returns the shape the server expects ({endpoint, keys}).
  try {
    const resp = await fetch(`${API_BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        categories: opts?.categories,
        userAgent: navigator.userAgent,
      }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, permission, error: body.error || `HTTP ${resp.status}` };
    return { ok: true, id: body.id, permission };
  } catch (err: any) {
    return { ok: false, permission, error: err?.message ?? 'subscription persist failed' };
  }
}

export async function disableBrowserPush(): Promise<{ ok: boolean; error?: string }> {
  if (!browserPushSupported()) return { ok: true };
  const sub = await getCurrentSubscription();
  if (sub) {
    // DELETE first so the server stops trying to push. We keep the
    // pushManager unsubscribe even if the DELETE fails so the browser
    // never holds a server-side-orphaned subscription.
    try {
      await fetch(`${API_BASE}/api/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
    } catch { /* ignore — proceed with unsubscribe */ }
    try { await sub.unsubscribe(); } catch { /* ignore */ }
  }
  return { ok: true };
}

export async function sendTestPush(): Promise<{ ok: boolean; delivered?: number; error?: string }> {
  try {
    const r = await fetch(`${API_BASE}/api/push/test`, { method: 'POST', credentials: 'include' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: body.error || `HTTP ${r.status}` };
    return { ok: true, delivered: body.delivered };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'request failed' };
  }
}
