import type { ErrorResponse } from "../shared/types.ts";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Calls the Worker API. The session cookie is sent automatically. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new ApiError(0, "Couldn't reach Kinnect. Check your internet connection.");
	}
	const data = (await response.json().catch(() => ({}))) as T | ErrorResponse;
	if (!response.ok) {
		throw new ApiError(
			response.status,
			(data as ErrorResponse).error ?? `Request failed (${response.status}).`,
		);
	}
	return data as T;
}

export const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);
