// Notification wording (requirements 4.6) and the push queue that the alarm drains (7.3, FR-45).
import type { PushOptions, PushResult, PushSubscriptionData } from "../push/send.ts";
import type { VapidConfig } from "../push/vapid.ts";
import { formatTime, formatWhen } from "../../shared/time.ts";
import type { OccurrenceRow } from "./schedule.ts";
import type { TaskRow } from "./tasks.ts";

export type AlertKind = "advance" | "due" | "second" | "missed" | "done_late" | "on_behalf";

/** What the service worker receives (see public/sw.js). */
export interface PushMessage {
	title: string;
	/** Notifications with the same tag replace each other. */
	tag: string;
	/** Opened when the notification is tapped. */
	url: string;
	alertId?: string;
	ackUrl?: string;
	/** Show a Done button (FR-44). */
	canComplete: boolean;
}

export const ACK_PATH = "/api/alerts/ack";
/** Pushes sent per alarm run (7.3). */
export const PUSHES_PER_RUN = 40;

const nameOf = (sql: SqlStorage, memberId: string | null) =>
	(memberId &&
		sql
			.exec<{ display_name: string }>("SELECT display_name FROM member WHERE id = ?", memberId)
			.toArray()[0]?.display_name) ||
	"Someone";

/** The generic text for each event (FR-35, D8). */
export function wording(
	sql: SqlStorage,
	timeZone: string,
	now: number,
	kind: AlertKind,
	task: TaskRow,
	occurrence: OccurrenceRow,
): Omit<PushMessage, "alertId" | "ackUrl"> {
	const due = formatTime(occurrence.due_at, timeZone);
	const url = `/#/task/${task.id}`;
	const reminder = (title: string) => ({ title, tag: occurrence.id, url, canComplete: true });
	const notice = (title: string) => ({
		title,
		tag: `missed-${occurrence.id}`,
		url,
		canComplete: false,
	});
	switch (kind) {
		case "advance":
			return reminder(`${task.title} is due ${formatWhen(occurrence.due_at, timeZone, now)}`);
		case "due":
			return reminder(`${task.title} — due now`);
		case "second":
			return reminder(`Reminder: ${task.title} is still open`);
		case "missed":
			return notice(
				task.assignee_id
					? `${nameOf(sql, task.assignee_id)} hasn't completed ${task.title} (due ${due})`
					: `${task.title} wasn't completed (due ${due})`,
			);
		case "done_late":
			return notice(`${nameOf(sql, occurrence.done_by)} completed ${task.title} (due ${due})`);
		case "on_behalf":
			return notice(
				`${nameOf(sql, occurrence.done_by)} marked ${task.title} done for ${nameOf(sql, task.assignee_id)}`,
			);
	}
}

/** Queues a push to every reachable device of the recipients (FR-40). */
export function enqueueAlert(
	sql: SqlStorage,
	alertId: string,
	memberIds: string[],
	message: Omit<PushMessage, "alertId" | "ackUrl">,
	ttl: number,
	now: number,
): void {
	if (!memberIds.length) return;
	const payload = JSON.stringify({ ...message, alertId, ackUrl: ACK_PATH } satisfies PushMessage);
	const devices = sql
		.exec<{ id: string }>(
			`SELECT id FROM device WHERE revoked_at IS NULL AND push_subscription IS NOT NULL
			 AND member_id IN (${memberIds.map(() => "?").join(",")})`,
			...memberIds,
		)
		.toArray();
	for (const device of devices) {
		sql.exec(
			"INSERT INTO push_queue (device_id, payload, ttl, created_at) VALUES (?, ?, ?, ?)",
			device.id,
			payload,
			ttl,
			now,
		);
	}
}

export type PushSender = (
	subscription: PushSubscriptionData,
	payload: unknown,
	options: PushOptions,
	vapid: VapidConfig,
) => Promise<PushResult>;

/**
 * Sends up to PUSHES_PER_RUN queued pushes. A 404/410 means the subscription is gone:
 * it's deleted and the device marked unreachable (FR-45). A delivered push starts the
 * device's "not shown since" clock until it acknowledges one (FR-42).
 * Returns the members whose notification status changed.
 */
export async function drainPushQueue(
	sql: SqlStorage,
	send: PushSender,
	vapid: VapidConfig,
	now: number,
): Promise<Set<string>> {
	const changed = new Set<string>();
	const rows = sql
		.exec<{
			id: number;
			device_id: string;
			payload: string;
			ttl: number;
			created_at: number;
			push_subscription: string | null;
			member_id: string | null;
			first_unacked_at: number | null;
		}>(
			`SELECT q.id, q.device_id, q.payload, q.ttl, q.created_at, d.push_subscription, d.member_id, d.first_unacked_at
			 FROM push_queue q LEFT JOIN device d ON d.id = q.device_id AND d.revoked_at IS NULL
			 ORDER BY q.id LIMIT ?`,
			PUSHES_PER_RUN,
		)
		.toArray();
	await Promise.all(
		rows.map(async (row) => {
			sql.exec("DELETE FROM push_queue WHERE id = ?", row.id);
			if (!row.push_subscription) return;
			// Time spent waiting in the queue counts against the TTL.
			const ttl = Math.max(0, row.ttl - Math.floor((now - row.created_at) / 1000));
			try {
				const result = await send(
					JSON.parse(row.push_subscription),
					JSON.parse(row.payload),
					{ ttl, urgency: "high" },
					vapid,
				);
				if (result.gone) {
					sql.exec(
						"UPDATE device SET push_subscription = NULL, unreachable_since = COALESCE(unreachable_since, ?) WHERE id = ?",
						now,
						row.device_id,
					);
					changed.add(row.member_id!);
				} else if (result.status >= 400) {
					console.warn("push failed", row.device_id, result.status);
				} else if (row.first_unacked_at === null) {
					sql.exec(
						"UPDATE device SET first_unacked_at = COALESCE(first_unacked_at, ?) WHERE id = ?",
						now,
						row.device_id,
					);
					changed.add(row.member_id!);
				}
			} catch (error) {
				console.warn("push failed", row.device_id, error);
			}
		}),
	);
	return changed;
}

/** A push that checks this device can show notifications; acknowledged like any other. */
export const TEST_ALERT_ID = "test";

export function enqueueTest(sql: SqlStorage, deviceId: string, now: number): void {
	const payload = JSON.stringify({
		title: "Kinnect notifications are working",
		tag: "test",
		url: "/#/settings",
		alertId: TEST_ALERT_ID,
		ackUrl: ACK_PATH,
		canComplete: false,
	} satisfies PushMessage);
	sql.exec(
		"INSERT INTO push_queue (device_id, payload, ttl, created_at) VALUES (?, ?, ?, ?)",
		deviceId,
		payload,
		600,
		now,
	);
}
