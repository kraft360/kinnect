// Tasks, checklist items and watchers: reading, permission checks and operations
// (requirements 4.1, 4.4, FR-86, FR-87).
import { isLabelColour, type LabelColour } from "../../shared/labels.ts";
import { parseSchedule } from "../../shared/schedule.ts";
import {
	TASK_LIMITS,
	type Op,
	type OccurrenceState,
	type SubtaskState,
	type TaskState,
} from "../../shared/sync.ts";
import { fail, ok, type Result } from "../result.ts";
import type { MemberRow } from "./accounts.ts";
import {
	archiveSchedule,
	completeOccurrence,
	getOccurrence,
	occurrenceStates,
	rebuildSchedule,
	reopenOccurrence,
	scheduleOf,
	setSchedule,
	type JobContext,
} from "./schedule.ts";
import { canSeeScope, type Audience } from "./sync.ts";

// Type aliases (not interfaces) so they satisfy SqlStorage's record constraint.
export type TaskRow = {
	id: string;
	team_id: string | null;
	title: string;
	notes: string | null;
	label: string | null;
	colour: string | null;
	assignee_id: string | null;
	due_date: string | null;
	due_time: string | null;
	repeat: string | null;
	remind_before_minutes: number | null;
	second_reminder_minutes: number | null;
	overdue_after_minutes: number | null;
	done_at: number | null;
	done_by: string | null;
	archived: number;
	created_by: string;
	created_at: number;
	updated_at: number;
	version: number;
};

type SubtaskRow = {
	id: string;
	task_id: string;
	title: string;
	note: string | null;
	position: number;
	done_at: number | null;
	done_by: string | null;
	deleted_at: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Reading ------------------------------------------------------------------

function getTaskRow(sql: SqlStorage, id: string): TaskRow | undefined {
	return sql.exec<TaskRow>("SELECT * FROM task WHERE id = ?", id).toArray()[0];
}

function toSubtask(row: SubtaskRow): SubtaskState {
	return {
		id: row.id,
		title: row.title,
		note: row.note,
		position: row.position,
		doneAt: row.done_at,
		doneBy: row.done_by,
	};
}

function toTaskState(
	row: TaskRow,
	watcherIds: string[],
	subtasks: SubtaskState[],
	occurrences: OccurrenceState[],
): TaskState {
	return {
		id: row.id,
		teamId: row.team_id,
		title: row.title,
		notes: row.notes,
		label: row.label,
		colour: row.label && isLabelColour(row.colour) ? row.colour : null,
		assigneeId: row.assignee_id,
		watcherIds,
		subtasks,
		doneAt: row.done_at,
		doneBy: row.done_by,
		schedule: scheduleOf(row),
		occurrences,
		archived: row.archived === 1,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		version: row.version,
	};
}

export function loadTask(sql: SqlStorage, id: string, now = Date.now()): TaskState | null {
	const row = getTaskRow(sql, id);
	if (!row) return null;
	const watchers = sql
		.exec<{ member_id: string }>(
			"SELECT member_id FROM task_watcher WHERE task_id = ? ORDER BY member_id",
			id,
		)
		.toArray();
	const subtasks = sql
		.exec<SubtaskRow>(
			"SELECT * FROM subtask WHERE task_id = ? AND deleted_at IS NULL ORDER BY position",
			id,
		)
		.toArray()
		.map(toSubtask);
	return toTaskState(
		row,
		watchers.map((w) => w.member_id),
		subtasks,
		occurrenceStates(sql, id, now).get(id) ?? [],
	);
}

export function listVisibleTasks(
	sql: SqlStorage,
	audience: Audience,
	now = Date.now(),
): TaskState[] {
	const rows = sql
		.exec<TaskRow>("SELECT * FROM task ORDER BY created_at")
		.toArray()
		.filter((row) => canSeeScope(audience, row.team_id));
	if (!rows.length) return [];
	const watchers = sql
		.exec<{ task_id: string; member_id: string }>(
			"SELECT task_id, member_id FROM task_watcher ORDER BY member_id",
		)
		.toArray();
	const subtasks = sql
		.exec<SubtaskRow>("SELECT * FROM subtask WHERE deleted_at IS NULL ORDER BY position")
		.toArray();
	const occurrences = occurrenceStates(sql, null, now);
	return rows.map((row) =>
		toTaskState(
			row,
			watchers.filter((w) => w.task_id === row.id).map((w) => w.member_id),
			subtasks.filter((s) => s.task_id === row.id).map(toSubtask),
			occurrences.get(row.id) ?? [],
		),
	);
}

// --- Validating operations ----------------------------------------------------

type Body = Record<string, unknown>;

class InvalidOp extends Error {}

function str(body: Body, key: string, max: number, required = true): string | undefined {
	const value = body[key];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string") throw new InvalidOp(`${key} must be text`);
	const trimmed = value.trim();
	if (required && !trimmed) throw new InvalidOp(`${key} is required`);
	if (trimmed.length > max) throw new InvalidOp(`${key} must be at most ${max} characters`);
	return trimmed;
}

/** Optional text that may also be null (to clear it). Empty text becomes null. */
function nullableStr(body: Body, key: string, max: number): string | null | undefined {
	if (body[key] === undefined) return undefined;
	if (body[key] === null) return null;
	return str(body, key, max, false) || null;
}

function id(body: Body, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || !UUID.test(value)) throw new InvalidOp(`${key} must be an id`);
	return value.toLowerCase();
}

