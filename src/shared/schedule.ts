// Task schedules: a one-off due point or a repeat, plus follow-up settings (requirements 4.2, FR-11, FR-24).
import {
	addDays,
	daysBetween,
	daysInMonth,
	formatClock,
	formatDate,
	isValidDate,
	localParts,
	localToUtc,
	TIME_PATTERN,
	weekdayOf,
} from "./time.ts";

export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * Every n days, weeks or months on fixed days, counted from `start` (a date in the family's timezone).
 * Both are absent for every 1, so repeats without an interval keep their stored form.
 */
export interface RepeatInterval {
	every?: number;
	start?: string;
}

export type Repeat = RepeatInterval &
	(
		| { kind: "daily"; times: string[] }
		| { kind: "weekly"; days: Weekday[]; times: string[] }
		/** Day 29–31 falls on the last day of shorter months (FR-24). */
		| { kind: "monthly"; day: number; times: string[] }
	);

export interface Schedule {
	/** A one-off due point, in the family's timezone. Exactly one of `due` and `repeat` is set. */
	due: { date: string; time: string } | null;
	repeat: Repeat | null;
	/** Advance reminder lead time; null = none. */
	remindBeforeMinutes: number | null;
	/** Reminder again this long after due if still open; null = none. */
	secondReminderMinutes: number | null;
	/** Marked missed and watchers alerted this long after due; null = Never (FR-14). */
	overdueAfterMinutes: number | null;
}

/** Follow-up defaults (D3). */
export const SCHEDULE_DEFAULTS = { secondReminderMinutes: 10, overdueAfterMinutes: 20 } as const;

export const SCHEDULE_LIMITS = {
	timesPerDay: 6,
	remindBeforeMinutes: 60 * 24 * 30,
	secondReminderMinutes: 60 * 24,
	overdueAfterMinutes: 60 * 24 * 7,
	repeatEvery: { daily: 365, weekly: 52, monthly: 24 },
} as const;

/** Checks an untrusted value and returns a Schedule (missing follow-ups get the defaults), or an error message. */
export function parseSchedule(value: unknown): Schedule | string {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return "schedule must be an object";
	const body = value as Record<string, unknown>;

	const minutes = (
		key: "remindBeforeMinutes" | "secondReminderMinutes" | "overdueAfterMinutes",
		fallback: number | null,
	): number | null | string => {
		const v = body[key];
		if (v === undefined) return fallback;
		if (v === null) return null;
		if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > SCHEDULE_LIMITS[key])
			return `${key} must be between 1 and ${SCHEDULE_LIMITS[key]} minutes`;
		return v;
	};
	const remind = minutes("remindBeforeMinutes", null);
	const second = minutes("secondReminderMinutes", SCHEDULE_DEFAULTS.secondReminderMinutes);
	const overdue = minutes("overdueAfterMinutes", SCHEDULE_DEFAULTS.overdueAfterMinutes);
	for (const v of [remind, second, overdue]) if (typeof v === "string") return v;

	const hasDue = body.due !== undefined && body.due !== null;
	const hasRepeat = body.repeat !== undefined && body.repeat !== null;
	if (hasDue === hasRepeat) return "a schedule needs either a due date or a repeat";

	let due: Schedule["due"] = null;
	let repeat: Repeat | null = null;
	if (hasDue) {
		const d = body.due as Record<string, unknown>;
		if (typeof d !== "object" || typeof d.date !== "string" || !isValidDate(d.date))
			return "due date must be YYYY-MM-DD";
		if (typeof d.time !== "string" || !TIME_PATTERN.test(d.time)) return "due time must be HH:MM";
		due = { date: d.date, time: d.time };
	} else {
		const r = body.repeat as Record<string, unknown>;
		if (typeof r !== "object") return "repeat must be an object";
		const times = r.times;
		if (!Array.isArray(times) || !times.length || times.length > SCHEDULE_LIMITS.timesPerDay) {
			return `repeat needs 1 to ${SCHEDULE_LIMITS.timesPerDay} times`;
		}
		if (!times.every((t) => typeof t === "string" && TIME_PATTERN.test(t)))
			return "repeat times must be HH:MM";
		const sortedTimes = [...new Set(times as string[])].sort();
		if (r.kind === "daily") repeat = { kind: "daily", times: sortedTimes };
		else if (r.kind === "weekly") {
			const days = r.days;
			if (
				!Array.isArray(days) ||
				!days.length ||
				!days.every((d) => (WEEKDAYS as readonly unknown[]).includes(d))
			) {
				return "weekly repeat needs days like MON";
			}
			repeat = {
				kind: "weekly",
				days: WEEKDAYS.filter((d) => days.includes(d)),
				times: sortedTimes,
			};
		} else if (r.kind === "monthly") {
			if (typeof r.day !== "number" || !Number.isInteger(r.day) || r.day < 1 || r.day > 31)
				return "monthly repeat needs a day from 1 to 31";
			repeat = { kind: "monthly", day: r.day, times: sortedTimes };
		} else return "repeat kind must be daily, weekly or monthly";

		const every = r.every ?? 1;
		const maxEvery = SCHEDULE_LIMITS.repeatEvery[repeat.kind];
		if (typeof every !== "number" || !Number.isInteger(every) || every < 1 || every > maxEvery)
			return `repeat every must be from 1 to ${maxEvery}`;
		if (every > 1) {
			if (typeof r.start !== "string" || !isValidDate(r.start))
				return "a repeat every few days, weeks or months needs a start date (YYYY-MM-DD)";
			repeat = { ...repeat, every, start: r.start };
		}
	}
	return {
		due,
		repeat,
		remindBeforeMinutes: remind as number | null,
		secondReminderMinutes: second as number | null,
		overdueAfterMinutes: overdue as number | null,
	};
}

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));

