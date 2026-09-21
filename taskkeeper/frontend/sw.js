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
// Coloured-circle emojis render natively on phone and desktop lock screens, so
// the priority shows as a real green/yellow/red dot next to the task name and
// time in the OS notification.
const PRIORITY_INFO = {
  low: { label: "Low", dot: "\u{1F7E2}" },
  medium: { label: "Medium", dot: "\u{1F7E1}" },
  high: { label: "High", dot: "\u{1F534}" },
};

function to12h(hhmm) {
  if (!hhmm || !String(hhmm).includes(":")) return hhmm || "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    /* malformed payload — fall back to generic message */
  }
  const payload = data.payload || data;

  const priority = PRIORITY_INFO[payload.priority] || PRIORITY_INFO.medium;
  const title = `${priority.dot} ${payload.title || "Dayline reminder"}`;
  const timeText = payload.time
    ? to12h(payload.time)
    : payload.startTime && payload.endTime
      ? `${to12h(payload.startTime)}–${to12h(payload.endTime)}`
      : "Anytime";
  const body = payload.body && !payload.priority
    ? payload.body
    : `${priority.label} · ${timeText}${payload.time ? ` · Reminder for ${to12h(payload.time)}` : ""}`;
  const options = {
    body,
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
