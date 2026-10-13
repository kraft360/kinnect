import { describe, expect, it } from "vitest";
import { dueIn, family, MIN } from "./family.ts";
import { addMember, Client, createFamily, invite, op, sync, uuid } from "./helpers.ts";

/** The member as other devices see it. */
async function memberState(viewer: Client, memberId: string) {
	const { live, first } = await sync(viewer);
	live.ws.close();
	return first.members.find((m: { id: string }) => m.id === memberId);
}

describe("notification health (FR-42)", () => {
	it("is off without a push subscription and ok once subscribed", async () => {
		const { owner } = await createFamily();
		const dadId = await addMember(owner, "dad");
		const dad = new Client();
		await dad.json("POST", "/api/join", {
			...(await invite(owner, dadId)),
			deviceName: "Dad's phone",
		});
		expect(await memberState(owner, dadId)).toMatchObject({
			notifications: "off",
			unconfirmedSince: null,
		});
		await dad.json("PUT", "/api/me/push", {
			subscription: {
				endpoint: "https://fcm.googleapis.com/fcm/send/dad",
				keys: { p256dh: "x", auth: "y" },
			},
		});
		expect(await memberState(owner, dadId)).toMatchObject({ notifications: "ok" });
	});

	it("becomes unconfirmed after a push that isn't shown, and ok again after an ack", async () => {
		const f = await family();
		const due = dueIn(60);
		await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Medicines",
			assigneeId: f.dadId,
			schedule: { due: { date: due.date, time: due.time } },
		});
		const { live } = await sync(f.son);
		const [reminder] = await f.run(due.at);
		// Watchers' devices hear about it live.
		const change = (await live.next()).changes.find(
			(c: { entity: string; id: string }) => c.entity === "member" && c.id === f.dadId,
		);
		expect(change.data).toMatchObject({ notifications: "unconfirmed", unconfirmedSince: due.at });
		live.ws.close();

		const devices = (await f.dad.json("GET", `/api/members/${f.dadId}/devices`)).body;
		expect(devices[0]).toMatchObject({ notifications: "unconfirmed", unconfirmedSince: due.at });

		// A second push doesn't move the start of the gap.
		await f.run(due.at + 10 * MIN);
		expect((await memberState(f.owner, f.dadId)).unconfirmedSince).toBe(due.at);

		await f.dad.json("POST", "/api/alerts/ack", { alertId: reminder.alertId, action: "shown" });
		expect(await memberState(f.owner, f.dadId)).toMatchObject({
			notifications: "ok",
			unconfirmedSince: null,
		});
	});

	it("is off when the push service says the subscription is gone", async () => {
		const f = await family();
		f.gone.add("https://fcm.googleapis.com/fcm/send/dad");
		const due = dueIn(60);
		await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Medicines",
			assigneeId: f.dadId,
			schedule: { due: { date: due.date, time: due.time } },
		});
		await f.run(due.at);
		expect(await memberState(f.owner, f.dadId)).toMatchObject({ notifications: "off" });
	});

	it("is off once the member's only device is signed out", async () => {
		const f = await family();
		const [device] = (await f.owner.json("GET", `/api/members/${f.dadId}/devices`)).body;
		await f.owner.json("DELETE", `/api/devices/${device.id}`);
		expect(await memberState(f.owner, f.dadId)).toMatchObject({ notifications: "off" });
	});

	it("sends a test notification that confirms the device", async () => {
		const f = await family();
		const sent = await (async () => {
			expect((await f.dad.json("POST", "/api/me/test-notification", {})).status).toBe(200);
			return f.run(Date.now());
		})();
		expect(sent.map((p) => [p.endpoint, p.title, p.alertId])).toEqual([
			["https://fcm.googleapis.com/fcm/send/dad", "Kinnect notifications are working", "test"],
		]);
		expect((await memberState(f.owner, f.dadId)).notifications).toBe("unconfirmed");
		expect(
			(await f.dad.json("POST", "/api/alerts/ack", { alertId: "test", action: "shown" })).status,
		).toBe(200);
		expect((await memberState(f.owner, f.dadId)).notifications).toBe("ok");
	});

	it("refuses a test notification without a subscription", async () => {
		const { owner } = await createFamily();
		expect((await owner.json("POST", "/api/me/test-notification", {})).status).toBe(409);
	});
});

describe("simple view (FR-34)", () => {
	it("can be set by the member and by admins, and reaches open devices", async () => {
		const f = await family();
		const { live } = await sync(f.dad);
		expect(
			(await f.owner.json("PATCH", `/api/members/${f.dadId}`, { simpleView: true })).body
				.simpleView,
		).toBe(true);
		const change = (await live.next()).changes.find(
			(c: { entity: string }) => c.entity === "member",
		);
		expect(change.data).toMatchObject({ id: f.dadId, simpleView: true });
		live.ws.close();

		expect((await f.dad.json("PATCH", "/api/me", { simpleView: false })).body.simpleView).toBe(
			false,
		);
		expect(
			(await f.dad.json("PATCH", `/api/members/${f.sonId}`, { simpleView: true })).status,
		).toBe(403);
		expect((await f.dad.json("PATCH", "/api/me", { simpleView: "yes" })).status).toBe(400);
	});
});
