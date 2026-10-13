// Durable Object RPC methods return a Result instead of throwing, so the HTTP
// status survives the RPC boundary (thrown errors arrive as plain Errors).

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (
	status: number,
	error: string,
): { ok: false; status: number; error: string } => ({ ok: false, status, error });
