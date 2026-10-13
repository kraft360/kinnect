// Request and response shapes shared by the Worker and the web app.

export interface ErrorResponse {
	error: string;
}

export type Role = "owner" | "admin" | "member";
export type InviteKind = "invite" | "add_device";

export interface Organization {
	id: string;
	name: string;
	timezone: string;
	/** Filled in when a task is given a date without a time (FR-24). */
	defaultDueTime: string;
}

export interface UpdateOrganizationRequest {
	timezone?: string;
	defaultDueTime?: string;
}

/**
 * Whether a device (or any of a member's devices) can receive notifications (FR-42):
 * "off" = no push subscription; "unconfirmed" = notifications were sent and none shown since `unconfirmedSince`.
 */
export type NotificationStatus = "ok" | "off" | "unconfirmed";

/** An "unconfirmed" device counts as unreachable after this long. */
export const UNCONFIRMED_AFTER_MS = 24 * 60 * 60 * 1000;

export interface Member {
	id: string;
	username: string;
	displayName: string;
	role: Role;
	/** Today-only screen with large text (FR-34). */
	simpleView: boolean;
	notifications: NotificationStatus;
	unconfirmedSince: number | null;
	/** Only included for admins. */
	activeDevices?: number;
}

export interface Device {
	id: string;
	name: string;
	createdAt: number;
	lastSeen: number | null;
	pushRegistered: boolean;
	notifications: NotificationStatus;
	unconfirmedSince: number | null;
	/** When this device last reported showing a notification (FR-46). */
	lastAckAt: number | null;
	revokedAt: number | null;
}

export interface MeResponse {
	organization: Organization;
	member: Member;
	device: Device;
	vapidPublicKey: string;
}

export interface InvitePreview {
	orgName: string;
	displayName: string;
}

export interface IssuedInvite {
	url: string;
	/** Formatted for display, e.g. "K7M-42Q". */
	code: string;
	expiresAt: number;
}

export interface PushSubscriptionJson {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

// Request bodies

export interface CreateOrgRequest {
	link: string;
	orgName: string;
	timezone: string;
	username: string;
	displayName: string;
	deviceName: string;
}

export interface RecoverRequest {
	link: string;
	deviceName: string;
}

export interface JoinPreviewRequest {
	orgId: string;
	token: string;
}

export interface JoinRequest extends JoinPreviewRequest {
	deviceName: string;
}

export interface JoinCodePreviewRequest {
	code: string;
}

export interface JoinCodeRequest extends JoinCodePreviewRequest {
	deviceName: string;
}

export interface CreateMemberRequest {
	username: string;
	displayName: string;
	role: "admin" | "member";
}

export interface UpdateMemberRequest {
	displayName?: string;
	role?: "admin" | "member";
	simpleView?: boolean;
}

export interface UpdateMeRequest {
	simpleView?: boolean;
}

export interface IssueInviteRequest {
	kind: InviteKind;
}

/** A household ("Team" in code, decision D16). */
export interface Team {
	id: string;
	name: string;
	memberIds: string[];
}

export interface TeamNameRequest {
	name: string;
}

export interface TeamDeletePreview {
	taskCount: number;
}

/** What happens to a household's tasks when it's deleted (FR-85). */
export type TeamDeleteTasks = "archive" | "move";

export interface RemovalPreviewTask {
	id: string;
	title: string;
	asAssignee: boolean;
	asWatcher: boolean;
	/** The task becomes unassigned, so its reminders go to the whole household (FR-47). */
	remindersWiden: boolean;
}

export interface RemovalPreview {
	tasks: RemovalPreviewTask[];
}
