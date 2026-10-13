import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { orgMigrations } from "../../src/worker/org/schema.ts";
import { addMember, Client, createFamily, invite } from "./helpers.ts";

async function setup() {
	const { owner, orgId } = await createFamily();
	const ownerId = (await owner.json("GET", "/api/me")).body.member.id as string;
	const dadId = await addMember(owner, "dad");
	const momId = await addMember(owner, "mom");
	const dad = new Client();
	await dad.json("POST", "/api/join", {
		...(await invite(owner, dadId)),
		deviceName: "Dad's phone",
	});
	return { owner, ownerId, orgId, dad, dadId, momId };
}

async function createTeam(admin: Client, name: string): Promise<string> {
	const response = await admin.json("POST", "/api/teams", { name });
	if (response.status !== 201) throw new Error(JSON.stringify(response.body));
	return response.body.id;
}

/** Tasks can't be created through the API until M4, so tests insert them directly. */
async function insertTask(
	orgId: string,
	task: {
		title: string;
		teamId: string | null;
		createdBy: string;
		assigneeId?: string;
		scheduled?: boolean;
		watchers?: string[];
	},
) {
	const id = crypto.randomUUID();
	await runInDurableObject(env.ORG.get(env.ORG.idFromName(orgId)), (_, state) => {
		state.storage.sql.exec(
			`INSERT INTO task (id, team_id, title, assignee_id, repeat, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
			id,
			task.teamId,
			task.title,
			task.assigneeId ?? null,
			task.scheduled ? '{"times":["20:00"],"days":"daily"}' : null,
			task.createdBy,
		);
		for (const watcher of task.watchers ?? [])
			state.storage.sql.exec(
				"INSERT INTO task_watcher (task_id, member_id) VALUES (?, ?)",
				id,
				watcher,
			);
	});
	return id;
}

async function readTask(orgId: string, id: string) {
	return runInDurableObject(env.ORG.get(env.ORG.idFromName(orgId)), (_, state) => ({
		task: state.storage.sql
			.exec<{ team_id: string | null; assignee_id: string | null; archived: number }>(
				"SELECT * FROM task WHERE id = ?",
				id,
			)
			.one(),
		watchers: state.storage.sql
			.exec<{ member_id: string }>("SELECT member_id FROM task_watcher WHERE task_id = ?", id)
			.toArray()
			.map((w) => w.member_id),
	}));
}

describe("households", () => {
	it("start empty: a new family has none and a new member is in none (FR-81)", async () => {
		const { owner, dad } = await setup();
		expect((await owner.json("GET", "/api/teams")).body).toEqual([]);
		await createTeam(owner, "Home");
		expect((await dad.json("GET", "/api/teams")).body).toEqual([]);
	});

	it("are created, renamed and listed by admins, with unique names", async () => {
		const { owner } = await setup();
		const home = await createTeam(owner, "Home");
		await createTeam(owner, "Parents' home");
		expect((await owner.json("POST", "/api/teams", { name: "HOME" })).status).toBe(409);
		expect((await owner.json("POST", "/api/teams", { name: "  " })).status).toBe(400);

		const renamed = await owner.json("PATCH", `/api/teams/${home}`, { name: "Bengaluru home" });
		expect(renamed.body).toEqual({ id: home, name: "Bengaluru home", memberIds: [] });
		expect(
			(await owner.json("PATCH", `/api/teams/${home}`, { name: "parents' HOME" })).status,
		).toBe(409);
		expect(
			(await owner.json("GET", "/api/teams")).body.map((t: { name: string }) => t.name),
		).toEqual(["Bengaluru home", "Parents' home"]);
	});

	it("can only be managed by admins (FR-80)", async () => {
		const { owner, dad, dadId } = await setup();
		const home = await createTeam(owner, "Home");
		expect((await dad.json("POST", "/api/teams", { name: "Mine" })).status).toBe(403);
		expect((await dad.json("PATCH", `/api/teams/${home}`, { name: "Mine" })).status).toBe(403);
		expect((await dad.json("PUT", `/api/teams/${home}/members/${dadId}`)).status).toBe(403);
		expect((await dad.request("DELETE", `/api/teams/${home}`)).status).toBe(403);
	});

	it("show members only the households they belong to; admins see all (FR-87)", async () => {
		const { owner, dad, dadId, momId } = await setup();
		const home = await createTeam(owner, "Home");
		await createTeam(owner, "Office");
		const added = await owner.json("PUT", `/api/teams/${home}/members/${dadId}`);
		expect(added.body.memberIds).toEqual([dadId]);
		await owner.json("PUT", `/api/teams/${home}/members/${momId}`);
		expect((await owner.json("PUT", `/api/teams/${home}/members/${dadId}`)).status).toBe(200);

		expect((await dad.json("GET", "/api/teams")).body).toEqual([
			{ id: home, name: "Home", memberIds: [dadId, momId] },
		]);
		expect((await owner.json("GET", "/api/teams")).body).toHaveLength(2);
	});

	it("reject unknown households and members", async () => {
		const { owner, dadId } = await setup();
		const home = await createTeam(owner, "Home");
		expect((await owner.json("PUT", `/api/teams/nope/members/${dadId}`)).status).toBe(404);
		expect((await owner.json("PUT", `/api/teams/${home}/members/nope`)).status).toBe(404);
		expect((await owner.json("DELETE", `/api/teams/${home}/members/${dadId}`)).status).toBe(404);
	});
});

describe("removing a member (FR-84)", () => {
	it("previews affected tasks, then unassigns them and removes them as watcher in that household only", async () => {
		const { owner, ownerId, orgId, dad, dadId } = await setup();
		const home = await createTeam(owner, "Home");
		const other = await createTeam(owner, "Parents' home");
		for (const team of [home, other])
			await owner.json("PUT", `/api/teams/${team}/members/${dadId}`);

		const medicines = await insertTask(orgId, {
			title: "Medicines",
			teamId: home,
			createdBy: ownerId,
			assigneeId: dadId,
			scheduled: true,
		});
		const milk = await insertTask(orgId, {
			title: "Buy milk",
			teamId: home,
			createdBy: ownerId,
			assigneeId: dadId,
		});
		const bills = await insertTask(orgId, {
			title: "Bills",
			teamId: home,
			createdBy: ownerId,
			watchers: [dadId, ownerId],
		});
		const untouchedTeam = await insertTask(orgId, {
			title: "Other house",
			teamId: other,
			createdBy: ownerId,
			assigneeId: dadId,
		});
		const familyWide = await insertTask(orgId, {
			title: "Family task",
			teamId: null,
			createdBy: ownerId,
			assigneeId: dadId,
		});

		const preview = await owner.json("GET", `/api/teams/${home}/members/${dadId}/removal-preview`);
		expect(preview.body.tasks).toEqual([
			{ id: bills, title: "Bills", asAssignee: false, asWatcher: true, remindersWiden: false },
			{ id: milk, title: "Buy milk", asAssignee: true, asWatcher: false, remindersWiden: false },
			{
				id: medicines,
				title: "Medicines",
				asAssignee: true,
				asWatcher: false,
				remindersWiden: true,
			},
		]);

		const removed = await owner.json("DELETE", `/api/teams/${home}/members/${dadId}`);
		expect(removed.body.memberIds).toEqual([]);
		expect((await dad.json("GET", "/api/teams")).body.map((t: { id: string }) => t.id)).toEqual([
			other,
		]);

		expect((await readTask(orgId, medicines)).task.assignee_id).toBeNull();
		expect((await readTask(orgId, milk)).task.assignee_id).toBeNull();
		expect((await readTask(orgId, bills)).watchers).toEqual([ownerId]);
		expect((await readTask(orgId, untouchedTeam)).task.assignee_id).toBe(dadId);
		expect((await readTask(orgId, familyWide)).task.assignee_id).toBe(dadId);
	});
});

describe("deleting a household (FR-85)", () => {
	it("archives its tasks by default and keeps them in the household", async () => {
		const { owner, ownerId, orgId, dadId } = await setup();
		const home = await createTeam(owner, "Home");
		await owner.json("PUT", `/api/teams/${home}/members/${dadId}`);
		const task = await insertTask(orgId, { title: "Shopping", teamId: home, createdBy: ownerId });

		expect((await owner.json("GET", `/api/teams/${home}/delete-preview`)).body).toEqual({
			taskCount: 1,
		});
		expect((await owner.request("DELETE", `/api/teams/${home}`)).status).toBe(200);

		expect((await owner.json("GET", "/api/teams")).body).toEqual([]);
		expect((await readTask(orgId, task)).task).toMatchObject({ team_id: home, archived: 1 });
		// The name can be used again.
		expect((await owner.json("POST", "/api/teams", { name: "Home" })).status).toBe(201);
	});

	it("can move its tasks to the whole family instead", async () => {
		const { owner, ownerId, orgId } = await setup();
		const home = await createTeam(owner, "Home");
		const task = await insertTask(orgId, { title: "Shopping", teamId: home, createdBy: ownerId });

		expect((await owner.request("DELETE", `/api/teams/${home}?tasks=move`)).status).toBe(200);
		expect((await readTask(orgId, task)).task).toMatchObject({ team_id: null, archived: 0 });
		expect((await owner.request("DELETE", `/api/teams/${home}?tasks=move`)).status).toBe(404);
		expect(
			(await owner.request("DELETE", `/api/teams/${crypto.randomUUID()}?tasks=keep`)).status,
		).toBe(400);
	});
});

it("upgrades an existing family database to the household schema", async () => {
	const { orgId } = await setup();
	await runInDurableObject(env.ORG.get(env.ORG.idFromName(orgId)), (_, state) => {
		expect(
			state.storage.sql.exec<{ version: number }>("SELECT version FROM schema_version").one()
				.version,
		).toBe(orgMigrations.length);
		const columns = state.storage.sql
			.exec<{ name: string }>("PRAGMA table_info(team)")
			.toArray()
			.map((c) => c.name);
		expect(columns).toContain("deleted_at");
	});
});
