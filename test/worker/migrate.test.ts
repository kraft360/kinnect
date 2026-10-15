import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newOrgId } from "../../src/shared/ids.ts";
import { migrate } from "../../src/worker/db/migrate.ts";
import { directoryMigrations } from "../../src/worker/directory/schema.ts";
import { orgMigrations } from "../../src/worker/org/schema.ts";

const freshOrg = () => env.ORG.get(env.ORG.idFromName(newOrgId()));
const tables = (storage: DurableObjectStorage) =>
	storage.sql
		.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
		.toArray()
		.map((t) => t.name);
const version = (storage: DurableObjectStorage) =>
	storage.sql.exec<{ version: number }>("SELECT version FROM schema_version").one().version;

describe("migrate", () => {
	it("creates the full Organization schema on a new database", async () => {
		await runInDurableObject(freshOrg(), (_, state) => {
			expect(version(state.storage)).toBe(orgMigrations.length);
			expect(tables(state.storage)).toEqual(
				expect.arrayContaining([
					"organization",
					"member",
					"team",
					"team_member",
					"device",
					"invite",
					"task",
					"task_watcher",
					"subtask",
					"occurrence",
					"occurrence_tick",
					"scheduled_job",
					"alert",
					"change_log",
				]),
			);
		});
	});

	it("creates the Directory schema", async () => {
		await runInDurableObject(
			env.DIRECTORY.get(env.DIRECTORY.idFromName("migrate-test")),
			(_, state) => {
				expect(version(state.storage)).toBe(directoryMigrations.length);
				expect(tables(state.storage)).toEqual(
					expect.arrayContaining(["join_code", "operator_link", "rate_limit"]),
				);
				expect(tables(state.storage)).not.toContain("org_creation");
			},
		);
	});

	it("applies only new migrations, and running again changes nothing", async () => {
		await runInDurableObject(freshOrg(), (_, state) => {
			const next = [...orgMigrations, "CREATE TABLE extra (x INTEGER)"];
			expect(migrate(state.storage, next)).toBe(next.length);
			expect(tables(state.storage)).toContain("extra");

			expect(migrate(state.storage, next)).toBe(next.length);
			expect(version(state.storage)).toBe(next.length);
		});
	});

	it("rolls back a failing migration and keeps the previous version", async () => {
		await runInDurableObject(freshOrg(), (_, state) => {
			const broken = [...orgMigrations, "CREATE TABLE half_done (x INTEGER); THIS IS NOT SQL"];
			expect(() => migrate(state.storage, broken)).toThrow();
			expect(tables(state.storage)).not.toContain("half_done");
			expect(version(state.storage)).toBe(orgMigrations.length);
		});
	});

	it("refuses to run against a database newer than the code", async () => {
		await runInDurableObject(freshOrg(), (_, state) => {
			expect(() => migrate(state.storage, orgMigrations.slice(0, -1))).toThrow(
				/newer than this code/,
			);
		});
	});

	it("rebuilds scheduled_job for purge jobs, keeping every job (migration 7)", async () => {
		await runInDurableObject(freshOrg(), (_, state) => {
			const sql = state.storage.sql;
			// Start again from an empty database at version 6.
			// Newest first, so no table is dropped while another still refers to it.
			for (const name of tables(state.storage)
				.filter((t) => !/^(_cf|sqlite)/.test(t))
				.reverse())
				sql.exec(`DROP TABLE ${name}`);
			expect(migrate(state.storage, orgMigrations.slice(0, 6))).toBe(6);
			sql.exec("INSERT INTO organization (id, name, created_at) VALUES ('org', 'Family', 0)");
			sql.exec(
				"INSERT INTO member (id, username, display_name, role, created_at) VALUES ('m', 'm', 'M', 'owner', 0)",
			);
			sql.exec(
				"INSERT INTO task (id, title, created_by, created_at, updated_at) VALUES ('t', 'T', 'm', 0, 0)",
			);
			sql.exec("INSERT INTO occurrence (id, task_id, due_at) VALUES ('o', 't', 100)");
			sql.exec(
				"INSERT INTO scheduled_job (id, occurrence_id, kind, fire_at, done_at) VALUES ('j1', 'o', 'due', 100, NULL), ('j2', NULL, 'materialize', 50, 60)",
			);
			expect(() =>
				sql.exec("INSERT INTO scheduled_job (id, kind, fire_at) VALUES ('p', 'purge', 0)"),
			).toThrow(/CHECK/);

			expect(migrate(state.storage, orgMigrations)).toBe(7);
			const jobs = sql
				.exec("SELECT id, occurrence_id, kind, fire_at, done_at FROM scheduled_job ORDER BY kind")
				.toArray();
			expect(jobs.filter((j) => j.kind !== "purge")).toEqual([
				{ id: "j1", occurrence_id: "o", kind: "due", fire_at: 100, done_at: null },
				{ id: "j2", occurrence_id: null, kind: "materialize", fire_at: 50, done_at: 60 },
			]);
			// The first purge is due straight away.
			expect(jobs.filter((j) => j.kind === "purge")).toMatchObject([{ fire_at: 0, done_at: null }]);
			expect(
				sql
					.exec<{ name: string }>(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scheduled_job' AND name NOT LIKE 'sqlite_%' ORDER BY name",
					)
					.toArray()
					.map((r) => r.name),
			).toEqual(["scheduled_job_by_occurrence", "scheduled_job_pending"]);
			// Still cascades from occurrences.
			sql.exec("DELETE FROM occurrence WHERE id = 'o'");
			expect(sql.exec("SELECT id FROM scheduled_job WHERE id = 'j1'").toArray()).toEqual([]);
		});
	});

	it("enforces foreign keys", async () => {
		await runInDurableObject(freshOrg(), (_, state) => {
			expect(() =>
				state.storage.sql.exec(
					"INSERT INTO team_member (team_id, member_id, added_by, added_at) VALUES ('no-team', 'no-member', 'no-member', 0)",
				),
			).toThrow(/FOREIGN KEY/);
		});
	});
});
