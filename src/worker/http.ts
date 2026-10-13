import type { ErrorResponse } from "../shared/types.ts";
import type { Result } from "./result.ts";

export function errorResponse(status: number, error: string): Response {
	return Response.json({ error } satisfies ErrorResponse, { status });
}

export const notFound = () => errorResponse(404, "not found");

/** Turns a Durable Object Result into a JSON response. */
export function resultResponse<T>(result: Result<T>, init?: ResponseInit): Response {
	return result.ok ? Response.json(result.value, init) : errorResponse(result.status, result.error);
}

/**
 * Cross-site request protection for state-changing requests: the browser must
 * say the request comes from this app. POST must also be JSON, because a plain
 * HTML form on another site can send POST but not JSON. Other sites can't send
 * PUT, PATCH or DELETE at all without CORS approval, so those may have no body.
 */
export function checkSameOrigin(request: Request): Response | null {
	if (request.method === "GET" || request.method === "HEAD") return null;
	if (request.headers.get("Origin") !== new URL(request.url).origin)
		return errorResponse(403, "cross-origin request refused");
	if (
		request.method === "POST" &&
		!request.headers.get("Content-Type")?.startsWith("application/json")
	) {
		return errorResponse(415, "expected JSON");
	}
	return null;
}

export class BadRequest extends Error {}

/** Reads a JSON object body. Field checks are done by the caller with the helpers below. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		if (body && typeof body === "object" && !Array.isArray(body))
			return body as Record<string, unknown>;
	} catch {}
	throw new BadRequest("request body must be a JSON object");
}

export function stringField(body: Record<string, unknown>, name: string, maxLength = 2000): string {
	const value = body[name];
	if (typeof value !== "string" || value.length > maxLength)
		throw new BadRequest(`${name} must be a string`);
	return value;
}

export function optionalStringField(
	body: Record<string, unknown>,
	name: string,
	maxLength = 2000,
): string | undefined {
	return body[name] === undefined ? undefined : stringField(body, name, maxLength);
}

export function enumField<T extends string>(
	body: Record<string, unknown>,
	name: string,
	allowed: readonly T[],
): T {
	const value = body[name];
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new BadRequest(`${name} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}
