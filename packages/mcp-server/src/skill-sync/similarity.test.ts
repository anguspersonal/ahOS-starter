import { describe, expect, it } from "vitest";
import { bodySimilarity, suggestMappings } from "./similarity.js";

describe("bodySimilarity", () => {
	it("is 1 for identical bodies", () => {
		expect(bodySimilarity("the quick brown fox jumps", "the quick brown fox jumps")).toBe(1);
	});

	it("is 0 for fully disjoint bodies", () => {
		expect(bodySimilarity("alpha bravo charlie", "delta echo foxtrot")).toBe(0);
	});

	it("scores partial overlap strictly between 0 and 1", () => {
		const s = bodySimilarity("shared tokens here plus extra", "shared tokens here minus other");
		expect(s).toBeGreaterThan(0);
		expect(s).toBeLessThan(1);
	});

	it("ignores fenced code blocks (boilerplate skew)", () => {
		const a = "interview relentlessly about the plan\n```\nlots unique code xyz zzz\n```\n";
		const b = "interview relentlessly about the plan\n";
		expect(bodySimilarity(a, b)).toBe(1);
	});
});

describe("suggestMappings", () => {
	const upstream = [
		{ name: "to-tickets", body: "break a plan into tracer bullet vertical slices tickets" },
		{ name: "wayfinder", body: "chart foggy destination map decision frontier" },
	];
	const local = [
		{ name: "to-issues", body: "break a plan into tracer bullet vertical slices issues" },
		{ name: "qa-review", body: "review pull request against rubric standards bar" },
	];

	it("maps a drifted fork to its best local match despite the rename", () => {
		const [tickets] = suggestMappings(upstream, local);
		expect(tickets.local).toBe("to-issues");
		expect(tickets.score).toBeGreaterThan(0.2);
		expect(tickets.runnerUp?.local).toBe("qa-review");
	});

	it("suggests null (a new import) when nothing clears the threshold", () => {
		const [, wayfinder] = suggestMappings(upstream, local);
		expect(wayfinder.local).toBeNull();
	});

	it("maps a same-named local fork by name even when its body has drifted below threshold", () => {
		// The #380 gap: upstream `grill-me` is a terse one-liner while the local `grill-me`
		// is a long, heavily-rewritten fork. Body overlap sinks below threshold, but a
		// same-named local IS the fork — so it must map, not suggest a spurious re-import.
		const shortUpstream = [{ name: "grill-me", body: "interview the user about their plan" }];
		const longLocal = [
			{
				name: "grill-me",
				body: "completely rewritten fork sharing zero common vocabulary, padded out with many additional unique descriptive words for length",
			},
			{ name: "qa-review", body: "review pull request against rubric standards bar" },
		];
		const [s] = suggestMappings(shortUpstream, longLocal);
		expect(s.local).toBe("grill-me");
		expect(s.matchedBy).toBe("name");
		// The reported score stays the honest (low) body similarity — the match is by name.
		expect(s.score).toBeLessThan(0.2);
	});

	it("prefers an exact name match over a different-named local with higher body similarity", () => {
		const upSkills = [{ name: "grill-me", body: "interview the user relentlessly about their plan" }];
		const localForks = [
			{ name: "grill-me", body: "an unrelated rewrite with hardly any shared words at all" },
			{ name: "grill-me-pro", body: "interview the user relentlessly about their plan and then some" },
		];
		const [s] = suggestMappings(upSkills, localForks);
		expect(s.local).toBe("grill-me");
		expect(s.matchedBy).toBe("name");
		expect(s.runnerUp?.local).toBe("grill-me-pro");
	});

	it("matches names case-insensitively", () => {
		const [s] = suggestMappings(
			[{ name: "Grill-Me", body: "short upstream body" }],
			[{ name: "grill-me", body: "a long diverged local fork with entirely different words" }],
		);
		expect(s.local).toBe("grill-me");
		expect(s.matchedBy).toBe("name");
	});

	it("still reports body-similarity matches as matchedBy 'body'", () => {
		const [tickets] = suggestMappings(upstream, local);
		expect(tickets.local).toBe("to-issues");
		expect(tickets.matchedBy).toBe("body");
	});
});
