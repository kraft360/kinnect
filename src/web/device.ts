// What we can tell about this device from the browser.

/** A readable default name for the device list, e.g. "Android phone · Chrome". */
export function defaultDeviceName(): string {
	const ua = navigator.userAgent;
	const kind = /iPhone/.test(ua)
		? "iPhone"
		: /iPad/.test(ua)
			? "iPad"
			: /Android/.test(ua)
				? /Mobile/.test(ua)
					? "Android phone"
					: "Android tablet"
				: /Windows/.test(ua)
					? "Windows PC"
					: /Mac OS X/.test(ua)
						? "Mac"
						: /Linux/.test(ua)
							? "Linux PC"
							: "Device";
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /Firefox\//.test(ua)
			? "Firefox"
			: /Chrome\//.test(ua)
				? "Chrome"
				: /Safari\//.test(ua)
					? "Safari"
					: "";
	return browser ? `${kind} · ${browser}` : kind;
}

/** Chat apps' built-in browsers can't install the app or receive notifications (FR-79a). */
export function inAppBrowser(): string | null {
	const ua = navigator.userAgent;
	if (/WhatsApp/i.test(ua)) return "WhatsApp";
	if (/Instagram/i.test(ua)) return "Instagram";
	if (/FBAN|FBAV/.test(ua)) return "Facebook";
	if (/\bLine\//.test(ua)) return "LINE";
	if (/Android.*; wv\)/.test(ua)) return "an app";
	return null;
}

export const isIos = () => /iPhone|iPad/.test(navigator.userAgent);
export const isStandalone = () =>
	matchMedia("(display-mode: standalone)").matches ||
	(navigator as { standalone?: boolean }).standalone === true;
