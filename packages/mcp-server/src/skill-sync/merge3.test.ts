import { describe, expect, it } from "vitest";
import { merge3 } from "./merge3.js";

describe("merge3", () => {
	it("takes a non-overlapping upstream change cleanly", () => {
		const r = merge3("a\nb\nc\n", "a\nb\nc\n", "a\nB\nc\n");
		expect(r.clean).toBe(true);
		expect(r.merged).toBe("a\nB\nc\n");
	});

	it("keeps a local-only change while folding in an upstream-only change", () => {
		const r = merge3("a\nb\nc\n", "a\nb\nc\nLOCAL\n", "A\nb\nc\n");
		expect(r.clean).toBe(true);
		expect(r.merged).toBe("A\nb\nc\nLOCAL\n");
	});

	it("marks a conflict when both sides change the same region", () => {
		const r = merge3("a\nb\nc\n", "a\nLOCAL\nc\n", "a\nUP\nc\n");
		expect(r.clean).toBe(false);
		expect(r.conflicts).toBeGreaterThan(0);
		expect(r.merged).toContain("<<<<<<<");
		expect(r.merged).toContain(">>>>>>>");
	});
});
