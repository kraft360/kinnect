// Minimal router: "GET /api/members/:id" style patterns.
import { decodeSegment } from "../shared/url.ts";
import { BadRequest } from "./http.ts";

export type Params = Record<string, string>;
type Handler<C> = (request: Request, params: Params, context: C) => Promise<Response>;

interface Route<C> {
	method: string;
	parts: string[];
	handler: Handler<C>;
}

export class Router<C> {
	private routes: Route<C>[] = [];

	on(method: string, path: string, handler: Handler<C>): this {
		this.routes.push({ method, parts: path.split("/"), handler });
		return this;
	}

	/** Returns null when no route matches the path; 405 when only the method differs. */
	async handle(request: Request, context: C): Promise<Response | null> {
		const parts = new URL(request.url).pathname.split("/");
		let pathMatched = false;
		for (const route of this.routes) {
			const params = match(route.parts, parts);
			if (!params) continue;
			pathMatched = true;
			if (route.method === request.method) return route.handler(request, params, context);
		}
		return pathMatched ? Response.json({ error: "method not allowed" }, { status: 405 }) : null;
	}
}

function match(pattern: string[], parts: string[]): Params | null {
	if (pattern.length !== parts.length) return null;
	const params: Params = {};
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i].startsWith(":")) {
			if (!parts[i]) return null;
			const value = decodeSegment(parts[i]);
			if (value === null) throw new BadRequest("Malformed URL.");
			params[pattern[i].slice(1)] = value;
		} else if (pattern[i] !== parts[i]) {
			return null;
		}
	}
	return params;
}
