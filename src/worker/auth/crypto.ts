import { encode } from "../../shared/base64url.ts";

const text = new TextEncoder();

/** Random bytes as base64url, for tokens. */
export function randomToken(bytes = 32): string {
	return encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 as base64url. Tokens are random and long, so a plain hash is enough to store them safely. */
export async function sha256(value: string): Promise<string> {
	return encode(await crypto.subtle.digest("SHA-256", text.encode(value)));
}
