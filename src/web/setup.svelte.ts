// This phone's setup for reminders (Phase 0 findings, FR-42): the checklist on the setup
// screen, the dot on the header avatar and Today's "not reaching this phone" line all use this.
import { UNCONFIRMED_AFTER_MS, type MeResponse } from "../shared/types.ts";
import { isIos, isStandalone } from "./device.ts";
import { notificationPermission } from "./session.svelte.ts";

export type StepId = "install" | "notifications" | "battery" | "test";
export type SetupStatus = "ok" | "incomplete" | "broken";

/** Chrome's install prompt (not in TypeScript's DOM types). */
interface InstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const STORAGE_KEY = "kinnect.setup";
type Ticks = Partial<Record<"install" | "battery", boolean>>;

function loadTicks(): Ticks {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Ticks;
	} catch {
		return {};
	}
}

export const android = /Android/.test(navigator.userAgent);
export const ios = isIos();

export const setup = $state({
	/** Steps ticked by hand; they belong to this phone, not the member. */
	ticks: loadTicks(),
	installed: isStandalone(),
	permission: notificationPermission(),
	installPrompt: null as InstallPromptEvent | null,
});

addEventListener("beforeinstallprompt", (event) => {
	event.preventDefault();
	setup.installPrompt = event as InstallPromptEvent;
});
addEventListener("appinstalled", () => tick("install"));
// Notification permission can be changed in the phone's settings while the app is in the background.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") setup.permission = notificationPermission();
});

export function tick(step: keyof Ticks, done = true): void {
	setup.ticks[step] = done;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(setup.ticks));
}

/** Shows Chrome's install dialog; false if it isn't available (then the screen explains the menu). */
export async function install(): Promise<boolean> {
	const prompt = setup.installPrompt;
	if (!prompt) return false;
	await prompt.prompt();
	if ((await prompt.userChoice).outcome === "accepted") tick("install");
	setup.installPrompt = null;
	return true;
}

/** Sent notifications haven't been shown for a day (FR-42). */
export const notShowing = (me: MeResponse, now = Date.now()) =>
	me.device.notifications === "unconfirmed" &&
	now - (me.device.unconfirmedSince ?? now) >= UNCONFIRMED_AFTER_MS;

/** The steps that apply to this device, in order, and whether each is done. */
export function setupSteps(me: MeResponse): { id: StepId; done: boolean }[] {
	const steps: { id: StepId; done: boolean }[] = [];
	if (android || ios) steps.push({ id: "install", done: setup.installed || !!setup.ticks.install });
	// On iPhone, notifications only exist once installed.
	if (setup.permission !== "unsupported" || (ios && !setup.installed)) {
		steps.push({
			id: "notifications",
			done: setup.permission === "granted" && me.device.notifications !== "off",
		});
	}
	if (android) steps.push({ id: "battery", done: !!setup.ticks.battery });
	if (setup.permission !== "unsupported")
		steps.push({ id: "test", done: me.device.lastAckAt !== null });
	return steps;
}

/** "broken" means reminders can't reach this phone right now; Today shows it, the rest only flags it. */
export function setupStatus(me: MeResponse): SetupStatus {
	const reachable =
		setup.permission === "granted" && me.device.notifications !== "off" && !notShowing(me);
	if (!reachable && (setup.permission !== "unsupported" || (ios && !setup.installed)))
		return "broken";
	return setupSteps(me).every((s) => s.done) ? "ok" : "incomplete";
}
