// Occurrences, scheduled jobs and completion for tasks with a due date or repeat
// (requirements 4.4 FR-11–25, 7.3, 7.5, NFR-5). Functions here change SQL only;
// OrgDO runs them in transactions, records changes and arms the alarm.
import { newId } from "../../shared/ids.ts";
import { dueTimesBetween, type Schedule } from "../../shared/schedule.ts";
import type { OccurrenceState, OccurrenceStatus } from "../../shared/sync.ts";
import { DAY_MS } from "../../shared/time.ts";
import { enqueueAlert, wording, type AlertKind } from "./notify.ts";
import type { TaskRow } from "./tasks.ts";

const MINUTE_MS = 60_000;
/** Occurrences are created at least this far ahead (FR-25). */
const WINDOW_MS = 2 * DAY_MS;
const MATERIALIZE_EVERY_MS = 6 * 60 * MINUTE_MS;
/** An unacknowledged missed alert is sent once more after this (NFR-5). */
export const RESEND_AFTER_MS = 10 * MINUTE_MS;
/** Devices get occurrences due in the last week plus upcoming ones. */
const HISTORY_MS = 7 * DAY_MS;

export type OccurrenceRow = {
	id: string;
	task_id: string;
	due_at: number;
	status: OccurrenceStatus;
	done_at: number | null;
	done_by: string | null;
	on_behalf: number;
	note: string | null;
};

type JobKind = "advance" | "due" | "second" | "missed" | "resend" | "materialize" | "purge";

type JobRow = {
	id: string;
	occurrence_id: string | null;
	kind: JobKind;
	fire_at: number;
	done_at: number | null;
};

type AlertRow = {
	id: string;
	occurrence_id: string;
	kind: string;
	sent_at: number | null;
	acked_at: number | null;
	attempts: number;
	recipients: string | null;
	undelivered_at: number | null;
};

// --- Schedule columns -----------------------------------------------------------

export function scheduleOf(row: TaskRow): Schedule | null {
	if (!row.due_date && !row.repeat) return null;
	return {
		due: row.due_date ? { date: row.due_date, time: row.due_time! } : null,
		repeat: row.repeat ? JSON.parse(row.repeat) : null,
		remindBeforeMinutes: row.remind_before_minutes,
		secondReminderMinutes: row.second_reminder_minutes,
		overdueAfterMinutes: row.overdue_after_minutes,
	};
}

function writeSchedule(sql: SqlStorage, taskId: string, schedule: Schedule | null): void {
	sql.exec(
		`UPDATE task SET due_date = ?, due_time = ?, repeat = ?, remind_before_minutes = ?, second_reminder_minutes = ?, overdue_after_minutes = ?
		 WHERE id = ?`,
		schedule?.due?.date ?? null,
		schedule?.due?.time ?? null,
		schedule?.repeat ? JSON.stringify(schedule.repeat) : null,
		schedule?.remindBeforeMinutes ?? null,
		schedule?.secondReminderMinutes ?? null,
		schedule?.overdueAfterMinutes ?? null,
		taskId,
	);
}

const getTask = (sql: SqlStorage, id: string) =>
	sql.exec<TaskRow>("SELECT * FROM task WHERE id = ?", id).toArray()[0];

export const getOccurrence = (sql: SqlStorage, id: string) =>
	sql.exec<OccurrenceRow>("SELECT * FROM occurrence WHERE id = ?", id).toArray()[0];

// --- Creating and removing occurrences ------------------------------------------

/** Pending jobs for one occurrence; steps already in the past are skipped. */
function createJobs(
	sql: SqlStorage,
	occurrence: { id: string; due_at: number },
	schedule: Schedule,
	now: number,
): void {
	const due = occurrence.due_at;
	const steps: [JobKind, number | null][] = [
		[
			"advance",
			schedule.remindBeforeMinutes === null ? null : due - schedule.remindBeforeMinutes * MINUTE_MS,
		],
		["due", due],
		[
			"second",
			schedule.secondReminderMinutes === null
				? null
				: due + schedule.secondReminderMinutes * MINUTE_MS,
		],
		[
			"missed",
			schedule.overdueAfterMinutes === null ? null : due + schedule.overdueAfterMinutes * MINUTE_MS,
		],
	];
	for (const [kind, fireAt] of steps) {
		if (fireAt === null || fireAt < now) continue;
		sql.exec(
			"INSERT INTO scheduled_job (id, occurrence_id, kind, fire_at) VALUES (?, ?, ?, ?)",
			newId(),
			occurrence.id,
			kind,
			fireAt,
		);
	}
}

