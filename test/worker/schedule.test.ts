import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { daysBetween, localParts, localToUtc } from "../../src/shared/time.ts";
import { materializeTask } from "../../src/worker/org/schedule.ts";
import type { TaskRow } from "../../src/worker/org/tasks.ts";
import { dueIn, family, MIN, taskState } from "./family.ts";
import { Client, op, sync, uuid } from "./helpers.ts";

describe("one-off tasks", () => {
	it("reminds, follows up, alerts watchers and reports a late completion (FR-12–14, FR-22)", async () => {
		const f = await family();
		const due = dueIn(60);
		const id = uuid();
		const created = await op(f.owner, {
			type: "task.create",
			id,
			title: "Evening medicines",
			assigneeId: f.dadId,
			watcherIds: [f.sonId],
			schedule: { due: { date: due.date, time: due.time }, remindBeforeMinutes: 30 },
		});
		expect(created.status).toBe(200);
		const [occurrence] = created.body.task.occurrences;
		expect(created.body.task.schedule).toMatchObject({
			secondReminderMinutes: 10,
			overdueAfterMinutes: 20,
			remindBeforeMinutes: 30,
		});
		expect(occurrence).toMatchObject({ dueAt: due.at, status: "open" });

		const advance = await f.run(due.at - 30 * MIN);
		expect(f.who(advance)).toEqual(["dad"]);
		expect(advance[0].title).toMatch(/^Evening medicines is due \d+:\d\d (AM|PM)$/);
		expect(advance[0].canComplete).toBe(true);

		expect((await f.run(due.at)).map((p) => [p.endpoint, p.title])).toEqual([
			["https://fcm.googleapis.com/fcm/send/dad", "Evening medicines — due now"],
		]);
		expect((await f.run(due.at + 10 * MIN)).map((p) => p.title)).toEqual([
			"Reminder: Evening medicines is still open",
		]);

		const missed = await f.run(due.at + 20 * MIN);
		expect(f.who(missed)).toEqual(["son"]);
		expect(missed[0].title).toMatch(
			/^dad hasn't completed Evening medicines \(due \d+:\d\d (AM|PM)\)$/,
		);
		expect(missed[0].canComplete).toBe(false);
		expect((await taskState(f.son, id)).occurrences[0]).toMatchObject({
			status: "missed",
			missedAlertSent: true,
		});

		// Running the same time again sends nothing more (7.3).
		expect(await f.run(due.at + 20 * MIN)).toEqual([]);

		// The test's clock is ahead of the server's, so this counts as on time; the alerted watcher still hears (FR-22).
		const done = await op(f.dad, { type: "occurrence.done", id: occurrence.id });
		expect(done.body.task.occurrences[0]).toMatchObject({
			status: "done",
			doneBy: f.dadId,
			onBehalf: false,
			missedAlertSent: true,
		});
		const notice = await f.run(due.at + 21 * MIN);
		expect(f.who(notice)).toEqual(["son"]);
		expect(notice[0].title).toMatch(/^dad completed Evening medicines \(due /);
	});

	it("marks a completion after the deadline as done late (FR-22)", async () => {
		const f = await family();
		const due = dueIn(-60);
		const created = await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Bill",
			schedule: { due: { date: due.date, time: due.time } },
		});
		// Already past due when created: no reminders are sent for steps in the past.
		expect(await f.run(Date.now())).toEqual([]);
		const done = await op(f.dad, {
			type: "occurrence.done",
			id: created.body.task.occurrences[0].id,
		});
		expect(done.body.task.occurrences[0].status).toBe("done_late");
	});

	it("counts a completion tapped before the deadline as on time (FR-22)", async () => {
		const f = await family();
		const due = dueIn(-30);
		const id = uuid();
		const created = await op(f.owner, {
			type: "task.create",
			id,
			title: "Bill",
			assigneeId: f.dadId,
			schedule: { due: { date: due.date, time: due.time } },
		});
		const occurrenceId = created.body.task.occurrences[0].id;
		const done = await op(f.dad, {
			type: "occurrence.done",
			id: occurrenceId,
			at: due.at + 5 * MIN,
		});
		expect(done.body.task.occurrences[0]).toMatchObject({
			status: "done",
			doneAt: due.at + 5 * MIN,
		});
		// A time in the future is capped at the server's time.
		const later = await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Other",
			schedule: { due: { date: due.date, time: due.time } },
		});
		const capped = await op(f.dad, {
			type: "occurrence.done",
			id: later.body.task.occurrences[0].id,
			at: Date.now() + 3_600_000,
		});
		expect(capped.body.task.occurrences[0].doneAt).toBeLessThanOrEqual(Date.now());
	});

	it("sends reminders for an unassigned household task to everyone in the household (FR-12)", async () => {
		const f = await family();
		const due = dueIn(60);
		await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Water plants",
			teamId: f.home,
			schedule: { due: { date: due.date, time: due.time } },
		});
		expect(f.who(await f.run(due.at))).toEqual(["dad", "son"]);
	});

	it("just marks it missed when nobody watches (FR-14)", async () => {
		const f = await family();
		const due = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Solo",
			assigneeId: f.dadId,
			schedule: { due: { date: due.date, time: due.time } },
		});
		await f.run(due.at + 10 * MIN);
		expect(await f.run(due.at + 20 * MIN)).toEqual([]);
		expect((await taskState(f.owner, id)).occurrences[0].status).toBe("missed");
	});

	it("lets a watcher mark it done on the assignee's behalf with a note (FR-18)", async () => {
		const f = await family();
		const due = dueIn(60);
		const id = uuid();
		const created = await op(f.owner, {
			type: "task.create",
			id,
			title: "Evening medicines",
			assigneeId: f.dadId,
			watcherIds: [f.sonId, f.ownerId],
			schedule: { due: { date: due.date, time: due.time } },
		});
		const done = await op(f.son, {
			type: "occurrence.done",
			id: created.body.task.occurrences[0].id,
			note: "Gave them myself",
		});
		expect(done.body.task.occurrences[0]).toMatchObject({
			status: "done",
			doneBy: f.sonId,
			onBehalf: true,
			note: "Gave them myself",
		});
		const notices = await f.run(Date.now());
		expect(f.who(notices)).toEqual(["dad", "owner"]);
		expect(notices[0].title).toBe("son marked Evening medicines done for dad");
		// Pending reminders were cancelled.
		expect(await f.run(due.at + 30 * MIN)).toEqual([]);
	});

	it("keeps the first Done and allows Undo (FR-54)", async () => {
		const f = await family();
		const due = dueIn(60);
		const created = await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Once",
			schedule: { due: { date: due.date, time: due.time } },
		});
		const occurrenceId = created.body.task.occurrences[0].id;
		await op(f.dad, { type: "occurrence.done", id: occurrenceId });
		const second = await op(f.son, { type: "occurrence.done", id: occurrenceId });
		expect(second.body.task.occurrences[0].doneBy).toBe(f.dadId);
		const undone = await op(f.dad, { type: "occurrence.reopen", id: occurrenceId });
		expect(undone.body.task.occurrences[0]).toMatchObject({ status: "open", doneBy: null });
		// Reminders are back.
		expect(f.who(await f.run(due.at))).toEqual(["dad", "owner", "son"]);
	});
});

