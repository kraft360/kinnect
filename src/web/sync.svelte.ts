// Live data for the signed-in device: tasks, households and members, kept current
// over a WebSocket while the app is in the foreground (FR-50, FR-52), and edited
// with optimistic operations over HTTP (FR-51, FR-55).
import type {
	Change,
	OccurrenceState,
	Op,
	OpRejection,
	OpResponse,
	ServerMessage,
	TaskState,
} from "../shared/sync.ts";
import { localParts } from "../shared/time.ts";
import { UNCONFIRMED_AFTER_MS, type Member, type Team } from "../shared/types.ts";

type Status = "offline" | "connecting" | "live";

export const live = $state({
	status: "offline" as Status,
	/** Last change version received over the WebSocket; sent with "hello" on reconnect. */
	syncedVersion: null as number | null,
	tasks: {} as Record<string, TaskState>,
	teams: [] as Team[],
	members: [] as Member[],
	/** Last rejected edit, shown to the user. */
	error: "",
});

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const PING_INTERVAL_MS = 30000;

let socket: WebSocket | null = null;
let running = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;

export function startSync(): void {
	if (running) return;
	running = true;
	document.addEventListener("visibilitychange", onVisibility);
	if (document.visibilityState === "visible") connect();
}

/** Stops syncing and forgets the data (on sign-out). */
export function stopSync(): void {
	running = false;
	document.removeEventListener("visibilitychange", onVisibility);
	disconnect();
	Object.assign(live, { syncedVersion: null, tasks: {}, teams: [], members: [], error: "" });
}

function onVisibility(): void {
	// The connection is open only while the app is in the foreground (FR-50).
	if (document.visibilityState === "visible") connect();
	else disconnect();
}

