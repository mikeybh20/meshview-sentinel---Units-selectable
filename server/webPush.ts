/**
 * Web Push notification dispatcher.
 *
 * Sentinel pushes alerts to operators' browsers even when the dashboard
 * tab is closed: DMs to the local node, mentions, NODE_LOST on a
 * favorite, WEATHER_ALERT. Replaces / complements the in-page
 * Notification API which only fires while the tab is open.
 *
 * Wire format:
 *   1. Server generates a VAPID keypair on first boot, persists it to
 *      data/vapid-keys.json with 0600 perms. The PUBLIC key is exposed
 *      via GET /api/push/vapid-public so the browser's
 *      ServiceWorkerRegistration.pushManager.subscribe() can use it.
 *      Private key never leaves the server.
 *   2. Browser registers /push-sw.js, calls pushManager.subscribe(),
 *      POSTs the resulting PushSubscription JSON to /api/push/subscribe.
 *      We store it in push_subscriptions keyed by user_id + endpoint.
 *   3. When an alertable event fires (dispatcher.send(userIds, payload))
 *      we look up the active subscriptions and call web-push.sendNotification.
 *      Subscriptions returning 404 / 410 are auto-pruned (browser told
 *      us they're invalid).
 *
 * Why this and not raw web sockets: the OS-level push channel survives
 * tab close, browser restart, and even (in some browsers) device
 * sleep. SSE only works while the tab is open and CPU-active.
 *
 * Privacy: push payloads are encrypted end-to-end between Sentinel and
 * the browser's push subscription endpoint — Google/Apple/Mozilla
 * push services relay the encrypted blob but can't read it. We still
 * keep payloads compact (no full message text by default — see
 * dispatcher.send for the body shape).
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import webpush, { type PushSubscription, type SendResult } from 'web-push';

import { meshDb as meshDbFactory, type PushSubscriptionRow } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VAPID_PATH = process.env.MESHVIEW_DATA_DIR
  ? join(process.env.MESHVIEW_DATA_DIR, 'vapid-keys.json')
  : join(__dirname, '..', 'data', 'vapid-keys.json');

/**
 * `mailto:` address used as the VAPID contact. Push services expect a
 * contact URL so they can reach the operator if their push traffic
 * misbehaves. Defaults to a local-only placeholder; operators with a
 * public deployment should set PUSH_CONTACT_EMAIL in their .env.
 */
const PUSH_CONTACT = (process.env.PUSH_CONTACT_EMAIL || 'admin@meshview.local').trim();
const VAPID_SUBJECT = PUSH_CONTACT.startsWith('mailto:') ? PUSH_CONTACT : `mailto:${PUSH_CONTACT}`;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cachedKeys: VapidKeys | null = null;

/** Load existing VAPID keys or generate + persist a fresh pair. The
 *  keypair lives for the life of the install — rotating it invalidates
 *  every subscription, so we never regenerate unless the file is gone. */
