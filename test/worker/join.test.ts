import { describe, expect, it } from "vitest";
import { JOIN_LIMIT_PER_IP } from "../../src/worker/directory/directory-do.ts";
import { addMember, Client, createFamily, invite } from "./helpers.ts";

describe("join by link", () => {
	it("previews without using the invite, then joins once", async () => {
		const { owner } = await createFamily();
		const dadId = await addMember(owner, "dad");
		const { orgId, token, url } = await invite(owner, dadId);
		expect(url).toMatch(/^https:\/\/kinnect\.test\/#\/join\//);

		const dad = new Client();
		for (let i = 0; i < 2; i++) {
			const preview = await dad.json("POST", "/api/join/preview", { orgId, token });
			expect(preview).toEqual({
				status: 200,
				body: { orgName: "Sharma family", displayName: "dad" },
			});
		}

		expect(
			(await dad.json("POST", "/api/join", { orgId, token, deviceName: "Dad's phone" })).status,
		).toBe(200);
		const me = await dad.json("GET", "/api/me");
		expect(me.body.member).toMatchObject({ username: "dad", role: "member" });

		const again = await new Client().json("POST", "/api/join", {
			orgId,
			token,
			deviceName: "Someone else",
		});
		expect(again.status).toBe(409);
		expect((await new Client().json("POST", "/api/join/preview", { orgId, token })).status).toBe(
			409,
		);
	});

	it("rejects unknown tokens and organizations", async () => {
		const { orgId } = await createFamily();
		expect(
			(await new Client().json("POST", "/api/join/preview", { orgId, token: "nope" })).status,
		).toBe(404);
		expect(
			(await new Client().json("POST", "/api/join/preview", { orgId: "bad", token: "nope" }))
				.status,
		).toBe(404);
	});

	it("stops the previous invite working when a new one is issued", async () => {
		const { owner } = await createFamily();
		const dadId = await addMember(owner, "dad");
		const first = await invite(owner, dadId);
		const second = await invite(owner, dadId);

		expect((await new Client().json("POST", "/api/join/preview", first)).status).toBe(404);
		expect(
			(await new Client().json("POST", "/api/join-code/preview", { code: first.code })).status,
		).toBe(404);
		expect((await new Client().json("POST", "/api/join/preview", second)).status).toBe(200);
	});

	it("adds a second device for an existing member", async () => {
		const { owner } = await createFamily();
		const dadId = await addMember(owner, "dad");
		await new Client().json("POST", "/api/join", {
			...(await invite(owner, dadId)),
			deviceName: "Phone",
		});
		await new Client().json("POST", "/api/join", {
			...(await invite(owner, dadId, "add_device")),
			deviceName: "Tablet",
		});

		const devices = await owner.json("GET", `/api/members/${dadId}/devices`);
		expect(devices.body.map((d: { name: string }) => d.name).sort()).toEqual(["Phone", "Tablet"]);
	});
});

describe("join by code", () => {
	it("accepts the code as typed and signs the device in", async () => {
		const { owner } = await createFamily();
		const momId = await addMember(owner, "mom");
		const { code } = await invite(owner, momId);
		expect(code).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);

		const mom = new Client("198.51.100.7");
		const typed = code.toLowerCase().replace("-", " ");
		expect((await mom.json("POST", "/api/join-code/preview", { code: typed })).body).toEqual({
			orgName: "Sharma family",
			displayName: "mom",
		});
		expect(
			(await mom.json("POST", "/api/join-code", { code: typed, deviceName: "Mom's iPhone" }))
				.status,
		).toBe(200);
		expect((await mom.json("GET", "/api/me")).body.member.username).toBe("mom");

		// The code is gone once used.
		expect(
			(await new Client("198.51.100.8").json("POST", "/api/join-code/preview", { code })).status,
		).toBe(404);
	});

	it("rejects malformed codes without a lookup", async () => {
		const response = await new Client().json("POST", "/api/join-code/preview", { code: "12" });
		expect(response.status).toBe(400);
	});

	it("limits attempts per IP address", async () => {
		const guesser = new Client("192.0.2.99");
		for (let i = 0; i < JOIN_LIMIT_PER_IP; i++) {
			expect(
				(await guesser.json("POST", "/api/join-code/preview", { code: "AAAAAA" })).status,
			).toBe(404);
		}
		expect((await guesser.json("POST", "/api/join-code/preview", { code: "AAAAAA" })).status).toBe(
			429,
		);
		expect(
			(await new Client("192.0.2.100").json("POST", "/api/join-code/preview", { code: "AAAAAA" }))
				.status,
		).toBe(404);
	});
});