describe("repeating tasks", () => {
	it("creates occurrences ahead and keeps ticks per occurrence (FR-17, FR-25)", async () => {
		const f = await family();
		const first = dueIn(60);
		const itemId = uuid();
		const created = await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Evening medicines",
			subtasks: [{ id: itemId, title: "Metformin" }],
			schedule: { repeat: { kind: "daily", times: [first.time] } },
		});
		const occurrences = created.body.task.occurrences;
		expect(occurrences.map((o: { dueAt: number }) => o.dueAt)).toEqual([
			first.at,
			first.at + 86_400_000,
		]);

		const ticked = await op(f.dad, {
			type: "occurrence.tick",
			occurrenceId: occurrences[0].id,
			subtaskId: itemId,
		});
		expect(ticked.body.task.occurrences[0].ticks).toEqual([
			{ subtaskId: itemId, doneAt: expect.any(Number), doneBy: f.dadId },
		]);
		expect(ticked.body.task.occurrences[1].ticks).toEqual([]);
		expect(ticked.body.task.subtasks[0].doneAt).toBeNull();

		expect((await op(f.dad, { type: "subtask.tick", id: itemId })).status).toBe(409);
		expect(
			(await op(f.dad, { type: "task.clearCompleted", id: created.body.task.id })).status,
		).toBe(409);
		expect((await op(f.dad, { type: "task.done", id: created.body.task.id })).status).toBe(409);
	});

	it("extends the window with the recurring materialize job", async () => {
		const f = await family();
		const first = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Daily",
			schedule: { repeat: { kind: "daily", times: [first.time] }, overdueAfterMinutes: null },
		});
		await f.run(Date.now() + 6 * 3_600_000 + MIN);
		await f.run(Date.now() + 30 * 3_600_000);
		const task = await taskState(f.owner, id);
		expect(task.occurrences.length).toBeGreaterThanOrEqual(3);
	});

	it("closes an open occurrence quietly when the next is due, with Overdue after = Never (FR-14)", async () => {
		const f = await family();
		const first = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Walk",
			assigneeId: f.dadId,
			watcherIds: [f.sonId],
			schedule: {
				repeat: { kind: "daily", times: [first.time] },
				overdueAfterMinutes: null,
				secondReminderMinutes: null,
			},
		});
		expect(f.who(await f.run(first.at))).toEqual(["dad"]);
		expect(f.who(await f.run(first.at + 86_400_000))).toEqual(["dad"]);
		const task = await taskState(f.owner, id);
		expect(task.occurrences.map((o: { status: string }) => o.status).slice(0, 2)).toEqual([
			"missed",
			"open",
		]);
		expect(task.occurrences[0].missedAlertSent).toBe(false);
	});

	it("repeats every other day on fixed days, skipping the days in between", async () => {
		const f = await family();
		const first = dueIn(60);
		const id = uuid();
		const repeat = { kind: "daily", times: [first.time], every: 2, start: first.date };
		const created = await op(f.owner, {
			type: "task.create",
			id,
			title: "Vitamin D",
			schedule: { repeat, overdueAfterMinutes: null },
		});
		expect(created.body.task.schedule.repeat).toEqual(repeat);
		expect(created.body.task.occurrences.map((o: { dueAt: number }) => o.dueAt)).toEqual([
			first.at,
		]);

		// Further occurrences come from the materialize job, still only every other day.
		await f.run(Date.now() + 6 * 3_600_000 + MIN);
		await f.run(Date.now() + 30 * 3_600_000);
		const dues = (await taskState(f.owner, id)).occurrences.map((o: { dueAt: number }) => o.dueAt);
		expect(dues).toContain(first.at + 2 * 86_400_000);
		expect(dues).not.toContain(first.at + 86_400_000);
		expect(dues.every((at: number) => ((at - first.at) / 86_400_000) % 2 === 0)).toBe(true);
	});

	it("moves to an every-n schedule from its start date (FR-23)", async () => {
		const f = await family();
		const first = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Medicines",
			schedule: { repeat: { kind: "daily", times: [first.time] } },
		});
		const tomorrow = dueIn(60 + 24 * 60);
		const changed = await op(f.owner, {
			type: "task.setSchedule",
			id,
			schedule: { repeat: { kind: "daily", times: [first.time], every: 3, start: tomorrow.date } },
		});
		expect(
			changed.body.task.occurrences
				.filter((o: { status: string }) => o.status === "open")
				.map((o: { dueAt: number }) => o.dueAt),
		).toEqual([tomorrow.at]);
		expect(
			(
				await op(f.owner, {
					type: "task.setSchedule",
					id,
					schedule: { repeat: { kind: "daily", times: [first.time], every: 3 } },
				})
			).status,
		).toBe(400);
	});

	it("replaces only future occurrences when the schedule changes (FR-23)", async () => {
		const f = await family();
		const past = dueIn(-120);
		const id = uuid();
		const created = await op(f.owner, {
			type: "task.create",
			id,
			title: "Bill",
			schedule: { due: { date: past.date, time: past.time } },
		});
		await op(f.dad, { type: "occurrence.done", id: created.body.task.occurrences[0].id });
		const next = dueIn(180);
		const changed = await op(f.owner, {
			type: "task.setSchedule",
			id,
			schedule: { repeat: { kind: "daily", times: [next.time] } },
		});
		const list = changed.body.task.occurrences;
		expect(list[0]).toMatchObject({ dueAt: past.at, status: "done_late" });
		expect(
			list
				.slice(1)
				.every(
					(o: { status: string; dueAt: number }) => o.status === "open" && o.dueAt > Date.now(),
				),
		).toBe(true);

		const removed = await op(f.owner, { type: "task.setSchedule", id, schedule: null });
		expect(removed.body.task.schedule).toBeNull();
		expect(removed.body.task.occurrences.map((o: { status: string }) => o.status)).toEqual([
			"done_late",
		]);
		expect(await f.run(next.at)).toEqual([]);
	});

	it("cancels reminders when archived and restores them when unarchived (FR-20)", async () => {
		const f = await family();
		const due = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Daily",
			schedule: { repeat: { kind: "daily", times: [due.time] } },
		});
		const archived = await op(f.owner, { type: "task.archive", id });
		expect(archived.body.task.occurrences).toEqual([]);
		expect(await f.run(due.at)).toEqual([]);
		expect((await op(f.owner, { type: "task.setSchedule", id, schedule: null })).status).toBe(409);

		const restored = await op(f.owner, { type: "task.unarchive", id });
		expect(restored.body.task.occurrences.length).toBeGreaterThan(0);
		expect(f.who(await f.run(due.at))).toEqual(["dad", "owner", "son"]);
	});

	it("archives schedules when a household is deleted with its tasks archived (FR-85)", async () => {
		const f = await family();
		const due = dueIn(60);
		await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Home chore",
			teamId: f.home,
			schedule: { repeat: { kind: "daily", times: [due.time] } },
		});
		await f.owner.json("DELETE", `/api/teams/${f.home}?tasks=archive`);
		expect(await f.run(due.at)).toEqual([]);
	});

	it("arms the alarm for the earliest job", async () => {
		const f = await family();
		const due = dueIn(60);
		await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Soon",
			schedule: { due: { date: due.date, time: due.time }, remindBeforeMinutes: 15 },
		});
		const alarm = await runInDurableObject(f.stub, (_instance, state) => state.storage.getAlarm());
		expect(alarm).toBe(due.at - 15 * MIN);
	});
});

