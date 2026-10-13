// Family-local dates and times <-> UTC instants, using only Intl (NFR-4).
// Dates are "YYYY-MM-DD" and times "HH:MM" in the family's timezone; instants are UTC ms.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
}

/** The wall-clock fields of an instant in a timezone. */
function wallClock(utc: number, timeZone: string) {
	const parts = Object.fromEntries(
		partsFormatter(timeZone)
			.formatToParts(utc)
			.map((p) => [p.type, p.value]),
	);
	return {
		year: +parts.year,
		month: +parts.month,
		day: +parts.day,
		hour: +parts.hour,
		minute: +parts.minute,
		second: +parts.second,
	};
}

/** Offset of the timezone from UTC at an instant, in ms (e.g. +5:30 for Asia/Kolkata). */
export function zoneOffset(utc: number, timeZone: string): number {
	const w = wallClock(utc, timeZone);
	const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return asUtc - Math.floor(utc / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date, time and weekday (0 = Sunday) of an instant. */
export function localParts(
	utc: number,
	timeZone: string,
): { date: string; time: string; weekday: number } {
	const w = wallClock(utc, timeZone);
	const date = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
	return { date, time: `${pad(w.hour)}:${pad(w.minute)}`, weekday: weekdayOf(date) };
}

/**
 * The instant a local date and time happens. A time skipped by a daylight-saving change
 * moves forward to the first valid time; a time that happens twice uses the first (NFR-4).
 */
export function localToUtc(date: string, time: string, timeZone: string): number {
	const [year, month, day] = date.split("-").map(Number);
	const [hour, minute] = time.split(":").map(Number);
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	const before = wall - zoneOffset(wall - 12 * HOUR_MS, timeZone);
	const after = wall - zoneOffset(wall + 12 * HOUR_MS, timeZone);
	const valid = [before, after]
		.filter((t) => t + zoneOffset(t, timeZone) === wall)
		.sort((a, b) => a - b);
	// No valid candidate means the time was skipped: using the earlier offset lands just after the gap.
	return valid[0] ?? before;
}

export function addDays(date: string, days: number): string {
	const [year, month, day] = date.split("-").map(Number);
	const d = new Date(Date.UTC(year, month - 1, day + days));
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole days from `from` to `to` (negative if `to` is earlier). Dates only, so daylight saving can't affect it. */
export function daysBetween(from: string, to: string): number {
	const utc = (date: string) => {
		const [year, month, day] = date.split("-").map(Number);
		return Date.UTC(year, month - 1, day);
	};
	return Math.round((utc(to) - utc(from)) / DAY_MS);
}

export function weekdayOf(date: string): number {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function daysInMonth(date: string): number {
	const [year, month] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidDate(date: string): boolean {
	return DATE_PATTERN.test(date) && Number(date.slice(8)) <= daysInMonth(date);
}

// Formatting is done by hand: Intl output differs between engines (commas, narrow spaces).
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** "20:00" → "8:00 PM". */
export function formatClock(time: string): string {
	const [h, m] = time.split(":").map(Number);
	return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** "2026-10-17" → "Sat 17 Oct" (or "Sat 17 Oct 2026"). */
export function formatDate(date: string, withYear = false): string {
	const [year, month, day] = date.split("-").map(Number);
	return `${DAY_NAMES[weekdayOf(date)]} ${day} ${MONTH_NAMES[month - 1]}${withYear ? ` ${year}` : ""}`;
}

/** "8:00 PM" in the family's timezone. */
export function formatTime(utc: number, timeZone: string): string {
	return formatClock(localParts(utc, timeZone).time);
}

/** "8:00 PM" if on the same local day as `now`, else "Sat 5 Oct, 9:00 AM". */
export function formatWhen(utc: number, timeZone: string, now: number): string {
	const local = localParts(utc, timeZone);
	if (local.date === localParts(now, timeZone).date) return formatClock(local.time);
	return `${formatDate(local.date)}, ${formatClock(local.time)}`;
}
