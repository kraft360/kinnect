// One Organization (family): its database, members, devices, invites, households,
// tasks, live sync to open devices, and the alarm that runs reminders and alerts.
import { DurableObject } from "cloudflare:workers";
import { newId } from "../../shared/ids.ts";
import { localParts } from "../../shared/time.ts";
import type { ClientMessage, Op, OpResponse, ServerMessage, TaskState } from "../../shared/sync.ts";
import type {
	CreateMemberRequest,
	Device,
	InviteKind,
	InvitePreview,
	IssuedInvite,
	Member,
	MeResponse,
	PushSubscriptionJson,
	RemovalPreview,
	Team,
	TeamDeletePreview,
	TeamDeleteTasks,
	UpdateMeRequest,
	UpdateMemberRequest,
} from "../../shared/types.ts";
import { formatJoinCode, newJoinCode } from "../auth/codes.ts";
import { randomToken, sha256 } from "../auth/crypto.ts";
import { sessionToken, type SessionAuth } from "../auth/session.ts";
import { migrate } from "../db/migrate.ts";
import { DIRECTORY_NAME } from "../directory/directory-do.ts";
import { sendPush } from "../push/send.ts";
import { fail, ok, type Result } from "../result.ts";
import {
	getMember,
	getOrganization,
	insertDevice,
	insertMember,
	isAdmin,
	toDevice,
	toMember,
	toOrganization,
	usernameTaken,
	type DeviceRow,
	type InviteRow,
	type MemberRow,
	type Session,
} from "./accounts.ts";
import { drainPushQueue, enqueueTest, TEST_ALERT_ID, type PushSender } from "./notify.ts";
import { exportData } from "./export.ts";
import {
	archiveSchedule,
	dueJobs,
	getOccurrence,
	nextJobAt,
	rebuildSchedule,
	runJob,
	type JobContext,
} from "./schedule.ts";
import { orgMigrations } from "./schema.ts";
import {
	audienceChangedSince,
	audienceOf,
	canSeeScope,
	changesSince,
	markAudienceChanged,
	pruneChangeLog,
	recordChange,
	snapshot,
	type StoredChange,
} from "./sync.ts";
import { applyOp, loadTask, parseOp } from "./tasks.ts";
import * as teams from "./teams.ts";

const INVITE_LIFETIME_MS = 48 * 60 * 60 * 1000;
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
/** Jobs handled per alarm run; the rest run in an immediate follow-up. */
const JOBS_PER_RUN = 200;

export type AckAction = "shown" | "done";

export interface OrganizationSettings {
	timezone?: string;
	defaultDueTime?: string;
}

export interface CreateOrganizationInput {
	orgId: string;
	name: string;
	timezone: string;
	username: string;
	displayName: string;
	deviceName: string;
}

/** An invite is found either by its link token or by its join code. */
export type InviteLookup = { tokenHash: string } | { codeHash: string };

/** Result of a task operation: rejections carry the task's real state so the device can undo its optimistic change (FR-55). */
export type OpOutcome =
	| { ok: true; value: OpResponse }
	| { ok: false; status: number; error: string; task: TaskState | null };

/** Stored on each WebSocket so it survives hibernation. */
interface SocketInfo {
	memberId: string;
	deviceId: string;
}

/** Headers the Worker uses to pass a verified session to the WebSocket upgrade. */
export const SYNC_DEVICE_HEADER = "X-Kinnect-Device-Id";
export const SYNC_TOKEN_HEADER = "X-Kinnect-Token-Hash";

