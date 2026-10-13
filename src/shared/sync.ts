// Tasks, operations and live-sync messages, shared by the Worker and the web app.
import type { LabelColour } from "./labels.ts";
import type { Schedule } from "./schedule.ts";
import type { Member, Team } from "./types.ts";

export interface SubtaskState {
	id: string;
	title: string;
	note: string | null;
	position: number;
	doneAt: number | null;
	doneBy: string | null;
}

export type OccurrenceStatus = "open" | "done" | "done_late" | "missed";

/** One due point of a scheduled task (FR-11). */
export interface OccurrenceState {
	id: string;
	dueAt: number;
	status: OccurrenceStatus;
	doneAt: number | null;
	doneBy: string | null;
	/** Completed by someone other than the assignee (FR-18). */
	onBehalf: boolean;
	note: string | null;
	/** Checklist ticks for this occurrence only (FR-17). */
	ticks: { subtaskId: string; doneAt: number; doneBy: string }[];
	/** Watchers were alerted that it was missed. */
	missedAlertSent: boolean;
	/** No watcher's device showed the missed alert, even after a re-send (NFR-5). */
	alertNotDelivered: boolean;
}

/** A whole task as devices see it: fields, watchers and live checklist items. */
export interface TaskState {
	id: string;
	/** null = the whole family. */
	teamId: string | null;
	title: string;
	notes: string | null;
	/** Visual grouping only (FR-4). */
	label: string | null;
	colour: LabelColour | null;
	assigneeId: string | null;
	watcherIds: string[];
	subtasks: SubtaskState[];
	/** Completion of tasks without a schedule (FR-21). */
	doneAt: number | null;
	doneBy: string | null;
	schedule: Schedule | null;
	/** Occurrences from the last 7 days and upcoming ones, oldest first. */
	occurrences: OccurrenceState[];
	archived: boolean;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	/** Change-log version of the last change to this task. */
	version: number;
}

export type Op =
	| {
			type: "task.create";
			id: string;
			title: string;
			notes?: string;
			label?: string | null;
			colour?: LabelColour | null;
			teamId?: string | null;
			assigneeId?: string | null;
			watcherIds?: string[];
			subtasks?: { id: string; title: string }[];
			schedule?: Schedule | null;
	  }
	| {
			type: "task.update";
			id: string;
			changes: {
				title?: string;
				notes?: string | null;
				label?: string | null;
				colour?: LabelColour | null;
				teamId?: string | null;
				assigneeId?: string | null;
			};
	  }
	| { type: "task.setWatchers"; id: string; watcherIds: string[] }
	| { type: "task.setSchedule"; id: string; schedule: Schedule | null }
	| { type: "task.done"; id: string }
	| { type: "task.reopen"; id: string }
	| { type: "task.archive"; id: string }
	| { type: "task.unarchive"; id: string }
	| { type: "task.clearCompleted"; id: string }
	| {
			type: "subtask.add";
			taskId: string;
			id: string;
			title: string;
			note?: string | null;
			position: number;
	  }
	| { type: "subtask.update"; id: string; title?: string; note?: string | null }
	| { type: "subtask.tick"; id: string }
	| { type: "subtask.untick"; id: string }
	| { type: "subtask.move"; id: string; position: number }
	| { type: "subtask.remove"; id: string }
	/** `at` is when the member tapped Done (capped at the server's time, FR-22). */
	| { type: "occurrence.done"; id: string; at?: number; note?: string | null }
	| { type: "occurrence.reopen"; id: string }
	| { type: "occurrence.tick"; occurrenceId: string; subtaskId: string }
	| { type: "occurrence.untick"; occurrenceId: string; subtaskId: string };

export type OpType = Op["type"];

export interface OpResponse {
	version: number;
	/** The task after the operation; null if the caller can no longer see it. */
	task: TaskState | null;
}

/** Sent with a rejected operation, so the device can restore the real state. */
export interface OpRejection {
	error: string;
	task: TaskState | null;
}

export type Entity = "task" | "team" | "member";

export type Change =
	| { version: number; entity: "task"; id: string; op: "upsert"; data: TaskState }
	| { version: number; entity: "team"; id: string; op: "upsert"; data: Team }
	| { version: number; entity: "member"; id: string; op: "upsert"; data: Member }
	| { version: number; entity: Entity; id: string; op: "remove" };

export interface Snapshot {
	version: number;
	tasks: TaskState[];
	teams: Team[];
	members: Member[];
}

export type ClientMessage = { type: "hello"; version: number | null };

export type ServerMessage =
	({ type: "snapshot" } & Snapshot) | { type: "changes"; changes: Change[] };

export const TASK_LIMITS = {
	title: 120,
	notes: 2000,
	subtaskTitle: 120,
	subtaskNote: 200,
	subtasks: 200,
	watchers: 20,
	label: 30,
	occurrenceNote: 200,
} as const;
