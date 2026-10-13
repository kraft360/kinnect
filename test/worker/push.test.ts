import { describe, expect, it } from "vitest";
import { concat, decode, encode } from "../../src/shared/base64url.ts";
import { ecdh, encryptPayload, importP256PrivateKey } from "../../src/worker/push/encrypt.ts";
import { sendPush } from "../../src/worker/push/send.ts";
import { signVapidJwt, vapidAuthorization, type VapidConfig } from "../../src/worker/push/vapid.ts";

// RFC 8291, Appendix A.
const rfc = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPublic:
		"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	uaPublic:
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const text = new TextEncoder();
const hmac = async (key: Uint8Array, data: Uint8Array) =>
	new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			await crypto.subtle.importKey(
				"raw",
				key as Uint8Array<ArrayBuffer>,
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			),
			data as Uint8Array<ArrayBuffer>,
		),
	);

// Independent decryption as the browser would do it, used for random-key round trips.
async function decrypt(
	body: Uint8Array<ArrayBuffer>,
	uaPublic: string,
	uaPrivate: string,
	authSecret: string,
): Promise<string> {
	const salt = body.slice(0, 16);
	const idLength = body[20];
	const asPublic = body.slice(21, 21 + idLength);
	const ciphertext = body.slice(21 + idLength);
	const uaPub = decode(uaPublic);
	const uaKey = await importP256PrivateKey(uaPrivate, uaPub, "ecdh");
	const asKey = await crypto.subtle.importKey(
		"raw",
		asPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(asKey), uaKey, 256));
	const ikm = await hmac(
		await hmac(decode(authSecret), shared),
		concat(text.encode("WebPush: info\0"), uaPub, asPublic, new Uint8Array([1])),
	);
	const prk = await hmac(salt, ikm);
	const cek = new Uint8Array(
		(await hmac(prk, text.encode("Content-Encoding: aes128gcm\0\x01"))).subarray(0, 16),
	);
	const nonce = new Uint8Array(
		(await hmac(prk, text.encode("Content-Encoding: nonce\0\x01"))).subarray(0, 12),
	);
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const padded = new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
	);
	expect(padded[padded.length - 1]).toBe(2);
	return new TextDecoder().decode(padded.slice(0, -1));
}

async function newP256Pair(): Promise<{ publicKey: string; privateKey: string }> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const publicKey = encode((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const { d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
	return { publicKey, privateKey: d! };
}

describe("encryptPayload", () => {
	it("matches the RFC 8291 test vector", async () => {
		const body = await encryptPayload(
			{ p256dh: rfc.uaPublic, auth: rfc.authSecret },
			rfc.plaintext,
			{
				serverPublicKey: rfc.asPublic,
				serverPrivateKey: rfc.asPrivate,
				salt: rfc.salt,
			},
		);
		expect(encode(body)).toBe(rfc.body);
	});

	it("round-trips with a random server key and salt", async () => {
		const ua = await newP256Pair();
		const auth = encode(crypto.getRandomValues(new Uint8Array(16)));
		const message = JSON.stringify({ alertId: 7, title: "Medicines", body: "due now" });
		const body = await encryptPayload({ p256dh: ua.publicKey, auth }, message);
		expect(await decrypt(body, ua.publicKey, ua.privateKey, auth)).toBe(message);
	});

	it("rejects payloads that don't fit in one record", async () => {
		await expect(
			encryptPayload({ p256dh: rfc.uaPublic, auth: rfc.authSecret }, "x".repeat(4000)),
		).rejects.toThrow("too large");
	});
});

describe("VAPID", () => {
	it("signs an ES256 JWT that verifies with the public key", async () => {
		const keys = await newP256Pair();
		const vapid: VapidConfig = { ...keys, subject: "mailto:test@example.com" };
		const jwt = await signVapidJwt(vapid, "https://fcm.googleapis.com", 1_000_000);
		const [header, claims, signature] = jwt.split(".");

		expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({
			typ: "JWT",
			alg: "ES256",
		});
		expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toEqual({
			aud: "https://fcm.googleapis.com",
			exp: 1_000_000 + 24 * 3600,
			sub: "mailto:test@example.com",
		});
		const publicKey = await crypto.subtle.importKey(
			"raw",
			decode(keys.publicKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			publicKey,
			decode(signature),
			text.encode(`${header}.${claims}`),
		);
		expect(valid).toBe(true);
	});

	it("reuses the token for the same push service", async () => {
		const vapid: VapidConfig = { ...(await newP256Pair()), subject: "mailto:test@example.com" };
		const a = await vapidAuthorization(vapid, "https://fcm.googleapis.com/fcm/send/abc");
		const b = await vapidAuthorization(vapid, "https://fcm.googleapis.com/fcm/send/def");
		const c = await vapidAuthorization(
			vapid,
			"https://updates.push.services.mozilla.com/wpush/v2/xyz",
		);
		expect(a).toBe(b);
		expect(c).not.toBe(a);
		expect(a).toMatch(new RegExp(`^vapid t=.+, k=${vapid.publicKey}$`));
	});
});

describe("sendPush", () => {
	it("drops a stored subscription that isn't on a browser push service, without sending", async () => {
		const vapid: VapidConfig = { ...(await newP256Pair()), subject: "https://kinnect.test" };
		const subscription = {
			endpoint: "https://169.254.169.254/latest",
			keys: { p256dh: rfc.uaPublic, auth: rfc.authSecret },
		};
		expect(await sendPush(subscription, { title: "Hi" }, { ttl: 60 }, vapid)).toEqual({
			status: 0,
			gone: true,
		});
	});
});
