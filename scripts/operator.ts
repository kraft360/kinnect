// Operator commands (requirements FR-61, FR-64). Run with: npm run operator -- <command>
//
//   init-secret                 Adds OPERATOR_SECRET to .dev.vars if missing.
//   create-org                  Prints a single-use "create family" link (valid 7 days).
//   recover <orgId>             Prints a single-use link that signs a new device in as the owner (48 hours).
//
// Options: --base-url <url>    Default: APP_URL from .dev.vars
//
// Links are signed with OPERATOR_SECRET from .dev.vars, which must match the
// deployed secret (npx wrangler secret put OPERATOR_SECRET).
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { encode } from "../src/shared/base64url.ts";
import { isOrgId } from "../src/shared/ids.ts";
import {
	OPERATOR_LINK_LIFETIME_MS,
	signOperatorLink,
	type OperatorLink,
} from "../src/worker/auth/operator-link.ts";

const DEV_VARS = ".dev.vars";
const args = process.argv.slice(2);
const option = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const baseUrlOption = option("--base-url");
const [command, argument] = args;

function readVar(name: string): string | undefined {
	if (!existsSync(DEV_VARS)) return undefined;
	return readFileSync(DEV_VARS, "utf8")
		.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]
		.trim();
}

function requireSecret(): string {
	const secret = readVar("OPERATOR_SECRET");
	if (!secret) {
		console.error(
			"OPERATOR_SECRET is missing from .dev.vars. Run: npm run operator -- init-secret",
		);
		process.exit(1);
	}
	return secret;
}

function requireBaseUrl(): string {
	const url = baseUrlOption ?? readVar("APP_URL");
	if (!url) {
		console.error("Set APP_URL in .dev.vars (see docs/deploy.md) or pass --base-url <url>.");
		process.exit(1);
	}
	// http:// is allowed only for local testing; push services reject reminders from an http: APP_URL.
	if (!/^https:\/\/[^/]+|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) {
		console.error(
			`${url} isn't a valid address: it should look like https://kinnect.<your-subdomain>.workers.dev`,
		);
		process.exit(1);
	}
	return url.replace(/\/$/, "");
}

async function printLink(link: OperatorLink, path: string, description: string): Promise<void> {
	const baseUrl = requireBaseUrl();
	const signed = await signOperatorLink(link, requireSecret());
	console.log(`${description} (single use, expires ${new Date(link.exp).toLocaleString()}):\n`);
	console.log(`${baseUrl}/#/${path}/${signed}\n`);
}

switch (command) {
	case "init-secret": {
		if (readVar("OPERATOR_SECRET")) {
			console.log("OPERATOR_SECRET already exists in .dev.vars.");
			break;
		}
		appendFileSync(
			DEV_VARS,
			`OPERATOR_SECRET=${encode(crypto.getRandomValues(new Uint8Array(32)))}\n`,
		);
		console.log(
			"OPERATOR_SECRET added to .dev.vars. Upload it with: npx wrangler secret put OPERATOR_SECRET",
		);
		break;
	}
	case "create-org":
		await printLink(
			{
				kind: "create_org",
				linkId: randomUUID(),
				exp: Date.now() + OPERATOR_LINK_LIFETIME_MS.create_org,
			},
			"create",
			"Create-family link",
		);
		break;
	case "recover":
		if (!argument || !isOrgId(argument)) {
			console.error("Usage: npm run operator -- recover <orgId>");
			process.exit(1);
		}
		await printLink(
			{
				kind: "recover",
				linkId: randomUUID(),
				orgId: argument,
				exp: Date.now() + OPERATOR_LINK_LIFETIME_MS.recover,
			},
			"recover",
			"Owner recovery link",
		);
		break;
	default:
		console.error(
			"Commands: init-secret | create-org | recover <orgId>   (option: --base-url <url>)",
		);
		process.exit(1);
}
