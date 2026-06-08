/**
 * MeshView Sentinel — Web Push service worker.
 *
 * Two responsibilities:
 *
 *  1. Receive push events from the OS push service (Mozilla / Apple /
 *     Google) and render them as OS notifications. Payload shape is
 *     PushPayload from server/webPush.ts: { title, body, category, url,
 *     tag }.
 *
 *  2. On notificationclick, focus an existing dashboard tab if one is
 *     open, or open a new one at payload.url. Saves the operator the
 *     "click notification → tab opens → click around to the right view"
 *     dance.
 *
 * No app code lives here. The service worker is intentionally
 * minimal — every render decision is server-side in the payload, so
 * shipping a new category doesn't require redeploying the worker.
 */

self.addEventListener('install', (event) => {
  // Activate immediately on first install instead of waiting for the
  // next page load. New worker takes over the page on the next
  // navigation (controlled by clients.claim below).
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch (err) {
    // Fall back to plain text if the server sent a non-JSON body.
    payload = { title: 'MeshView Sentinel', body: event.data.text() };
  }
  const title = payload.title || 'MeshView Sentinel';
  const body = payload.body || '';
  // OS-level options — `tag` coalesces (replace older notification
  // with the same tag), `data.url` is what notificationclick uses to
  // deep-link, `renotify:true` re-alerts even when the tag matches so
  // a second DM in the same thread still pings.
  const options = {
    body,
    tag: payload.tag,
    renotify: !!payload.tag,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: {
      url: payload.url || '/',
      category: payload.category,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  // Try to find an open dashboard tab and focus it; otherwise open a
  // new one. The URL match is prefix-only on origin so a tab anywhere
  // in the app counts as "open" and gets focused before we deep-link.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        try {
          const u = new URL(client.url);
          const target = new URL(url, client.url);
          if (u.origin === target.origin) {
            return client.focus().then((focused) => {
              try {
                focused.navigate(target.href);
              } catch {
                // navigate() not supported in this browser — focused tab
                // stays where it was; user can navigate manually.
              }
              return focused;
            });
          }
        } catch {
          // Bad URL — skip this client and try the next.
        }
      }
      // No existing tab; open one.
      return self.clients.openWindow(url);
    })
  );
});