function nullableId(body: Body, key: string): string | null | undefined {
	if (body[key] === undefined) return undefined;
	if (body[key] === null) return null;
	return id(body, key);
}

function ids(body: Body, key: string, max: number): string[] {
	const value = body[key];
	if (!Array.isArray(value) || value.length > max)
		throw new InvalidOp(`${key} must be a list of at most ${max} ids`);
	return [...new Set(value.map((_, i) => id(value as unknown as Body, String(i))))];
}

function schedule(body: Body) {
	if (body.schedule === undefined || body.schedule === null) return null;
	const parsed = parseSchedule(body.schedule);
	if (typeof parsed === "string") throw new InvalidOp(parsed);
	return parsed;
}

function colour(body: Body): LabelColour | null | undefined {
	const value = body.colour;
	if (value === undefined || value === null) return value;
	if (!isLabelColour(value)) throw new InvalidOp("colour must be one of the label colours");
	return value;
}

function position(body: Body): number {
	const value = body.position;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new InvalidOp("position must be a number");
	return value;
}

/** Turns an untrusted JSON value into an operation, or an error message. */
export function parseOp(value: unknown): Op | string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "op must be an object";
	const body = value as Body;
	try {
		switch (body.type) {
			case "task.create": {
				const subtasks = body.subtasks === undefined ? [] : body.subtasks;
				if (!Array.isArray(subtasks) || subtasks.length > TASK_LIMITS.subtasks)
					throw new InvalidOp("subtasks must be a list");
				return {
					type: "task.create",
					id: id(body, "id"),
					title: str(body, "title", TASK_LIMITS.title)!,
					notes: nullableStr(body, "notes", TASK_LIMITS.notes) ?? undefined,
					label: nullableStr(body, "label", TASK_LIMITS.label) ?? null,
					colour: colour(body) ?? null,
					teamId: nullableId(body, "teamId") ?? null,
					assigneeId: nullableId(body, "assigneeId") ?? null,
					watcherIds:
						body.watcherIds === undefined ? [] : ids(body, "watcherIds", TASK_LIMITS.watchers),
					subtasks: subtasks.map((item: unknown) => {
						if (!item || typeof item !== "object")
							throw new InvalidOp("each subtask must be an object");
						return {
							id: id(item as Body, "id"),
							title: str(item as Body, "title", TASK_LIMITS.subtaskTitle)!,
						};
					}),
					schedule: schedule(body),
				};
			}
			case "task.update": {
				const changes = body.changes;
				if (!changes || typeof changes !== "object")
					throw new InvalidOp("changes must be an object");
				const c = changes as Body;
				const parsed = {
					title: str(c, "title", TASK_LIMITS.title, false),
					notes: nullableStr(c, "notes", TASK_LIMITS.notes),
					label: nullableStr(c, "label", TASK_LIMITS.label),
					colour: colour(c),
					teamId: nullableId(c, "teamId"),
					assigneeId: nullableId(c, "assigneeId"),
				};
				if (c.title !== undefined && !parsed.title) throw new InvalidOp("title is required");
				return {
					type: "task.update",
					id: id(body, "id"),
					changes: Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)),
				};
			}
			case "task.setSchedule":
				if (body.schedule === undefined)
					throw new InvalidOp("schedule is required (null removes it)");
				return { type: "task.setSchedule", id: id(body, "id"), schedule: schedule(body) };
			case "occurrence.done": {
				const at = body.at;
				if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at)))
					throw new InvalidOp("at must be a time");
				return {
					type: "occurrence.done",
					id: id(body, "id"),
					at,
					note: nullableStr(body, "note", TASK_LIMITS.occurrenceNote) ?? null,
				};
			}
			case "occurrence.reopen":
				return { type: "occurrence.reopen", id: id(body, "id") };
			case "occurrence.tick":
			case "occurrence.untick":
				return {
					type: body.type,
					occurrenceId: id(body, "occurrenceId"),
					subtaskId: id(body, "subtaskId"),
				};
			case "task.setWatchers":
				return {
					type: "task.setWatchers",
					id: id(body, "id"),
					watcherIds: ids(body, "watcherIds", TASK_LIMITS.watchers),
				};
			case "task.done":
			case "task.reopen":
			case "task.archive":
			case "task.unarchive":
			case "task.clearCompleted":
			case "subtask.tick":
			case "subtask.untick":
			case "subtask.remove":
				return { type: body.type, id: id(body, "id") };
			case "subtask.add":
				return {
					type: "subtask.add",
					taskId: id(body, "taskId"),
					id: id(body, "id"),
					title: str(body, "title", TASK_LIMITS.subtaskTitle)!,
					note: nullableStr(body, "note", TASK_LIMITS.subtaskNote) ?? null,
					position: position(body),
				};
			case "subtask.update": {
				const title = str(body, "title", TASK_LIMITS.subtaskTitle, false);
				if (body.title !== undefined && !title) throw new InvalidOp("title is required");
				return {
					type: "subtask.update",
					id: id(body, "id"),
					title,
					note: nullableStr(body, "note", TASK_LIMITS.subtaskNote),
				};
			}
			case "subtask.move":
				return { type: "subtask.move", id: id(body, "id"), position: position(body) };
			default:
				return "unknown operation";
		}
	} catch (error) {
		if (error instanceof InvalidOp) return error.message;
		throw error;
	}
}

