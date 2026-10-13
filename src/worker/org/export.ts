// The admin's download of all family data (FR-92, NFR-8).
//
// Every column of every table is listed here, either as exported or as deliberately left out,
// and a test checks this against the live schema: a new migration has to decide where its
// columns go, so data can't silently miss the export and secrets can't slip into it.

import { orgMigrations } from "./schema.ts";

interface TablePlan {
	/** Key in the export file. */
	as: string;
	columns: readonly string[];
	/** Not exported: sign-in secrets, push endpoints, or internal state rebuilt from the rest. */
	excluded: readonly string[];
	/** Columns holding JSON text, exported as parsed values. */
	json?: readonly string[];
	orderBy: string;
}

export const EXPORT_PLAN: Record<string, TablePlan | "excluded"> = {
	organization: {
		as: "organization",
		columns: ["id", "name", "timezone", "default_due_time", "created_at"],
		excluded: [],
		orderBy: "id",
	},
	member: {
		as: "members",
		columns: [
			"id",
			"username",
			"display_name",
			"role",
			"simple_view",
			"created_at",
			"deactivated_at",
		],
		// Live sync bookkeeping (see markAudienceChanged).
		excluded: ["audience_version"],
		orderBy: "created_at, id",
	},
	team: {
		as: "teams",
		columns: ["id", "name", "created_at", "deleted_at"],
		excluded: [],
		orderBy: "created_at, id",
	},
	team_member: {
		as: "teamMembers",
		columns: ["team_id", "member_id", "added_by", "added_at"],
		excluded: [],
		orderBy: "team_id, member_id",
	},
	device: {
		as: "devices",
		columns: ["id", "member_id", "name", "created_at", "last_seen", "revoked_at"],
		excluded: [
			"session_token_hash",
			"push_subscription",
			"last_ack_at",
			"unreachable_since",
			"first_unacked_at",
		],
		orderBy: "created_at, id",
	},
	task: {
		as: "tasks",
		// prettier-ignore
		columns: [
			"id", "team_id", "title", "notes", "label", "colour", "assignee_id", "due_date", "due_time", "repeat",
			"remind_before_minutes", "second_reminder_minutes", "overdue_after_minutes", "done_at", "done_by",
			"archived", "created_by", "created_at", "updated_at", "version",
		],
		excluded: [],
		json: ["repeat"],
		orderBy: "created_at, id",
	},
	task_watcher: {
		as: "watchers",
		columns: ["task_id", "member_id"],
		excluded: [],
		orderBy: "task_id, member_id",
	},
	subtask: {
		as: "subtasks",
		columns: ["id", "task_id", "title", "note", "position", "done_at", "done_by", "deleted_at"],
		excluded: [],
		orderBy: "task_id, position",
	},
	occurrence: {
		as: "occurrences",
		columns: ["id", "task_id", "due_at", "status", "done_at", "done_by", "on_behalf", "note"],
		excluded: [],
		orderBy: "due_at, id",
	},
	occurrence_tick: {
		as: "ticks",
		columns: ["occurrence_id", "subtask_id", "done_at", "done_by"],
		excluded: [],
		orderBy: "occurrence_id, subtask_id",
	},
	alert: {
		as: "alerts",
		columns: [
			"id",
			"occurrence_id",
			"kind",
			"sent_at",
			"acked_at",
			"attempts",
			"recipients",
			"undelivered_at",
		],
		excluded: [],
		json: ["recipients"],
		orderBy: "sent_at, id",
	},
	change_log: {
		as: "changes",
		columns: ["version", "entity", "entity_id", "op", "member_id", "at", "team_id"],
		// Full copies of each changed object, used for live sync; the tables above already hold the latest.
		excluded: ["data"],
		orderBy: "version",
	},
	// Join links and codes (secret hashes), queued pushes and scheduler jobs.
	invite: "excluded",
	push_queue: "excluded",
	scheduled_job: "excluded",
	schema_version: "excluded",
};

const TIME_COLUMNS = /(_at|^at|^last_seen)$/;
const BOOLEAN_COLUMNS = new Set(["simple_view", "archived", "on_behalf"]);

export const EXPORT_FORMAT = { format: "kinnect-export", version: 1 } as const;

export function exportData(
	sql: SqlStorage,
	exportedBy: string,
	now: number,
): Record<string, unknown> {
	const data: Record<string, unknown> = {
		...EXPORT_FORMAT,
		schemaVersion: orgMigrations.length,
		exportedAt: new Date(now).toISOString(),
		exportedBy,
	};
	for (const [table, plan] of Object.entries(EXPORT_PLAN)) {
		if (plan === "excluded") continue;
		const rows = sql
			.exec(`SELECT ${plan.columns.join(", ")} FROM ${table} ORDER BY ${plan.orderBy}`)
			.toArray();
		const converted = rows.map((row) =>
			Object.fromEntries(
				plan.columns.map((column) => [column, convert(column, row[column], plan)]),
			),
		);
		data[plan.as] = table === "organization" ? (converted[0] ?? null) : converted;
	}
	return data;
}

function convert(column: string, value: SqlStorageValue, plan: TablePlan): unknown {
	if (value === null) return null;
	if (plan.json?.includes(column)) return JSON.parse(String(value));
	if (BOOLEAN_COLUMNS.has(column)) return value === 1;
	if (TIME_COLUMNS.test(column) && typeof value === "number") return new Date(value).toISOString();
	return value;
}
