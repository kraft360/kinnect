import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/shared/time.ts";
import { PURGE_EVERY_MS, PURGE_ROWS_PER_RUN } from "../../src/worker/org/purge.ts";
import {
	DEFAULT_HISTORY_DAYS,
	DEFAULT_SYSTEM_DAYS,
	historyRetentionMs,
	retentionDays,
	systemRetentionMs,
} from "../../src/worker/retention.ts";
import { family } from "./family.ts";
import { uuid } from "./helpers.ts";

const HISTORY = DEFAULT_HISTORY_DAYS * DAY_MS;
const SYSTEM = DEFAULT_SYSTEM_DAYS * DAY_MS;

describe("retention settings", () => {
	it("come from wrangler.jsonc", () => {
		expect(historyRetentionMs(env)).toBe(HISTORY);
		expect(systemRetentionMs(env)).toBe(SYSTEM);
	});

	it("fall back to the default when missing, invalid or below the minimum", () => {
		const days = (value: unknown) => retentionDays("X", value, 90, 7);
		expect(days("30")).toBe(30);
		expect(days("7")).toBe(7);
		expect(days(undefined)).toBe(90);
		expect(days("")).toBe(90);
		expect(days("abc")).toBe(90);
		expect(days("1.5")).toBe(90);
		expect(days("6")).toBe(90);
		expect(historyRetentionMs({ PURGE_HISTORY_DAYS: "30" })).toBe(30 * DAY_MS);
		expect(systemRetentionMs({ PURGE_SYSTEM_DAYS: "1" })).toBe(DAY_MS);
		expect(systemRetentionMs({ PURGE_SYSTEM_DAYS: "0" })).toBe(SYSTEM);
	});
});

