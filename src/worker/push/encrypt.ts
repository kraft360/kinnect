// Web Push message encryption, RFC 8291 (aes128gcm content coding, RFC 8188).
import { concat, decode, encode } from "../../shared/base64url.ts";

const RECORD_SIZE = 4096;
const text = new TextEncoder();

export interface PushKeys {
	/** Browser's P-256 public key, base64url (uncompressed, 65 bytes). */
	p256dh: string;
	/** Browser's auth secret, base64url (16 bytes). */
	auth: string;
}

/** Only for tests: fixed server key pair and salt instead of random ones. */
export interface EncryptFixture {
	serverPublicKey: string;
	serverPrivateKey: string;
	salt: string;
}

// Inputs are never backed by a SharedArrayBuffer (TextEncoder output is typed as if they could be).
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const k = await crypto.subtle.importKey(
		"raw",
		key as Uint8Array<ArrayBuffer>,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as Uint8Array<ArrayBuffer>));
}

/** ECDH algorithm parameters. The Workers types name the field `$public`, but the runtime reads `public`. */
export function ecdh(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
	const algorithm = { name: "ECDH", public: publicKey };
	return algorithm;
}

/** Imports a P-256 private key from its raw `d` value and uncompressed public key. */
export function importP256PrivateKey(
	d: string,
	publicKey: Uint8Array,
	usage: "ecdh" | "ecdsa",
): Promise<CryptoKey> {
	const jwk: JsonWebKey = {
		kty: "EC",
		crv: "P-256",
		d,
		x: encode(publicKey.slice(1, 33)),
		y: encode(publicKey.slice(33, 65)),
		ext: true,
	};
	return usage === "ecdh"
		? crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, [
				"deriveBits",
			])
		: crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function serverKeys(
	fixture?: EncryptFixture,
): Promise<{ publicKey: Uint8Array<ArrayBuffer>; privateKey: CryptoKey }> {
	if (fixture) {
		const publicKey = decode(fixture.serverPublicKey);
		return {
			publicKey,
			privateKey: await importP256PrivateKey(fixture.serverPrivateKey, publicKey, "ecdh"),
		};
	}
	const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	])) as CryptoKeyPair;
	const publicKey = new Uint8Array(
		(await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
	);
	return { publicKey, privateKey: pair.privateKey };
}

/** Encrypts a payload for one push subscription. Returns the full request body. */
export async function encryptPayload(
	keys: PushKeys,
	payload: string,
	fixture?: EncryptFixture,
): Promise<Uint8Array<ArrayBuffer>> {
	const uaPublic = decode(keys.p256dh);
	const authSecret = decode(keys.auth);
	const salt = fixture ? decode(fixture.salt) : crypto.getRandomValues(new Uint8Array(16));
	const server = await serverKeys(fixture);

	const uaKey = await crypto.subtle.importKey(
		"raw",
		uaPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits(ecdh(uaKey), server.privateKey, 256),
	);

	// IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
	const prkKey = await hmac(authSecret, ecdhSecret);
	const keyInfo = concat(
		text.encode("WebPush: info\0"),
		uaPublic,
		server.publicKey,
		new Uint8Array([1]),
	);
	const ikm = await hmac(prkKey, keyInfo);

	// CEK and nonce from HKDF(salt, IKM)
	const prk = await hmac(salt, ikm);
	const cek = new Uint8Array(
		(await hmac(prk, text.encode("Content-Encoding: aes128gcm\0\x01"))).subarray(0, 16),
	);
	const nonce = new Uint8Array(
		(await hmac(prk, text.encode("Content-Encoding: nonce\0\x01"))).subarray(0, 12),
	);

	// Single record: plaintext followed by the 0x02 "last record" delimiter.
	const plaintext = concat(text.encode(payload), new Uint8Array([2]));
	if (plaintext.length + 16 + 86 > RECORD_SIZE) throw new Error("Push payload too large");
	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext),
	);

	// Header: salt (16) || record size (uint32 BE) || key id length (1) || key id (server public key)
	const header = new Uint8Array(16 + 4 + 1);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = server.publicKey.length;
	return concat(header, server.publicKey, ciphertext);
}
