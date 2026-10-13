// Households ("Team" in code, decision D16): SQL used by OrgDO (requirements 4.10).
import type { RemovalPreviewTask, Team, TeamDeleteTasks } from "../../shared/types.ts";

// Type alias, not interface, so it satisfies SqlStorage's record constraint.
export type TeamRow = {
	id: string;
	name: string;
	created_at: number;
	deleted_at: number | null;
};

export function getTeam(sql: SqlStorage, id: string): TeamRow | undefined {
	return sql
		.exec<TeamRow>("SELECT * FROM team WHERE id = ? AND deleted_at IS NULL", id)
		.toArray()[0];
}

export function teamNameTaken(sql: SqlStorage, name: string, exceptId = ""): boolean {
	return (
		sql
			.exec(
				"SELECT 1 FROM team WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id != ?",
				name,
				exceptId,
			)
			.toArray().length > 0
	);
}

export function isTeamMember(sql: SqlStorage, teamId: string, memberId: string): boolean {
	return (
		sql
			.exec("SELECT 1 FROM team_member WHERE team_id = ? AND member_id = ?", teamId, memberId)
			.toArray().length > 0
	);
}

/** Live households with their members; only those `memberId` belongs to, if given. */
export function listTeams(sql: SqlStorage, memberId?: string): Team[] {
	const teams = sql
		.exec<TeamRow>(
			memberId
				? `SELECT t.* FROM team t JOIN team_member tm ON tm.team_id = t.id
				   WHERE t.deleted_at IS NULL AND tm.member_id = ? ORDER BY t.name COLLATE NOCASE`
				: "SELECT * FROM team WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE",
			...(memberId ? [memberId] : []),
		)
		.toArray();
	const memberships = sql
		.exec<{ team_id: string; member_id: string }>(
			`SELECT tm.team_id, tm.member_id FROM team_member tm
			 JOIN member m ON m.id = tm.member_id WHERE m.deactivated_at IS NULL
			 ORDER BY m.display_name COLLATE NOCASE`,
		)
		.toArray();
	return teams.map((team) => ({
		id: team.id,
		name: team.name,
		memberIds: memberships.filter((m) => m.team_id === team.id).map((m) => m.member_id),
	}));
}

export function toTeam(sql: SqlStorage, id: string): Team {
	return listTeams(sql).find((team) => team.id === id)!;
}

/** The household's open tasks where the member is assignee or watcher (FR-84). */
export function removalPreview(
	sql: SqlStorage,
	teamId: string,
	memberId: string,
): RemovalPreviewTask[] {
	return sql
		.exec<{
			id: string;
			title: string;
			as_assignee: number;
			as_watcher: number;
			scheduled: number;
		}>(
			`SELECT t.id, t.title,
			        t.assignee_id IS ? AS as_assignee,
			        EXISTS (SELECT 1 FROM task_watcher w WHERE w.task_id = t.id AND w.member_id = ?) AS as_watcher,
			        (t.due_date IS NOT NULL OR t.repeat IS NOT NULL) AS scheduled
			 FROM task t
			 WHERE t.team_id = ? AND t.archived = 0
			   AND (t.assignee_id = ? OR EXISTS (SELECT 1 FROM task_watcher w WHERE w.task_id = t.id AND w.member_id = ?))
			 ORDER BY t.title COLLATE NOCASE`,
			memberId,
			memberId,
			teamId,
			memberId,
			memberId,
		)
		.toArray()
		.map((row) => ({
			id: row.id,
			title: row.title,
			asAssignee: row.as_assignee === 1,
			asWatcher: row.as_watcher === 1,
			remindersWiden: row.as_assignee === 1 && row.scheduled === 1,
		}));
}

/**
 * Removes a member from a household: they stop watching and are unassigned from its open tasks.
 * Returns the ids of the tasks that changed. Call inside a transaction.
 */
export function removeMember(
	sql: SqlStorage,
	teamId: string,
	memberId: string,
	now: number,
): string[] {
	const affected = removalPreview(sql, teamId, memberId).map((task) => task.id);
	sql.exec("DELETE FROM team_member WHERE team_id = ? AND member_id = ?", teamId, memberId);
	sql.exec(
		"DELETE FROM task_watcher WHERE member_id = ? AND task_id IN (SELECT id FROM task WHERE team_id = ? AND archived = 0)",
		memberId,
		teamId,
	);
	sql.exec(
		"UPDATE task SET assignee_id = NULL, updated_at = ? WHERE team_id = ? AND assignee_id = ? AND archived = 0",
		now,
		teamId,
		memberId,
	);
	return affected;
}

export function openTaskCount(sql: SqlStorage, teamId: string): number {
	return sql
		.exec<{ n: number }>(
			"SELECT COUNT(*) AS n FROM task WHERE team_id = ? AND archived = 0",
			teamId,
		)
		.one().n;
}

/**
 * Deletes a household (FR-85): its open tasks are archived or moved to the whole family.
 * Returns the ids of the tasks that changed. Call inside a transaction.
 */
export function deleteTeam(
	sql: SqlStorage,
	teamId: string,
	tasks: TeamDeleteTasks,
	now: number,
): string[] {
	const affected = sql
		.exec<{ id: string }>("SELECT id FROM task WHERE team_id = ? AND archived = 0", teamId)
		.toArray()
		.map((t) => t.id);
	if (tasks === "move") {
		sql.exec(
			"UPDATE task SET team_id = NULL, updated_at = ? WHERE team_id = ? AND archived = 0",
			now,
			teamId,
		);
	} else {
		sql.exec(
			"UPDATE task SET archived = 1, updated_at = ? WHERE team_id = ? AND archived = 0",
			now,
			teamId,
		);
	}
	sql.exec("DELETE FROM team_member WHERE team_id = ?", teamId);
	sql.exec("UPDATE team SET deleted_at = ? WHERE id = ?", now, teamId);
	return affected;
}