describe("daily purge job (8.3)", () => {
	/** A family whose first purge job is due at `at`, a day after it was created. */
	async function setup() {
		const f = await family();
		const at = Date.now() + PURGE_EVERY_MS + 60_000;
		const exec = <T>(fn: (sql: SqlStorage) => T) =>
			runInDurableObject(f.stub, (_instance, state) => fn(state.storage.sql));
		const ids = (query: string) =>
			exec((sql) =>
				sql
					.exec<{ id: string }>(query)
					.toArray()
					.map((r) => r.id),
			);
		const add = (table: string, row: Record<string, SqlStorageValue>) =>
			exec((sql) =>
				sql.exec(
					`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
						.map(() => "?")
						.join(", ")})`,
					...Object.values(row),
				),
			);
		const pendingPurge = () =>
			exec((sql) =>
				sql
					.exec<{ fire_at: number }>(
						"SELECT fire_at FROM scheduled_job WHERE kind = 'purge' AND done_at IS NULL",
					)
					.toArray()
					.map((r) => r.fire_at),
			);
		const alarm = () => runInDurableObject(f.stub, (_instance, state) => state.storage.getAlarm());
		return { ...f, at, exec, ids, add, pendingPurge, alarm };
	}

	it("is scheduled for a day after the family is created", async () => {
		const f = await setup();
		const [fireAt] = await f.pendingPurge();
		expect(fireAt).toBeGreaterThan(Date.now() + PURGE_EVERY_MS - 60_000);
		expect(fireAt).toBeLessThanOrEqual(f.at);
	});

	it("deletes history and system rows past their own windows, and keeps everything else", async () => {
		const f = await setup();
		const by = f.ownerId;
		const history = (days: number) => f.at - HISTORY + days * DAY_MS;
		const system = (days: number) => f.at - SYSTEM + days * DAY_MS;

		await f.add("task", {
			id: "t",
			title: "Medicines",
			created_by: by,
			created_at: 0,
			updated_at: 0,
		});
		await f.add("task", {
			id: "t-archived",
			title: "Old bill",
			archived: 1,
			created_by: by,
			created_at: 0,
			updated_at: 0,
		});
		// Occurrences: finished before the window (deleted), still open (kept), finished inside it (kept).
		await f.add("occurrence", { id: "o-old", task_id: "t", due_at: history(-1), status: "missed" });
		await f.add("occurrence", { id: "o-open", task_id: "t", due_at: history(-5), status: "open" });
		await f.add("occurrence", { id: "o-recent", task_id: "t", due_at: history(1), status: "done" });
		await f.add("alert", {
			id: "a-old",
			occurrence_id: "o-old",
			kind: "missed",
			sent_at: history(-1),
		});
		// Sub-tasks: cleared before the window (deleted), cleared before it but ticked in a kept
		// occurrence (kept), cleared inside it (kept), not cleared (kept).
		for (const [id, deleted_at] of [
			["s-old", history(-1)],
			["s-ticked", history(-1)],
			["s-recent", history(1)],
			["s-live", null],
		] as const)
			await f.add("subtask", { id, task_id: "t", title: id, position: 1, deleted_at });
		await f.add("occurrence_tick", {
			occurrence_id: "o-old",
			subtask_id: "s-old",
			done_at: history(-1),
			done_by: by,
		});
		await f.add("occurrence_tick", {
			occurrence_id: "o-recent",
			subtask_id: "s-ticked",
			done_at: history(1),
			done_by: by,
		});
		// Jobs follow the system window: ran before it (deleted), ran inside it (kept), pending (kept).
		await f.add("scheduled_job", {
			id: "j-old",
			kind: "materialize",
			fire_at: 0,
			done_at: system(-1),
		});
		await f.add("scheduled_job", {
			id: "j-recent",
			kind: "materialize",
			fire_at: 0,
			done_at: system(1),
		});
		await f.add("scheduled_job", {
			id: "j-pending",
			occurrence_id: "o-open",
			kind: "missed",
			fire_at: f.at + DAY_MS,
		});
		// Invites and revoked devices are never purged.
		await f.add("device", {
			id: "d-revoked",
			member_id: by,
			name: "Old phone",
			session_token_hash: "x",
			created_at: 0,
			revoked_at: history(-100),
		});
		await f.add("invite", {
			id: "i-old",
			member_id: by,
			kind: "add_device",
			token_hash: "t",
			code_hash: "c",
			created_at: 0,
			expires_at: history(-100),
			used_at: 0,
			used_by_device: "d-revoked",
		});

		await f.run(f.at);

		expect(await f.ids("SELECT id FROM occurrence ORDER BY id")).toEqual(["o-open", "o-recent"]);
		expect(await f.ids("SELECT id FROM alert")).toEqual([]);
		expect(await f.ids("SELECT subtask_id AS id FROM occurrence_tick")).toEqual(["s-ticked"]);
		expect(await f.ids("SELECT id FROM subtask ORDER BY id")).toEqual([
			"s-live",
			"s-recent",
			"s-ticked",
		]);
		expect(await f.ids("SELECT id FROM scheduled_job WHERE id LIKE 'j-%' ORDER BY id")).toEqual([
			"j-pending",
			"j-recent",
		]);
		expect(await f.ids("SELECT id FROM task ORDER BY id")).toEqual(["t", "t-archived"]);
		expect(await f.ids("SELECT id FROM device WHERE id = 'd-revoked'")).toEqual(["d-revoked"]);
		expect(await f.ids("SELECT id FROM invite WHERE id = 'i-old'")).toEqual(["i-old"]);
	});

	it("deletes the oldest change-log rows, keeping the newer versions consecutive", async () => {
		const f = await setup();
		const at = f.at + SYSTEM;
		// The family's setup changes are now older than the window; one newer change isn't.
		await f.add("change_log", { entity: "task", entity_id: "x", op: "remove", at: at - DAY_MS });
		const kept = await f.exec(
			(sql) => sql.exec<{ v: number }>("SELECT MAX(version) AS v FROM change_log").one().v,
		);
		await f.run(at);
		expect(
			await f.exec((sql) =>
				sql
					.exec<{ version: number }>("SELECT version FROM change_log")
					.toArray()
					.map((r) => r.version),
			),
		).toEqual([kept]);
	});

	it("schedules the next run a day later and arms the alarm for it", async () => {
		const f = await setup();
		await f.run(f.at);
		expect(await f.pendingPurge()).toEqual([f.at + PURGE_EVERY_MS]);
		expect(await f.alarm()).toBe(f.at + PURGE_EVERY_MS);
	});

	it(`deletes at most ${PURGE_ROWS_PER_RUN} rows per table per run and comes straight back`, async () => {
		const f = await setup();
		const old = f.at - SYSTEM - DAY_MS;
		await f.exec((sql) => {
			for (let i = 0; i <= PURGE_ROWS_PER_RUN; i++)
				sql.exec(
					"INSERT INTO scheduled_job (id, kind, fire_at, done_at) VALUES (?, 'materialize', 0, ?)",
					uuid(),
					old,
				);
		});
		const left = () =>
			f.exec(
				(sql) =>
					sql
						.exec<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_job WHERE done_at = ?", old)
						.one().n,
			);

		await f.run(f.at);
		expect(await left()).toBe(1);
		expect(await f.pendingPurge()).toEqual([f.at]);
		expect(await f.alarm()).toBe(f.at);

		await f.run(f.at);
		expect(await left()).toBe(0);
		expect(await f.pendingPurge()).toEqual([f.at + PURGE_EVERY_MS]);
	});

	it("comes back if its job is ever lost", async () => {
		const f = await setup();
		await f.exec((sql) => sql.exec("DELETE FROM scheduled_job WHERE kind = 'purge'"));
		const now = Date.now();
		await f.run(now);
		expect(await f.pendingPurge()).toEqual([now + PURGE_EVERY_MS]);
	});
});
