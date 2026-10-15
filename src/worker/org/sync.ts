// Change log, visibility and snapshots for live sync (requirements 4.7).
import type { Change, Entity, Snapshot } from "../../shared/sync.ts";
import { toMember, type MemberRow } from "./accounts.ts";
import { listTeams } from "./teams.ts";
import { listVisibleTasks } from "./tasks.ts";

/** A change plus who may see it: teamId null means the whole family. */
export interface StoredChange {
	change: Change;
	teamId: string | null;
}

/** Which scopes a member can see: admins everything, members the family and their households (FR-87). */
export interface Audience {
	all: boolean;
	teamIds: Set<string>;
}

export function audienceOf(sql: SqlStorage, member: MemberRow): Audience {
	const all = member.role === "owner" || member.role === "admin";
	const teamIds = new Set(
		sql
			.exec<{ team_id: string }>("SELECT team_id FROM team_member WHERE member_id = ?", member.id)
			.toArray()
			.map((r) => r.team_id),
	);
	return { all, teamIds };
}

export function canSeeScope(audience: Audience, teamId: string | null): boolean {
	return teamId === null || audience.all || audience.teamIds.has(teamId);
}

/** Appends a change to the log and returns it with its version. */
export function recordChange(
	sql: SqlStorage,
	entry: {
		entity: Entity;
		id: string;
		op: "upsert" | "remove";
		data?: { version?: number } & object;
		teamId: string | null;
		memberId: string | null;
		now: number;
	},
): StoredChange {
	const { version } = sql
		.exec<{ version: number }>(
			"INSERT INTO change_log (entity, entity_id, op, member_id, at, team_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING version",
			entry.entity,
			entry.id,
			entry.op,
			entry.memberId,
			entry.now,
			entry.teamId,
		)
		.one();
	let data: object | undefined;
	if (entry.op === "upsert" && entry.data) {
		data = entry.entity === "task" ? { ...entry.data, version } : entry.data;
		sql.exec("UPDATE change_log SET data = ? WHERE version = ?", JSON.stringify(data), version);
		if (entry.entity === "task")
			sql.exec("UPDATE task SET version = ? WHERE id = ?", version, entry.id);
	}
	const change = (
		data
			? { version, entity: entry.entity, id: entry.id, op: "upsert", data }
			: { version, entity: entry.entity, id: entry.id, op: "remove" }
	) as Change;
	return { change, teamId: entry.teamId };
}

/** The latest version ever issued (0 for a new family). */
export function currentVersion(sql: SqlStorage): number {
	return (
		sql
			.exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'")
			.toArray()[0]?.seq ?? 0
	);
}

/**
 * Changes after `version` that the audience may see, or null when a snapshot is better: the log
 * no longer covers that range, or there are more changes than tasks (FR-52).
 */
export function changesSince(
	sql: SqlStorage,
	version: number,
	audience: Audience,
): Change[] | null {
	const current = currentVersion(sql);
	if (version > current || version < 0) return null;
	if (version === current) return [];
	const oldest = sql.exec<{ v: number | null }>("SELECT MIN(version) AS v FROM change_log").one().v;
	if (oldest === null || version < oldest - 1) return null;
	// Each change carries a whole task, so past this point a snapshot is smaller. Versions are
	// consecutive, so the count is a subtraction; members who see fewer tasks switch a little early.
	const tasks = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task").one().n;
	if (current - version > tasks) return null;
	return sql
		.exec<{
			version: number;
			entity: Entity;
			entity_id: string;
			op: "upsert" | "remove";
			data: string | null;
			team_id: string | null;
		}>(
			"SELECT version, entity, entity_id, op, data, team_id FROM change_log WHERE version > ? ORDER BY version",
			version,
		)
		.toArray()
		.filter((row) => canSeeScope(audience, row.team_id))
		.map(
			(row) =>
				(row.op === "upsert"
					? {
							version: row.version,
							entity: row.entity,
							id: row.entity_id,
							op: "upsert",
							data: JSON.parse(row.data!),
						}
					: {
							version: row.version,
							entity: row.entity,
							id: row.entity_id,
							op: "remove",
						}) as Change,
		);
}

/** Records that what the member can see changed as of the latest version (FR-83, FR-84). */
export function markAudienceChanged(sql: SqlStorage, memberId: string): void {
	sql.exec("UPDATE member SET audience_version = ? WHERE id = ?", currentVersion(sql), memberId);
}

/** Whether a device at `version` missed a change to what the member can see, so needs a snapshot. */
export function audienceChangedSince(sql: SqlStorage, memberId: string, version: number): boolean {
	const row = sql
		.exec<{ audience_version: number }>(
			"SELECT audience_version FROM member WHERE id = ?",
			memberId,
		)
		.toArray()[0];
	return !!row && version < row.audience_version;
}

export function snapshot(sql: SqlStorage, member: MemberRow): Snapshot {
	const audience = audienceOf(sql, member);
	const members = sql
		.exec<MemberRow>(
			"SELECT * FROM member WHERE deactivated_at IS NULL ORDER BY display_name COLLATE NOCASE",
		)
		.toArray()
		.map((row) => toMember(sql, row));
	return {
		version: currentVersion(sql),
		tasks: listVisibleTasks(sql, audience),
		teams: listTeams(sql, audience.all ? undefined : member.id),
		members,
	};
}
