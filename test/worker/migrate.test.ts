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