export class OrgDO extends DurableObject<Env> {
	private schemaVersion = 0;
	private sql: SqlStorage;
	/** Replaced in tests so no real push services are called. */
	pushSender: PushSender = sendPush;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.schemaVersion = migrate(ctx.storage, orgMigrations);
		});
		// Keep-alive pings are answered without waking the object from hibernation.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	health(): number {
		return this.schemaVersion;
	}

	// --- Live sync (requirements 4.7) ------------------------------------------

	/** WebSocket upgrade for /api/sync. The Worker has already checked Origin and parsed the cookie. */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket")
			return new Response("expected a WebSocket upgrade", { status: 426 });
		const session = this.authenticate(
			{
				deviceId: request.headers.get(SYNC_DEVICE_HEADER) ?? "",
				tokenHash: request.headers.get(SYNC_TOKEN_HEADER) ?? "",
			},
			Date.now(),
		);
		if (!session) return new Response("not signed in", { status: 401 });
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server, [session.member.id, session.device.id]);
		server.serializeAttachment({
			memberId: session.member.id,
			deviceId: session.device.id,
		} satisfies SocketInfo);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		let parsed: ClientMessage;
		try {
			parsed = JSON.parse(
				typeof message === "string" ? message : new TextDecoder().decode(message),
			);
		} catch {
			return;
		}
		if (parsed?.type !== "hello") return;
		const member = this.socketMember(ws);
		if (!member) return;
		const changes =
			typeof parsed.version === "number" &&
			!audienceChangedSince(this.sql, member.id, parsed.version)
				? changesSince(this.sql, parsed.version, audienceOf(this.sql, member))
				: null;
		this.send(
			ws,
			changes ? { type: "changes", changes } : { type: "snapshot", ...snapshot(this.sql, member) },
		);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	/** Applies one task operation (FR-51) and tells every open device that can see the task. */
	async applyOp(auth: SessionAuth, raw: unknown, now = Date.now()): Promise<OpOutcome> {
		const session = this.authenticate(auth, now);
		if (!session) return { ok: false, status: 401, error: "Not signed in.", task: null };
		const op = parseOp(raw);
		if (typeof op === "string") return { ok: false, status: 400, error: op, task: null };

		const actor = { member: session.member, audience: audienceOf(this.sql, session.member) };
		const jobs = this.jobContext(now);
		const result = this.ctx.storage.transactionSync(() => {
			const applied = applyOp(this.sql, actor, op, jobs);
			if (!applied.ok) return applied;
			const { taskId, previousTeamId } = applied.value;
			jobs.changed.delete(taskId);
			const changes = [
				...this.emitTask(taskId, session.member.id, now, previousTeamId),
				...[...jobs.changed].flatMap((id) => this.emitTask(id, session.member.id, now)),
			];
			return ok({ taskId, changes });
		});

		if (!result.ok) {
			const taskId = this.opTaskId(op);
			const task = taskId ? loadTask(this.sql, taskId) : null;
			return {
				ok: false,
				status: result.status,
				error: result.error,
				task: task && canSeeScope(actor.audience, task.teamId) ? task : null,
			};
		}
		this.broadcast(result.value.changes);
		const lastVersion = result.value.changes.at(-1)!.change.version;
		if (lastVersion % 100 === 0) pruneChangeLog(this.sql, now);
		const task = loadTask(this.sql, result.value.taskId);
		await this.armAlarm(now);
		return {
			ok: true,
			value: {
				version: lastVersion,
				task: task && canSeeScope(audienceOf(this.sql, session.member), task.teamId) ? task : null,
			},
		};
	}

	// --- Scheduler (requirements 7.3, 7.5) ------------------------------------------

	async alarm(): Promise<void> {
		await this.runScheduled(Date.now());
	}

	/** Runs due jobs, records the resulting task changes, sends queued pushes and re-arms the alarm. */
	async runScheduled(now: number): Promise<void> {
		if (!getOrganization(this.sql)) return;
		const jobs = this.jobContext(now);
		for (const job of dueJobs(this.sql, now, JOBS_PER_RUN)) {
			this.ctx.storage.transactionSync(() => runJob(jobs, job.id));
		}
		if (jobs.changed.size) {
			const changes = this.ctx.storage.transactionSync(() =>
				[...jobs.changed].flatMap((id) => this.emitTask(id, null, now)),
			);
			this.broadcast(changes);
		}
		const members = await drainPushQueue(this.sql, this.pushSender, this.vapid(), now);
		this.emitMembers(members, now);
		await this.armAlarm(now);
	}

	/** Sets the alarm to the earliest pending job, or to now while pushes are waiting. */
	private async armAlarm(now: number): Promise<void> {
		const queued = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM push_queue").one().n > 0;
		const nextJob = nextJobAt(this.sql);
		const next = queued ? now : nextJob;
		if (next === null) {
			if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
			return;
		}
		if ((await this.ctx.storage.getAlarm()) !== next) await this.ctx.storage.setAlarm(next);
	}

	/** A device showed a notification or its Done button was tapped (FR-44, FR-46). */
	async ackAlert(
		auth: SessionAuth,
		alertId: string,
		action: AckAction,
		now = Date.now(),
	): Promise<Result<null>> {
		const session = this.authenticate(auth, now);
		if (!session) return fail(401, "Not signed in.");
		this.deviceAcked(session.device, now);
		if (alertId === TEST_ALERT_ID) return ok(null);
		const alert = this.sql
			.exec<{ id: string; occurrence_id: string; kind: string; acked_at: number | null }>(
				"SELECT id, occurrence_id, kind, acked_at FROM alert WHERE id = ?",
				alertId,
			)
			.toArray()[0];
		if (!alert) return fail(404, "Alert not found.");
		this.sql.exec("UPDATE alert SET acked_at = COALESCE(acked_at, ?) WHERE id = ?", now, alert.id);
		if (alert.kind === "missed" && alert.acked_at === null) {
			// Devices showing "alert not delivered" should see that it arrived after all.
			const taskId = getOccurrence(this.sql, alert.occurrence_id)?.task_id;
			if (taskId)
				this.broadcast(this.ctx.storage.transactionSync(() => this.emitTask(taskId, null, now)));
		}
		if (action === "done" && ["advance", "due", "second"].includes(alert.kind)) {
			const outcome = await this.applyOp(
				auth,
				{ type: "occurrence.done", id: alert.occurrence_id },
				now,
			);
			if (!outcome.ok) return fail(outcome.status, outcome.error);
		}
		return ok(null);
	}

	/** Sends this device a test notification (FR-42). */
	async sendTestNotification(auth: SessionAuth, now = Date.now()): Promise<Result<null>> {
		const session = this.authenticate(auth, now);
		if (!session) return fail(401, "Not signed in.");
		if (!session.device.push_subscription)
			return fail(409, "Notifications aren't turned on for this device yet.");
		enqueueTest(this.sql, session.device.id, now);
		await this.armAlarm(now);
		return ok(null);
	}

	/** All of the family's data for an admin to keep (FR-92); no sign-in secrets or push endpoints. */
	exportData(
		auth: SessionAuth,
		now = Date.now(),
	): Result<{ fileName: string; data: Record<string, unknown> }> {
		return this.withAdmin(auth, now, ({ member }) => {
			const org = getOrganization(this.sql)!;
			const slug =
				org.name
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "") || "family";
			const fileName = `kinnect-${slug}-${localParts(now, org.timezone).date}.json`;
			return ok({ fileName, data: exportData(this.sql, member.id, now) });
		});
	}

	/** Records that a device showed a notification: it's confirmed reachable again (FR-42, FR-46). */
	private deviceAcked(device: DeviceRow, now: number): void {
		this.sql.exec(
			"UPDATE device SET last_ack_at = ?, unreachable_since = NULL, first_unacked_at = NULL WHERE id = ?",
			now,
			device.id,
		);
		if (device.first_unacked_at !== null) this.emitMembers([device.member_id], now);
	}

	/** Admins change the family's timezone or default due time; a new timezone re-creates future occurrences. */
	async updateOrganization(
		auth: SessionAuth,
		settings: OrganizationSettings,
		now = Date.now(),
	): Promise<Result<null>> {
		const allowed = this.withAdmin(auth, now, (session) => ok(session));
		if (!allowed.ok) return allowed;
		const org = getOrganization(this.sql)!;
		if (settings.defaultDueTime)
			this.sql.exec("UPDATE organization SET default_due_time = ?", settings.defaultDueTime);
		if (settings.timezone && settings.timezone !== org.timezone) {
			const timeZone = settings.timezone;
			const changes = this.ctx.storage.transactionSync(() => {
				this.sql.exec("UPDATE organization SET timezone = ?", timeZone);
				const tasks = this.sql
					.exec<{ id: string }>(
						"SELECT id FROM task WHERE archived = 0 AND (due_date IS NOT NULL OR repeat IS NOT NULL)",
					)
					.toArray();
				for (const task of tasks) rebuildSchedule(this.sql, task.id, timeZone, now);
				return tasks.flatMap((task) => this.emitTask(task.id, allowed.value.member.id, now));
			});
			this.broadcast(changes);
			await this.armAlarm(now);
		}
		return ok(null);
	}

	// --- Creating the Organization and signing devices in -------------------

	async createOrganization(
		input: CreateOrganizationInput,
		now = Date.now(),
	): Promise<Result<{ token: string }>> {
		if (getOrganization(this.sql)) return fail(409, "This family already exists.");
		const memberId = newId();
		const device = await this.newDeviceSecret(input.orgId);
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				"INSERT INTO organization (id, name, timezone, created_at) VALUES (?, ?, ?, ?)",
				input.orgId,
				input.name,
				input.timezone,
				now,
			);
			insertMember(this.sql, {
				id: memberId,
				username: input.username,
				display_name: input.displayName,
				role: "owner",
				created_at: now,
			});
			insertDevice(this.sql, {
				id: device.id,
				memberId,
				name: input.deviceName,
				tokenHash: device.tokenHash,
				now,
			});
		});
		return ok({ token: device.token });
	}

	/** Operator recovery (FR-64): signs a new device in as the owner. */
	async recoverOwner(deviceName: string, now = Date.now()): Promise<Result<{ token: string }>> {
		const org = getOrganization(this.sql);
		const owner = this.sql
			.exec<MemberRow>("SELECT * FROM member WHERE role = 'owner' AND deactivated_at IS NULL")
			.toArray()[0];
		if (!org || !owner) return fail(404, "Family not found.");
		const device = await this.newDeviceSecret(org.id);
		insertDevice(this.sql, {
			id: device.id,
			memberId: owner.id,
			name: deviceName,
			tokenHash: device.tokenHash,
			now,
		});
		return ok({ token: device.token });
	}

	previewInvite(lookup: InviteLookup, now = Date.now()): Result<InvitePreview> {
		const found = this.findUsableInvite(lookup, now);
		if (!found.ok) return found;
		return ok({
			orgName: getOrganization(this.sql)!.name,
			displayName: found.value.member.display_name,
		});
	}

	/** Uses up the invite and signs a new device in as its member (FR-73). */
	async joinWithInvite(
		lookup: InviteLookup,
		deviceName: string,
		now = Date.now(),
	): Promise<Result<{ token: string }>> {
		const org = getOrganization(this.sql);
		if (!org) return fail(404, "That invite isn't valid.");
		const device = await this.newDeviceSecret(org.id);

		// Re-checked synchronously so two taps on the same invite can't both succeed.
		const result = this.ctx.storage.transactionSync((): Result<InviteRow> => {
			const found = this.findUsableInvite(lookup, now);
			if (!found.ok) return found;
			const { invite, member } = found.value;
			insertDevice(this.sql, {
				id: device.id,
				memberId: member.id,
				name: deviceName,
				tokenHash: device.tokenHash,
				now,
			});
			this.sql.exec(
				"UPDATE invite SET used_at = ?, used_by_device = ? WHERE id = ?",
				now,
				device.id,
				invite.id,
			);
			return ok(invite);
		});
		if (!result.ok) return result;
		await this.directory().removeJoinCodes([result.value.code_hash]);
		return ok({ token: device.token });
	}

	// --- Signed-in requests ---------------------------------------------------

	me(auth: SessionAuth, now = Date.now()): Result<MeResponse> {
		return this.withSession(auth, now, ({ member, device }) =>
			ok({
				organization: toOrganization(getOrganization(this.sql)!),
				member: toMember(this.sql, member),
				device: toDevice(device),
				vapidPublicKey: this.env.VAPID_PUBLIC_KEY,
			}),
		);
	}

	signOut(auth: SessionAuth, now = Date.now()): Result<null> {
		return this.withSession(auth, now, ({ device }) => {
			this.revoke(device.id, now);
			return ok(null);
		});
	}

	setPushSubscription(
		auth: SessionAuth,
		subscription: PushSubscriptionJson,
		now = Date.now(),
	): Result<null> {
		return this.withSession(auth, now, ({ device }) => {
			const unchanged = device.push_subscription === JSON.stringify(subscription);
			// A new subscription starts with a clean record (FR-42).
			this.sql.exec(
				`UPDATE device SET push_subscription = ?, unreachable_since = NULL,
				 first_unacked_at = CASE WHEN ? THEN first_unacked_at ELSE NULL END WHERE id = ?`,
				JSON.stringify(subscription),
				unchanged ? 1 : 0,
				device.id,
			);
			if (!unchanged) this.emitMembers([device.member_id], now);
			return ok(null);
		});
	}

	listMembers(auth: SessionAuth, now = Date.now()): Result<Member[]> {
		return this.withSession(auth, now, ({ member: me }) => {
			const rows = this.sql
				.exec<MemberRow & { active_devices: number }>(
					`SELECT m.*, (SELECT COUNT(*) FROM device d WHERE d.member_id = m.id AND d.revoked_at IS NULL) AS active_devices
					 FROM member m WHERE m.deactivated_at IS NULL ORDER BY m.display_name COLLATE NOCASE`,
				)
				.toArray();
			return ok(
				rows.map((row) => toMember(this.sql, row, isAdmin(me) ? row.active_devices : undefined)),
			);
		});
	}

	createMember(auth: SessionAuth, input: CreateMemberRequest, now = Date.now()): Result<Member> {
		return this.withAdmin(auth, now, ({ member: admin }) => {
			if (usernameTaken(this.sql, input.username))
				return fail(409, "That username is already taken in this family.");
			const row: MemberRow = {
				id: newId(),
				username: input.username,
				display_name: input.displayName,
				role: input.role,
				simple_view: 0,
				created_at: now,
				deactivated_at: null,
			};
			insertMember(this.sql, row);
			this.broadcast([this.emitMember(row.id, admin.id, now)]);
			return ok(toMember(this.sql, row, 0));
		});
	}

	updateMember(
		auth: SessionAuth,
		memberId: string,
		input: UpdateMemberRequest,
		now = Date.now(),
	): Result<Member> {
		return this.withAdmin(auth, now, ({ member: admin }) => {
			const target = getMember(this.sql, memberId);
			if (!target || target.deactivated_at) return fail(404, "Member not found.");
			if (input.role && target.role === "owner")
				return fail(403, "The owner's role can't be changed.");
			if (input.displayName !== undefined)
				this.sql.exec(
					"UPDATE member SET display_name = ? WHERE id = ?",
					input.displayName,
					memberId,
				);
			if (input.role)
				this.sql.exec("UPDATE member SET role = ? WHERE id = ?", input.role, memberId);
			// Admins can switch simple view for members who wouldn't find the setting (FR-34).
			if (input.simpleView !== undefined)
				this.sql.exec(
					"UPDATE member SET simple_view = ? WHERE id = ?",
					input.simpleView ? 1 : 0,
					memberId,
				);
			this.broadcast([this.emitMember(memberId, admin.id, now)]);
			// A role change changes what they can see.
			if (input.role && input.role !== target.role) this.resyncMembers([memberId]);
			return ok(toMember(this.sql, getMember(this.sql, memberId)!));
		});
	}

	/** A member's own settings. */
	updateMe(auth: SessionAuth, input: UpdateMeRequest, now = Date.now()): Result<Member> {
		return this.withSession(auth, now, ({ member }) => {
			if (input.simpleView !== undefined)
				this.sql.exec(
					"UPDATE member SET simple_view = ? WHERE id = ?",
					input.simpleView ? 1 : 0,
					member.id,
				);
			this.broadcast([this.emitMember(member.id, member.id, now)]);
			return ok(toMember(this.sql, getMember(this.sql, member.id)!));
		});
	}

	/** Creates a fresh invite or add-device link with a join code; earlier unused ones for the member stop working. */
	async issueInvite(
		auth: SessionAuth,
		memberId: string,
		kind: InviteKind,
		baseUrl: string,
		now = Date.now(),
	): Promise<Result<IssuedInvite>> {
		const allowed = this.withAdmin(auth, now, (session) => ok(session));
		if (!allowed.ok) return allowed;
		const target = getMember(this.sql, memberId);
		if (!target || target.deactivated_at) return fail(404, "Member not found.");
		const org = getOrganization(this.sql)!;

		const previous = this.sql
			.exec<{ code_hash: string }>(
				"UPDATE invite SET revoked_at = ? WHERE member_id = ? AND used_at IS NULL AND revoked_at IS NULL RETURNING code_hash",
				now,
				memberId,
			)
			.toArray();
		if (previous.length) await this.directory().removeJoinCodes(previous.map((p) => p.code_hash));

		const token = randomToken();
		const expiresAt = now + INVITE_LIFETIME_MS;
		let code = "";
		let codeHash = "";
		for (let attempt = 0; attempt < 5 && !codeHash; attempt++) {
			code = newJoinCode();
			const hash = await sha256(code);
			if (await this.directory().registerJoinCode(hash, org.id, expiresAt, now)) codeHash = hash;
		}
		if (!codeHash) return fail(503, "Couldn't create a join code. Please try again.");

		this.sql.exec(
			`INSERT INTO invite (id, member_id, kind, token_hash, code_hash, created_by, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			newId(),
			memberId,
			kind,
			await sha256(token),
			codeHash,
			allowed.value.member.id,
			now,
			expiresAt,
		);
		return ok({
			url: `${baseUrl}/#/join/${org.id}/${token}`,
			code: formatJoinCode(code),
			expiresAt,
		});
	}

	listDevices(auth: SessionAuth, memberId: string, now = Date.now()): Result<Device[]> {
		return this.withSession(auth, now, ({ member }) => {
			if (member.id !== memberId && !isAdmin(member))
				return fail(403, "Only admins can see other members' devices.");
			const rows = this.sql
				.exec<DeviceRow>(
					"SELECT * FROM device WHERE member_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC",
					memberId,
				)
				.toArray();
			return ok(rows.map(toDevice));
		});
	}

	/** Ends a device's session immediately (FR-78). */
	revokeDevice(auth: SessionAuth, deviceId: string, now = Date.now()): Result<null> {
		return this.withSession(auth, now, ({ member }) => {
			const device = this.sql
				.exec<DeviceRow>("SELECT * FROM device WHERE id = ?", deviceId)
				.toArray()[0];
			if (!device) return fail(404, "Device not found.");
			if (device.member_id !== member.id && !isAdmin(member))
				return fail(403, "Only admins can sign out other members' devices.");
			this.revoke(deviceId, now);
			return ok(null);
		});
	}

	// --- Households (requirements 4.10) ----------------------------------------

	/** Admins see every household (FR-87); members see the ones they belong to. */
	listTeams(auth: SessionAuth, now = Date.now()): Result<Team[]> {
		return this.withSession(auth, now, ({ member }) =>
			ok(teams.listTeams(this.sql, isAdmin(member) ? undefined : member.id)),
		);
	}

	createTeam(auth: SessionAuth, name: string, now = Date.now()): Result<Team> {
		return this.withAdmin(auth, now, ({ member: admin }) => {
			if (teams.teamNameTaken(this.sql, name))
				return fail(409, "A household with that name already exists.");
			const id = newId();
			this.sql.exec("INSERT INTO team (id, name, created_at) VALUES (?, ?, ?)", id, name, now);
			this.broadcast([this.emitTeam(id, admin.id, now)]);
			return ok(teams.toTeam(this.sql, id));
		});
	}

	renameTeam(auth: SessionAuth, teamId: string, name: string, now = Date.now()): Result<Team> {
		return this.withAdmin(auth, now, ({ member: admin }) => {
			if (!teams.getTeam(this.sql, teamId)) return fail(404, "Household not found.");
			if (teams.teamNameTaken(this.sql, name, teamId))
				return fail(409, "A household with that name already exists.");
			this.sql.exec("UPDATE team SET name = ? WHERE id = ?", name, teamId);
			this.broadcast([this.emitTeam(teamId, admin.id, now)]);
			return ok(teams.toTeam(this.sql, teamId));
		});
	}

	teamDeletePreview(
		auth: SessionAuth,
		teamId: string,
		now = Date.now(),
	): Result<TeamDeletePreview> {
		return this.withAdmin(auth, now, () =>
			teams.getTeam(this.sql, teamId)
				? ok({ taskCount: teams.openTaskCount(this.sql, teamId) })
				: fail(404, "Household not found."),
		);
	}

	deleteTeam(
		auth: SessionAuth,
		teamId: string,
		tasks: TeamDeleteTasks,
		now = Date.now(),
	): Result<null> {
		return this.withAdmin(auth, now, ({ member: admin }) => {
			if (!teams.getTeam(this.sql, teamId)) return fail(404, "Household not found.");
			const formerMembers = teams.toTeam(this.sql, teamId).memberIds;
			const changes = this.ctx.storage.transactionSync(() => {
				const affected = teams.deleteTeam(this.sql, teamId, tasks, now);
				if (tasks === "archive")
					for (const taskId of affected) archiveSchedule(this.sql, taskId, now);
				return [
					recordChange(this.sql, {
						entity: "team",
						id: teamId,
						op: "remove",
						teamId,
						memberId: admin.id,
						now,
					}),
					...affected.flatMap((taskId) =>
						this.emitTask(taskId, admin.id, now, tasks === "move" ? teamId : undefined),
					),
				];
			});
			this.broadcast(changes);
			this.resyncMembers(formerMembers);
			return ok(null);
		});
	}

	addTeamMember(
		auth: SessionAuth,
		teamId: string,
		memberId: string,
		now = Date.now(),
	): Result<Team> {
		return this.withAdmin(auth, now, ({ member: admin }) => {
			if (!teams.getTeam(this.sql, teamId)) return fail(404, "Household not found.");
			const target = getMember(this.sql, memberId);
			if (!target || target.deactivated_at) return fail(404, "Member not found.");
			this.sql.exec(
				"INSERT INTO team_member (team_id, member_id, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
				teamId,
				memberId,
				admin.id,
				now,
			);
			this.broadcast([this.emitTeam(teamId, admin.id, now)]);
			// They can now see the household's tasks (FR-83).
			this.resyncMembers([memberId]);
			return ok(teams.toTeam(this.sql, teamId));
		});
	}

	removalPreview(
		auth: SessionAuth,
		teamId: string,
		memberId: string,
		now = Date.now(),
	): Result<RemovalPreview> {
		return this.withAdmin(auth, now, () => {
			if (!teams.getTeam(this.sql, teamId)) return fail(404, "Household not found.");
			if (!teams.isTeamMember(this.sql, teamId, memberId))
				return fail(404, "That member isn't in this household.");
			return ok({ tasks: teams.removalPreview(this.sql, teamId, memberId) });
		});
	}

	/** FR-84: the member loses access, stops watching and is unassigned from the household's open tasks. */
	removeTeamMember(
		auth: SessionAuth,
		teamId: string,
		memberId: string,
		now = Date.now(),
	): Result<Team> {
		return this.withAdmin(auth, now, ({ member: admin }) => {
			if (!teams.getTeam(this.sql, teamId)) return fail(404, "Household not found.");
			if (!teams.isTeamMember(this.sql, teamId, memberId))
				return fail(404, "That member isn't in this household.");
			const changes = this.ctx.storage.transactionSync(() => {
				const affected = teams.removeMember(this.sql, teamId, memberId, now);
				return [
					this.emitTeam(teamId, admin.id, now),
					...affected.flatMap((taskId) => this.emitTask(taskId, admin.id, now)),
				];
			});
			this.broadcast(changes);
			// They lose the household's tasks immediately (FR-84).
			this.resyncMembers([memberId]);
			return ok(teams.toTeam(this.sql, teamId));
		});
	}

	// --- Change log and broadcasting -------------------------------------------

	/** Records a task's new state; a scope change first tells the old audience it's gone. */
	private emitTask(
		taskId: string,
		actorId: string | null,
		now: number,
		previousTeamId?: string | null,
	): StoredChange[] {
		const task = loadTask(this.sql, taskId)!;
		const changes: StoredChange[] = [];
		if (previousTeamId !== undefined && previousTeamId !== task.teamId) {
			changes.push(
				recordChange(this.sql, {
					entity: "task",
					id: taskId,
					op: "remove",
					teamId: previousTeamId,
					memberId: actorId,
					now,
				}),
			);
		}
		changes.push(
			recordChange(this.sql, {
				entity: "task",
				id: taskId,
				op: "upsert",
				data: task,
				teamId: task.teamId,
				memberId: actorId,
				now,
			}),
		);
		return changes;
	}

	private emitTeam(teamId: string, actorId: string, now: number): StoredChange {
		return recordChange(this.sql, {
			entity: "team",
			id: teamId,
			op: "upsert",
			data: teams.toTeam(this.sql, teamId),
			teamId,
			memberId: actorId,
			now,
		});
	}

	/** Records and broadcasts member changes (e.g. notification status) not caused by a member's action. */
	private emitMembers(memberIds: Iterable<string>, now: number): void {
		const ids = [...new Set(memberIds)].filter((id) => getMember(this.sql, id));
		if (ids.length)
			this.broadcast(
				this.ctx.storage.transactionSync(() => ids.map((id) => this.emitMember(id, null, now))),
			);
	}

	private emitMember(memberId: string, actorId: string | null, now: number): StoredChange {
		const data = toMember(this.sql, getMember(this.sql, memberId)!);
		return recordChange(this.sql, {
			entity: "member",
			id: memberId,
			op: "upsert",
			data,
			teamId: null,
			memberId: actorId,
			now,
		});
	}

	/** Sends each open device the changes it's allowed to see, in version order. */
	private broadcast(changes: StoredChange[]): void {
		if (!changes.length) return;
		const audiences = new Map<string, ReturnType<typeof audienceOf> | null>();
		for (const ws of this.ctx.getWebSockets()) {
			const info = ws.deserializeAttachment() as SocketInfo | null;
			if (!info) continue;
			if (!audiences.has(info.memberId)) {
				const member = this.socketMember(ws);
				audiences.set(info.memberId, member ? audienceOf(this.sql, member) : null);
			}
			const audience = audiences.get(info.memberId);
			if (!audience) continue;
			const visible = changes.filter((c) => canSeeScope(audience, c.teamId)).map((c) => c.change);
			if (visible.length) this.send(ws, { type: "changes", changes: visible });
		}
	}

	/**
	 * After what members can see has changed (FR-83, FR-84): sends their open devices a fresh snapshot,
	 * and marks the change so devices that were away get one when they reconnect.
	 */
	private resyncMembers(memberIds: string[]): void {
		for (const memberId of memberIds) {
			const member = getMember(this.sql, memberId);
			if (!member) continue;
			markAudienceChanged(this.sql, memberId);
			const data = snapshot(this.sql, member);
			for (const ws of this.ctx.getWebSockets(memberId))
				this.send(ws, { type: "snapshot", ...data });
		}
	}

	/** The member behind a socket, or null (closing it) if the device was signed out or the member removed. */
	private socketMember(ws: WebSocket): MemberRow | null {
		const info = ws.deserializeAttachment() as SocketInfo | null;
		const device =
			info &&
			this.sql
				.exec<DeviceRow>("SELECT * FROM device WHERE id = ? AND revoked_at IS NULL", info.deviceId)
				.toArray()[0];
		const member = device ? getMember(this.sql, device.member_id) : undefined;
		if (!member || member.deactivated_at) {
			ws.close(4401, "signed out");
			return null;
		}
		return member;
	}

	private send(ws: WebSocket, message: ServerMessage): void {
		try {
			ws.send(JSON.stringify(message));
		} catch {
			// The device disconnected; it will catch up with "hello" when it reconnects.
		}
	}

	/** The task an operation touches (sub-task and occurrence operations name only their own id). */
	private opTaskId(op: Op): string | null {
		if ("taskId" in op) return op.taskId;
		if (op.type === "occurrence.tick" || op.type === "occurrence.untick") {
			return getOccurrence(this.sql, op.occurrenceId)?.task_id ?? null;
		}
		if (op.type === "occurrence.done" || op.type === "occurrence.reopen")
			return getOccurrence(this.sql, op.id)?.task_id ?? null;
		if (op.type.startsWith("subtask.")) {
			return (
				this.sql
					.exec<{ task_id: string }>("SELECT task_id FROM subtask WHERE id = ?", op.id)
					.toArray()[0]?.task_id ?? null
			);
		}
		return op.id;
	}

	/** Callers run only once the family exists (a signed-in device, or runScheduled's check). */
	private jobContext(now: number): JobContext {
		const org = getOrganization(this.sql);
		if (!org) throw new Error("jobContext: the family hasn't been created");
		return { sql: this.sql, timeZone: org.timezone, now, changed: new Set() };
	}

	private vapid() {
		// Push services contact the sender here; Apple's rejects every push if it isn't https: (or mailto:).
		if (!/^(https|mailto):/.test(this.env.APP_URL)) {
			console.error("APP_URL must start with https://, or push services will reject reminders.");
		}
		return {
			publicKey: this.env.VAPID_PUBLIC_KEY,
			privateKey: this.env.VAPID_PRIVATE_KEY,
			subject: this.env.APP_URL,
		};
	}

	// --- Helpers --------------------------------------------------------------

	private authenticate(auth: SessionAuth, now: number): Session | null {
		const device = this.sql
			.exec<DeviceRow>(
				"SELECT * FROM device WHERE id = ? AND session_token_hash = ? AND revoked_at IS NULL",
				auth.deviceId,
				auth.tokenHash,
			)
			.toArray()[0];
		if (!device) return null;
		const member = getMember(this.sql, device.member_id);
		if (!member || member.deactivated_at) return null;
		if (!device.last_seen || now - device.last_seen > LAST_SEEN_INTERVAL_MS) {
			this.sql.exec("UPDATE device SET last_seen = ? WHERE id = ?", now, device.id);
			device.last_seen = now;
		}
		return { member, device };
	}

	private withSession<T>(
		auth: SessionAuth,
		now: number,
		action: (session: Session) => Result<T>,
	): Result<T> {
		const session = this.authenticate(auth, now);
		return session ? action(session) : fail(401, "Not signed in.");
	}

	private withAdmin<T>(
		auth: SessionAuth,
		now: number,
		action: (session: Session) => Result<T>,
	): Result<T> {
		return this.withSession(auth, now, (session) =>
			isAdmin(session.member) ? action(session) : fail(403, "Only admins can do this."),
		);
	}

	private findUsableInvite(
		lookup: InviteLookup,
		now: number,
	): Result<{ invite: InviteRow; member: MemberRow }> {
		const invite =
			"tokenHash" in lookup
				? this.sql
						.exec<InviteRow>("SELECT * FROM invite WHERE token_hash = ?", lookup.tokenHash)
						.toArray()[0]
				: this.sql
						.exec<InviteRow>("SELECT * FROM invite WHERE code_hash = ?", lookup.codeHash)
						.toArray()[0];
		if (!invite || invite.revoked_at)
			return fail(404, "That invite isn't valid. Ask an admin for a new one.");
		if (invite.used_at)
			return fail(409, "That invite has already been used. Ask an admin for a new one.");
		if (invite.expires_at <= now)
			return fail(410, "That invite has expired. Ask an admin for a new one.");
		const member = getMember(this.sql, invite.member_id);
		if (!member || member.deactivated_at)
			return fail(404, "That invite isn't valid. Ask an admin for a new one.");
		return ok({ invite, member });
	}

	private async newDeviceSecret(
		orgId: string,
	): Promise<{ id: string; token: string; tokenHash: string }> {
		const id = newId();
		const random = randomToken();
		return { id, token: sessionToken(orgId, id, random), tokenHash: await sha256(random) };
	}

	private revoke(deviceId: string, now: number): void {
		const device = this.sql
			.exec<{ member_id: string }>(
				"UPDATE device SET revoked_at = COALESCE(revoked_at, ?), push_subscription = NULL WHERE id = ? RETURNING member_id",
				now,
				deviceId,
			)
			.toArray()[0];
		// Its live connections end too (FR-78).
		for (const ws of this.ctx.getWebSockets(deviceId)) ws.close(4401, "signed out");
		if (device) this.emitMembers([device.member_id], now);
	}

	private directory() {
		return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME));
	}
}
