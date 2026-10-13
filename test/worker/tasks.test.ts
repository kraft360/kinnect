import { describe, expect, it } from "vitest";
import { addMember, Client, createFamily, invite, op, uuid } from "./helpers.ts";

async function family() {
	const { owner } = await createFamily();
	const ownerId = (await owner.json("GET", "/api/me")).body.member.id as string;
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
	return { owner, ownerId, dad, dadId, son, sonId, home };
}

describe("creating tasks", () => {
	it("creates a plain to-do with only a title, family-wide by default", async () => {
		const { dad, dadId } = await family();
		const id = uuid();
		const response = await op(dad, { type: "task.create", id, title: "  Fix the tap " });
		expect(response.status).toBe(200);
		expect(response.body.task).toMatchObject({
			id,
			title: "Fix the tap",
			teamId: null,
			assigneeId: null,
			watcherIds: [],
			subtasks: [],
			createdBy: dadId,
			archived: false,
		});
		expect(response.body.version).toBeGreaterThan(0);
		expect(response.body.task.version).toBe(response.body.version);
	});

	it("creates Dad's medicines with an assignee, watchers and a checklist", async () => {
		const { owner, ownerId, dadId, sonId } = await family();
		const [a, b] = [uuid(), uuid()];
		const response = await op(owner, {
			type: "task.create",
			id: uuid(),
			title: "Evening medicines",
			assigneeId: dadId,
			watcherIds: [sonId, ownerId, sonId],
			subtasks: [
				{ id: a, title: "Metformin" },
				{ id: b, title: "Amlodipine" },
			],
		});
		expect(response.body.task.assigneeId).toBe(dadId);
		expect(response.body.task.watcherIds.sort()).toEqual([ownerId, sonId].sort());
		expect(
			response.body.task.subtasks.map((s: { id: string; title: string }) => [s.id, s.title]),
		).toEqual([
			[a, "Metformin"],
			[b, "Amlodipine"],
		]);
	});

	it("is idempotent when a device retries the same create", async () => {
		const { dad, son } = await family();
		const id = uuid();
		await op(dad, { type: "task.create", id, title: "Once" });
		expect((await op(dad, { type: "task.create", id, title: "Once" })).status).toBe(200);
		expect((await op(son, { type: "task.create", id, title: "Clash" })).status).toBe(409);
	});

	it("validates operations", async () => {
		const { dad } = await family();
		expect((await op(dad, { type: "task.create", id: uuid(), title: "" })).status).toBe(400);
		expect((await op(dad, { type: "task.create", id: "not-a-uuid", title: "x" })).status).toBe(400);
		expect(
			(await op(dad, { type: "task.create", id: uuid(), title: "x".repeat(121) })).status,
		).toBe(400);
		expect((await op(dad, { type: "nonsense" })).status).toBe(400);
		expect((await dad.json("POST", "/api/ops", {})).status).toBe(400);
	});
});

