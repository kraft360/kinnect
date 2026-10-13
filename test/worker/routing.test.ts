import { describe, expect, it } from "vitest";
import { isOrgId, newOrgId } from "../../src/shared/ids.ts";
import { directoryMigrations } from "../../src/worker/directory/schema.ts";
import { Client, createFamily } from "./helpers.ts";

describe("routing", () => {
	it("answers the Directory health check", async () => {
		const response = await new Client().json("GET", "/api/directory/health");
		expect(response).toEqual({
			status: 200,
			body: { ok: true, schemaVersion: directoryMigrations.length },
		});
	});

	it("requires a session for anything that isn't public", async () => {
		expect((await new Client().request("GET", "/api/members")).status).toBe(401);
		expect((await new Client().request("GET", "/api/nothing")).status).toBe(401);
	});

	it("answers 405 when only the method is wrong", async () => {
		expect((await new Client().request("GET", "/api/create-org")).status).toBe(405);
	});

	it("answers 400, not 500, for malformed percent-encoding in the path", async () => {
		const { owner } = await createFamily();
		expect(await owner.json("GET", "/api/members/%E0/devices")).toEqual({
			status: 400,
			body: { error: "Malformed URL." },
		});
		expect((await owner.request("DELETE", "/api/teams/%/members/x")).status).toBe(400);
	});

	it("rejects bodies that aren't JSON objects", async () => {
		expect((await new Client().request("POST", "/api/join/preview", [1, 2])).status).toBe(400);
	});
});

describe("ids", () => {
	it("generates distinct, valid organization ids", () => {
		const ids = new Set(Array.from({ length: 1000 }, newOrgId));
		expect(ids.size).toBe(1000);
		for (const id of ids) expect(isOrgId(id)).toBe(true);
	});
});
