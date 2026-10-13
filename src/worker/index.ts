// Worker entry. Static files (the web app) are served by the assets layer;
// only /api requests reach this code. The Worker handles HTTP (routing, JSON,
// cookies, cross-site checks); the Durable Objects hold the data and rules.
import { isOrgId, newOrgId } from "../shared/ids.ts";
import type { OpRejection } from "../shared/sync.ts";
import type { PushSubscriptionJson } from "../shared/types.ts";
import { TIME_PATTERN } from "../shared/time.ts";
import { checkText, checkTimezone, checkUsername, LIMITS } from "../shared/validation.ts";
import { normalizeJoinCode } from "./auth/codes.ts";
import { sha256 } from "./auth/crypto.ts";
import { verifyOperatorLink, type OperatorLinkKind } from "./auth/operator-link.ts";
import {
	clearSessionCookie,
	parseSessionToken,
	readCookie,
	SESSION_COOKIE,
	sessionCookie,
	type ParsedSession,
} from "./auth/session.ts";
import { DIRECTORY_NAME } from "./directory/directory-do.ts";
import { SYNC_DEVICE_HEADER, SYNC_TOKEN_HEADER } from "./org/org-do.ts";
import {
	BadRequest,
	checkSameOrigin,
	enumField,
	errorResponse,
	notFound,
	optionalStringField,
	readJson,
	resultResponse,
	stringField,
} from "./http.ts";
import { isPushServiceEndpoint } from "./push/send.ts";
import type { Result } from "./result.ts";
import { Router } from "./router.ts";

export { DirectoryDO } from "./directory/directory-do.ts";
export { OrgDO } from "./org/org-do.ts";

interface Context {
	env: Env;
}

const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME));
const org = (env: Env, orgId: string) => env.ORG.get(env.ORG.idFromName(orgId));

function check(...errors: (string | null)[]): void {
	const error = errors.find((e) => e !== null);
	if (error) throw new BadRequest(error);
}

/** Responds to a successful sign-in by setting the session cookie. */
function signedIn(result: Result<{ token: string }>): Response {
	if (!result.ok) return errorResponse(result.status, result.error);
	return Response.json(
		{ ok: true },
		{ headers: { "Set-Cookie": sessionCookie(result.value.token) } },
	);
}