/**
 * Creates the task's occurrences over the rolling window (FR-25), with their jobs.
 * A one-off task gets its single occurrence straight away, whenever it's due. Returns true if any were created.
 */
export function materializeTask(
	sql: SqlStorage,
	task: TaskRow,
	timeZone: string,
	now: number,
): boolean {
	const schedule = scheduleOf(task);
	if (!schedule || task.archived) return false;
	const times = schedule.due
		? dueTimesBetween(schedule, timeZone, 0, Number.MAX_SAFE_INTEGER)
		: dueTimesBetween(
				schedule,
				timeZone,
				now,
				now + WINDOW_MS + (schedule.remindBeforeMinutes ?? 0) * MINUTE_MS,
			);
	let created = false;
	for (const dueAt of times) {
		const inserted = sql
			.exec<{ id: string }>(
				"INSERT INTO occurrence (id, task_id, due_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
				newId(),
				task.id,
				dueAt,
			)
			.toArray()[0];
		if (!inserted) continue;
		createJobs(sql, { id: inserted.id, due_at: dueAt }, schedule, now);
		created = true;
	}
	return created;
}

/** Deletes the matching occurrences with their jobs, alerts and ticks; returns how many. */
export function deleteOccurrences(
	sql: SqlStorage,
	where: string,
	...params: (string | number)[]
): number {
	const ids = sql
		.exec<{ id: string }>(`SELECT id FROM occurrence WHERE ${where}`, ...params)
		.toArray()
		.map((r) => r.id);
	for (const id of ids) {
		sql.exec("DELETE FROM scheduled_job WHERE occurrence_id = ?", id);
		sql.exec("DELETE FROM alert WHERE occurrence_id = ?", id);
		sql.exec("DELETE FROM occurrence_tick WHERE occurrence_id = ?", id);
		sql.exec("DELETE FROM occurrence WHERE id = ?", id);
	}
	return ids.length;
}

/** Stops all pending reminders for a task's occurrences. */
function cancelJobs(sql: SqlStorage, taskId: string): void {
	sql.exec(
		"DELETE FROM scheduled_job WHERE done_at IS NULL AND occurrence_id IN (SELECT id FROM occurrence WHERE task_id = ?)",
		taskId,
	);
}

/**
 * Sets or removes a task's schedule (FR-23): open occurrences still in the future are
 * replaced; past ones and their history stay. Without a schedule, nothing more is sent.
 */
export function setSchedule(
	sql: SqlStorage,
	taskId: string,
	schedule: Schedule | null,
	timeZone: string,
	now: number,
): void {
	writeSchedule(sql, taskId, schedule);
	deleteOccurrences(sql, "task_id = ? AND status = 'open' AND due_at > ?", taskId, now);
	// A one-off task has a single due point, so moving it replaces an overdue one too.
	if (schedule?.due) deleteOccurrences(sql, "task_id = ? AND status = 'open'", taskId);
	if (!schedule) {
		cancelJobs(sql, taskId);
		// Open occurrences of a schedule that no longer exists would stay overdue forever.
		deleteOccurrences(sql, "task_id = ? AND status = 'open'", taskId);
		return;
	}
	materializeTask(sql, getTask(sql, taskId), timeZone, now);
	ensureMaterializeJob(sql, now);
}

/** Archiving cancels pending reminders and drops occurrences that haven't happened yet (FR-20). */
export function archiveSchedule(sql: SqlStorage, taskId: string, now: number): void {
	cancelJobs(sql, taskId);
	deleteOccurrences(sql, "task_id = ? AND status = 'open' AND due_at > ?", taskId, now);
}

/** Unarchiving or a timezone change: future occurrences are created again from the schedule. */
export function rebuildSchedule(
	sql: SqlStorage,
	taskId: string,
	timeZone: string,
	now: number,
): void {
	const task = getTask(sql, taskId);
	const schedule = task && scheduleOf(task);
	if (!schedule) return;
	setSchedule(sql, taskId, schedule, timeZone, now);
}

/** Keeps one recurring job that extends every task's window. */
export function ensureMaterializeJob(sql: SqlStorage, now: number): void {
	const pending =
		sql.exec("SELECT 1 FROM scheduled_job WHERE kind = 'materialize' AND done_at IS NULL").toArray()
			.length > 0;
	if (!pending)
		sql.exec(
			"INSERT INTO scheduled_job (id, kind, fire_at) VALUES (?, 'materialize', ?)",
			newId(),
			now + MATERIALIZE_EVERY_MS,
		);
}

