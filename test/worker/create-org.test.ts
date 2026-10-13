import { describe, expect, it } from "vitest";
import { Client, createFamily, operatorLink, ORIGIN } from "./helpers.ts";

const form = async (link?: string) => ({
	link: link ?? (await operatorLink()),
	orgName: "Sharma family",
	timezone: "Asia/Kolkata",
	username: "anil",
	displayName: "Anil",
	deviceName: "Anil's phone",
});

describe("create organization", () => {
	it("makes whoever opens the link the owner, signed in on this device", async () => {
		const { owner } = await createFamily();
		const me = await owner.json("GET", "/api/me");
		expect(me.status).toBe(200);
		expect(me.body.organization).toMatchObject({ name: "Sharma family", timezone: "Asia/Kolkata" });
		expect(me.body.member).toMatchObject({ username: "anil", displayName: "Anil", role: "owner" });
		expect(me.body.device).toMatchObject({
			name: "Anil's phone",
			pushRegistered: false,
			revokedAt: null,
		});
		expect(me.body.vapidPublicKey).toBeTruthy();
	});

	it("sets an HttpOnly session cookie", async () => {
		const response = await new Client().request("POST", "/api/create-org", await form());
		expect(response.status).toBe(200);
		expect(response.headers.get("Set-Cookie")).toMatch(
			/^kinnect_session=.+; HttpOnly; Secure; SameSite=Lax/,
		);
	});

	it("can be used only once", async () => {
		const link = await operatorLink();
		expect((await new Client().json("POST", "/api/create-org", await form(link))).status).toBe(200);
		const second = await new Client().json("POST", "/api/create-org", await form(link));
		expect(second.status).toBe(409);
	});

	it("rejects expired, tampered and wrong-kind links", async () => {
		const expired = await operatorLink({ exp: Date.now() - 1 });
		expect(
			(await new Client().json("POST", "/api/create-org", await form(expired))).body.error,
		).toMatch(/expired/);

		// Change a character in the middle of the signature (the last one may only hold padding bits).
		const signed = await operatorLink();
		const i = signed.length - 10;
		const tampered = signed.slice(0, i) + (signed[i] === "A" ? "B" : "A") + signed.slice(i + 1);
		expect((await new Client().json("POST", "/api/create-org", await form(tampered))).status).toBe(
			400,
		);

		const recover = await operatorLink({ kind: "recover", orgId: "0".repeat(26) });
		expect((await new Client().json("POST", "/api/create-org", await form(recover))).status).toBe(
			400,
		);
	});

	it("validates the form", async () => {
		const bad = { ...(await form()), username: "a b" };
		const response = await new Client().json("POST", "/api/create-org", bad);
		expect(response.status).toBe(400);
		expect(response.body.error).toMatch(/Username/);
		expect(
			(
				await new Client().json("POST", "/api/create-org", {
					...(await form()),
					timezone: "Mars/Base",
				})
			).status,
		).toBe(400);
	});

	it("refuses cross-site requests", async () => {
		const client = new Client();
		const response = await client.request("POST", "/api/create-org", await form(), {
			Origin: "https://evil.example",
		});
		expect(response.status).toBe(403);
		const noJson = await client.request("POST", "/api/create-org", "x", {
			"Content-Type": "text/plain",
		});
		expect(noJson.status).toBe(415);
	});
});

describe("owner recovery", () => {
	it("signs a new device in as the owner, once", async () => {
		const { orgId } = await createFamily();
		const link = await operatorLink({ kind: "recover", orgId });
		const device = new Client();
		expect(
			(await device.json("POST", "/api/recover", { link, deviceName: "New phone" })).status,
		).toBe(200);
		expect((await device.json("GET", "/api/me")).body.member.role).toBe("owner");
		expect(
			(await new Client().json("POST", "/api/recover", { link, deviceName: "Another" })).status,
		).toBe(409);
	});
});

describe("sessions", () => {
	it("require a valid cookie", async () => {
		expect((await new Client().json("GET", "/api/me")).status).toBe(401);
		const forged = new Client();
		forged.cookie = "kinnect_session=not-a-token";
		expect((await forged.json("GET", "/api/me")).status).toBe(401);
	});

	it("end on sign-out, and the cookie is cleared", async () => {
		const { owner } = await createFamily();
		const saved = owner.cookie;
		const response = await owner.request("POST", "/api/sign-out", {});
		expect(response.status).toBe(200);
		expect(owner.cookie).toBe("");

		const replay = new Client();
		replay.cookie = saved;
		expect((await replay.json("GET", "/api/me")).status).toBe(401);
	});

	it("register a push subscription for the current device", async () => {
		const { owner } = await createFamily();
		const subscription = {
			endpoint: "https://fcm.googleapis.com/fcm/send/abc",
			keys: { p256dh: "key", auth: "auth" },
		};
		expect((await owner.json("PUT", "/api/me/push", { subscription })).status).toBe(200);
		expect((await owner.json("GET", "/api/me")).body.device.pushRegistered).toBe(true);
		expect(
			(await owner.json("PUT", "/api/me/push", { subscription: { endpoint: "http://insecure" } }))
				.status,
		).toBe(400);
	});

	it("accept push endpoints only from the browsers' push services", async () => {
		const { owner } = await createFamily();
		const put = async (endpoint: string) =>
			(
				await owner.json("PUT", "/api/me/push", {
					subscription: { endpoint, keys: { p256dh: "key", auth: "auth" } },
				})
			).status;
		expect(await put("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(200);
		expect(await put("https://web.push.apple.com/abc")).toBe(200);
		expect(await put("https://wns2-par02p.notify.windows.com/w/?token=abc")).toBe(200);
		for (const endpoint of [
			"https://example.com/fcm/send/abc",
			"https://fcm.googleapis.com.evil.example/abc",
			"https://evilfcm.googleapis.com/abc",
			"https://fcm.googleapis.com:8443/abc",
			"https://user@fcm.googleapis.com/abc",
			"https://169.254.169.254/latest",
			"not a url",
		]) {
			expect(await put(endpoint), endpoint).toBe(400);
		}
	});
});

it("serves the API only under /api", async () => {
	expect((await new Client().request("GET", "/not-api")).status).toBe(404);
	expect(ORIGIN).toBe("https://kinnect.test");
});
