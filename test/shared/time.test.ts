import { describe, expect, it } from "vitest";
import {
	describeSchedule,
	dueTimesBetween,
	parseSchedule,
	type Schedule,
} from "../../src/shared/schedule.ts";
import { addDays, formatTime, formatWhen, localParts, localToUtc } from "../../src/shared/time.ts";

const iso = (ms: number) => new Date(ms).toISOString();

describe("localToUtc", () => {
	it("converts in a zone without daylight saving", () => {
		expect(iso(localToUtc("2026-10-12", "20:00", "Asia/Kolkata"))).toBe("2026-10-12T14:30:00.000Z");
		expect(localParts(Date.parse("2026-10-12T14:30:00Z"), "Asia/Kolkata")).toEqual({
			date: "2026-10-12",
			time: "20:00",
			weekday: 1,
		});
	});

	it("moves a time skipped by daylight saving forward (NFR-4)", () => {
		// New York springs forward at 02:00 on 8 March 2026: 02:30 doesn't exist.
		expect(iso(localToUtc("2026-03-08", "02:30", "America/New_York"))).toBe(
			"2026-03-08T07:30:00.000Z",
		);
		expect(
			localParts(localToUtc("2026-03-08", "02:30", "America/New_York"), "America/New_York").time,
		).toBe("03:30");
	});

	it("uses the first of a time that happens twice (NFR-4)", () => {
		// New York falls back at 02:00 on 1 November 2026: 01:30 happens twice.
		expect(iso(localToUtc("2026-11-01", "01:30", "America/New_York"))).toBe(
			"2026-11-01T05:30:00.000Z",
		);
	});

	it("handles ordinary times either side of a change", () => {
		expect(iso(localToUtc("2026-03-07", "20:00", "America/New_York"))).toBe(
			"2026-03-08T01:00:00.000Z",
		);
		expect(iso(localToUtc("2026-03-08", "20:00", "America/New_York"))).toBe(
			"2026-03-09T00:00:00.000Z",
		);
		expect(iso(localToUtc("2026-03-29", "09:00", "Europe/London"))).toBe(
			"2026-03-29T08:00:00.000Z",
		);
	});

	it("adds days across month and year ends", () => {
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
	});

	it("formats times in the family's timezone", () => {
		expect(formatTime(Date.parse("2026-10-12T14:30:00Z"), "Asia/Kolkata")).toBe("8:00 PM");
	});
});

const schedule = (value: unknown) => {
	const parsed = parseSchedule(value);
	if (typeof parsed === "string") throw new Error(parsed);
	return parsed;
};