/** When the alarm should next run: the earliest pending job, or null. */
export function nextJobAt(sql: SqlStorage): number | null {
	return sql
		.exec<{ at: number | null }>(
			"SELECT MIN(fire_at) AS at FROM scheduled_job WHERE done_at IS NULL",
		)
		.one().at;
}

// --- Running jobs -----------------------------------------------------------------

export interface JobContext {
	sql: SqlStorage;
	timeZone: string;
	now: number;
	/** Task ids whose state changed, so OrgDO can record and broadcast them. */
	changed: Set<string>;
}

/** Due jobs, oldest first. */
export function dueJobs(sql: SqlStorage, now: number, limit: number): JobRow[] {
	return sql
		.exec<JobRow>(
			"SELECT * FROM scheduled_job WHERE done_at IS NULL AND fire_at <= ? ORDER BY fire_at LIMIT ?",
			now,
			limit,
		)
		.toArray();
}

/**
 * Runs one job and marks it done. Every step re-checks the occurrence first, so a job
 * that runs twice (alarms may repeat) never sends twice (7.3). Call inside a transaction.
 */
export function runJob(ctx: JobContext, jobId: string): void {
	const { sql, now } = ctx;
	const job = sql
		.exec<JobRow>("SELECT * FROM scheduled_job WHERE id = ? AND done_at IS NULL", jobId)
		.toArray()[0];
	if (!job) return;
	sql.exec("UPDATE scheduled_job SET done_at = ? WHERE id = ?", now, job.id);

	if (job.kind === "materialize") {
		const tasks = sql
			.exec<TaskRow>(
				"SELECT * FROM task WHERE archived = 0 AND (due_date IS NOT NULL OR repeat IS NOT NULL)",
			)
			.toArray();
		for (const task of tasks)
			if (materializeTask(sql, task, ctx.timeZone, now)) ctx.changed.add(task.id);
		if (tasks.some((t) => t.repeat)) ensureMaterializeJob(sql, now);
		return;
	}

	const occurrence = job.occurrence_id ? getOccurrence(sql, job.occurrence_id) : undefined;
	const task = occurrence && getTask(sql, occurrence.task_id);
	const schedule = task && scheduleOf(task);
	if (!occurrence || !task || task.archived || !schedule) return;

	switch (job.kind) {
		case "advance":
		case "due":
		case "second": {
			if (occurrence.status !== "open") return;
			if (job.kind === "due" && schedule.overdueAfterMinutes === null)
				closeEarlierQuietly(ctx, task.id, occurrence.due_at);
			const ttl = reminderTtl(job.kind, occurrence.due_at, schedule, now);
			sendAlert(ctx, occurrence, task, job.kind, reminderRecipients(sql, task), ttl);
			return;
		}
		case "missed": {
			if (occurrence.status !== "open") return;
			sql.exec("UPDATE occurrence SET status = 'missed' WHERE id = ?", occurrence.id);
			ctx.changed.add(task.id);
			const watchers = activeWatchers(sql, task.id);
			// Without watchers it is just shown as missed (FR-14).
			if (!watchers.length) return;
			sendAlert(ctx, occurrence, task, "missed", watchers, ALERT_TTL_S);
			sql.exec(
				"INSERT INTO scheduled_job (id, occurrence_id, kind, fire_at) VALUES (?, ?, 'resend', ?)",
				newId(),
				occurrence.id,
				now + RESEND_AFTER_MS,
			);
			return;
		}
		case "resend": {
			const alert = missedAlert(sql, occurrence.id);
			if (
				!alert ||
				alert.acked_at !== null ||
				alert.undelivered_at !== null ||
				occurrence.status !== "missed"
			)
				return;
			if (alert.attempts < 2) {
				// Sent once more (NFR-5), then checked again.
				const recipients = (JSON.parse(alert.recipients ?? "[]") as string[]).filter((id) =>
					isActive(sql, id),
				);
				enqueueAlert(
					sql,
					alert.id,
					recipients,
					wording(sql, ctx.timeZone, now, "missed", task, occurrence),
					ALERT_TTL_S,
					now,
				);
				sql.exec(
					"UPDATE alert SET attempts = attempts + 1, sent_at = ? WHERE id = ?",
					now,
					alert.id,
				);
				sql.exec(
					"INSERT INTO scheduled_job (id, occurrence_id, kind, fire_at) VALUES (?, ?, 'resend', ?)",
					newId(),
					occurrence.id,
					now + RESEND_AFTER_MS,
				);
			} else {
				sql.exec("UPDATE alert SET undelivered_at = ? WHERE id = ?", now, alert.id);
				ctx.changed.add(task.id);
			}
			return;
		}
	}
}

