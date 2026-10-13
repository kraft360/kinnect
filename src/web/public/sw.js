// Kinnect service worker: shows push notifications and reports display / Done
// back to the server (FR-44, FR-46). Offline caching comes in Phase 2.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Push payloads carry the URL to report to (POST /api/alerts/ack, with the session cookie).
function report(data, action, note) {
	if (!data || !data.ackUrl) return Promise.resolve();
	return fetch(data.ackUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ alertId: data.alertId, action, note }),
	}).catch(() => {});
}

self.addEventListener("push", (event) => {
	const data = event.data ? event.data.json() : {};
	event.waitUntil(
		self.registration
			.showNotification(data.title || "Kinnect", {
				body: data.body,
				icon: "/icon-192.png",
				tag: data.tag,
				data,
				actions: data.canComplete ? [{ action: "done", title: "Done" }] : [],
			})
			// Only report "shown" once the browser has accepted the notification.
			.then(
				() => report(data, "shown"),
				(error) => report(data, "error", String(error)),
			),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	if (event.action === "done") {
		event.waitUntil(report(data, "done"));
		return;
	}
	// Open the task: reuse an open window if there is one.
	const url = new URL(data.url || "/", self.location.origin).href;
	event.waitUntil(
		self.clients.matchAll({ type: "window" }).then((windows) => {
			const existing = windows[0];
			if (!existing) return self.clients.openWindow(url);
			return existing
				.focus()
				.then((client) => (client.url === url ? client : client.navigate(url)));
		}),
	);
});
