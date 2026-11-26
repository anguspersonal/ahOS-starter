import { describe, expect, it } from "vitest";
import { classify, isAutoApplicable } from "./reconcile.js";

describe("classify — 3-way merge base", () => {
	it("in-sync when all three match", () => {
		expect(classify({ local: "a", ahkms: "a", base: "a" })).toBe("in-sync");
	});

	it("local-moved when only local changed since base", () => {
		expect(classify({ local: "b", ahkms: "a", base: "a" })).toBe("local-moved");
	});

	it("ahkms-moved when only ahkms changed since base", () => {
		expect(classify({ local: "a", ahkms: "b", base: "a" })).toBe("ahkms-moved");
	});

	it("conflict when both changed to different content", () => {
		expect(classify({ local: "b", ahkms: "c", base: "a" })).toBe("conflict");
	});

	it("converged when both changed to the same content", () => {
		expect(classify({ local: "b", ahkms: "b", base: "a" })).toBe("converged");
	});
});

describe("classify — edge states", () => {
	it("ahkms-missing when there is no ahkms body", () => {
		expect(classify({ local: "a", ahkms: null, base: "a" })).toBe("ahkms-missing");
		expect(classify({ local: "a", ahkms: null, base: null })).toBe("ahkms-missing");
	});

	it("in-sync when base-less but the two sides already match", () => {
		expect(classify({ local: "a", ahkms: "a", base: null })).toBe("in-sync");
	});

	it("no-base when base-less and the two sides differ", () => {
		expect(classify({ local: "a", ahkms: "b", base: null })).toBe("no-base");
	});
});

describe("isAutoApplicable", () => {
	it("auto-applies the unambiguous rows only", () => {
		expect(isAutoApplicable("local-moved")).toBe(true);
		expect(isAutoApplicable("ahkms-moved")).toBe(true);
		expect(isAutoApplicable("converged")).toBe(true);
	});

	it("never auto-applies conflict / no-base / in-sync / missing", () => {
		for (const s of ["conflict", "no-base", "in-sync", "ahkms-missing"] as const) {
			expect(isAutoApplicable(s)).toBe(false);
		}
	});
});