describe("family settings", () => {
	it("lets admins change the timezone, which moves future occurrences", async () => {
		const f = await family();
		const due = dueIn(180);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Daily",
			schedule: { repeat: { kind: "daily", times: [due.time] } },
		});
		expect(
			(await f.dad.json("PATCH", "/api/organization", { timezone: "Europe/London" })).status,
		).toBe(403);
		expect(
			(await f.owner.json("PATCH", "/api/organization", { timezone: "Mars/Base" })).status,
		).toBe(400);
		expect(
			(
				await f.owner.json("PATCH", "/api/organization", {
					timezone: "Europe/London",
					defaultDueTime: "08:30",
				})
			).status,
		).toBe(200);
		const me = (await f.owner.json("GET", "/api/me")).body;
		expect(me.organization).toMatchObject({ timezone: "Europe/London", defaultDueTime: "08:30" });
		const task = await taskState(f.owner, id);
		expect(
			task.occurrences.every(
				(o: { dueAt: number }) => localParts(o.dueAt, "Europe/London").time === due.time,
			),
		).toBe(true);
	});
});

describe("daylight saving and timezones (NFR-4)", () => {
	const NY = "America/New_York";
	const HOUR = 60 * MIN;

	/** Runs the window logic every 6 hours from `from` to `to`, as the recurring job does, and lists the task's occurrences. */
	async function materializeThrough(
		f: Awaited<ReturnType<typeof family>>,
		taskId: string,
		from: string,
		to: string,
	) {
		return runInDurableObject(f.stub, (_instance, state) => {
			const sql = state.storage.sql;
			const task = sql.exec<TaskRow>("SELECT * FROM task WHERE id = ?", taskId).one();
			for (
				let now = localToUtc(from, "00:00", NY);
				now < localToUtc(to, "00:00", NY);
				now += 6 * HOUR
			)
				materializeTask(sql, task, NY, now);
			const rows = sql
				.exec<{ id: string; due_at: number }>(
					"SELECT id, due_at FROM occurrence WHERE task_id = ? AND due_at >= ? AND due_at < ? ORDER BY due_at",
					taskId,
					localToUtc(from, "00:00", NY),
					localToUtc(to, "00:00", NY),
				)
				.toArray();
			const jobs = (id: string) =>
				Object.fromEntries(
					sql
						.exec<{ kind: string; fire_at: number }>(
							"SELECT kind, fire_at FROM scheduled_job WHERE occurrence_id = ?",
							id,
						)
						.toArray()
						.map((j) => [j.kind, j.fire_at]),
				);
			return rows.map((r) => ({
				at: r.due_at,
				local: `${localParts(r.due_at, NY).date} ${localParts(r.due_at, NY).time}`,
				jobs: jobs(r.id),
			}));
		});
	}

	async function nyTask(f: Awaited<ReturnType<typeof family>>, time: string) {
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Pills",
			assigneeId: f.dadId,
			schedule: { repeat: { kind: "daily", times: [time] } },
		});
		return id;
	}

	it("creates one occurrence a day through spring forward, the skipped time moved to 03:30", async () => {
		const f = await family();
		const occurrences = await materializeThrough(
			f,
			await nyTask(f, "02:30"),
			"2026-03-06",
			"2026-03-11",
		);
		expect(occurrences.map((o) => o.local)).toEqual([
			"2026-03-06 02:30",
			"2026-03-07 02:30",
			"2026-03-08 03:30",
			"2026-03-09 02:30",
			"2026-03-10 02:30",
		]);
	});

	it("creates one occurrence a day through fall back, with no gap across the 25-hour day", async () => {
		const f = await family();
		const late = await materializeThrough(f, await nyTask(f, "23:30"), "2026-10-30", "2026-11-04");
		expect(late.map((o) => o.local)).toEqual([
			"2026-10-30 23:30",
			"2026-10-31 23:30",
			"2026-11-01 23:30",
			"2026-11-02 23:30",
			"2026-11-03 23:30",
		]);
		const twice = await materializeThrough(f, await nyTask(f, "01:30"), "2026-10-30", "2026-11-04");
		expect(twice.map((o) => o.local)).toEqual([
			"2026-10-30 01:30",
			"2026-10-31 01:30",
			"2026-11-01 01:30",
			"2026-11-02 01:30",
			"2026-11-03 01:30",
		]);
		expect(twice[2].at).toBe(Date.parse("2026-11-01T05:30:00Z"));
	});

	it("keeps the follow-ups 10 and 20 real minutes after a time on a change day", async () => {
		const f = await family();
		const [onChange] = (
			await materializeThrough(f, await nyTask(f, "01:50"), "2026-11-01", "2026-11-02")
		).filter((o) => o.local.startsWith("2026-11-01"));
		// 01:50 (first, EDT) + 10 and 20 minutes: 02:00 is already back to 01:00 EST, so the clock reads 01:00 and 01:10.
		expect(onChange.jobs).toEqual({
			due: onChange.at,
			second: onChange.at + 10 * MIN,
			missed: onChange.at + 20 * MIN,
		});
		expect(localParts(onChange.jobs.second, NY).time).toBe("01:00");
	});

	it("on a timezone change, keeps done occurrences and moves the rest to the new local time", async () => {
		const f = await family();
		const due = dueIn(120);
		const daily = uuid();
		await op(f.owner, {
			type: "task.create",
			id: daily,
			title: "Daily",
			schedule: { repeat: { kind: "daily", times: [due.time] } },
		});
		const every2 = uuid();
		await op(f.owner, {
			type: "task.create",
			id: every2,
			title: "Alternate days",
			schedule: { repeat: { kind: "daily", times: ["09:00"], every: 2, start: due.date } },
		});
		const first = (await taskState(f.owner, daily)).occurrences[0];
		await op(f.owner, { type: "occurrence.done", id: first.id });

		expect((await f.owner.json("PATCH", "/api/organization", { timezone: NY })).status).toBe(200);
		const after = (await taskState(f.owner, daily)).occurrences;
		expect(after.find((o: { id: string }) => o.id === first.id)).toMatchObject({
			dueAt: first.dueAt,
			status: "done",
		});
		const moved = after.filter((o: { id: string }) => o.id !== first.id);
		expect(moved.length).toBeGreaterThan(0);
		expect(moved.every((o: { dueAt: number }) => localParts(o.dueAt, NY).time === due.time)).toBe(
			true,
		);

		const alternate = (await taskState(f.owner, every2)).occurrences;
		expect(alternate.length).toBeGreaterThan(0);
		for (const o of alternate) {
			const { date, time } = localParts(o.dueAt, NY);
			expect(time).toBe("09:00");
			expect(daysBetween(due.date, date) % 2).toBe(0);
		}
	});
});

