import { describe, expect, it } from "vitest";
import { addMember, Client, createFamily, invite } from "./helpers.ts";

async function familyWithMember() {
	const { owner } = await createFamily();
	const dadId = await addMember(owner, "dad");
	const dad = new Client();
	await dad.json("POST", "/api/join", {
		...(await invite(owner, dadId)),
		deviceName: "Dad's phone",
	});
	return { owner, dad, dadId };
}

describe("members", () => {
	it("are listed for everyone; device counts only for admins", async () => {
		const { owner, dad } = await familyWithMember();
		const asOwner = await owner.json("GET", "/api/members");
		expect(asOwner.body.map((m: { username: string }) => m.username)).toEqual(["anil", "dad"]);
		expect(asOwner.body[1].activeDevices).toBe(1);

		const asDad = await dad.json("GET", "/api/members");
		expect(asDad.body[1].activeDevices).toBeUndefined();
	});

	it("have usernames unique within the family, ignoring case", async () => {
		const { owner } = await createFamily();
		await addMember(owner, "dad");
		const clash = await owner.json("POST", "/api/members", {
			username: "DAD",
			displayName: "Dad",
			role: "member",
		});
		expect(clash.status).toBe(409);
	});

	it("can only be managed by admins", async () => {
		const { owner, dad, dadId } = await familyWithMember();
		expect(
			(await dad.json("POST", "/api/members", { username: "x1", displayName: "X", role: "member" }))
				.status,
		).toBe(403);
		expect(
			(await dad.json("POST", `/api/members/${dadId}/invites`, { kind: "add_device" })).status,
		).toBe(403);
		expect((await dad.json("PATCH", `/api/members/${dadId}`, { role: "admin" })).status).toBe(403);

		const promoted = await owner.json("PATCH", `/api/members/${dadId}`, {
			role: "admin",
			displayName: "Papa",
		});
		expect(promoted.body).toMatchObject({ role: "admin", displayName: "Papa" });
		expect(
			(await dad.json("POST", "/api/members", { username: "x1", displayName: "X", role: "member" }))
				.status,
		).toBe(201);
	});

	it("never change the owner's role", async () => {
		const { owner, dad, dadId } = await familyWithMember();
		await owner.json("PATCH", `/api/members/${dadId}`, { role: "admin" });
		const ownerId = (await owner.json("GET", "/api/me")).body.member.id;
		expect((await dad.json("PATCH", `/api/members/${ownerId}`, { role: "member" })).status).toBe(
			403,
		);
		expect((await owner.json("PATCH", `/api/members/${ownerId}`, { role: "admin" })).status).toBe(
			403,
		);
		expect((await owner.json("PATCH", `/api/members/${dadId}`, { role: "owner" })).status).toBe(
			400,
		);
	});
});

describe("devices", () => {
	it("are visible to their member and admins only", async () => {
		const { owner, dad, dadId } = await familyWithMember();
		const ownerId = (await owner.json("GET", "/api/me")).body.member.id;
		expect((await dad.json("GET", `/api/members/${dadId}/devices`)).status).toBe(200);
		expect((await dad.json("GET", `/api/members/${ownerId}/devices`)).status).toBe(403);
		expect((await owner.json("GET", `/api/members/${dadId}/devices`)).status).toBe(200);
	});

	it("stop working immediately when revoked by an admin", async () => {
		const { owner, dad, dadId } = await familyWithMember();
		const [device] = (await owner.json("GET", `/api/members/${dadId}/devices`)).body;
		expect((await owner.json("DELETE", `/api/devices/${device.id}`)).status).toBe(200);

		const after = await dad.json("GET", "/api/me");
		expect(after.status).toBe(401);
		expect(dad.cookie).toBe("");
		const listed = (await owner.json("GET", `/api/members/${dadId}/devices`)).body[0];
		expect(listed.revokedAt).toBeTruthy();
	});

	it("can't be revoked by another non-admin member", async () => {
		const { owner, dad } = await familyWithMember();
		const ownerDevice = (await owner.json("GET", "/api/me")).body.device.id;
		expect((await dad.json("DELETE", `/api/devices/${ownerDevice}`)).status).toBe(403);
	});
});
