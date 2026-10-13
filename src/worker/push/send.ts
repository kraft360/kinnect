import { encryptPayload, type PushKeys } from "./encrypt.ts";
import { vapidAuthorization, type VapidConfig } from "./vapid.ts";

export interface PushSubscriptionData {
	endpoint: string;
	keys: PushKeys;
}

export interface PushOptions {
	/** Seconds the push service keeps the message if the device is offline. */
	ttl: number;
	urgency?: "very-low" | "low" | "normal" | "high";
}

export interface PushResult {
	status: number;
	/** The subscription no longer exists and should be deleted (FR-45). */
	gone: boolean;
}

/**
 * Push services the browsers use: Chrome and other Chromium browsers (FCM), Firefox, Safari, and Edge on
 * Windows. Subscriptions elsewhere are refused, so a signed-in device can't make the Worker POST to any host.
 */
const PUSH_SERVICES = [
	"fcm.googleapis.com",
	"push.services.mozilla.com",
	"push.apple.com",
	"notify.windows.com",
];

export function isPushServiceEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
	return PUSH_SERVICES.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export async function sendPush(
	subscription: PushSubscriptionData,
	payload: unknown,
	options: PushOptions,
	vapid: VapidConfig,
): Promise<PushResult> {
	// Checked again here for subscriptions saved before the check existed; they're dropped like expired ones.
	if (!isPushServiceEndpoint(subscription.endpoint)) return { status: 0, gone: true };
	const body = await encryptPayload(subscription.keys, JSON.stringify(payload));
	const response = await fetch(subscription.endpoint, {
		method: "POST",
		headers: {
			Authorization: await vapidAuthorization(vapid, subscription.endpoint),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: String(options.ttl),
			Urgency: options.urgency ?? "high",
		},
		body,
	});
	// Drain the body so the connection is released.
	await response.arrayBuffer();
	return { status: response.status, gone: response.status === 404 || response.status === 410 };
}
