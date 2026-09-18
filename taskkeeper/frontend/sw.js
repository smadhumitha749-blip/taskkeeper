/* Dayline — service worker
 * 1. Caches the app shell so the PWA works offline.
 * 2. Receives Web Push notifications (laptop + phone) even when the tab/app
 *    is closed, and wakes the open page so the reminder sound can play.
 */

const CACHE_NAME = "dayline-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for everything: the browser always gets the freshest app and
  // data from the server; the cache is only an offline fallback. This also
  // guarantees the HTML and app.js never drift apart after an update.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (res.type === "basic" || res.type === "default")) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error()))
  );
});

// ---------- Push notifications ----------

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    /* malformed payload — fall back to generic message */
  }
  const payload = data.payload || data;

  const title = payload.title || "Dayline reminder";
  const options = {
    body: payload.body || "You have a task right now.",
    tag: payload.tag || new Date(Date.now()).toISOString(),
    icon: payload.icon || "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    renotify: true,
    // Android uses the Chrome notification channel for the audible alert. Ask
    // for that normal channel explicitly and provide a vibration fallback for
    // phones set to vibrate or silent mode. A service worker cannot play a
    // custom sound while the app is closed.
    silent: false,
    vibrate: [180, 80, 180, 80, 260],
    data: { url: "./", task: payload },
  };

  event.waitUntil(
    self.registration.showNotification(title, options).then(() => tellOpenPages(payload))
  );
});

// Ask any open tab to play the reminder sound + show a toast.
function tellOpenPages(payload) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    clients.forEach((client) => client.postMessage({ type: "DAYLINE_REMINDER", payload }));
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./");
    })
  );
});
