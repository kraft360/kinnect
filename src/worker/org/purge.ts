// Daily purge (requirements 8.3): a recurring "purge" job deletes rows older than the
// retention windows so each family's database stays small. Tasks, members, households,
// invites and devices are never purged.
import { newId } from "../../shared/ids.ts";
import { DAY_MS } from "../../shared/time.ts";
import { deleteOccurrences } from "./schedule.ts";

export const PURGE_EVERY_MS = DAY_MS;
/** Rows deleted per table per run, to keep one alarm run short; the rest go in an immediate follow-up. */
export const PURGE_ROWS_PER_RUN = 500;

/** Retention windows in ms, from PURGE_HISTORY_DAYS and PURGE_SYSTEM_DAYS. */
export interface Retention {
	historyMs: number;
	systemMs: number;
}

/** Keeps one pending purge job, so purging can't silently stop. */
export function ensurePurgeJob(sql: SqlStorage, fireAt: number): void {
	const pending =
		sql.exec("SELECT 1 FROM scheduled_job WHERE kind = 'purge' AND done_at IS NULL").toArray()
			.length > 0;
	if (!pending)
		sql.exec(
			"INSERT INTO scheduled_job (id, kind, fire_at) VALUES (?, 'purge', ?)",
			newId(),
			fireAt,
		);
}

/**
 * Runs one purge job: deletes a batch from each table and schedules the next run, straight
 * away if rows are left, otherwise in a day. Like other jobs, it's marked done in the same
 * transaction, so a repeated alarm run does nothing.
 */
export function runPurgeJob(
	sql: SqlStorage,
	jobId: string,
	now: number,
	retention: Retention,
): void {
	const job = sql
		.exec("SELECT 1 FROM scheduled_job WHERE id = ? AND kind = 'purge' AND done_at IS NULL", jobId)
		.toArray()[0];
	if (!job) return;
	sql.exec("UPDATE scheduled_job SET done_at = ? WHERE id = ?", now, jobId);

	const counts = purge(sql, now, retention);
	const more = Object.values(counts).some((n) => n === PURGE_ROWS_PER_RUN);
	ensurePurgeJob(sql, more ? now : now + PURGE_EVERY_MS);
	console.log(`purge: ${JSON.stringify(counts)}${more ? " (more to come)" : ""}`);
}

/** Deletes up to PURGE_ROWS_PER_RUN rows per table that ended before their window; returns the counts. */
export function purge(sql: SqlStorage, now: number, retention: Retention): Record<string, number> {
	const history = now - retention.historyMs;
	const system = now - retention.systemMs;
	const limit = PURGE_ROWS_PER_RUN;
	return {
		// History: finished occurrences with their jobs, alerts and ticks. Open ones are still to be done.
		occurrence: deleteOccurrences(
			sql,
			"status != 'open' AND due_at < ? ORDER BY due_at LIMIT ?",
			history,
			limit,
		),
		// History: cleared or removed sub-tasks no longer in any occurrence's ticks (FR-17, FR-23).
		subtask: deleteIds(
			sql,
			"subtask",
			`SELECT id FROM subtask WHERE deleted_at < ?
			 AND NOT EXISTS (SELECT 1 FROM occurrence_tick t WHERE t.subtask_id = subtask.id) LIMIT ?`,
			history,
			limit,
		),
		// System: jobs that have run, including past purge and materialize jobs.
		scheduled_job: deleteIds(
			sql,
			"scheduled_job",
			"SELECT id FROM scheduled_job WHERE done_at < ? ORDER BY done_at LIMIT ?",
			system,
			limit,
		),
		// System: the live-sync log, oldest first, so the versions left stay consecutive (FR-52).
		change_log: deleteOldestChanges(sql, system, limit),
	};
}

function deleteOldestChanges(sql: SqlStorage, cutoff: number, limit: number): number {
	const versions = sql
		.exec<{ version: number }>(
			`SELECT version FROM change_log
			 WHERE version <= (SELECT MAX(version) FROM change_log WHERE at < ?)
			 ORDER BY version LIMIT ?`,
			cutoff,
			limit,
		)
		.toArray();
	if (versions.length)
		sql.exec("DELETE FROM change_log WHERE version <= ?", versions.at(-1)!.version);
	return versions.length;
}

function deleteIds(
	sql: SqlStorage,
	table: string,
	select: string,
	...params: (string | number)[]
): number {
	const ids = sql
		.exec<{ id: string }>(select, ...params)
		.toArray()
		.map((r) => r.id);
	for (const id of ids) sql.exec(`DELETE FROM ${table} WHERE id = ?`, id);
	return ids.length;
}
