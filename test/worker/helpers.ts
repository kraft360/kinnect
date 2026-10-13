import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { signOperatorLink, type OperatorLink } from "../../src/worker/auth/operator-link.ts";

export const ORIGIN = "https://kinnect.test";

/** A browser on one device: keeps its session cookie between requests. */
export class Client {
	cookie = "";
	constructor(public ip = "203.0.113.1") {}

	async request(
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<Response> {
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: {
					Origin: ORIGIN,
					"CF-Connecting-IP": this.ip,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
					...(this.cookie ? { Cookie: this.cookie } : {}),
					...headers,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
		const setCookie = response.headers.get("Set-Cookie");
		if (setCookie) {
			const value = setCookie.split(";")[0];
			this.cookie = value.endsWith("=") ? "" : value;
		}
		return response;
	}

	async json<T = any>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<{ status: number; body: T }> {
		const response = await this.request(method, path, body);
		return { status: response.status, body: (await response.json()) as T };
	}
}

export function operatorLink(link: Partial<OperatorLink> = {}): Promise<string> {
	return signOperatorLink(
		{ kind: "create_org", linkId: crypto.randomUUID(), exp: Date.now() + 60_000, ...link },
		env.OPERATOR_SECRET,
	);
}

/** Creates a family and returns the owner's signed-in client. */
export async function createFamily(
	owner = new Client(),
): Promise<{ owner: Client; orgId: string }> {
	const response = await owner.json("POST", "/api/create-org", {
		link: await operatorLink(),
		orgName: "Sharma family",
		timezone: "Asia/Kolkata",
		username: "anil",
		displayName: "Anil",
		deviceName: "Anil's phone",
	});
	if (response.status !== 200)
		throw new Error(`create-org failed: ${JSON.stringify(response.body)}`);
	const me = await owner.json("GET", "/api/me");
	return { owner, orgId: me.body.organization.id };
}

/** Adds a member as the given admin and returns their id. */
export async function addMember(
	admin: Client,
	username: string,
	role: "admin" | "member" = "member",
): Promise<string> {
	const response = await admin.json("POST", "/api/members", {
		username,
		displayName: username,
		role,
	});
	if (response.status !== 201)
		throw new Error(`add member failed: ${JSON.stringify(response.body)}`);
	return response.body.id;
}

/** Issues an invite and returns the token from its link, plus the join code. */
export async function invite(
	admin: Client,
	memberId: string,
	kind = "invite",
): Promise<{ orgId: string; token: string; code: string; url: string }> {
	const response = await admin.json("POST", `/api/members/${memberId}/invites`, { kind });
	if (response.status !== 201) throw new Error(`invite failed: ${JSON.stringify(response.body)}`);
	const [, , orgId, token] = new URL(response.body.url).hash.split("/");
	return { orgId, token, code: response.body.code, url: response.body.url };
}

/** Runs one task operation as the client. */
export function op(client: Client, operation: Record<string, unknown>) {
	return client.json("POST", "/api/ops", { op: operation });
}

export const uuid = () => crypto.randomUUID();

/** An open live-sync connection that collects server messages. */
export interface Live {
	ws: WebSocket;
	/** Waits for the next message (fails after 2 s). */
	next(): Promise<any>;
	/** Resolves when the socket closes, with its close code. */
	closed: Promise<number>;
}

export async function connect(client: Client, headers: Record<string, string> = {}): Promise<Live> {
	const response = await exports.default.fetch(
		new Request(`${ORIGIN}/api/sync`, {
			headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: client.cookie, ...headers },
		}),
	);
	const ws = response.webSocket;
	if (!ws) throw new Error(`no WebSocket: ${response.status}`);
	ws.accept();
	const queue: any[] = [];
	const waiting: ((value: any) => void)[] = [];
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data as string);
		const resolve = waiting.shift();
		if (resolve) resolve(message);
		else queue.push(message);
	});
	const closed = new Promise<number>((resolve) =>
		ws.addEventListener("close", (event) => resolve(event.code)),
	);
	return {
		ws,
		closed,
		next: () =>
			queue.length
				? Promise.resolve(queue.shift())
				: new Promise((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("no message within 2 s")), 2000);
						waiting.push((message) => {
							clearTimeout(timer);
							resolve(message);
						});
					}),
	};
}

/** Connects and completes the hello handshake; returns the connection and the first reply. */
export async function sync(
	client: Client,
	version: number | null = null,
): Promise<{ live: Live; first: any }> {
	const live = await connect(client);
	live.ws.send(JSON.stringify({ type: "hello", version }));
	return { live, first: await live.next() };
}
