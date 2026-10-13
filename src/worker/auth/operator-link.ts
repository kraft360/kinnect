// Operator links (FR-61, FR-64): signed with the deploy-time OPERATOR_SECRET.
// Format: base64url(JSON payload) "." base64url(HMAC-SHA256). Also used by scripts/operator.ts.
import { decode, encode } from "../../shared/base64url.ts";

export type OperatorLinkKind = "create_org" | "recover";

export interface OperatorLink {
	kind: OperatorLinkKind;
	linkId: string;
	/** Only for "recover": the Organization to recover. */
	orgId?: string;
	/** Expiry, ms since epoch. */
	exp: number;
}

export const OPERATOR_LINK_LIFETIME_MS: Record<OperatorLinkKind, number> = {
	create_org: 7 * 24 * 60 * 60 * 1000,
	recover: 48 * 60 * 60 * 1000,
};

const text = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", decode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		usage,
	]);
}

export async function signOperatorLink(link: OperatorLink, secret: string): Promise<string> {
	const payload = encode(text.encode(JSON.stringify(link)));
	const signature = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(secret, "sign"),
		text.encode(payload),
	);
	return `${payload}.${encode(signature)}`;
}

export type VerifyResult =
	{ ok: true; link: OperatorLink } | { ok: false; reason: "invalid" | "expired" };

export async function verifyOperatorLink(
	value: string,
	secret: string,
	now = Date.now(),
): Promise<VerifyResult> {
	const [payload, signature, extra] = value.split(".");
	if (!payload || !signature || extra !== undefined) return { ok: false, reason: "invalid" };
	let valid = false;
	try {
		// subtle.verify compares in constant time.
		valid = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret, "verify"),
			decode(signature),
			text.encode(payload),
		);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	if (!valid) return { ok: false, reason: "invalid" };
	const link = JSON.parse(new TextDecoder().decode(decode(payload))) as OperatorLink;
	if (!(link.exp > now)) return { ok: false, reason: "expired" };
	return { ok: true, link };
}
