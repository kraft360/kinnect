// Crockford base32: no I, L, O or U, so ids are easy to read and type.
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** Organization ids appear in links and session tokens: 16 random bytes as 26 base32 characters. */
export const ORG_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;

export function newOrgId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

export function isOrgId(value: string): boolean {
	return ORG_ID_PATTERN.test(value);
}

/** Row ids inside an Organization's database. */
export function newId(): string {
	return crypto.randomUUID();
}