describe("schedules", () => {
	it("fills in follow-up defaults and keeps Never and none (D3, FR-14)", () => {
		expect(schedule({ due: { date: "2026-10-20", time: "09:00" } })).toEqual({
			due: { date: "2026-10-20", time: "09:00" },
			repeat: null,
			remindBeforeMinutes: null,
			secondReminderMinutes: 10,
			overdueAfterMinutes: 20,
		});
		const never = schedule({
			repeat: { kind: "daily", times: ["20:00"] },
			secondReminderMinutes: null,
			overdueAfterMinutes: null,
		});
		expect([never.secondReminderMinutes, never.overdueAfterMinutes]).toEqual([null, null]);
	});

	it("rejects bad input", () => {
		expect(parseSchedule({})).toMatch(/either a due date or a repeat/);
		expect(parseSchedule({ due: { date: "2026-02-30", time: "09:00" } })).toMatch(/due date/);
		expect(parseSchedule({ due: { date: "2026-02-03", time: "9am" } })).toMatch(/due time/);
		expect(
			parseSchedule({ repeat: { kind: "weekly", days: ["MONDAY"], times: ["09:00"] } }),
		).toMatch(/days/);
		expect(parseSchedule({ repeat: { kind: "daily", times: [] } })).toMatch(/times/);
		expect(
			parseSchedule({ repeat: { kind: "daily", times: ["09:00"] }, overdueAfterMinutes: 0 }),
		).toMatch(/overdueAfterMinutes/);
	});

	it("lists daily times in a window", () => {
		const daily = schedule({ repeat: { kind: "daily", times: ["20:00", "08:00"] } });
		const from = Date.parse("2026-10-12T00:00:00Z");
		const times = dueTimesBetween(daily, "Asia/Kolkata", from, from + 2 * 86_400_000).map(iso);
		expect(times).toEqual([
			"2026-10-12T02:30:00.000Z",
			"2026-10-12T14:30:00.000Z",
			"2026-10-13T02:30:00.000Z",
			"2026-10-13T14:30:00.000Z",
		]);
	});

	it("lists weekdays only", () => {
		const weekly = schedule({ repeat: { kind: "weekly", days: ["SAT", "MON"], times: ["09:00"] } });
		const from = Date.parse("2026-10-12T00:00:00Z"); // a Monday
		const dates = dueTimesBetween(weekly, "Asia/Kolkata", from, from + 7 * 86_400_000).map(
			(t) => localParts(t, "Asia/Kolkata").date,
		);
		expect(dates).toEqual(["2026-10-12", "2026-10-17"]);
	});

	it("puts the 31st on the last day of shorter months (FR-24)", () => {
		const monthly = schedule({ repeat: { kind: "monthly", day: 31, times: ["09:00"] } });
		const from = Date.parse("2027-01-01T00:00:00Z");
		const dates = dueTimesBetween(
			monthly,
			"Asia/Kolkata",
			from,
			Date.parse("2027-05-01T00:00:00Z"),
		).map((t) => localParts(t, "Asia/Kolkata").date);
		expect(dates).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
	});

	it("keeps local times across a daylight-saving change", () => {
		const daily = schedule({ repeat: { kind: "daily", times: ["20:00"] } });
		const from = Date.parse("2026-03-07T00:00:00Z");
		const times = dueTimesBetween(daily, "America/New_York", from, from + 3 * 86_400_000);
		expect(times.map((t) => localParts(t, "America/New_York").time)).toEqual([
			"20:00",
			"20:00",
			"20:00",
		]);
		expect(times[2] - times[1]).toBe(23 * 3_600_000);
	});

	it("describes schedules in words", () => {
		expect(
			describeSchedule(schedule({ repeat: { kind: "daily", times: ["08:00", "20:00"] } })),
		).toBe("Daily at 8:00 AM and 8:00 PM");
		expect(
			describeSchedule(
				schedule({ repeat: { kind: "weekly", days: ["THU", "MON"], times: ["09:00"] } }),
			),
		).toBe("Mon, Thu at 9:00 AM");
		expect(
			describeSchedule(schedule({ repeat: { kind: "monthly", day: 5, times: ["09:00"] } })),
		).toBe("Monthly on the 5th at 9:00 AM");
		expect(
			describeSchedule(
				schedule({ due: { date: "2026-10-17", time: "12:30" } } as Partial<Schedule>),
			),
		).toBe("Due Sat 17 Oct 2026, 12:30 PM");
	});
});