// --- Applying operations -------------------------------------------------------

export interface Actor {
	member: MemberRow;
	audience: Audience;
}

/** How long ago a Done may say it was tapped (offline completions, FR-22). */
const MAX_DONE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Applied {
	taskId: string;
	/** Set when the task changed scope, so devices that could see the old scope are told it's gone. */
	previousTeamId?: string | null;
}

function liveTeamExists(sql: SqlStorage, teamId: string): boolean {
	return (
		sql.exec("SELECT 1 FROM team WHERE id = ? AND deleted_at IS NULL", teamId).toArray().length > 0
	);
}

function activeMember(sql: SqlStorage, memberId: string): { display_name: string } | undefined {
	return sql
		.exec<{ display_name: string }>(
			"SELECT display_name FROM member WHERE id = ? AND deactivated_at IS NULL",
			memberId,
		)
		.toArray()[0];
}

function inTeam(sql: SqlStorage, teamId: string, memberId: string): boolean {
	return (
		sql
			.exec("SELECT 1 FROM team_member WHERE team_id = ? AND member_id = ?", teamId, memberId)
			.toArray().length > 0
	);
}

/** FR-86 and FR-87 checks for a task's scope and people. */
function checkScopeAndPeople(
	sql: SqlStorage,
	actor: Actor,
	teamId: string | null,
	people: string[],
): Result<null> {
	if (teamId !== null) {
		if (!liveTeamExists(sql, teamId)) return fail(404, "Household not found.");
		if (!canSeeScope(actor.audience, teamId))
			return fail(403, "You can only add tasks to households you belong to.");
	}
	for (const memberId of people) {
		const member = activeMember(sql, memberId);
		if (!member) return fail(404, "That family member wasn't found.");
		if (teamId !== null && !inTeam(sql, teamId, memberId)) {
			return fail(
				409,
				`${member.display_name} isn't in this household. Only people in the household can be assigned or watch its tasks.`,
			);
		}
	}
	return ok(null);
}

