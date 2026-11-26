// What "the dos sweep missed a day" means, in one place (#2268, #2270).
//
// Two readers ask it: ahos_doctor's `dos sweep closed` outcome check, when someone
// looks, and the exception-alert evaluator, which emails when nobody is looking. They
// must not disagree about which days count, so both take the window and the rule from
// here.

import { isUncoveredDay, type SynthesisCoverageDay } from "../ports/externalLinks.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The days the sweep has definitely had a run to close: [today-7, today-3].
 *
 * The sweep itself runs over [today-7, today-2], once a day in the afternoon (UTC). So
 * today-2 is only closed by TODAY's run: read before that run, it is uncovered every
 * single morning and says nothing about whether the sweep works. today-3 was already in
 * yesterday's window, so by any hour today it should carry a marker. Ending one day
 * short of the sweep's window is what stops a failure here from crying wolf daily.
 */
export function sweepCheckWindow(now: Date): { from: string; to: string } {
	return {
		from: new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10),
		to: new Date(now.getTime() - 3 * DAY_MS).toISOString().slice(0, 10),
	};
}

/** The fields of a coverage day the "missed" rule and its reporting read. */
export type SweepCoverageDay = Pick<
	SynthesisCoverageDay,
	| "date"
	| "captured_atoms"
	| "no_material"
	| "synthesized"
	| "synthesized_unattended"
	| "evidence_aggregated"
	| "evidence_aggregated_unattended"
>;

/**
 * Days with material and no closing marker of either family. A day with no material is
 * not a miss: there was nothing to close.
 *
 * "Closed" is deliberately NOT restated here. It is `isUncoveredDay`, the one predicate
 * coverage formatting and the streak also use, so a day closed by evidence aggregation
 * (ADR-109 §2) is closed for the doctor and the alert too. The first version of this
 * function counted only the `synthesized` kinds and would have reported such a day as
 * missed.
 */
export function missedSweepDays<T extends SweepCoverageDay>(days: readonly T[]): T[] {
	return days.filter(isUncoveredDay);
}