describe("scheduled times around daylight-saving changes (NFR-4)", () => {
	const local = (zone: string) => (t: number) => {
		const p = localParts(t, zone);
		return `${p.date} ${p.time}`;
	};
	const between = (s: Schedule, zone: string, from: string, to: string) =>
		dueTimesBetween(s, zone, localToUtc(from, "00:00", zone), localToUtc(to, "00:00", zone));

	it("moves a daily time inside the spring-forward gap to just after it, once", () => {
		const zone = "America/New_York";
		const times = between(
			schedule({ repeat: { kind: "daily", times: ["02:30"] } }),
			zone,
			"2026-03-07",
			"2026-03-10",
		);
		expect(times.map(local(zone))).toEqual([
			"2026-03-07 02:30",
			"2026-03-08 03:30",
			"2026-03-09 02:30",
		]);
		expect(times.map(iso)).toEqual([
			"2026-03-07T07:30:00.000Z",
			"2026-03-08T07:30:00.000Z",
			"2026-03-09T06:30:00.000Z",
		]);
	});

	it("uses a daily time that happens twice on fall-back day only once, the first time", () => {
		const zone = "America/New_York";
		const times = between(
			schedule({ repeat: { kind: "daily", times: ["01:30"] } }),
			zone,
			"2026-10-31",
			"2026-11-03",
		);
		expect(times.map(iso)).toEqual([
			"2026-10-31T05:30:00.000Z",
			"2026-11-01T05:30:00.000Z",
			"2026-11-02T06:30:00.000Z",
		]);
		expect(times.map(local(zone))).toEqual([
			"2026-10-31 01:30",
			"2026-11-01 01:30",
			"2026-11-02 01:30",
		]);
	});

	it("handles London, and the southern hemisphere changing in April and October", () => {
		expect(local("Europe/London")(localToUtc("2026-03-29", "01:30", "Europe/London"))).toBe(
			"2026-03-29 02:30",
		);
		expect(iso(localToUtc("2026-10-25", "01:30", "Europe/London"))).toBe(
			"2026-10-25T00:30:00.000Z",
		);
		// Sydney: clocks go back at 03:00 on 5 April and forward at 02:00 on 4 October 2026.
		expect(iso(localToUtc("2026-04-05", "02:30", "Australia/Sydney"))).toBe(
			"2026-04-04T15:30:00.000Z",
		);
		expect(local("Australia/Sydney")(localToUtc("2026-10-04", "02:30", "Australia/Sydney"))).toBe(
			"2026-10-04 03:30",
		);
		const sydney = between(
			schedule({ repeat: { kind: "daily", times: ["08:00"] } }),
			"Australia/Sydney",
			"2026-04-04",
			"2026-04-07",
		);
		expect(sydney.map(local("Australia/Sydney"))).toEqual([
			"2026-04-04 08:00",
			"2026-04-05 08:00",
			"2026-04-06 08:00",
		]);
		expect(sydney[2] - sydney[1]).toBe(24 * 3_600_000);
		expect(sydney[1] - sydney[0]).toBe(25 * 3_600_000);
	});

	it("handles a 30-minute change (Lord Howe Island)", () => {
		const zone = "Australia/Lord_Howe";
		// Forward 02:00 → 02:30 on 4 October 2026; back 02:00 → 01:30 on 5 April 2026.
		expect(local(zone)(localToUtc("2026-10-04", "02:15", zone))).toBe("2026-10-04 02:45");
		expect(local(zone)(localToUtc("2026-10-04", "02:30", zone))).toBe("2026-10-04 02:30");
		expect(iso(localToUtc("2026-04-05", "01:45", zone))).toBe("2026-04-04T14:45:00.000Z");
	});

	it("never drifts in a zone without daylight saving", () => {
		const times = between(
			schedule({ repeat: { kind: "daily", times: ["09:00"] } }),
			"Asia/Kolkata",
			"2026-01-01",
			"2027-01-01",
		);
		expect(times).toHaveLength(365);
		expect(times.every((t) => iso(t).endsWith("T03:30:00.000Z"))).toBe(true);
	});

	it("keeps every-2-weeks and monthly repeats on their days through a change", () => {
		const zone = "America/New_York";
		const fortnightly = schedule({
			repeat: { kind: "weekly", days: ["SUN"], times: ["02:30"], every: 2, start: "2026-02-22" },
		});
		expect(between(fortnightly, zone, "2026-02-01", "2026-04-01").map(local(zone))).toEqual([
			"2026-02-22 02:30",
			"2026-03-08 03:30",
			"2026-03-22 02:30",
		]);
		const monthly = schedule({ repeat: { kind: "monthly", day: 8, times: ["02:30"] } });
		expect(between(monthly, zone, "2026-02-01", "2026-05-01").map(local(zone))).toEqual([
			"2026-02-08 02:30",
			"2026-03-08 03:30",
			"2026-04-08 02:30",
		]);
	});

	it("decides 'today' by the family's date, not UTC's", () => {
		// 03:30 on 14 Oct in Kolkata is still 13 Oct in UTC.
		const now = Date.parse("2026-10-13T22:00:00Z");
		expect(formatWhen(Date.parse("2026-10-13T23:30:00Z"), "Asia/Kolkata", now)).toBe("5:00 AM");
		expect(formatWhen(Date.parse("2026-10-13T18:00:00Z"), "Asia/Kolkata", now)).toBe(
			"Tue 13 Oct, 11:30 PM",
		);
		// Auckland is a day ahead: 23:50 on 13 Oct, and ten past midnight is tomorrow.
		const lateEvening = Date.parse("2026-10-13T10:50:00Z");
		expect(formatWhen(Date.parse("2026-10-13T11:10:00Z"), "Pacific/Auckland", lateEvening)).toBe(
			"Wed 14 Oct, 12:10 AM",
		);
	});
});