/** Whether the repeat falls on a date: fixed days counted from `start`, however earlier ones were completed. */
function repeatsOn(repeat: Repeat, date: string): boolean {
	const every = repeat.every ?? 1;
	const start = repeat.start;
	if (start && date < start) return false;
	if (repeat.kind === "daily") return !start || daysBetween(start, date) % every === 0;
	if (repeat.kind === "weekly") {
		if (!repeat.days.includes(WEEKDAYS[weekdayOf(date)])) return false;
		// Weeks run Sunday to Saturday; the week containing `start` is week 0.
		return (
			!start ||
			(daysBetween(addDays(start, -weekdayOf(start)), addDays(date, -weekdayOf(date))) / 7) %
				every ===
				0
		);
	}
	if (start && (monthIndex(date) - monthIndex(start)) % every !== 0) return false;
	return Number(date.slice(8)) === Math.min(repeat.day, daysInMonth(date));
}

/** The next `count` dates from `from` (inclusive) on which the repeat falls; looks at most two years ahead. */
export function nextRepeatDates(repeat: Repeat, from: string, count: number): string[] {
	const dates: string[] = [];
	for (let date = from, i = 0; dates.length < count && i < 731; date = addDays(date, 1), i++) {
		if (repeatsOn(repeat, date)) dates.push(date);
	}
	return dates;
}

/** Due instants in [from, to), oldest first. A one-off schedule yields its single due point if it's in range. */
export function dueTimesBetween(
	schedule: Schedule,
	timeZone: string,
	from: number,
	to: number,
): number[] {
	if (schedule.due) {
		const at = localToUtc(schedule.due.date, schedule.due.time, timeZone);
		return at >= from && at < to ? [at] : [];
	}
	const repeat = schedule.repeat!;
	const result: number[] = [];
	const last = addDays(localParts(to, timeZone).date, 1);
	for (
		let date = addDays(localParts(from, timeZone).date, -1);
		date <= last;
		date = addDays(date, 1)
	) {
		if (!repeatsOn(repeat, date)) continue;
		for (const time of repeat.times) {
			const at = localToUtc(date, time, timeZone);
			if (at >= from && at < to) result.push(at);
		}
	}
	return [...new Set(result)].sort((a, b) => a - b);
}

const DAY_NAMES: Record<Weekday, string> = {
	SUN: "Sun",
	MON: "Mon",
	TUE: "Tue",
	WED: "Wed",
	THU: "Thu",
	FRI: "Fri",
	SAT: "Sat",
};

function ordinal(n: number): string {
	const suffix =
		n % 10 === 1 && n !== 11
			? "st"
			: n % 10 === 2 && n !== 12
				? "nd"
				: n % 10 === 3 && n !== 13
					? "rd"
					: "th";
	return `${n}${suffix}`;
}

/** Duration in words: "10 min", "2 hours", "3 days". */
export function formatMinutes(minutes: number): string {
	if (minutes % (60 * 24 * 7) === 0) return plural(minutes / (60 * 24 * 7), "week");
	if (minutes % (60 * 24) === 0) return plural(minutes / (60 * 24), "day");
	if (minutes % 60 === 0) return plural(minutes / 60, "hour");
	return `${minutes} min`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Daily at 8:00 AM and 8:00 PM", "Mon, Thu at 9:00 AM", "Monthly on the 5th at 9:00 AM", "Due Sat 5 Oct 2026, 9:00 AM". */
export function describeSchedule(schedule: Schedule): string {
	if (schedule.due) {
		return `Due ${formatDate(schedule.due.date, true)}, ${formatClock(schedule.due.time)}`;
	}
	const repeat = schedule.repeat!;
	const times = repeat.times.map(formatClock);
	const at = `at ${times.length > 1 ? `${times.slice(0, -1).join(", ")} and ${times.at(-1)}` : times[0]}`;
	const every = repeat.every ?? 1;
	if (every > 1) {
		const from = `, from ${formatDate(repeat.start!, true)}`;
		if (repeat.kind === "daily") return `Every ${every} days ${at}${from}`;
		if (repeat.kind === "weekly")
			return `Every ${every} weeks on ${repeat.days.map((d) => DAY_NAMES[d]).join(", ")} ${at}${from}`;
		return `Every ${every} months on the ${ordinal(repeat.day)} ${at}${from}`;
	}
	if (repeat.kind === "daily") return `Daily ${at}`;
	if (repeat.kind === "weekly")
		return repeat.days.length === 7
			? `Daily ${at}`
			: `${repeat.days.map((d) => DAY_NAMES[d]).join(", ")} ${at}`;
	return `Monthly on the ${ordinal(repeat.day)} ${at}`;
}
