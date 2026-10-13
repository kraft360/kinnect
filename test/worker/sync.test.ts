import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addMember, Client, createFamily, invite, op, ORIGIN, sync, uuid } from "./helpers.ts";

async function family() {
	const { owner, orgId } = await createFamily();
	const dadId = await addMember(owner, "dad");
	const sonId = await addMember(owner, "son");
	const dad = new Client();
	await dad.json("POST", "/api/join", {
		...(await invite(owner, dadId)),
		deviceName: "Dad's phone",
	});
	const son = new Client();
	await son.json("POST", "/api/join", {
		...(await invite(owner, sonId)),
		deviceName: "Son's phone",
	});
	const home = (await owner.json("POST", "/api/teams", { name: "Home" })).body.id as string;
	await owner.json("PUT", `/api/teams/${home}/members/${dadId}`);
	return { owner, orgId, dad, dadId, son, sonId, home };
}

describe("connecting", () => {
	it("gets a snapshot of what the member may see", async () => {
		const { owner, dad, son, home } = await family();
		await op(dad, { type: "task.create", id: uuid(), title: "Household list", teamId: home });
		await op(son, { type: "task.create", id: uuid(), title: "Family task" });

		const forSon = (await sync(son)).first;
		expect(forSon.type).toBe("snapshot");
		expect(forSon.tasks.map((t: { title: string }) => t.title)).toEqual(["Family task"]);
		expect(forSon.teams).toEqual([]);
		expect(forSon.members.map((m: { username: string }) => m.username).sort()).toEqual([
			"anil",
			"dad",
			"son",
		]);

		const forDad = (await sync(dad)).first;
		expect(forDad.tasks).toHaveLength(2);
		expect(forDad.teams.map((t: { name: string }) => t.name)).toEqual(["Home"]);

		const forOwner = (await sync(owner)).first;
		expect(forOwner.tasks).toHaveLength(2);
		expect(forOwner.version).toBeGreaterThan(0);
	});

	it("requires a session and the app's own origin", async () => {
		const { dad } = await family();
		const anonymous = await exports.default.fetch(
			new Request(`${ORIGIN}/api/sync`, { headers: { Upgrade: "websocket", Origin: ORIGIN } }),
		);
		expect(anonymous.status).toBe(401);
		const crossSite = await exports.default.fetch(
			new Request(`${ORIGIN}/api/sync`, {
				headers: { Upgrade: "websocket", Origin: "https://evil.example", Cookie: dad.cookie },
			}),
		);
		expect(crossSite.status).toBe(403);
		expect((await dad.request("GET", "/api/sync")).status).toBe(426);
	});
});

describe("live changes", () => {
	it("reach other open devices that can see the task, in order", async () => {
		const { owner, dad, son, home } = await family();
		const { live: ownerLive } = await sync(owner);
		const { live: sonLive } = await sync(son);

		const id = uuid();
		await op(dad, { type: "task.create", id, title: "Shopping", teamId: home });
		const milk = uuid();
		await op(dad, { type: "subtask.add", taskId: id, id: milk, title: "Milk", position: 1 });

		const first = await ownerLive.next();
		const second = await ownerLive.next();
		expect(first.changes[0]).toMatchObject({ entity: "task", id, op: "upsert" });
		expect(second.changes[0].data.subtasks[0].title).toBe("Milk");
		expect(second.changes[0].version).toBeGreaterThan(first.changes[0].version);

		// The son isn't in the household, so he gets nothing; his next message is about a family-wide task.
		await op(dad, { type: "task.create", id: uuid(), title: "For everyone" });
		const forSon = await sonLive.next();
		expect(forSon.changes.map((c: { data: { title: string } }) => c.data.title)).toEqual([
			"For everyone",
		]);
	});

	it("tell devices a task is gone when it moves out of their scope", async () => {
		const { owner, son, home } = await family();
		const id = uuid();
		await op(owner, { type: "task.create", id, title: "Was family-wide" });
		const { live } = await sync(son);
		await op(owner, { type: "task.update", id, changes: { teamId: home } });
		expect((await live.next()).changes).toEqual([
			expect.objectContaining({ entity: "task", id, op: "remove" }),
		]);
	});

	it("send a fresh snapshot when someone joins or leaves a household (FR-83, FR-84)", async () => {
		const { owner, dad, son, sonId, home } = await family();
		await op(dad, { type: "task.create", id: uuid(), title: "Household list", teamId: home });
		const { live } = await sync(son);

		await owner.json("PUT", `/api/teams/${home}/members/${sonId}`);
		// The household update may arrive first; the snapshot follows (and supersedes it).
		let joined = await live.next();
		if (joined.type === "changes") joined = await live.next();
		expect(joined.type).toBe("snapshot");
		expect(joined.tasks.map((t: { title: string }) => t.title)).toEqual(["Household list"]);

		await owner.json("DELETE", `/api/teams/${home}/members/${sonId}`);
		const left = await live.next();
		expect(left.type).toBe("snapshot");
		expect(left.tasks).toEqual([]);
	});

	it("close a device's connection when it's signed out (FR-78)", async () => {
		const { owner, dad, dadId } = await family();
		const { live } = await sync(dad);
		const [device] = (await owner.json("GET", `/api/members/${dadId}/devices`)).body;
		await owner.json("DELETE", `/api/devices/${device.id}`);
		expect(await live.closed).toBe(4401);
	});
});

