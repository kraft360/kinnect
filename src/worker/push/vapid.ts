// VAPID authentication for Web Push, RFC 8292.
import { decode, encode } from "../../shared/base64url.ts";
import { importP256PrivateKey } from "./encrypt.ts";

export interface VapidConfig {
	/** Uncompressed P-256 public key, base64url. Also used as the browser's applicationServerKey. */
	publicKey: string;
	/** Private key `d` value, base64url. */
	privateKey: string;
	/** Contact for push services: "mailto:..." or an https URL. */
	subject: string;
}

const JWT_LIFETIME_S = 24 * 60 * 60;
const JWT_REUSE_S = 12 * 60 * 60;
const text = new TextEncoder();

// Signed tokens are reused per push-service origin to save an ECDSA signature per push.
const tokenCache = new Map<string, { token: string; reuseUntil: number }>();
let signingKey: { publicKey: string; key: Promise<CryptoKey> } | undefined;

function getSigningKey(vapid: VapidConfig): Promise<CryptoKey> {
	if (signingKey?.publicKey !== vapid.publicKey) {
		signingKey = {
			publicKey: vapid.publicKey,
			key: importP256PrivateKey(vapid.privateKey, decode(vapid.publicKey), "ecdsa"),
		};
	}
	return signingKey.key;
}

export async function signVapidJwt(
	vapid: VapidConfig,
	audience: string,
	nowS = Math.floor(Date.now() / 1000),
): Promise<string> {
	const header = encode(text.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = encode(
		text.encode(JSON.stringify({ aud: audience, exp: nowS + JWT_LIFETIME_S, sub: vapid.subject })),
	);
	const unsigned = `${header}.${claims}`;
	// WebCrypto returns the raw r || s signature, which is the JWS ES256 format.
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		await getSigningKey(vapid),
		text.encode(unsigned),
	);
	return `${unsigned}.${encode(signature)}`;
}

/** Returns the Authorization header value for a push endpoint. */
export async function vapidAuthorization(vapid: VapidConfig, endpoint: string): Promise<string> {
	const audience = new URL(endpoint).origin;
	const nowS = Math.floor(Date.now() / 1000);
	let cached = tokenCache.get(audience);
	if (!cached || cached.reuseUntil <= nowS) {
		cached = { token: await signVapidJwt(vapid, audience, nowS), reuseUntil: nowS + JWT_REUSE_S };
		tokenCache.set(audience, cached);
	}
	return `vapid t=${cached.token}, k=${vapid.publicKey}`;
}
