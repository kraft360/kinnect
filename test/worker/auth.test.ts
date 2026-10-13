import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { formatJoinCode, newJoinCode, normalizeJoinCode } from "../../src/worker/auth/codes.ts";
import { signOperatorLink, verifyOperatorLink } from "../../src/worker/auth/operator-link.ts";
import { parseSessionToken, readCookie, sessionCookie } from "../../src/worker/auth/session.ts";
import { newOrgId } from "../../src/shared/ids.ts";
import { randomToken, sha256 } from "../../src/worker/auth/crypto.ts";

describe("join codes", () => {
	it("are 6 characters from the Crockford alphabet", () => {
		for (let i = 0; i < 200; i++) expect(newJoinCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
	});

	it("accept what people type", () => {
		const code = "K7M42Q";
		expect(formatJoinCode(code)).toBe("K7M-42Q");
		expect(normalizeJoinCode("k7m-42q")).toBe(code);
		expect(normalizeJoinCode(" K7M 42Q ")).toBe(code);
		expect(normalizeJoinCode("1O0-IL1")).toBe("100111");
		expect(normalizeJoinCode("K7M-42")).toBeNull();
		expect(normalizeJoinCode("K7M-42U")).toBeNull();
	});
});

describe("operator links", () => {
	const link = { kind: "create_org" as const, linkId: "link-1", exp: Date.now() + 60_000 };

	it("verify when signed with the same secret", async () => {
		const result = await verifyOperatorLink(
			await signOperatorLink(link, env.OPERATOR_SECRET),
			env.OPERATOR_SECRET,
		);
		expect(result).toEqual({ ok: true, link });
	});

	it("reject another secret, tampering and expiry", async () => {
		const signed = await signOperatorLink(link, env.OPERATOR_SECRET);
		expect(await verifyOperatorLink(signed, randomToken())).toEqual({
			ok: false,
			reason: "invalid",
		});

		const [, signature] = signed.split(".");
		const forged = btoa(JSON.stringify({ ...link, kind: "recover" })).replace(/=+$/, "");
		expect(await verifyOperatorLink(`${forged}.${signature}`, env.OPERATOR_SECRET)).toEqual({
			ok: false,
			reason: "invalid",
		});

		expect(await verifyOperatorLink("garbage", env.OPERATOR_SECRET)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(await verifyOperatorLink(signed, env.OPERATOR_SECRET, link.exp + 1)).toEqual({
			ok: false,
			reason: "expired",
		});
	});
});

describe("session tokens", () => {
	it("parse into routing ids and a hash of the random part", async () => {
		const orgId = newOrgId();
		const deviceId = crypto.randomUUID();
		const random = randomToken();
		const parsed = await parseSessionToken(`${orgId}.${deviceId}.${random}`);
		expect(parsed).toMatchObject({ orgId, deviceId, tokenHash: await sha256(random) });
	});

	it("reject malformed tokens", async () => {
		const good = `${newOrgId()}.${crypto.randomUUID()}.${randomToken()}`;
		for (const token of ["", "a.b.c", `${good}.extra`, good.replace(/\.[^.]+$/, ".short")]) {
			expect(await parseSessionToken(token)).toBeNull();
		}
	});

	it("travel in a secure, script-proof cookie", () => {
		const cookie = sessionCookie("value");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");
		expect(
			readCookie(
				new Request("https://x", { headers: { Cookie: "a=1; kinnect_session=abc=; b=2" } }),
				"kinnect_session",
			),
		).toBe("abc=");
	});
});