describe("reconnecting (FR-52)", () => {
	it("gets only the changes it missed", async () => {
		const { dad, home } = await family();
		const { live, first } = await sync(dad);
		live.ws.close();

		const id = uuid();
		await op(dad, { type: "task.create", id, title: "While away", teamId: home });
		const reply = (await sync(dad, first.version)).first;
		expect(reply.type).toBe("changes");
		expect(reply.changes.map((c: { id: string }) => c.id)).toEqual([id]);

		const upToDate = (await sync(dad, reply.changes[0].version)).first;
		expect(upToDate).toEqual({ type: "changes", changes: [] });
	});

	it("gets a snapshot when its version is unknown or older than the log", async () => {
		const { owner, orgId, dad } = await family();
		await op(owner, { type: "task.create", id: uuid(), title: "Old" });
		expect((await sync(dad, 999_999)).first.type).toBe("snapshot");

		await runInDurableObject(env.ORG.get(env.ORG.idFromName(orgId)), (_, state) => {
			state.storage.sql.exec("DELETE FROM change_log WHERE version <= 3");
		});
		expect((await sync(dad, 1)).first.type).toBe("snapshot");
	});

	describe("gets a snapshot when what it can see changed while it was away (FR-83, FR-84)", () => {
		async function away() {
			const f = await family();
			await op(f.dad, { type: "task.create", id: uuid(), title: "Household list", teamId: f.home });
			const { live, first } = await sync(f.son);
			live.ws.close();
			const { live: dadLive, first: dadFirst } = await sync(f.dad);
			dadLive.ws.close();
			return { ...f, sonVersion: first.version as number, dadVersion: dadFirst.version as number };
		}
		const titles = (reply: { tasks: { title: string }[] }) => reply.tasks.map((t) => t.title);

		it("added to a household", async () => {
			const { owner, son, sonId, home, sonVersion } = await away();
			await owner.json("PUT", `/api/teams/${home}/members/${sonId}`);
			const reply = (await sync(son, sonVersion)).first;
			expect(reply.type).toBe("snapshot");
			expect(titles(reply)).toEqual(["Household list"]);
		});

		it("removed from a household", async () => {
			const { owner, dad, dadId, home, dadVersion } = await away();
			await owner.json("DELETE", `/api/teams/${home}/members/${dadId}`);
			const reply = (await sync(dad, dadVersion)).first;
			expect(reply.type).toBe("snapshot");
			expect(reply.tasks).toEqual([]);
		});

		it("the household deleted", async () => {
			const { owner, dad, home, dadVersion } = await away();
			await owner.json("DELETE", `/api/teams/${home}?tasks=archive`);
			const reply = (await sync(dad, dadVersion)).first;
			expect(reply.type).toBe("snapshot");
			expect(reply.tasks).toEqual([]);
		});

		it("made an admin, then demoted", async () => {
			const { owner, son, sonId, sonVersion } = await away();
			await owner.json("PATCH", `/api/members/${sonId}`, { role: "admin" });
			const promoted = (await sync(son, sonVersion)).first;
			expect(promoted.type).toBe("snapshot");
			expect(titles(promoted)).toEqual(["Household list"]);

			await owner.json("PATCH", `/api/members/${sonId}`, { role: "member" });
			const demoted = (await sync(son, promoted.version)).first;
			expect(demoted.type).toBe("snapshot");
			expect(demoted.tasks).toEqual([]);
		});

		it("but not when it already got the snapshot while connected", async () => {
			const { owner, son, sonId, home } = await away();
			const { live } = await sync(son);
			await owner.json("PUT", `/api/teams/${home}/members/${sonId}`);
			let joined = await live.next();
			if (joined.type === "changes") joined = await live.next();
			live.ws.close();
			expect((await sync(son, joined.version)).first).toEqual({ type: "changes", changes: [] });
		});
	});
});
