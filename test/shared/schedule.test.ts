import { describe, expect, it } from "vitest";
import {
	describeSchedule,
	dueTimesBetween,
	nextRepeatDates,
	parseSchedule,
	type Repeat,
	type Schedule,
} from "../../src/shared/schedule.ts";
import { daysBetween, localParts, localToUtc } from "../../src/shared/time.ts";

const schedule = (repeat: Repeat): Schedule => ({
	due: null,
	repeat,
	remindBeforeMinutes: null,
	secondReminderMinutes: 10,
	overdueAfterMinutes: 20,
});

describe("every n days, weeks or months (fixed days)", () => {
	it("counts days across a month end and a leap day", () => {
		const repeat: Repeat = { kind: "daily", times: ["09:00"], every: 2, start: "2028-02-26" };
		expect(nextRepeatDates(repeat, "2028-02-26", 4)).toEqual([
			"2028-02-26",
			"2028-02-28",
			"2028-03-01",
			"2028-03-03",
		]);
	});

	it("starts on the start date, even when asked from earlier", () => {
		const repeat: Repeat = { kind: "daily", times: ["09:00"], every: 3, start: "2026-10-20" };
		expect(nextRepeatDates(repeat, "2026-10-13", 3)).toEqual([
			"2026-10-20",
			"2026-10-23",
			"2026-10-26",
		]);
	});

	it("stays on the same days when the start is in the past", () => {
		// Every other day from Tue 13 Oct: the 15th, 17th, … — not shifted by when you look.
		const repeat: Repeat = { kind: "daily", times: ["09:00"], every: 2, start: "2026-10-13" };
		expect(nextRepeatDates(repeat, "2026-10-16", 3)).toEqual([
			"2026-10-17",
			"2026-10-19",
			"2026-10-21",
		]);
	});

	it("repeats weekly days every n weeks, counting from the week of the start", () => {
		// Start Wed 14 Oct 2026; that week's Thursday counts, its Monday is before the start.
		const repeat: Repeat = {
			kind: "weekly",
			days: ["MON", "THU"],
			times: ["09:00"],
			every: 2,
			start: "2026-10-14",
		};
		expect(nextRepeatDates(repeat, "2026-10-01", 5)).toEqual([
			"2026-10-15",
			"2026-10-26",
			"2026-10-29",
			"2026-11-09",
			"2026-11-12",
		]);
	});

	it("repeats every n months, on the last day of shorter months", () => {
		const repeat: Repeat = {
			kind: "monthly",
			day: 31,
			times: ["09:00"],
			every: 3,
			start: "2026-11-01",
		};
		expect(nextRepeatDates(repeat, "2026-11-01", 4)).toEqual([
			"2026-11-30",
			"2027-02-28",
			"2027-05-31",
			"2027-08-31",
		]);
	});

	it("skips a month whose day is before the start", () => {
		const repeat: Repeat = {
			kind: "monthly",
			day: 5,
			times: ["09:00"],
			every: 2,
			start: "2026-10-13",
		};
		expect(nextRepeatDates(repeat, "2026-10-13", 2)).toEqual(["2026-12-05", "2027-02-05"]);
	});

	it("keeps the local time across daylight-saving changes (NFR-4)", () => {
		const zone = "America/New_York";
		const s = schedule({ kind: "daily", times: ["08:00"], every: 2, start: "2026-03-05" });
		const times = dueTimesBetween(
			s,
			zone,
			localToUtc("2026-03-05", "00:00", zone),
			localToUtc("2026-03-12", "00:00", zone),
		);
		expect(times.map((t) => localParts(t, zone))).toEqual(
			["2026-03-05", "2026-03-07", "2026-03-09", "2026-03-11"].map((date) => ({
				date,
				time: "08:00",
				weekday: expect.any(Number),
			})),
		);
		const autumn = schedule({ kind: "daily", times: ["08:00"], every: 2, start: "2026-10-30" });
		const later = dueTimesBetween(
			autumn,
			zone,
			localToUtc("2026-10-30", "00:00", zone),
			localToUtc("2026-11-04", "00:00", zone),
		);
		expect(later.map((t) => localParts(t, zone).date + " " + localParts(t, zone).time)).toEqual([
			"2026-10-30 08:00",
			"2026-11-01 08:00",
			"2026-11-03 08:00",
		]);
	});

	it("leaves repeats without an interval as before", () => {
		expect(nextRepeatDates({ kind: "daily", times: ["09:00"] }, "2026-10-13", 2)).toEqual([
			"2026-10-13",
			"2026-10-14",
		]);
		expect(nextRepeatDates({ kind: "monthly", day: 5, times: ["09:00"] }, "2026-10-13", 2)).toEqual(
			["2026-11-05", "2026-12-05"],
		);
	});

	it("counts days between dates", () => {
		expect(daysBetween("2026-10-13", "2026-10-15")).toBe(2);
		expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
		expect(daysBetween("2026-10-15", "2026-10-13")).toBe(-2);
	});
});

describe("parseSchedule with an interval", () => {
	const parse = (repeat: Record<string, unknown>) => parseSchedule({ repeat });

	it("keeps every and start when every is 2 or more", () => {
		expect(
			(parse({ kind: "daily", times: ["09:00"], every: 2, start: "2026-10-13" }) as Schedule)
				.repeat,
		).toEqual({
			kind: "daily",
			times: ["09:00"],
			every: 2,
			start: "2026-10-13",
		});
	});

	it("drops them for every 1, so the stored form doesn't change", () => {
		expect(
			(parse({ kind: "daily", times: ["09:00"], every: 1, start: "2026-10-13" }) as Schedule)
				.repeat,
		).toEqual({ kind: "daily", times: ["09:00"] });
	});

	it("rejects bad intervals", () => {
		expect(parse({ kind: "daily", times: ["09:00"], every: 2 })).toMatch(/start date/);
		expect(parse({ kind: "daily", times: ["09:00"], every: 2, start: "2026-02-30" })).toMatch(
			/start date/,
		);
		expect(parse({ kind: "daily", times: ["09:00"], every: 0, start: "2026-10-13" })).toMatch(
			/every/,
		);
		expect(parse({ kind: "daily", times: ["09:00"], every: 1.5, start: "2026-10-13" })).toMatch(
			/every/,
		);
		expect(
			parse({ kind: "weekly", days: ["MON"], times: ["09:00"], every: 53, start: "2026-10-13" }),
		).toMatch(/1 to 52/);
		expect(
			parse({ kind: "monthly", day: 5, times: ["09:00"], every: 25, start: "2026-10-13" }),
		).toMatch(/1 to 24/);
	});
});

describe("describeSchedule with an interval", () => {
	it("says how often and from when", () => {
		expect(
			describeSchedule(
				schedule({ kind: "daily", times: ["09:00"], every: 2, start: "2026-10-13" }),
			),
		).toBe("Every 2 days at 9:00 AM, from Tue 13 Oct 2026");
		expect(
			describeSchedule(
				schedule({
					kind: "weekly",
					days: ["MON"],
					times: ["09:00"],
					every: 2,
					start: "2026-10-13",
				}),
			),
		).toBe("Every 2 weeks on Mon at 9:00 AM, from Tue 13 Oct 2026");
		expect(
			describeSchedule(
				schedule({ kind: "monthly", day: 5, times: ["09:00"], every: 3, start: "2026-10-13" }),
			),
		).toBe("Every 3 months on the 5th at 9:00 AM, from Tue 13 Oct 2026");
	});
});
