// Push-only service worker. No fetch handler and no cache: a new CC build reaches the phone on the next reload.
// Safari requires every push to show a notification, so showNotification always runs.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    // plain-text or empty payload
  }
  event.waitUntil(
    self.registration.showNotification(d.t || "Command Center", {
      body: d.b || "",
      tag: d.tag, // same tag replaces the previous notification for that item
      data: { url: d.u || "/" }, // always a CC path, e.g. /#item=<key>
      icon: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
        if (!c.url.startsWith(self.location.origin)) continue;
        await c.focus();
        // navigate() only works on controlled clients; fall back to a new window.
        return c.navigate(url).catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    })(),
  );
});