describe("household tasks (FR-86, FR-87)", () => {
	it("can be created by household members and by admins, not by others", async () => {
		const { owner, dad, son, home } = await family();
		expect(
			(await op(dad, { type: "task.create", id: uuid(), title: "Shopping", teamId: home })).status,
		).toBe(200);
		expect(
			(await op(owner, { type: "task.create", id: uuid(), title: "Admin-made", teamId: home }))
				.status,
		).toBe(200);
		const outsider = await op(son, {
			type: "task.create",
			id: uuid(),
			title: "Not mine",
			teamId: home,
		});
		expect(outsider.status).toBe(403);
	});

	it("only allow household members as assignee or watchers", async () => {
		const { dad, dadId, sonId, home } = await family();
		const rejected = await op(dad, {
			type: "task.create",
			id: uuid(),
			title: "Bills",
			teamId: home,
			assigneeId: sonId,
		});
		expect(rejected.status).toBe(409);
		expect(rejected.body.error).toMatch(/son isn't in this household/);

		const id = uuid();
		await op(dad, { type: "task.create", id, title: "Bills", teamId: home, assigneeId: dadId });
		expect((await op(dad, { type: "task.setWatchers", id, watcherIds: [sonId] })).status).toBe(409);
	});

	it("are invisible and untouchable for non-members", async () => {
		const { dad, son, home } = await family();
		const id = uuid();
		await op(dad, { type: "task.create", id, title: "Shopping", teamId: home });
		const response = await op(son, { type: "task.update", id, changes: { title: "Hacked" } });
		expect(response.status).toBe(404);
		expect(response.body.task).toBeNull();
	});

	it("reject moving a task into a household its people aren't in", async () => {
		const { owner, sonId, home } = await family();
		const id = uuid();
		await op(owner, { type: "task.create", id, title: "Homework", assigneeId: sonId });
		const moved = await op(owner, { type: "task.update", id, changes: { teamId: home } });
		expect(moved.status).toBe(409);
		expect(moved.body.task).toMatchObject({ id, teamId: null }); // real state, so the device can undo
	});
});

describe("editing tasks", () => {
	it("applies only the changed fields, so concurrent edits to different fields both survive (FR-54)", async () => {
		const { dad, son } = await family();
		const id = uuid();
		await op(dad, { type: "task.create", id, title: "Plan trip" });
		await op(dad, { type: "task.update", id, changes: { title: "Plan Goa trip" } });
		const last = await op(son, { type: "task.update", id, changes: { notes: "December" } });
		expect(last.body.task).toMatchObject({ title: "Plan Goa trip", notes: "December" });
	});

	it("marks plain tasks done once, records who, and can reopen them (FR-15, FR-19)", async () => {
		const { dad, dadId, son } = await family();
		const id = uuid();
		await op(dad, { type: "task.create", id, title: "Fix the tap" });
		const done = await op(dad, { type: "task.done", id });
		expect(done.body.task.doneBy).toBe(dadId);
		const again = await op(son, { type: "task.done", id });
		expect(again.body.task).toMatchObject({ doneBy: dadId, doneAt: done.body.task.doneAt }); // first Done wins
		expect((await op(son, { type: "task.reopen", id })).body.task.doneAt).toBeNull();
	});

	it("archives and unarchives (FR-20)", async () => {
		const { dad } = await family();
		const id = uuid();
		await op(dad, { type: "task.create", id, title: "Old" });
		expect((await op(dad, { type: "task.archive", id })).body.task.archived).toBe(true);
		expect((await op(dad, { type: "task.unarchive", id })).body.task.archived).toBe(false);
	});
});

describe("checklists", () => {
	async function list() {
		const setup = await family();
		const id = uuid();
		await op(setup.dad, { type: "task.create", id, title: "Shopping", teamId: setup.home });
		return { ...setup, id };
	}

	it("add, tick, untick, edit, move and remove items; the task never completes itself (FR-16, FR-17)", async () => {
		const { dad, dadId, id } = await list();
		const [milk, eggs, rice] = [uuid(), uuid(), uuid()];
		await op(dad, { type: "subtask.add", taskId: id, id: milk, title: "Milk", position: 1 });
		await op(dad, {
			type: "subtask.add",
			taskId: id,
			id: eggs,
			title: "Eggs",
			note: "12",
			position: 2,
		});
		await op(dad, { type: "subtask.add", taskId: id, id: rice, title: "Rice", position: 3 });

		await op(dad, { type: "subtask.tick", id: milk });
		await op(dad, { type: "subtask.tick", id: eggs });
		await op(dad, { type: "subtask.tick", id: rice });
		let task = (await op(dad, { type: "subtask.untick", id: rice })).body.task;
		expect(task.subtasks.find((s: { id: string }) => s.id === milk).doneBy).toBe(dadId);
		expect(task.subtasks.find((s: { id: string }) => s.id === rice).doneAt).toBeNull();

		await op(dad, { type: "subtask.update", id: rice, title: "Basmati rice" });
		task = (await op(dad, { type: "subtask.move", id: rice, position: 0.5 })).body.task;
		expect(task.subtasks.map((s: { title: string }) => s.title)).toEqual([
			"Basmati rice",
			"Milk",
			"Eggs",
		]);
		expect(task.doneAt).toBeNull();

		task = (await op(dad, { type: "subtask.remove", id: eggs })).body.task;
		expect(task.subtasks).toHaveLength(2);
		expect((await op(dad, { type: "subtask.tick", id: eggs })).status).toBe(404);
	});

	it("clear completed hides ticked items only", async () => {
		const { dad, id } = await list();
		const [a, b] = [uuid(), uuid()];
		await op(dad, { type: "subtask.add", taskId: id, id: a, title: "Ticked", position: 1 });
		await op(dad, { type: "subtask.add", taskId: id, id: b, title: "Open", position: 2 });
		await op(dad, { type: "subtask.tick", id: a });
		const task = (await op(dad, { type: "task.clearCompleted", id })).body.task;
		expect(task.subtasks.map((s: { title: string }) => s.title)).toEqual(["Open"]);
	});

	it("keep concurrent ticks on different items (FR-54)", async () => {
		const { owner, dad, id } = await list();
		const [a, b] = [uuid(), uuid()];
		await op(dad, { type: "subtask.add", taskId: id, id: a, title: "A", position: 1 });
		await op(dad, { type: "subtask.add", taskId: id, id: b, title: "B", position: 2 });
		await Promise.all([
			op(dad, { type: "subtask.tick", id: a }),
			op(owner, { type: "subtask.tick", id: b }),
		]);
		const task = (await op(dad, { type: "task.update", id, changes: {} })).body.task;
		expect(task.subtasks.every((s: { doneAt: number | null }) => s.doneAt !== null)).toBe(true);
	});
});

describe("labels (FR-4)", () => {
	it("sets, changes and clears a label and colour", async () => {
		const { dad } = await family();
		const id = uuid();
		const created = await op(dad, {
			type: "task.create",
			id,
			title: "Bill",
			label: " Bills ",
			colour: "orange",
		});
		expect(created.body.task).toMatchObject({ label: "Bills", colour: "orange" });
		const changed = await op(dad, {
			type: "task.update",
			id,
			changes: { label: "Home", colour: "teal" },
		});
		expect(changed.body.task).toMatchObject({ label: "Home", colour: "teal" });
		const cleared = await op(dad, {
			type: "task.update",
			id,
			changes: { label: null, colour: null },
		});
		expect(cleared.body.task).toMatchObject({ label: null, colour: null });
	});

	it("validates labels", async () => {
		const { dad } = await family();
		expect(
			(
				await op(dad, {
					type: "task.create",
					id: uuid(),
					title: "x",
					label: "y",
					colour: "chartreuse",
				})
			).status,
		).toBe(400);
		expect(
			(await op(dad, { type: "task.create", id: uuid(), title: "x", label: "y".repeat(31) }))
				.status,
		).toBe(400);
	});
});