export function loadOrGenerateVapidKeys(): VapidKeys {
  if (cachedKeys) return cachedKeys;
  try {
    if (existsSync(VAPID_PATH)) {
      const raw = readFileSync(VAPID_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as VapidKeys;
      if (parsed.publicKey && parsed.privateKey) {
        cachedKeys = parsed;
        webpush.setVapidDetails(VAPID_SUBJECT, parsed.publicKey, parsed.privateKey);
        return parsed;
      }
      console.warn('[WebPush] vapid-keys.json present but malformed; regenerating');
    }
  } catch (err: any) {
    console.warn(`[WebPush] failed to read vapid-keys.json (${err.message}); regenerating`);
  }
  const fresh = webpush.generateVAPIDKeys();
  try {
    mkdirSync(dirname(VAPID_PATH), { recursive: true });
    writeFileSync(VAPID_PATH, JSON.stringify(fresh, null, 2), 'utf-8');
    try { chmodSync(VAPID_PATH, 0o600); } catch { /* best-effort */ }
    console.log(`[WebPush] Generated VAPID keypair at ${VAPID_PATH}`);
  } catch (err: any) {
    console.error(`[WebPush] FAILED to persist VAPID keys: ${err.message}. ` +
      `Subscriptions will be invalidated on next restart.`);
  }
  cachedKeys = fresh;
  webpush.setVapidDetails(VAPID_SUBJECT, fresh.publicKey, fresh.privateKey);
  return fresh;
}

export function getVapidPublicKey(): string {
  return loadOrGenerateVapidKeys().publicKey;
}

/**
 * Push payload categories. Each subscription has a per-category opt-in
 * (Settings → Notifications). The dispatcher checks the user's prefs
 * AND the subscription's category mask before sending.
 */
export type PushCategory = 'dm' | 'mention' | 'outage' | 'weather';

export interface PushPayload {
  /** Notification title shown on the OS surface. ≤ 50 chars
   *  recommended — Android truncates after that. */
  title: string;
  /** Body text. ≤ 120 chars recommended; some surfaces cap at 240. */
  body: string;
  /** Category tag — drives the icon, vibration pattern, and the
   *  user-prefs check at delivery time. */
  category: PushCategory;
  /** Deep-link URL the service worker opens on notification click.
   *  Relative to the dashboard origin. */
  url?: string;
  /** Tag string — Android/Chrome coalesce notifications with the same
   *  tag (replace the previous one). Use e.g. `dm:<nodeId>` so a
   *  rapid-fire DM thread doesn't generate a stack of 20 notifications. */
  tag?: string;
}

interface DeliveryReport {
  delivered: number;
  pruned: number;
  failed: number;
}

/**
 * Send a push payload to every active subscription for the given
 * user(s). Auto-prunes subscriptions whose push service returns
 * 404 / 410 (browser told us the subscription is gone).
 *
 * Per-category opt-in is enforced at the subscription row level:
 * pushSubscriptions.categories is a JSON array of opted-in categories,
 * matched against payload.category here. Empty array == subscriber
 * disabled (subscription kept so they can re-enable without
 * re-prompting the browser).
 */
export async function dispatch(userIds: number[] | 'all', payload: PushPayload): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: 0, pruned: 0, failed: 0 };
  const subs = userIds === 'all'
    ? meshDbFactory().listPushSubscriptions()
    : meshDbFactory().listPushSubscriptions({ userIds });
  if (subs.length === 0) return report;

  loadOrGenerateVapidKeys(); // ensure web-push has its VAPID config
  const body = JSON.stringify(payload);

  await Promise.all(subs.map(async sub => {
    if (!sub.categories.includes(payload.category)) return;
    const target: PushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.authSecret },
    };
    try {
      const r: SendResult = await webpush.sendNotification(target, body, { TTL: 86_400 });
      report.delivered += 1;
      if (r.statusCode >= 400) {
        console.warn(`[WebPush] non-2xx for sub#${sub.id} (user#${sub.userId}): ${r.statusCode}`);
      }
    } catch (err: any) {
      const status = err?.statusCode ?? 0;
      if (status === 404 || status === 410) {
        // Subscription gone — prune so we stop trying.
        meshDbFactory().deletePushSubscription(sub.id);
        report.pruned += 1;
        console.log(`[WebPush] pruned dead sub#${sub.id} user#${sub.userId} (status=${status})`);
      } else {
        report.failed += 1;
        console.warn(`[WebPush] send failed sub#${sub.id} user#${sub.userId}: ${err?.message ?? err}`);
      }
    }
  }));

  return report;
}

/** Re-export for the API endpoint that lists schema-allowed categories.
 *  Kept here (not in api.ts) so adding a new category in this file is
 *  the single edit needed. */
export const PUSH_CATEGORIES: readonly PushCategory[] = ['dm', 'mention', 'outage', 'weather'];

// Re-export the DB row type so api.ts can type its handlers without
// reaching into database.ts.
export type { PushSubscriptionRow };