function connect(): void {
	if (!running || socket) return;
	clearTimeout(retryTimer);
	live.status = "connecting";
	const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/sync`);
	socket = ws;
	ws.onopen = () => ws.send(JSON.stringify({ type: "hello", version: live.syncedVersion }));
	ws.onmessage = (event) => {
		if (event.data === "pong") return;
		attempt = 0;
		live.status = "live";
		receive(JSON.parse(event.data) as ServerMessage);
	};
	ws.onclose = (event) => {
		if (socket !== ws) return;
		socket = null;
		clearInterval(pingTimer);
		live.status = "offline";
		// 4401: this device was signed out; reloading shows the welcome screen.
		if (event.code === 4401) location.reload();
		else if (running && document.visibilityState === "visible") {
			retryTimer = setTimeout(
				connect,
				RETRY_DELAYS_MS[Math.min(attempt++, RETRY_DELAYS_MS.length - 1)],
			);
		}
	};
	pingTimer = setInterval(
		() => ws.readyState === WebSocket.OPEN && ws.send("ping"),
		PING_INTERVAL_MS,
	);
}

function disconnect(): void {
	clearTimeout(retryTimer);
	clearInterval(pingTimer);
	const ws = socket;
	socket = null;
	ws?.close();
	live.status = "offline";
}

function receive(message: ServerMessage): void {
	if (message.type === "snapshot") {
		live.tasks = Object.fromEntries(message.tasks.map((task) => [task.id, task]));
		live.teams = message.teams;
		live.members = message.members;
		live.syncedVersion = message.version;
		return;
	}
	for (const change of message.changes) {
		// Anything at or below the synced version is already included (e.g. in a snapshot).
		if (live.syncedVersion !== null && change.version <= live.syncedVersion) continue;
		apply(change);
		live.syncedVersion = change.version;
	}
}

function apply(change: Change): void {
	if (change.entity === "task") {
		if (change.op === "remove") delete live.tasks[change.id];
		else setTask(change.data);
	} else if (change.entity === "team") {
		live.teams =
			change.op === "remove"
				? live.teams.filter((t) => t.id !== change.id)
				: upsert(live.teams, change.data);
	} else {
		live.members =
			change.op === "remove"
				? live.members.filter((m) => m.id !== change.id)
				: upsert(live.members, change.data);
	}
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
	return list.some((x) => x.id === item.id)
		? list.map((x) => (x.id === item.id ? item : x))
		: [...list, item];
}

/** Keeps whichever copy of a task is newer (HTTP replies and WebSocket changes can cross). */
function setTask(task: TaskState): void {
	const current = live.tasks[task.id];
	if (!current || current.version <= task.version) live.tasks[task.id] = task;
}

/** The task an operation touches (sub-task operations name only the item). */
function taskIdOf(op: Op): string | null {
	if ("taskId" in op) return op.taskId;
	const find = (match: (task: TaskState) => boolean) =>
		Object.values(live.tasks).find(match)?.id ?? null;
	if ("occurrenceId" in op) return find((t) => t.occurrences.some((o) => o.id === op.occurrenceId));
	if (op.type.startsWith("occurrence."))
		return find((t) => t.occurrences.some((o) => o.id === op.id));
	if (op.type.startsWith("subtask.")) return find((t) => t.subtasks.some((s) => s.id === op.id));
	return op.id;
}

/**
 * Applies an operation: `optimistic` changes the local copy right away; the
 * server's reply replaces it, or restores the real state if the edit was refused.
 */
export async function send(
	op: Op,
	optimistic?: (tasks: Record<string, TaskState>) => void,
): Promise<boolean> {
	live.error = "";
	const taskId = taskIdOf(op);
	const before = taskId && live.tasks[taskId] ? $state.snapshot(live.tasks[taskId]) : null;
	optimistic?.(live.tasks);
	let response: Response;
	let body: OpResponse | OpRejection;
	try {
		response = await fetch("/api/ops", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ op }),
		});
		body = await response.json();
	} catch {
		live.error = "Couldn't save. Check your internet connection.";
		restore(taskId, before);
		return false;
	}
	if (response.ok) {
		const { task } = body as OpResponse;
		// setTask keeps a newer copy if a live change already arrived; the optimistic copy keeps the old version.
		if (task) setTask(task);
		else if (taskId) delete live.tasks[taskId]; // no longer visible to this member
		return true;
	}
	if (response.status === 401) location.reload();
	const rejection = body as OpRejection;
	live.error = rejection.error;
	restore(taskId, rejection.task ?? before);
	return false;
}

/** Puts back the server's copy of a task (or the copy from before the edit); removes it if neither exists. */
function restore(taskId: string | null, task: TaskState | null): void {
	if (task) live.tasks[task.id] = task;
	else if (taskId) delete live.tasks[taskId];
}

// --- Helpers for screens ------------------------------------------------------

export const memberName = (id: string | null) =>
	id ? (live.members.find((m) => m.id === id)?.displayName ?? "Someone") : "";
export const teamName = (id: string | null) =>
	id ? (live.teams.find((t) => t.id === id)?.name ?? "A household") : "Whole family";

/** Who may be assignee or watcher for a scope (FR-86). */
export function eligiblePeople(teamId: string | null): Member[] {
	if (teamId === null) return live.members;
	const team = live.teams.find((t) => t.id === teamId);
	return live.members.filter((m) => team?.memberIds.includes(m.id));
}

// --- Occurrences (FR-11, FR-30) -------------------------------------------------

export const isPending = (o: OccurrenceState) => o.status === "open" || o.status === "missed";

/** The occurrence to act on: the latest one that's due and not done, else the next upcoming one. */
export function currentOccurrence(task: TaskState, now = Date.now()): OccurrenceState | null {
	const due = task.occurrences.filter((o) => isPending(o) && o.dueAt <= now);
	return due.at(-1) ?? task.occurrences.find((o) => o.dueAt > now && o.status === "open") ?? null;
}

/** The member is expected to act on it: assigned to them, unassigned, or they watch it. */
export const concerns = (task: TaskState, memberId: string) =>
	task.assigneeId === null || task.assigneeId === memberId || task.watcherIds.includes(memberId);

export interface TodayItem {
	task: TaskState;
	occurrence: OccurrenceState;
}

/** Today (FR-30): occurrences due today plus anything overdue, by time. */
export function todayItems(memberId: string, timeZone: string, now = Date.now()): TodayItem[] {
	const today = localParts(now, timeZone).date;
	return Object.values(live.tasks)
		.filter((task) => !task.archived && concerns(task, memberId))
		.flatMap((task) =>
			task.occurrences
				.filter(
					(o) => localParts(o.dueAt, timeZone).date === today || (isPending(o) && o.dueAt < now),
				)
				.map((occurrence) => ({ task, occurrence })),
		)
		.sort((a, b) => a.occurrence.dueAt - b.occurrence.dueAt);
}

// --- People and notifications (FR-42) ----------------------------------------

/** The live copy of a member (updates when an admin changes them, e.g. simple view). */
export const liveMember = (id: string) => live.members.find((m) => m.id === id);

/** Can receive notifications on at least one device. */
export const isReachable = (member: Member, now = Date.now()) =>
	member.notifications === "ok" ||
	(member.notifications === "unconfirmed" &&
		now - (member.unconfirmedSince ?? now) < UNCONFIRMED_AFTER_MS);

/** People who can see a task (its household, or the whole family). */
export function scopeMembers(task: TaskState): Member[] {
	return eligiblePeople(task.teamId);
}

/**
 * A warning when a scheduled task's reminders can't reach anyone (FR-42): the assignee's
 * phones, or for an unassigned task everyone in its scope. null when fine.
 */
export function reminderWarning(task: TaskState, now = Date.now()): string | null {
	if (!task.schedule || task.archived) return null;
	if (task.assigneeId) {
		const assignee = liveMember(task.assigneeId);
		return assignee && !isReachable(assignee, now)
			? `${assignee.displayName}'s phone can't receive notifications`
			: null;
	}
	const people = scopeMembers(task);
	return people.length && !people.some((m) => isReachable(m, now))
		? "Nobody who can see this task can receive notifications"
		: null;
}

// --- Tasks list filters (FR-31) ----------------------------------------------

/** Each distinct warning for a set of tasks, so a screen shows it once rather than on every row (FR-42). */
export const reminderWarnings = (tasks: TaskState[], now = Date.now()): string[] => [
	...new Set(
		tasks.map((task) => reminderWarning(task, now)).filter((w): w is string => w !== null),
	),
];

export interface TaskFilter {
	who: "mine" | "all";
	personId: string;
	teamId: string;
	label: string;
}

export function matchesFilter(task: TaskState, filter: TaskFilter, meId: string): boolean {
	if (filter.who === "mine" && task.assigneeId !== meId && !task.watcherIds.includes(meId))
		return false;
	if (filter.personId && task.assigneeId !== filter.personId) return false;
	if (
		filter.teamId &&
		(filter.teamId === "family" ? task.teamId !== null : task.teamId !== filter.teamId)
	)
		return false;
	if (filter.label && task.label !== filter.label) return false;
	return true;
}

/** Labels in use, with the colour most recently used for each (for suggestions). */
export function labelsInUse(): { label: string; colour: TaskState["colour"] }[] {
	const latest = new Map<string, TaskState>();
	for (const task of Object.values(live.tasks)) {
		if (!task.label) continue;
		const seen = latest.get(task.label);
		if (!seen || seen.updatedAt < task.updatedAt) latest.set(task.label, task);
	}
	return [...latest.entries()]
		.map(([label, task]) => ({ label, colour: task.colour }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** Plain words for a device's or member's notification status (FR-42). */
export function notificationText(
	status: Member["notifications"],
	since: number | null,
	now = Date.now(),
): string {
	if (status === "ok") return "notifications working";
	if (status === "off") return "notifications off";
	const day = new Date(since ?? now).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit",
	});
	return now - (since ?? now) < UNCONFIRMED_AFTER_MS
		? "last notification not shown yet"
		: `notifications not showing since ${day}`;
}