describe("alerts and acknowledgements", () => {
	async function missedTask(f: Awaited<ReturnType<typeof family>>) {
		const due = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Evening medicines",
			assigneeId: f.dadId,
			watcherIds: [f.sonId],
			schedule: { due: { date: due.date, time: due.time } },
		});
		await f.run(due.at + 10 * MIN);
		const [alert] = await f.run(due.at + 20 * MIN);
		return { due, id, alert };
	}

	it("re-sends an unacknowledged missed alert once, then reports it undelivered (NFR-5)", async () => {
		const f = await family();
		const { due, id } = await missedTask(f);
		const resent = await f.run(due.at + 30 * MIN);
		expect(f.who(resent)).toEqual(["son"]);
		expect(resent[0].title).toMatch(/hasn't completed/);
		expect(await f.run(due.at + 40 * MIN)).toEqual([]);
		expect((await taskState(f.owner, id)).occurrences[0].alertNotDelivered).toBe(true);
	});

	it("doesn't re-send once a device shows the alert (FR-46)", async () => {
		const f = await family();
		const { due, id, alert } = await missedTask(f);
		expect(
			(await f.son.json("POST", "/api/alerts/ack", { alertId: alert.alertId, action: "shown" }))
				.status,
		).toBe(200);
		expect(await f.run(due.at + 30 * MIN)).toEqual([]);
		expect(await f.run(due.at + 40 * MIN)).toEqual([]);
		expect((await taskState(f.owner, id)).occurrences[0].alertNotDelivered).toBe(false);
		const devices = (await f.owner.json("GET", `/api/members/${f.sonId}/devices`)).body;
		expect(devices[0].pushRegistered).toBe(true);
	});

	it("completes the occurrence from the notification's Done button (FR-44)", async () => {
		const f = await family();
		const due = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Evening medicines",
			assigneeId: f.dadId,
			schedule: { due: { date: due.date, time: due.time } },
		});
		const [reminder] = await f.run(due.at);
		expect(reminder.canComplete).toBe(true);
		expect(
			(await f.dad.json("POST", "/api/alerts/ack", { alertId: reminder.alertId, action: "done" }))
				.status,
		).toBe(200);
		expect((await taskState(f.dad, id)).occurrences[0]).toMatchObject({
			status: "done",
			doneBy: f.dadId,
		});
		expect(await f.run(due.at + 10 * MIN)).toEqual([]);
	});

	it("validates acknowledgements", async () => {
		const f = await family();
		expect(
			(await f.son.json("POST", "/api/alerts/ack", { alertId: "nope", action: "shown" })).status,
		).toBe(404);
		expect(
			(await f.son.json("POST", "/api/alerts/ack", { alertId: "nope", action: "explode" })).status,
		).toBe(400);
		expect(
			(await new Client().json("POST", "/api/alerts/ack", { alertId: "nope", action: "shown" }))
				.status,
		).toBe(401);
	});

	it("forgets a subscription the push service says is gone (FR-45)", async () => {
		const f = await family();
		f.gone.add("https://fcm.googleapis.com/fcm/send/dad");
		const due = dueIn(60);
		await op(f.owner, {
			type: "task.create",
			id: uuid(),
			title: "Task",
			assigneeId: f.dadId,
			schedule: { due: { date: due.date, time: due.time } },
		});
		expect(f.who(await f.run(due.at))).toEqual(["dad"]);
		const devices = (await f.dad.json("GET", `/api/members/${f.dadId}/devices`)).body;
		expect(devices[0].pushRegistered).toBe(false);
		expect(await f.run(due.at + 10 * MIN)).toEqual([]);
	});

	it("sends at most 40 pushes per run and comes straight back for the rest (7.3)", async () => {
		const f = await family();
		const now = Date.now() + MIN;
		await runInDurableObject(f.stub, (_instance, state) => {
			const device = state.storage.sql
				.exec<{ id: string }>("SELECT id FROM device WHERE push_subscription IS NOT NULL LIMIT 1")
				.one();
			for (let i = 0; i < 45; i++) {
				state.storage.sql.exec(
					"INSERT INTO push_queue (device_id, payload, ttl, created_at) VALUES (?, ?, 60, ?)",
					device.id,
					JSON.stringify({ title: `#${i}` }),
					now,
				);
			}
		});
		expect(await f.run(now)).toHaveLength(40);
		expect(await runInDurableObject(f.stub, (_instance, state) => state.storage.getAlarm())).toBe(
			now,
		);
		expect(await f.run(now)).toHaveLength(5);
	});
});

describe("live updates from the scheduler", () => {
	it("tells open devices when an occurrence becomes missed", async () => {
		const f = await family();
		const due = dueIn(60);
		const id = uuid();
		await op(f.owner, {
			type: "task.create",
			id,
			title: "Walk",
			schedule: { due: { date: due.date, time: due.time } },
		});
		const { live } = await sync(f.son);
		await f.run(due.at + 20 * MIN);
		const message = await live.next();
		live.ws.close();
		expect(message.type).toBe("changes");
		expect(message.changes.at(-1).data.occurrences[0].status).toBe("missed");
	});
});
