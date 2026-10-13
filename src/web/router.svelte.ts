// Minimal hash router: "#/member/abc" → { name: "member", params: ["abc"] }.
// Links with tokens use the hash so the token never reaches a server or a link preview.
import { decodeSegment } from "../shared/url.ts";

export const routeNames = [
	"today",
	"tasks",
	"task",
	"new-task",
	"settings",
	"setup",
	"member",
	"team",
	"join",
	"code",
	"create",
	"recover",
] as const;
export type RouteName = (typeof routeNames)[number];

export interface Route {
	name: RouteName;
	params: string[];
}

/** A malformed link keeps its raw text rather than crashing the app; a bad token then fails as "link isn't valid". */
function parse(hash: string): Route {
	const [name, ...params] = hash
		.replace(/^#\/?/, "")
		.split("/")
		.map((part) => decodeSegment(part) ?? part);
	return (routeNames as readonly string[]).includes(name)
		? { name: name as RouteName, params }
		: { name: "today", params: [] };
}

export const router = $state({ route: parse(location.hash) });

addEventListener("hashchange", () => {
	router.route = parse(location.hash);
});

export function href(name: RouteName, ...params: string[]): string {
	return `#/${[name, ...params].map(encodeURIComponent).join("/")}`;
}

/** Leaves a one-time link page without keeping its token in history. */
export function replaceRoute(name: RouteName): void {
	history.replaceState(null, "", href(name));
	router.route = parse(location.hash);
}