const ALERT_TTL_S = 12 * 60 * 60;

/** Push TTL: until the next follow-up step (FR-45). */
function reminderTtl(
	kind: "advance" | "due" | "second",
	dueAt: number,
	schedule: Schedule,
	now: number,
): number {
	const until = (at: number) => Math.max(60, Math.round((at - now) / 1000));
	if (kind === "advance") return until(dueAt);
	if (kind === "due" && schedule.secondReminderMinutes !== null)
		return schedule.secondReminderMinutes * 60;
	if (schedule.overdueAfterMinutes !== null)
		return until(dueAt + schedule.overdueAfterMinutes * MINUTE_MS);
	return 60 * 60;
}

/** With Overdue after = Never, an open occurrence closes (without alerts) when the next one is due (FR-14). */
function closeEarlierQuietly(ctx: JobContext, taskId: string, dueAt: number): void {
	const closed = ctx.sql
		.exec(
			"UPDATE occurrence SET status = 'missed' WHERE task_id = ? AND status = 'open' AND due_at < ? RETURNING id",
			taskId,
			dueAt,
		)
		.toArray();
	if (closed.length) ctx.changed.add(taskId);
}

function sendAlert(
	ctx: JobContext,
	occurrence: OccurrenceRow,
	task: TaskRow,
	kind: AlertKind,
	recipients: string[],
	ttl: number,
): void {
	const { sql, now } = ctx;
	const alertId = newId();
	sql.exec(
		"INSERT INTO alert (id, occurrence_id, kind, sent_at, attempts, recipients) VALUES (?, ?, ?, ?, 1, ?)",
		alertId,
		occurrence.id,
		kind,
		now,
		JSON.stringify(recipients),
	);
	enqueueAlert(
		sql,
		alertId,
		recipients,
		wording(sql, ctx.timeZone, now, kind, task, occurrence),
		ttl,
		now,
	);
}

const isActive = (sql: SqlStorage, memberId: string) =>
	sql.exec("SELECT 1 FROM member WHERE id = ? AND deactivated_at IS NULL", memberId).toArray()
		.length > 0;

/** The assignee, or everyone who can see the task (FR-12). */
function reminderRecipients(sql: SqlStorage, task: TaskRow): string[] {
	if (task.assignee_id && isActive(sql, task.assignee_id)) return [task.assignee_id];
	const rows = task.team_id
		? sql.exec<{ id: string }>(
				"SELECT m.id FROM member m JOIN team_member tm ON tm.member_id = m.id WHERE tm.team_id = ? AND m.deactivated_at IS NULL",
				task.team_id,
			)
		: sql.exec<{ id: string }>("SELECT id FROM member WHERE deactivated_at IS NULL");
	return rows.toArray().map((r) => r.id);
}

function activeWatchers(sql: SqlStorage, taskId: string): string[] {
	return sql
		.exec<{ id: string }>(
			"SELECT m.id FROM task_watcher w JOIN member m ON m.id = w.member_id WHERE w.task_id = ? AND m.deactivated_at IS NULL",
			taskId,
		)
		.toArray()
		.map((r) => r.id);
}

const missedAlert = (sql: SqlStorage, occurrenceId: string) =>
	sql
		.exec<AlertRow>(
			"SELECT * FROM alert WHERE occurrence_id = ? AND kind = 'missed' ORDER BY sent_at LIMIT 1",
			occurrenceId,
		)
		.toArray()[0];

// --- Completing occurrences ---------------------------------------------------------

/**
 * Marks an occurrence done (FR-15, FR-18, FR-22). The first Done wins (FR-54).
 * `at` is when the member tapped Done, already capped at the server's time.
 */
