import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway VAPID key pair so tests never need the real secret.
const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
	"sign",
	"verify",
])) as CryptoKeyPair;
const vapidPublicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
	"base64url",
);
const { d: vapidPrivateKey } = await crypto.subtle.exportKey("jwk", pair.privateKey);
const TEST_OPERATOR_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
	"base64url",
);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					VAPID_PUBLIC_KEY: vapidPublicKey,
					VAPID_PRIVATE_KEY: vapidPrivateKey!,
					OPERATOR_SECRET: TEST_OPERATOR_SECRET,
					APP_URL: "https://kinnect.test",
				},
			},
		}),
	],
	test: { include: ["test/worker/**/*.test.ts", "test/shared/**/*.test.ts"] },
});
