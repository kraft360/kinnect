// Join codes (FR-72, FR-75): 6 Crockford base32 characters, shown as "K7M-42Q".

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;

export function newJoinCode(): string {
	// 32 symbols divide 256 evenly, so taking each byte modulo 32 is unbiased.
	return Array.from(
		crypto.getRandomValues(new Uint8Array(CODE_LENGTH)),
		(b) => ALPHABET[b % 32],
	).join("");
}

export function formatJoinCode(code: string): string {
	return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/** Accepts what people type: any case, spaces or dashes, and the usual look-alikes. Returns null if invalid. */
export function normalizeJoinCode(input: string): string | null {
	const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
	return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}