function visibleTask(sql: SqlStorage, actor: Actor, taskId: string): Result<TaskRow> {
	const task = getTaskRow(sql, taskId);
	if (!task || !canSeeScope(actor.audience, task.team_id)) return fail(404, "Task not found.");
	return ok(task);
}

function visibleSubtask(
	sql: SqlStorage,
	actor: Actor,
	subtaskId: string,
): Result<{ task: TaskRow; subtask: SubtaskRow }> {
	const subtask = sql
		.exec<SubtaskRow>("SELECT * FROM subtask WHERE id = ? AND deleted_at IS NULL", subtaskId)
		.toArray()[0];
	if (!subtask) return fail(404, "Checklist item not found.");
	const task = visibleTask(sql, actor, subtask.task_id);
	return task.ok ? ok({ task: task.value, subtask }) : task;
}

const watcherIdsOf = (sql: SqlStorage, taskId: string) =>
	sql
		.exec<{ member_id: string }>("SELECT member_id FROM task_watcher WHERE task_id = ?", taskId)
		.toArray()
		.map((w) => w.member_id);

/**
 * Applies one operation. Call inside a transaction; the caller records the change.
 * `jobs` collects pushes and other tasks changed by scheduling rules.
 */
export function applyOp(sql: SqlStorage, actor: Actor, op: Op, jobs: JobContext): Result<Applied> {
	const { now, timeZone } = jobs;
	const me = actor.member.id;
	const touch = (taskId: string) =>
		sql.exec("UPDATE task SET updated_at = ? WHERE id = ?", now, taskId);

	switch (op.type) {
		case "task.create": {
			const existing = getTaskRow(sql, op.id);
			// A retried create (same device, same id) succeeds without creating a duplicate.
			if (existing)
				return existing.created_by === me
					? ok({ taskId: op.id })
					: fail(409, "A task with that id already exists.");
			const people = [...(op.assigneeId ? [op.assigneeId] : []), ...(op.watcherIds ?? [])];
			const allowed = checkScopeAndPeople(sql, actor, op.teamId ?? null, people);
			if (!allowed.ok) return allowed;
			sql.exec(
				`INSERT INTO task (id, team_id, title, notes, label, colour, assignee_id, created_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				op.id,
				op.teamId ?? null,
				op.title,
				op.notes ?? null,
				op.label ?? null,
				op.label ? (op.colour ?? null) : null,
				op.assigneeId ?? null,
				me,
				now,
				now,
			);
			for (const watcher of op.watcherIds ?? [])
				sql.exec("INSERT INTO task_watcher (task_id, member_id) VALUES (?, ?)", op.id, watcher);
			(op.subtasks ?? []).forEach((item, i) => {
				sql.exec(
					"INSERT INTO subtask (id, task_id, title, position) VALUES (?, ?, ?, ?)",
					item.id,
					op.id,
					item.title,
					i + 1,
				);
			});
			if (op.schedule) setSchedule(sql, op.id, op.schedule, timeZone, now);
			return ok({ taskId: op.id });
		}

		case "task.update": {
			const found = visibleTask(sql, actor, op.id);
			if (!found.ok) return found;
			const task = found.value;
			const { changes } = op;
			const teamId = changes.teamId !== undefined ? changes.teamId : task.team_id;
			const assigneeId = changes.assigneeId !== undefined ? changes.assigneeId : task.assignee_id;
			if (changes.teamId !== undefined || changes.assigneeId !== undefined) {
				const people = [...(assigneeId ? [assigneeId] : []), ...watcherIdsOf(sql, op.id)];
				const allowed = checkScopeAndPeople(sql, actor, teamId, people);
				if (!allowed.ok) return allowed;
			}
			if (changes.title !== undefined)
				sql.exec("UPDATE task SET title = ? WHERE id = ?", changes.title, op.id);
			if (changes.notes !== undefined)
				sql.exec("UPDATE task SET notes = ? WHERE id = ?", changes.notes, op.id);
			if (changes.label !== undefined)
				sql.exec("UPDATE task SET label = ? WHERE id = ?", changes.label, op.id);
			if (changes.colour !== undefined)
				sql.exec("UPDATE task SET colour = ? WHERE id = ?", changes.colour, op.id);
			if (changes.assigneeId !== undefined)
				sql.exec("UPDATE task SET assignee_id = ? WHERE id = ?", changes.assigneeId, op.id);
			if (changes.teamId !== undefined)
				sql.exec("UPDATE task SET team_id = ? WHERE id = ?", changes.teamId, op.id);
			touch(op.id);
			return ok(
				changes.teamId !== undefined && changes.teamId !== task.team_id
					? { taskId: op.id, previousTeamId: task.team_id }
					: { taskId: op.id },
			);
		}

		case "task.setWatchers": {
			const found = visibleTask(sql, actor, op.id);
			if (!found.ok) return found;
			const allowed = checkScopeAndPeople(sql, actor, found.value.team_id, op.watcherIds);
			if (!allowed.ok) return allowed;
			sql.exec("DELETE FROM task_watcher WHERE task_id = ?", op.id);
			for (const watcher of op.watcherIds)
				sql.exec("INSERT INTO task_watcher (task_id, member_id) VALUES (?, ?)", op.id, watcher);
			touch(op.id);
			return ok({ taskId: op.id });
		}

		case "task.setSchedule": {
			const found = visibleTask(sql, actor, op.id);
			if (!found.ok) return found;
			if (found.value.archived) return fail(409, "Restore this task before changing its schedule.");
			if (!op.schedule) {
				// It becomes a plain task again, starting open (FR-21).
				sql.exec("UPDATE task SET done_at = NULL, done_by = NULL WHERE id = ?", op.id);
			} else if (!scheduleOf(found.value)) {
				// Ticks belong to occurrences from now on (FR-17, FR-21).
				sql.exec("UPDATE subtask SET done_at = NULL, done_by = NULL WHERE task_id = ?", op.id);
			}
			setSchedule(sql, op.id, op.schedule, timeZone, now);
			touch(op.id);
			return ok({ taskId: op.id });
		}

		case "occurrence.done":
		case "occurrence.reopen":
		case "occurrence.tick":
		case "occurrence.untick": {
			const occurrence = getOccurrence(
				sql,
				op.type === "occurrence.done" || op.type === "occurrence.reopen" ? op.id : op.occurrenceId,
			);
			if (!occurrence) return fail(404, "That occurrence wasn't found.");
			const found = visibleTask(sql, actor, occurrence.task_id);
			if (!found.ok) return found;
			const task = found.value;
			if (task.archived) return fail(409, "This task is archived.");
			if (op.type === "occurrence.done") {
				const at = Math.max(Math.min(op.at ?? now, now), now - MAX_DONE_AGE_MS);
				completeOccurrence(jobs, occurrence, task, me, at, op.note ?? null);
			} else if (op.type === "occurrence.reopen") {
				reopenOccurrence(jobs, occurrence, task);
			} else {
				const item = sql
					.exec(
						"SELECT 1 FROM subtask WHERE id = ? AND task_id = ? AND deleted_at IS NULL",
						op.subtaskId,
						task.id,
					)
					.toArray();
				if (!item.length) return fail(404, "Checklist item not found.");
				if (op.type === "occurrence.tick") {
					sql.exec(
						"INSERT INTO occurrence_tick (occurrence_id, subtask_id, done_at, done_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
						occurrence.id,
						op.subtaskId,
						now,
						me,
					);
				} else {
					sql.exec(
						"DELETE FROM occurrence_tick WHERE occurrence_id = ? AND subtask_id = ?",
						occurrence.id,
						op.subtaskId,
					);
				}
			}
			touch(task.id);
			return ok({ taskId: task.id });
		}

		case "task.done":
		case "task.reopen": {
			const found = visibleTask(sql, actor, op.id);
			if (!found.ok) return found;
			if (found.value.due_date || found.value.repeat)
				return fail(409, "Tasks with a due date or repeat are completed per occurrence.");
			if (op.type === "task.done") {
				// First Done wins (FR-54).
				sql.exec(
					"UPDATE task SET done_at = COALESCE(done_at, ?), done_by = COALESCE(done_by, ?) WHERE id = ?",
					now,
					me,
					op.id,
				);
			} else {
				sql.exec("UPDATE task SET done_at = NULL, done_by = NULL WHERE id = ?", op.id);
			}
			touch(op.id);
			return ok({ taskId: op.id });
		}

		case "task.archive":
		case "task.unarchive": {
			const found = visibleTask(sql, actor, op.id);
			if (!found.ok) return found;
			if (
				op.type === "task.unarchive" &&
				found.value.team_id &&
				!liveTeamExists(sql, found.value.team_id)
			) {
				return fail(
					409,
					"This task's household was deleted. Move it to the whole family or another household first.",
				);
			}
			if (op.type === "task.archive" && !found.value.archived) {
				sql.exec("UPDATE task SET archived = 1 WHERE id = ?", op.id);
				archiveSchedule(sql, op.id, now);
			} else if (op.type === "task.unarchive" && found.value.archived) {
				sql.exec("UPDATE task SET archived = 0 WHERE id = ?", op.id);
				rebuildSchedule(sql, op.id, timeZone, now);
			}
			touch(op.id);
			return ok({ taskId: op.id });
		}

		case "task.clearCompleted": {
			const found = visibleTask(sql, actor, op.id);
			if (!found.ok) return found;
			if (scheduleOf(found.value))
				return fail(
					409,
					"Each occurrence starts with a fresh checklist, so there's nothing to clear.",
				);
			sql.exec(
				"UPDATE subtask SET deleted_at = ? WHERE task_id = ? AND done_at IS NOT NULL AND deleted_at IS NULL",
				now,
				op.id,
			);
			touch(op.id);
			return ok({ taskId: op.id });
		}

		case "subtask.add": {
			const found = visibleTask(sql, actor, op.taskId);
			if (!found.ok) return found;
			const existing = sql
				.exec<SubtaskRow>("SELECT * FROM subtask WHERE id = ?", op.id)
				.toArray()[0];
			if (existing)
				return existing.task_id === op.taskId
					? ok({ taskId: op.taskId })
					: fail(409, "A checklist item with that id already exists.");
			const count = sql
				.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM subtask WHERE task_id = ? AND deleted_at IS NULL",
					op.taskId,
				)
				.one().n;
			if (count >= TASK_LIMITS.subtasks)
				return fail(409, `A checklist can have at most ${TASK_LIMITS.subtasks} items.`);
			sql.exec(
				"INSERT INTO subtask (id, task_id, title, note, position) VALUES (?, ?, ?, ?, ?)",
				op.id,
				op.taskId,
				op.title,
				op.note ?? null,
				op.position,
			);
			touch(op.taskId);
			return ok({ taskId: op.taskId });
		}

		case "subtask.update":
		case "subtask.tick":
		case "subtask.untick":
		case "subtask.move":
		case "subtask.remove": {
			const found = visibleSubtask(sql, actor, op.id);
			if (!found.ok) return found;
			const taskId = found.value.task.id;
			if (
				(op.type === "subtask.tick" || op.type === "subtask.untick") &&
				scheduleOf(found.value.task)
			) {
				return fail(409, "On a scheduled task, items are ticked for one occurrence.");
			}
			if (op.type === "subtask.update") {
				if (op.title !== undefined)
					sql.exec("UPDATE subtask SET title = ? WHERE id = ?", op.title, op.id);
				if (op.note !== undefined)
					sql.exec("UPDATE subtask SET note = ? WHERE id = ?", op.note, op.id);
			} else if (op.type === "subtask.tick") {
				sql.exec(
					"UPDATE subtask SET done_at = COALESCE(done_at, ?), done_by = COALESCE(done_by, ?) WHERE id = ?",
					now,
					me,
					op.id,
				);
			} else if (op.type === "subtask.untick") {
				sql.exec("UPDATE subtask SET done_at = NULL, done_by = NULL WHERE id = ?", op.id);
			} else if (op.type === "subtask.move") {
				sql.exec("UPDATE subtask SET position = ? WHERE id = ?", op.position, op.id);
			} else {
				sql.exec("UPDATE subtask SET deleted_at = ? WHERE id = ?", now, op.id);
			}
			touch(taskId);
			return ok({ taskId });
		}
	}
}
