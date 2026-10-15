// How long the daily purge keeps old rows (requirements 8.3). Two deployment-wide settings:
// PURGE_HISTORY_DAYS for family history, PURGE_SYSTEM_DAYS for internal scheduler and sync rows.
import { DAY_MS } from "../shared/time.ts";

export const DEFAULT_HISTORY_DAYS = 90;
/** The app shows 7 days of history. */
export const MIN_HISTORY_DAYS = 7;
export const DEFAULT_SYSTEM_DAYS = 10;
export const MIN_SYSTEM_DAYS = 1;

/** A setting in days; a missing value gives the default, an invalid or too-small one logs and gives the default. */
export function retentionDays(
	name: string,
	value: unknown,
	defaultDays: number,
	minDays: number,
): number {
	if (value === undefined || value === "") return defaultDays;
	const days = Number(value);
	if (Number.isInteger(days) && days >= minDays) return days;
	console.error(`${name} must be a whole number of at least ${minDays}; using ${defaultDays}.`);
	return defaultDays;
}

export interface RetentionVars {
	PURGE_HISTORY_DAYS?: unknown;
	PURGE_SYSTEM_DAYS?: unknown;
}

export function historyRetentionMs(env: RetentionVars): number {
	return (
		retentionDays(
			"PURGE_HISTORY_DAYS",
			env.PURGE_HISTORY_DAYS,
			DEFAULT_HISTORY_DAYS,
			MIN_HISTORY_DAYS,
		) * DAY_MS
	);
}

export function systemRetentionMs(env: RetentionVars): number {
	return (
		retentionDays(
			"PURGE_SYSTEM_DAYS",
			env.PURGE_SYSTEM_DAYS,
			DEFAULT_SYSTEM_DAYS,
			MIN_SYSTEM_DAYS,
		) * DAY_MS
	);
}
