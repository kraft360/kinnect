/** Decodes one percent-encoded URL path segment, or returns null if the encoding is malformed (e.g. "%E0"). */
export function decodeSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}
