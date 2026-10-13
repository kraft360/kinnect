// Opaque session tokens: "<orgId>.<deviceId>.<random>". The org and device ids
// only route the request; the random part is the credential and is stored hashed.
import { isOrgId } from "../../shared/ids.ts";
import { sha256 } from "./crypto.ts";

export const SESSION_COOKIE = "kinnect_session";
const MAX_AGE_S = 365 * 24 * 60 * 60;
const DEVICE_ID_PATTERN = /^[0-9a-f-]{36}$/;
const RANDOM_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What an Organization needs to check a session. */
export interface SessionAuth {
	deviceId: string;
	tokenHash: string;
}

export interface ParsedSession extends SessionAuth {
	orgId: string;
	token: string;
}

export function sessionToken(orgId: string, deviceId: string, random: string): string {
	return `${orgId}.${deviceId}.${random}`;
}

export async function parseSessionToken(token: string): Promise<ParsedSession | null> {
	const [orgId, deviceId, random, extra] = token.split(".");
	if (
		extra !== undefined ||
		!isOrgId(orgId ?? "") ||
		!DEVICE_ID_PATTERN.test(deviceId ?? "") ||
		!RANDOM_PATTERN.test(random ?? "")
	) {
		return null;
	}
	return { orgId, deviceId, tokenHash: await sha256(random), token };
}

export function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return null;
}

export function sessionCookie(token: string): string {
	return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}`;
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
