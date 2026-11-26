import { describe, expect, it } from "vitest";
import { isUncoveredDay } from "../ports/externalLinks.js";
import { missedSweepDays, sweepCheckWindow } from "./sweepOutcome.js";

const day = (date: string, atoms: number, s = 0, u = 0, e = 0, eu = 0) => ({
	date,
	captured_atoms: atoms,
	no_material: atoms === 0 && s + u + e + eu === 0,
	synthesized: s,
	synthesized_unattended: u,
	evidence_aggregated: e,
	evidence_aggregated_unattended: eu,
});

describe("sweepCheckWindow (#2268)", () => {
	it("is [today-7, today-3], one day short of the sweep's own window", () => {
		expect(sweepCheckWindow(new Date("2026-11-20T14:00:00Z"))).toEqual({
			from: "2026-11-13",
			to: "2026-11-17",
		});
	});

	it("does not move with the hour of the day", () => {
		expect(sweepCheckWindow(new Date("2026-11-20T00:05:00Z"))).toEqual(
			sweepCheckWindow(new Date("2026-11-20T23:55:00Z")),
		);
	});

	it("crosses a month boundary", () => {
		expect(sweepCheckWindow(new Date("2026-12-02T10:00:00Z"))).toEqual({
			from: "2026-11-25",
			to: "2026-11-29",
		});
	});
});

describe("missedSweepDays (#2268)", () => {
	it("keeps only days with material and no marker of either kind", () => {
		const missed = missedSweepDays([
			day("2026-11-13", 3),
			day("2026-11-14", 0),
			day("2026-11-15", 2, 1, 0),
			day("2026-11-16", 5, 0, 1),
			day("2026-11-17", 1),
		]);

		expect(missed.map((d) => d.date)).toEqual(["2026-11-13", "2026-11-17"]);
	});

	// ADR-109 §2 / #2276: evidence aggregation closes a day just as synthesis does. The
	// doctor and the alert must not call such a day missed.
	it("does not count a day closed by evidence aggregation, attended or unattended", () => {
		const missed = missedSweepDays([
			day("2026-11-13", 3, 0, 0, 1, 0),
			day("2026-11-14", 3, 0, 0, 0, 1),
			day("2026-11-15", 3),
		]);

		expect(missed.map((d) => d.date)).toEqual(["2026-11-15"]);
	});

	it("agrees with isUncoveredDay on every day, so there is one rule", () => {
		const days = [
			day("2026-11-13", 3),
			day("2026-11-14", 0),
			day("2026-11-15", 2, 1),
			day("2026-11-16", 2, 0, 1),
			day("2026-11-17", 2, 0, 0, 1),
			day("2026-11-18", 2, 0, 0, 0, 1),
		];

		expect(missedSweepDays(days)).toEqual(days.filter(isUncoveredDay));
	});

	it("returns nothing for an empty window", () => {
		expect(missedSweepDays([])).toEqual([]);
	});
});
