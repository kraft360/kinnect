// Row shapes and SQL helpers for members, devices and invites in an Organization database.
// Rows are type aliases (not interfaces) so they satisfy SqlStorage's record constraint.
import type { Device, Member, NotificationStatus, Organization, Role } from "../../shared/types.ts";

export type OrganizationRow = {
	id: string;
	name: string;
	timezone: string;
	default_due_time: string;
	created_at: number;
};

export type MemberRow = {
	id: string;
	username: string;
	display_name: string;
	role: Role;
	simple_view: number;
	created_at: number;
	deactivated_at: number | null;
};

export type DeviceRow = {
	id: string;
	member_id: string;
	name: string;
	session_token_hash: string;
	push_subscription: string | null;
	created_at: number;
	last_seen: number | null;
	last_ack_at: number | null;
	unreachable_since: number | null;
	revoked_at: number | null;
	first_unacked_at: number | null;
};

export type InviteRow = {
	id: string;
	member_id: string;
	kind: "invite" | "add_device";
	token_hash: string;
	code_hash: string;
	expires_at: number;
	used_at: number | null;
	revoked_at: number | null;
};

/** The signed-in member and device for a request. */
export interface Session {
	member: MemberRow;
	device: DeviceRow;
}

export const isAdmin = (member: MemberRow) => member.role === "owner" || member.role === "admin";

export function toOrganization(row: OrganizationRow): Organization {
	return {
		id: row.id,
		name: row.name,
		timezone: row.timezone,
		defaultDueTime: row.default_due_time,
	};
}

export function toMember(sql: SqlStorage, row: MemberRow, activeDevices?: number): Member {
	return {
		id: row.id,
		username: row.username,
		displayName: row.display_name,
		role: row.role,
		simpleView: row.simple_view === 1,
		...memberNotifications(sql, row.id),
		...(activeDevices === undefined ? {} : { activeDevices }),
	};
}

function deviceNotifications(row: Pick<DeviceRow, "push_subscription" | "first_unacked_at">): {
	notifications: NotificationStatus;
	unconfirmedSince: number | null;
} {
	if (row.push_subscription === null) return { notifications: "off", unconfirmedSince: null };
	if (row.first_unacked_at !== null)
		return { notifications: "unconfirmed", unconfirmedSince: row.first_unacked_at };
	return { notifications: "ok", unconfirmedSince: null };
}

/** A member is reachable through any signed-in device; "unconfirmed" only if every subscribed device is (FR-42). */
export function memberNotifications(
	sql: SqlStorage,
	memberId: string,
): { notifications: NotificationStatus; unconfirmedSince: number | null } {
	const devices = sql
		.exec<Pick<DeviceRow, "push_subscription" | "first_unacked_at">>(
			"SELECT push_subscription, first_unacked_at FROM device WHERE member_id = ? AND revoked_at IS NULL AND push_subscription IS NOT NULL",
			memberId,
		)
		.toArray()
		.map(deviceNotifications);
	if (!devices.length) return { notifications: "off", unconfirmedSince: null };
	if (devices.some((d) => d.notifications === "ok"))
		return { notifications: "ok", unconfirmedSince: null };
	// The member can still be reached as long as the most recently confirmed device is within the grace period.
	return {
		notifications: "unconfirmed",
		unconfirmedSince: Math.max(...devices.map((d) => d.unconfirmedSince!)),
	};
}

export function toDevice(row: DeviceRow): Device {
	return {
		id: row.id,
		name: row.name,
		createdAt: row.created_at,
		lastSeen: row.last_seen,
		pushRegistered: row.push_subscription !== null,
		...deviceNotifications(row),
		lastAckAt: row.last_ack_at,
		revokedAt: row.revoked_at,
	};
}

export function getOrganization(sql: SqlStorage): OrganizationRow | undefined {
	return sql.exec<OrganizationRow>("SELECT * FROM organization").toArray()[0];
}

export function getMember(sql: SqlStorage, id: string): MemberRow | undefined {
	return sql.exec<MemberRow>("SELECT * FROM member WHERE id = ?", id).toArray()[0];
}

export function insertMember(
	sql: SqlStorage,
	row: Omit<MemberRow, "simple_view" | "deactivated_at">,
): void {
	sql.exec(
		"INSERT INTO member (id, username, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
		row.id,
		row.username,
		row.display_name,
		row.role,
		row.created_at,
	);
}

export function insertDevice(
	sql: SqlStorage,
	row: { id: string; memberId: string; name: string; tokenHash: string; now: number },
): void {
	sql.exec(
		"INSERT INTO device (id, member_id, name, session_token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
		row.id,
		row.memberId,
		row.name,
		row.tokenHash,
		row.now,
		row.now,
	);
}

export function usernameTaken(sql: SqlStorage, username: string): boolean {
	return sql.exec("SELECT 1 FROM member WHERE username = ?", username).toArray().length > 0;
}
