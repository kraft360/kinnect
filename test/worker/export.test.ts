import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EXPORT_PLAN } from "../../src/worker/org/export.ts";
import { orgMigrations } from "../../src/worker/org/schema.ts";
import { dueIn, family } from "./family.ts";
import { op, uuid } from "./helpers.ts";

describe("family data export (FR-92)", () => {
	it("gives admins every task, its history, members and households", async () => {
		const f = await family();
		const due = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Evening medicines",
			teamId: f.home,
			assigneeId: f.dadId,
			watcherIds: [f.sonId],
			schedule: { repeat: { kind: "daily", times: [due.time], every: 2, start: due.date } },
		});
		const item = uuid();
		await op(f.owner, {
			type: "subtask.add",
			taskId: id,
			id: item,
			title: "Old item",
			position: 1,
		});
		await op(f.owner, { type: "subtask.remove", id: item });
		const archived = uuid();
		await op(f.owner, { type: "task.create", id: archived, title: "Old chore" });
		await op(f.owner, { type: "task.archive", id: archived });
		await f.run(due.at);

		const response = await f.owner.request("GET", "/api/export");
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Disposition")).toMatch(
			/^attachment; filename="kinnect-[a-z0-9-]+-\d{4}-\d\d-\d\d\.json"$/,
		);
		const data = (await response.json()) as Record<string, any>;

		expect(data).toMatchObject({
			format: "kinnect-export",
			version: 1,
			schemaVersion: orgMigrations.length,
			exportedBy: f.ownerId,
		});
		expect(data.organization).toMatchObject({ timezone: "Asia/Kolkata" });
		expect(data.members.map((m: { username: string }) => m.username)).toEqual(
			expect.arrayContaining(["dad", "son"]),
		);
		expect(data.teams).toEqual([
			expect.objectContaining({ id: f.home, name: "Home", deleted_at: null }),
		]);
		expect(data.teamMembers).toHaveLength(2);

		const task = data.tasks.find((t: { id: string }) => t.id === id);
		expect(task).toMatchObject({
			title: "Evening medicines",
			repeat: { kind: "daily", every: 2, start: due.date },
			archived: false,
		});
		expect(data.tasks.find((t: { id: string }) => t.id === archived)).toMatchObject({
			archived: true,
		});
		expect(data.watchers).toEqual([{ task_id: id, member_id: f.sonId }]);
		expect(data.subtasks).toEqual([
			expect.objectContaining({ id: item, deleted_at: expect.any(String) }),
		]);
		expect(
			data.occurrences.find((o: { due_at: string }) => o.due_at === new Date(due.at).toISOString()),
		).toMatchObject({ task_id: id, status: "open" });
		expect(data.alerts).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "due", recipients: [f.dadId] })]),
		);
		expect(data.changes.length).toBeGreaterThan(0);
		expect(data.changes[0]).not.toHaveProperty("data");

		// Signed-in devices are listed without anything that could sign in or send to them.
		expect(data.devices.length).toBeGreaterThanOrEqual(3);
		const text = JSON.stringify(data);
		expect(text).not.toMatch(
			/session_token_hash|push_subscription|token_hash|code_hash|fcm\.googleapis/,
		);
		expect(data).not.toHaveProperty("invites");
	});

	it("is only for admins", async () => {
		const f = await family();
		expect((await f.dad.request("GET", "/api/export")).status).toBe(403);
	});

	it("accounts for every column in the schema, exported or deliberately left out", async () => {
		const f = await family();
		await runInDurableObject(f.stub, (_instance, state) => {
			const sql = state.storage.sql;
			const tables = sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
				)
				.toArray()
				.map((t) => t.name);
			const unplanned = tables.filter((t) => !(t in EXPORT_PLAN));
			expect(unplanned, "tables missing from EXPORT_PLAN").toEqual([]);
			for (const table of tables) {
				const plan = EXPORT_PLAN[table];
				if (plan === "excluded") continue;
				const columns = sql
					.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
					.toArray()
					.map((c) => c.name);
				expect([...plan.columns, ...plan.excluded].sort(), `columns of ${table}`).toEqual(
					[...columns].sort(),
				);
			}
		});
	});
});
