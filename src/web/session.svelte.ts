// The signed-in state of this device, loaded from /api/me.
import { decode } from "../shared/base64url.ts";
import type { MeResponse } from "../shared/types.ts";
import { api, ApiError, errorMessage } from "./api.ts";
import { stopSync } from "./sync.svelte.ts";

type SessionState =
	| { status: "loading" }
	| { status: "signedOut" }
	| { status: "signedIn"; me: MeResponse }
	| { status: "error"; message: string };

export const session = $state<{ current: SessionState }>({ current: { status: "loading" } });

export async function loadSession(): Promise<void> {
	try {
		const me = await api<MeResponse>("GET", "/api/me");
		session.current = { status: "signedIn", me };
		// Android drops the subscription when notification permission changes, so
		// re-send the current one on every start (Phase 0 finding).
		if (notificationPermission() === "granted") {
			registerPush(me)
				// A device that just got its subscription back should stop showing "not set up".
				.then(async () => {
					if (me.device.notifications === "off")
						session.current = { status: "signedIn", me: await api<MeResponse>("GET", "/api/me") };
				})
				.catch((error) => console.warn("Push registration failed", error));
		}
	} catch (error) {
		session.current =
			error instanceof ApiError && error.status === 401
				? { status: "signedOut" }
				: { status: "error", message: errorMessage(error) };
	}
}

export async function signOut(): Promise<void> {
	await api("POST", "/api/sign-out", {});
	stopSync();
	session.current = { status: "signedOut" };
	location.hash = "#/today";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
	return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window
		? Notification.permission
		: "unsupported";
}

/** Asks for permission (must be called from a tap) and registers this device for push. */
export async function enableNotifications(): Promise<NotificationPermission | "unsupported"> {
	if (notificationPermission() === "unsupported") return "unsupported";
	const permission = await Notification.requestPermission();
	if (permission === "granted" && session.current.status === "signedIn") {
		await registerPush(session.current.me);
		await loadSession();
	}
	return permission;
}

async function registerPush(me: MeResponse): Promise<void> {
	const registration = await navigator.serviceWorker.ready;
	const subscription =
		(await registration.pushManager.getSubscription()) ??
		(await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: decode(me.vapidPublicKey),
		}));
	await api("PUT", "/api/me/push", { subscription: subscription.toJSON() });
}
