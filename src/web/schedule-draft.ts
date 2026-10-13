// Editor state for a task's schedule, and conversion to and from the Schedule sent to the server.
import { SCHEDULE_DEFAULTS, WEEKDAYS, type Schedule, type Weekday } from "../shared/schedule.ts";
import { localParts } from "../shared/time.ts";

export interface ScheduleDraft {
	mode: "none" | "once" | "repeat";
	date: string;
	time: string;
	repeatKind: "daily" | "weekly" | "monthly";
	/** Every n days, weeks or months; 1 is plain daily, weekly or monthly. */
	every: number;
	/** Where an every-n cycle is counted from (FR-24): its first day. */
	start: string;
	days: Weekday[];
	monthDay: number;
	times: string[];
	remindBefore: number | null;
	second: number | null;
	overdue: number | null;
}

/** A blank draft: today's date and the family's default time (FR-24). */
export function emptyDraft(defaultTime: string, timeZone: string): ScheduleDraft {
	const today = localParts(Date.now(), timeZone);
	return {
		mode: "none",
		date: today.date,
		time: defaultTime,
		repeatKind: "daily",
		every: 1,
		start: today.date,
		days: [WEEKDAYS[today.weekday]],
		monthDay: Number(today.date.slice(8)),
		times: [defaultTime],
		remindBefore: null,
		second: SCHEDULE_DEFAULTS.secondReminderMinutes,
		overdue: SCHEDULE_DEFAULTS.overdueAfterMinutes,
	};
}

export function draftFrom(
	schedule: Schedule | null,
	defaultTime: string,
	timeZone: string,
): ScheduleDraft {
	const draft = emptyDraft(defaultTime, timeZone);
	if (!schedule) return draft;
	draft.remindBefore = schedule.remindBeforeMinutes;
	draft.second = schedule.secondReminderMinutes;
	draft.overdue = schedule.overdueAfterMinutes;
	if (schedule.due)
		return { ...draft, mode: "once", date: schedule.due.date, time: schedule.due.time };
	const repeat = schedule.repeat!;
	draft.mode = "repeat";
	draft.repeatKind = repeat.kind;
	draft.times = [...repeat.times];
	// Editing keeps the original start, so the cycle stays on the same days.
	draft.every = repeat.every ?? 1;
	if (repeat.start) draft.start = repeat.start;
	if (repeat.kind === "weekly") draft.days = [...repeat.days];
	if (repeat.kind === "monthly") draft.monthDay = repeat.day;
	return draft;
}

/** The schedule to send; null when the task has none. Validate it with parseSchedule. */
export function toSchedule(draft: ScheduleDraft): Schedule | null {
	if (draft.mode === "none") return null;
	const followUp = {
		remindBeforeMinutes: draft.remindBefore,
		secondReminderMinutes: draft.second,
		overdueAfterMinutes: draft.overdue,
	};
	if (draft.mode === "once")
		return { due: { date: draft.date, time: draft.time }, repeat: null, ...followUp };
	const times = [...new Set(draft.times.filter(Boolean))].sort();
	const interval = draft.every > 1 ? { every: draft.every, start: draft.start } : {};
	const base =
		draft.repeatKind === "daily"
			? { kind: "daily" as const, times }
			: draft.repeatKind === "weekly"
				? { kind: "weekly" as const, days: WEEKDAYS.filter((d) => draft.days.includes(d)), times }
				: { kind: "monthly" as const, day: draft.monthDay, times };
	return { due: null, repeat: { ...base, ...interval }, ...followUp };
}