export function completeOccurrence(
	ctx: JobContext,
	occurrence: OccurrenceRow,
	task: TaskRow,
	actorId: string,
	at: number,
	note: string | null,
): void {
	const { sql, now } = ctx;
	if (occurrence.status === "done" || occurrence.status === "done_late") return;
	const overdue = task.overdue_after_minutes;
	const late =
		overdue !== null && scheduleOf(task) !== null && at > occurrence.due_at + overdue * MINUTE_MS;
	const onBehalf = task.assignee_id !== null && task.assignee_id !== actorId;
	sql.exec(
		"UPDATE occurrence SET status = ?, done_at = ?, done_by = ?, on_behalf = ?, note = ? WHERE id = ?",
		late ? "done_late" : "done",
		at,
		actorId,
		onBehalf ? 1 : 0,
		note,
		occurrence.id,
	);
	sql.exec("DELETE FROM scheduled_job WHERE occurrence_id = ? AND done_at IS NULL", occurrence.id);
	ctx.changed.add(task.id);

	// Watchers who were told it was missed hear that it's done (FR-22); on-behalf
	// completions are reported to the assignee and the other watchers (FR-18).
	const alerted = missedAlert(sql, occurrence.id);
	const told = new Set<string>(alerted ? JSON.parse(alerted.recipients ?? "[]") : []);
	if (onBehalf) {
		told.add(task.assignee_id!);
		for (const watcher of activeWatchers(sql, task.id)) told.add(watcher);
	}
	told.delete(actorId);
	const recipients = [...told].filter((id) => isActive(sql, id));
	if (!recipients.length) return;
	const updated = getOccurrence(sql, occurrence.id);
	sendAlert(ctx, updated, task, onBehalf ? "on_behalf" : "done_late", recipients, ALERT_TTL_S);
}

/** Undo (no notifications): back to missed if watchers were already alerted or it's past the deadline, else open. */
export function reopenOccurrence(ctx: JobContext, occurrence: OccurrenceRow, task: TaskRow): void {
	const { sql, now } = ctx;
	const schedule = scheduleOf(task);
	if (occurrence.status === "open" || occurrence.status === "missed" || !schedule) return;
	const pastDeadline =
		schedule.overdueAfterMinutes !== null &&
		now > occurrence.due_at + schedule.overdueAfterMinutes * MINUTE_MS;
	const missed = pastDeadline || missedAlert(sql, occurrence.id) !== undefined;
	sql.exec(
		"UPDATE occurrence SET status = ?, done_at = NULL, done_by = NULL, on_behalf = 0, note = NULL WHERE id = ?",
		missed ? "missed" : "open",
		occurrence.id,
	);
	if (!missed) createJobs(sql, occurrence, schedule, now);
	ctx.changed.add(task.id);
}

// --- State for devices ---------------------------------------------------------------

/** Occurrences from the last week and upcoming, per task id. */
export function occurrenceStates(
	sql: SqlStorage,
	taskId: string | null,
	now: number,
): Map<string, OccurrenceState[]> {
	const since = now - HISTORY_MS;
	const filter = taskId ? "AND o.task_id = ?" : "";
	const params = taskId ? [since, taskId] : [since];
	const rows = sql
		.exec<OccurrenceRow>(
			`SELECT o.* FROM occurrence o WHERE o.due_at >= ? ${filter} ORDER BY o.due_at`,
			...params,
		)
		.toArray();
	if (!rows.length) return new Map();
	const ticks = sql
		.exec<{ occurrence_id: string; subtask_id: string; done_at: number; done_by: string }>(
			`SELECT t.* FROM occurrence_tick t JOIN occurrence o ON o.id = t.occurrence_id WHERE o.due_at >= ? ${filter}`,
			...params,
		)
		.toArray();
	const alerts = sql
		.exec<AlertRow>(
			`SELECT a.* FROM alert a JOIN occurrence o ON o.id = a.occurrence_id WHERE a.kind = 'missed' AND o.due_at >= ? ${filter}`,
			...params,
		)
		.toArray();
	const result = new Map<string, OccurrenceState[]>();
	for (const row of rows) {
		const alert = alerts.find((a) => a.occurrence_id === row.id);
		const list = result.get(row.task_id) ?? [];
		list.push({
			id: row.id,
			dueAt: row.due_at,
			status: row.status,
			doneAt: row.done_at,
			doneBy: row.done_by,
			onBehalf: row.on_behalf === 1,
			note: row.note,
			ticks: ticks
				.filter((t) => t.occurrence_id === row.id)
				.map((t) => ({ subtaskId: t.subtask_id, doneAt: t.done_at, doneBy: t.done_by })),
			missedAlertSent: alert !== undefined,
			alertNotDelivered:
				alert !== undefined && alert.acked_at === null && alert.undelivered_at !== null,
		});
		result.set(row.task_id, list);
	}
	return result;
}
