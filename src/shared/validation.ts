// Field rules shared by the Worker (enforced) and the web app (shown early).

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

export const LIMITS = {
	orgName: 60,
	displayName: 50,
	deviceName: 60,
	teamName: 40,
} as const;

/** Returns an error message, or null if the value is acceptable. */
export function checkUsername(value: string): string | null {
	return USERNAME_PATTERN.test(value)
		? null
		: "Username must be 2–32 characters: letters, numbers, dots, dashes or underscores, starting with a letter or number.";
}

export function checkText(label: string, value: string, max: number): string | null {
	const trimmed = value.trim();
	if (!trimmed) return `${label} is required.`;
	if (trimmed.length > max) return `${label} must be at most ${max} characters.`;
	return null;
}

export function checkTimezone(value: string): string | null {
	try {
		new Intl.DateTimeFormat("en", { timeZone: value });
		return null;
	} catch {
		return "Unknown timezone.";
	}
}
