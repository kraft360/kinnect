// A family with push-subscribed phones and a scheduler driven by a fake push service.
import { env, runInDurableObject } from "cloudflare:test";
import { localParts } from "../../src/shared/time.ts";
import type { OrgDO } from "../../src/worker/org/org-do.ts";
import { addMember, Client, createFamily, invite, sync } from "./helpers.ts";

export const TZ = "Asia/Kolkata";
export const MIN = 60_000;

/** A due point `minutes` from now, on a whole minute, as the editor would send it. */
export function dueIn(minutes: number) {
	const at = Math.ceil((Date.now() + minutes * MIN) / MIN) * MIN;
	const { date, time } = localParts(at, TZ);
	return { at, date, time };
}

export interface Sent {
	endpoint: string;
	title: string;
	alertId: string;
	canComplete: boolean;
}

/** A family with Dad and Son (both in Home) and push subscriptions on every phone. */
export async function family() {
	const { owner, orgId } = await createFamily();
	const ownerId = (await owner.json("GET", "/api/me")).body.member.id as string;
	const dadId = await addMember(owner, "dad");
	const sonId = await addMember(owner, "son");
	const dad = new Client();
	await dad.json("POST", "/api/join", {
		...(await invite(owner, dadId)),
		deviceName: "Dad's phone",
	});
	const son = new Client();
	await son.json("POST", "/api/join", {
		...(await invite(owner, sonId)),
		deviceName: "Son's phone",
	});
	for (const [client, name] of [
		[owner, "owner"],
		[dad, "dad"],
		[son, "son"],
	] as const) {
		await client.json("PUT", "/api/me/push", {
			subscription: {
				endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
				keys: { p256dh: "x", auth: "y" },
			},
		});
	}
	const home = (await owner.json("POST", "/api/teams", { name: "Home" })).body.id as string;
	await owner.json("PUT", `/api/teams/${home}/members/${dadId}`);
	await owner.json("PUT", `/api/teams/${home}/members/${sonId}`);

	const stub = env.ORG.get(env.ORG.idFromName(orgId));
	const sent: Sent[] = [];
	const gone = new Set<string>();
	/** Runs the scheduler at a given time with a fake push service; returns what it sent. */
	async function run(at: number): Promise<Sent[]> {
		const before = sent.length;
		await runInDurableObject(stub, async (instance: OrgDO) => {
			instance.pushSender = async (subscription, payload) => {
				const p = payload as Sent;
				sent.push({
					endpoint: subscription.endpoint,
					title: p.title,
					alertId: p.alertId,
					canComplete: p.canComplete,
				});
				return gone.has(subscription.endpoint)
					? { status: 410, gone: true }
					: { status: 201, gone: false };
			};
			await instance.runScheduled(at);
		});
		return sent.slice(before);
	}
	const who = (pushes: Sent[]) => pushes.map((p) => p.endpoint.split("/").pop()).sort();
	return { owner, ownerId, dad, dadId, son, sonId, home, orgId, stub, run, who, gone };
}

export async function taskState(client: Client, id: string) {
	const { live, first } = await sync(client);
	live.ws.close();
	return first.tasks.find((t: { id: string }) => t.id === id);
}