/** The family data file (FR-92): a JSON download the browser saves rather than shows. */
function download(result: Result<{ fileName: string; data: Record<string, unknown> }>): Response {
	if (!result.ok) return errorResponse(result.status, result.error);
	return new Response(JSON.stringify(result.value.data, null, 1), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="${result.value.fileName}"`,
			"Cache-Control": "no-store",
		},
	});
}

async function operatorLink(env: Env, value: string, kind: OperatorLinkKind) {
	const verified = await verifyOperatorLink(value, env.OPERATOR_SECRET);
	if (!verified.ok) {
		throw new BadRequest(
			verified.reason === "expired"
				? "This link has expired. Ask for a new one."
				: "This link isn't valid.",
		);
	}
	if (verified.link.kind !== kind) throw new BadRequest("This link isn't valid.");
	return verified.link;
}

async function codeLookup(
	env: Env,
	request: Request,
	input: string,
): Promise<Result<{ orgId: string; codeHash: string }>> {
	const code = normalizeJoinCode(input);
	if (!code)
		return {
			ok: false,
			status: 400,
			error: "A join code has 6 letters and numbers, like K7M-42Q.",
		};
	const codeHash = await sha256(code);
	const found = await directory(env).lookupJoinCode(
		codeHash,
		request.headers.get("CF-Connecting-IP") ?? "unknown",
	);
	return found.ok ? { ok: true, value: { orgId: found.value.orgId, codeHash } } : found;
}

// --- Public routes (no session) --------------------------------------------

const publicRoutes = new Router<Context>()
	.on("GET", "/api/directory/health", async (_request, _params, { env }) =>
		Response.json({ ok: true, schemaVersion: await directory(env).health() }),
	)
	.on("POST", "/api/create-org", async (request, _params, { env }) => {
		const body = await readJson(request);
		const input = {
			orgName: stringField(body, "orgName").trim(),
			timezone: stringField(body, "timezone"),
			username: stringField(body, "username").trim(),
			displayName: stringField(body, "displayName").trim(),
			deviceName: stringField(body, "deviceName").trim(),
		};
		check(
			checkText("Family name", input.orgName, LIMITS.orgName),
			checkTimezone(input.timezone),
			checkUsername(input.username),
			checkText("Display name", input.displayName, LIMITS.displayName),
			checkText("Device name", input.deviceName, LIMITS.deviceName),
		);
		const link = await operatorLink(env, stringField(body, "link"), "create_org");
		const orgId = newOrgId();
		if (!(await directory(env).claimOperatorLink(link.linkId, link.kind, orgId))) {
			return errorResponse(409, "This link has already been used.");
		}
		return signedIn(
			await org(env, orgId).createOrganization({ orgId, name: input.orgName, ...input }),
		);
	})
	.on("POST", "/api/recover", async (request, _params, { env }) => {
		const body = await readJson(request);
		const deviceName = stringField(body, "deviceName").trim();
		check(checkText("Device name", deviceName, LIMITS.deviceName));
		const link = await operatorLink(env, stringField(body, "link"), "recover");
		if (!link.orgId || !isOrgId(link.orgId)) throw new BadRequest("This link isn't valid.");
		if (!(await directory(env).claimOperatorLink(link.linkId, link.kind, link.orgId))) {
			return errorResponse(409, "This link has already been used.");
		}
		return signedIn(await org(env, link.orgId).recoverOwner(deviceName));
	})
	.on("POST", "/api/join/preview", async (request, _params, { env }) => {
		const body = await readJson(request);
		const orgId = stringField(body, "orgId");
		if (!isOrgId(orgId)) return errorResponse(404, "That invite isn't valid.");
		return resultResponse(
			await org(env, orgId).previewInvite({ tokenHash: await sha256(stringField(body, "token")) }),
		);
	})
	.on("POST", "/api/join", async (request, _params, { env }) => {
		const body = await readJson(request);
		const orgId = stringField(body, "orgId");
		const deviceName = stringField(body, "deviceName").trim();
		check(checkText("Device name", deviceName, LIMITS.deviceName));
		if (!isOrgId(orgId)) return errorResponse(404, "That invite isn't valid.");
		return signedIn(
			await org(env, orgId).joinWithInvite(
				{ tokenHash: await sha256(stringField(body, "token")) },
				deviceName,
			),
		);
	})
	.on("POST", "/api/join-code/preview", async (request, _params, { env }) => {
		const body = await readJson(request);
		const found = await codeLookup(env, request, stringField(body, "code", 20));
		if (!found.ok) return resultResponse(found);
		return resultResponse(
			await org(env, found.value.orgId).previewInvite({ codeHash: found.value.codeHash }),
		);
	})
	.on("POST", "/api/join-code", async (request, _params, { env }) => {
		const body = await readJson(request);
		const deviceName = stringField(body, "deviceName").trim();
		check(checkText("Device name", deviceName, LIMITS.deviceName));
		const found = await codeLookup(env, request, stringField(body, "code", 20));
		if (!found.ok) return resultResponse(found);
		return signedIn(
			await org(env, found.value.orgId).joinWithInvite(
				{ codeHash: found.value.codeHash },
				deviceName,
			),
		);
	});

// --- Signed-in routes ---------------------------------------------------------

interface SessionContext extends Context {
	session: ParsedSession;
}

const sessionRoutes = new Router<SessionContext>()
	.on("GET", "/api/me", async (_request, _params, { env, session }) => {
		// Re-issuing the cookie on each app start keeps an active device signed in (FR-74).
		return resultResponse(await org(env, session.orgId).me(session), {
			headers: { "Set-Cookie": sessionCookie(session.token) },
		});
	})
	.on("POST", "/api/sign-out", async (_request, _params, { env, session }) => {
		const result = await org(env, session.orgId).signOut(session);
		return resultResponse(result, { headers: { "Set-Cookie": clearSessionCookie() } });
	})
	.on("PUT", "/api/me/push", async (request, _params, { env, session }) => {
		const body = await readJson(request);
		const subscription = body.subscription as PushSubscriptionJson | undefined;
		if (
			typeof subscription?.endpoint !== "string" ||
			!isPushServiceEndpoint(subscription.endpoint) ||
			typeof subscription.keys?.p256dh !== "string" ||
			typeof subscription.keys?.auth !== "string"
		) {
			throw new BadRequest("subscription must be a push subscription");
		}
		const { endpoint, keys } = subscription;
		return resultResponse(
			await org(env, session.orgId).setPushSubscription(session, {
				endpoint,
				keys: { p256dh: keys.p256dh, auth: keys.auth },
			}),
		);
	})
	.on("PATCH", "/api/me", async (request, _params, { env, session }) => {
		const body = await readJson(request);
		return resultResponse(
			await org(env, session.orgId).updateMe(session, {
				simpleView: optionalBoolean(body, "simpleView"),
			}),
		);
	})
	.on("POST", "/api/me/test-notification", async (_request, _params, { env, session }) =>
		resultResponse(await org(env, session.orgId).sendTestNotification(session)),
	)
	.on("GET", "/api/members", async (_request, _params, { env, session }) =>
		resultResponse(await org(env, session.orgId).listMembers(session)),
	)
	.on("POST", "/api/members", async (request, _params, { env, session }) => {
		const body = await readJson(request);
		const input = {
			username: stringField(body, "username").trim(),
			displayName: stringField(body, "displayName").trim(),
			role: enumField(body, "role", ["admin", "member"] as const),
		};
		check(
			checkUsername(input.username),
			checkText("Display name", input.displayName, LIMITS.displayName),
		);
		return resultResponse(await org(env, session.orgId).createMember(session, input), {
			status: 201,
		});
	})
	.on("PATCH", "/api/members/:id", async (request, { id }, { env, session }) => {
		const body = await readJson(request);
		const displayName = optionalStringField(body, "displayName")?.trim();
		const role =
			body.role === undefined ? undefined : enumField(body, "role", ["admin", "member"] as const);
		if (displayName !== undefined)
			check(checkText("Display name", displayName, LIMITS.displayName));
		const simpleView = optionalBoolean(body, "simpleView");
		return resultResponse(
			await org(env, session.orgId).updateMember(session, id, { displayName, role, simpleView }),
		);
	})
	.on("POST", "/api/members/:id/invites", async (request, { id }, { env, session }) => {
		const body = await readJson(request);
		const kind = enumField(body, "kind", ["invite", "add_device"] as const);
		const baseUrl = new URL(request.url).origin;
		return resultResponse(await org(env, session.orgId).issueInvite(session, id, kind, baseUrl), {
			status: 201,
		});
	})
	.on("GET", "/api/members/:id/devices", async (_request, { id }, { env, session }) =>
		resultResponse(await org(env, session.orgId).listDevices(session, id)),
	)
	.on("DELETE", "/api/devices/:id", async (_request, { id }, { env, session }) =>
		resultResponse(await org(env, session.orgId).revokeDevice(session, id)),
	)
	// Tasks and live sync (requirements 4.7)
	.on("POST", "/api/ops", async (request, _params, { env, session }) => {
		const body = await readJson(request);
		const outcome = await org(env, session.orgId).applyOp(session, body.op);
		return outcome.ok
			? Response.json(outcome.value)
			: Response.json({ error: outcome.error, task: outcome.task } satisfies OpRejection, {
					status: outcome.status,
				});
	})
	.on("GET", "/api/sync", async (request, _params, { env, session }) => {
		if (request.headers.get("Upgrade") !== "websocket")
			return errorResponse(426, "expected a WebSocket upgrade");
		// Browsers always send Origin on WebSocket requests; refusing other sites blocks cross-site WebSocket hijacking.
		if (request.headers.get("Origin") !== new URL(request.url).origin)
			return errorResponse(403, "cross-origin request refused");
		const headers = new Headers(request.headers);
		headers.set(SYNC_DEVICE_HEADER, session.deviceId);
		headers.set(SYNC_TOKEN_HEADER, session.tokenHash);
		return org(env, session.orgId).fetch(new Request(request, { headers }));
	})
	// Reminders and alerts (requirements 4.6)
	.on("POST", "/api/alerts/ack", async (request, _params, { env, session }) => {
		const body = await readJson(request);
		const action = enumField(body, "action", ["shown", "done", "error"] as const);
		// "error" means the device couldn't show it; it isn't an acknowledgement.
		if (action === "error") return Response.json(null);
		return resultResponse(
			await org(env, session.orgId).ackAlert(session, stringField(body, "alertId", 64), action),
		);
	})
	.on("GET", "/api/export", async (_request, _params, { env, session }) =>
		download(await org(env, session.orgId).exportData(session)),
	)
	.on("PATCH", "/api/organization", async (request, _params, { env, session }) => {
		const body = await readJson(request);
		const timezone = optionalStringField(body, "timezone");
		const defaultDueTime = optionalStringField(body, "defaultDueTime");
		if (timezone !== undefined) check(checkTimezone(timezone));
		if (defaultDueTime !== undefined && !TIME_PATTERN.test(defaultDueTime))
			throw new BadRequest("Default time must be HH:MM.");
		return resultResponse(
			await org(env, session.orgId).updateOrganization(session, { timezone, defaultDueTime }),
		);
	})
	// Households ("Team" in code)
	.on("GET", "/api/teams", async (_request, _params, { env, session }) =>
		resultResponse(await org(env, session.orgId).listTeams(session)),
	)
	.on("POST", "/api/teams", async (request, _params, { env, session }) => {
		const name = await teamName(request);
		return resultResponse(await org(env, session.orgId).createTeam(session, name), { status: 201 });
	})
	.on("PATCH", "/api/teams/:id", async (request, { id }, { env, session }) =>
		resultResponse(await org(env, session.orgId).renameTeam(session, id, await teamName(request))),
	)
	.on("GET", "/api/teams/:id/delete-preview", async (_request, { id }, { env, session }) =>
		resultResponse(await org(env, session.orgId).teamDeletePreview(session, id)),
	)
	.on("DELETE", "/api/teams/:id", async (request, { id }, { env, session }) => {
		const tasks = new URL(request.url).searchParams.get("tasks") ?? "archive";
		if (tasks !== "archive" && tasks !== "move")
			throw new BadRequest("tasks must be archive or move");
		return resultResponse(await org(env, session.orgId).deleteTeam(session, id, tasks));
	})
	.on(
		"PUT",
		"/api/teams/:id/members/:memberId",
		async (_request, { id, memberId }, { env, session }) =>
			resultResponse(await org(env, session.orgId).addTeamMember(session, id, memberId)),
	)
	.on(
		"GET",
		"/api/teams/:id/members/:memberId/removal-preview",
		async (_request, { id, memberId }, { env, session }) =>
			resultResponse(await org(env, session.orgId).removalPreview(session, id, memberId)),
	)
	.on(
		"DELETE",
		"/api/teams/:id/members/:memberId",
		async (_request, { id, memberId }, { env, session }) =>
			resultResponse(await org(env, session.orgId).removeTeamMember(session, id, memberId)),
	);

function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
	if (body[name] === undefined) return undefined;
	if (typeof body[name] !== "boolean") throw new BadRequest(`${name} must be true or false`);
	return body[name];
}

async function teamName(request: Request): Promise<string> {
	const name = stringField(await readJson(request), "name").trim();
	check(checkText("Household name", name, LIMITS.teamName));
	return name;
}

async function handle(request: Request, env: Env): Promise<Response> {
	if (!new URL(request.url).pathname.startsWith("/api/")) return notFound();
	const refused = checkSameOrigin(request);
	if (refused) return refused;

	const publicResponse = await publicRoutes.handle(request, { env });
	if (publicResponse) return publicResponse;

	const session = await parseSessionToken(readCookie(request, SESSION_COOKIE) ?? "");
	if (!session) return errorResponse(401, "Not signed in.");
	const response = await sessionRoutes.handle(request, { env, session });
	if (!response) return notFound();
	if (response.status === 401 && !response.webSocket) {
		// The device was signed out or revoked: drop the dead cookie.
		const cleared = new Response(response.body, response);
		cleared.headers.set("Set-Cookie", clearSessionCookie());
		return cleared;
	}
	return response;
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handle(request, env);
		} catch (error) {
			if (error instanceof BadRequest) return errorResponse(400, error.message);
			console.error("Unhandled error", request.method, new URL(request.url).pathname, error);
			return errorResponse(500, "Something went wrong.");
		}
	},
} satisfies ExportedHandler<Env>;
