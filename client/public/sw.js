const CACHE_VERSION = "0.12.4";
const CACHE_NAME = `songbird-${CACHE_VERSION}`;
const APP_SHELL = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

const isCacheableAssetPath = (pathname) => {
  if (pathname.startsWith("/assets/")) return true;
  if (pathname.startsWith("/icons/")) return true;
  return (
    pathname.endsWith(".js") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".woff2") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".ico")
  );
};

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => null),
  );
});

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("songbird-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/sw.js") return;
  const isNavigation = event.request.mode === "navigate";
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      if (isNavigation) {
        const network = await fetch(event.request, { cache: "no-store" })
          .then((response) => {
            if (response && response.ok) {
              cache.put("/index.html", response.clone());
              self.clients
                .matchAll({ type: "window", includeUncontrolled: true })
                .then((clientsArr) => {
                  clientsArr.forEach((client) =>
                    client.postMessage({ type: "APP_SHELL_UPDATED" }),
                  );
                })
                .catch(() => null);
            }
            return response;
          })
          .catch(() => null);
        if (network) return network;
        const cachedIndex = await cache.match("/index.html");
        return cachedIndex || Response.error();
      }

      if (!isCacheableAssetPath(url.pathname)) {
        return fetch(event.request).catch(() => Response.error());
      }

      const cached = await cache.match(event.request);
      const revalidate = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => null);
      event.waitUntil(revalidate);
      if (cached) return cached;
      const network = await revalidate;
      return network || cached || Response.error();
    })(),
  );
});

// The call is over (the caller gave up, it timed out, or another device
// answered). Take the sticky "Incoming call" notification down; for a call that
// was never answered, leave a plain "missed call" behind instead.
async function handleCallEnded(payload, data) {
  const tag = `call-${data.callId}`;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const appFocused = clients.some((client) => ("focused" in client ? Boolean(client.focused) : false));
  const ringing = await self.registration.getNotifications({ tag });
  const missed = data.reason === "missed";
  if (appFocused && !ringing.length) return;

  const options = {
    body: missed ? payload.body || "Missed call" : "",
    data: { ...data, type: "call_missed" },
    tag,
    renotify: false,
    requireInteraction: false,
    silent: missed ? false : true,
    badge: "/icons/icon-192.png",
    icon: "/icons/icon-192.png",
  };
  // Browsers expect every push to end in a visible notification, so the
  // ringing one is replaced (same tag) rather than just closed.
  await self.registration.showNotification(payload.title || "Aurelle", options);
  if (!missed) {
    const replaced = await self.registration.getNotifications({ tag });
    replaced.forEach((notification) => notification.close());
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Aurelle", body: event.data?.text?.() || "" };
  }
  const title = payload.title || "Aurelle";
  const body = payload.body || "New message";
  const data = payload.data || {};
  const badgeCount = Number(payload.badge || 0);
  const isCall = data.type === "call";
  if (data.type === "call_end") {
    event.waitUntil(handleCallEnded(payload, data));
    return;
  }
  // A reaction gets a tag of its own, so it does not replace the chat's
  // notification about unread messages.
  const tag = isCall
    ? `call-${data.callId}`
    : data.type === "reaction" && data.messageId
      ? `reaction-${data.messageId}`
      : data.chatId
        ? `chat-${data.chatId}`
        : "songbird";
  const options = {
    body,
    data,
    tag,
    renotify: true,
    badge: "/icons/icon-192.png",
    icon: "/icons/icon-192.png",
    // An incoming call must stay on screen until it is answered or expires.
    ...(isCall ? { requireInteraction: true, vibrate: [300, 200, 300, 200, 300] } : {}),
  };
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const appFocused = clients.some((client) =>
        "focused" in client
          ? Boolean(client.focused)
          : false,
      );
      if (appFocused) {
        // A focused Aurelle window handles unread state in-app.
        return;
      }
      try {
        if (badgeCount > 0 && navigator?.setAppBadge) {
          navigator.setAppBadge(badgeCount).catch(() => null);
        }
      } catch {
        // ignore badge errors; must not affect notification delivery
      }
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientsArr) => {
        const existing = clientsArr.find((client) =>
          client.url.includes(self.location.origin),
        );
        if (existing) {
          // Only bring the window forward. Navigating it would reload the app,
          // and with it end a call in progress (a call lives in the page); all
          // notification targets are "/" anyway.
          return existing.focus();
        }
        self.clients.openWindow(target);
      }),
  );
});
