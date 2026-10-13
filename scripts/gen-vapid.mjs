// Generates a VAPID key pair.
// Writes the public key into wrangler.jsonc and the secrets into .dev.vars.
// First deploy uploads the secret with: npx wrangler deploy --secrets-file .dev.vars
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

if (existsSync(".dev.vars") && !process.argv.includes("--force")) {
	console.error(
		".dev.vars already exists; pass --force to replace the keys (existing subscriptions will stop working).",
	);
	process.exit(1);
}

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
	"sign",
	"verify",
]);
const publicKey = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);

writeFileSync(".dev.vars", `VAPID_PRIVATE_KEY=${d}\n`);

const config = readFileSync("wrangler.jsonc", "utf8").replace(
	/"VAPID_PUBLIC_KEY": "[^"]*"/,
	`"VAPID_PUBLIC_KEY": "${publicKey}"`,
);
writeFileSync("wrangler.jsonc", config);

console.log(`VAPID public key written to wrangler.jsonc: ${publicKey}`);
console.log("Private key written to .dev.vars.");
