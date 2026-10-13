import { describe, expect, it } from "vitest";
import { decodeSegment } from "../../src/shared/url.ts";

describe("decodeSegment", () => {
	it("decodes percent-encoded path segments", () => {
		expect(decodeSegment("K7M-42Q")).toBe("K7M-42Q");
		expect(decodeSegment("Grand%20ma")).toBe("Grand ma");
	});

	it("returns null for malformed encoding instead of throwing", () => {
		expect(decodeSegment("%E0")).toBeNull();
		expect(decodeSegment("%")).toBeNull();
		expect(decodeSegment("abc%zz")).toBeNull();
	});
});
