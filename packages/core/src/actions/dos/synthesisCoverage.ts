import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import {
	isUncoveredDay,
	type ExternalLinkRepository,
	type SynthesisCoverageDay,
	type SynthesisStreak,
} from "../../ports/externalLinks.js";
import { defineAction } from "../defineAction.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Widest window this tool will enumerate in one call. The #561 sweep asks for six days
 * (`[today-7, today-2]`); a quarter is generous headroom for a coverage/adherence read
 * (#493/#495) while keeping the response bounded and the two queries cheap.
 */
export const MAX_COVERAGE_DAYS = 92;

export const dosSynthesisCoverageInput = {
	from: z
		.string()
		.regex(DATE_ONLY)
		.describe(
			"First calendar day of the window, 'YYYY-MM-DD' (UTC). Inclusive. Days are bucketed on the atom's captured_at, so this bounds the days being reported on \u2014 not when their markers were written.",
		),
	to: z
		.string()
		.regex(DATE_ONLY)
		.describe(
			`Last calendar day of the window, 'YYYY-MM-DD' (UTC). Inclusive. Must be >= from, and the window must be at most ${MAX_COVERAGE_DAYS} days.`,
		),
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Whose coverage to report: 'work' (the Work ritual) or 'angus' (the personal one). There is one log PER DOMAIN (ADR-051 §11), so coverage is a per-domain question \u2014 a day closed in 'angus' and never in 'work' is covered for the first and uncovered for the second, and a domain-scoped sweep that asks unscoped will skip a genuinely un-run day (#677). This is the dos ritual's routing axis (ADR-051 §1), not the subject-area 'topic' a day's atoms are about. Omitted, markers from every domain are pooled and a day counts as covered if ANY domain closed it \u2014 the cross-domain audit view, and exactly what every caller got before this argument existed.",
		),
} as const;

export const getSynthesisCoverageInput = dosSynthesisCoverageInput;

export const dosSynthesisCoverageSchema = z.object(dosSynthesisCoverageInput);

export type DosSynthesisCoverageInput = z.infer<typeof dosSynthesisCoverageSchema>;

export interface DosSynthesisCoverageOutput {
	from: string;
	to: string;
	span: number;
	domain?: Domain;
	days: SynthesisCoverageDay[];
	/**
	 * The full-history ritual streak, or `null` when it could not be computed (#2257).
	 * Coverage decides which days the sweep may write; the streak is a motivational
	 * figure that decides nothing. So a failed streak read no longer discards a good
	 * coverage answer: `days` is returned and `streak_error` says why the streak is not.
	 * A failed COVERAGE read still throws, because an empty coverage answer reads as
	 * "every day is uncovered" and the caller would act on it.
	 */
	streak: SynthesisStreak | null;
	streak_error?: string;
}

export const DOS_SYNTHESIS_COVERAGE_DESCRIPTION =
	"Per-day synthesis coverage over a date window: how many 'synthesized' and " +
	"'synthesized_unattended' markers each day has, and what they point at, attributed per kind. Days " +
	"bucket on the atom's captured_at, never on when the marker was written, so a late backfill still " +
	"lands on the day it covers. Full notes: docs/guides/tools/dos_synthesis_coverage.md";

function daysBetween(from: string, to: string): number {
	const ms = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
	return Math.round(ms / 86_400_000) + 1;
}

function line(day: SynthesisCoverageDay): string {
	const counts = `synthesized=${day.synthesized}  synthesized_unattended=${day.synthesized_unattended}  evidence_aggregated=${day.evidence_aggregated}  evidence_aggregated_unattended=${day.evidence_aggregated_unattended}`;
	if (day.no_material) {
		return `${day.date}  ${counts}  → no_material`;
	}
	if (isUncoveredDay(day)) {
		return `${day.date}  ${counts}  → uncovered`;
	}
	const objects: string[] = [];
	if (day.synthesized_external_ids.length) {
		objects.push(`synthesized → ${day.synthesized_external_ids.join(", ")}`);
	}
	if (day.synthesized_unattended_external_ids.length) {
		objects.push(
			`synthesized_unattended → ${day.synthesized_unattended_external_ids.join(", ")}`,
		);
	}
	if (day.evidence_aggregated_external_ids.length) {
		objects.push(`evidence_aggregated → ${day.evidence_aggregated_external_ids.join(", ")}`);
	}
	if (day.evidence_aggregated_unattended_external_ids.length) {
		objects.push(
			`evidence_aggregated_unattended → ${day.evidence_aggregated_unattended_external_ids.join(", ")}`,
		);
	}
	return `${day.date}  ${counts}  ${objects.length ? objects.join("  ") : "(no external_id read back)"}`;
}

export function formatDosSynthesisCoverageMcp(output: DosSynthesisCoverageOutput): string {
	const { from, to, span, domain, days, streak } = output;
	const uncovered = days.filter(isUncoveredDay);
	const noMaterial = days.filter((d) => d.no_material);
	const carryNoneCount = uncovered.length + noMaterial.length;
	const scope = domain
		? `domain: ${domain}`
		: "all domains pooled (no domain given)";

	return [
		`synthesis coverage ${from} → ${to} (${span} day(s)), ${scope}, bucketed on artifacts.captured_at (UTC):`,
		streak
			? `streak: ${streak.formatted}`
			: `streak: UNAVAILABLE (${output.streak_error ?? "unknown error"}). Do not report a streak figure; the coverage below is complete and unaffected.`,
		"",
		days.map(line).join("\n"),
		"",
		`${days.length - carryNoneCount} day(s) carry a synthesis marker; ${carryNoneCount} carry none.`,
		`Of the days with no marker: ${uncovered.length} uncovered (material existed), ${noMaterial.length} no_material (zero atoms captured).`,
		domain
			? `Counts are for domain '${domain}' ALONE \u2014 a day another domain closed still reads as uncovered here, which is the point: there is one log per domain (ADR-051 §11).`
			: "Counts POOL every domain \u2014 a day reads as covered if any domain closed it. Pass `domain` for the per-domain answer a domain-scoped ritual needs (#677).",
		"A day with zero atoms captured is no_material \u2014 it pauses the streak rather than breaking it (ADR-052 §8, #664).",
		"A day with captured atoms but no closing marker (synthesized, synthesized_unattended, evidence_aggregated, or evidence_aggregated_unattended) is uncovered \u2014 a candidate for the #561 sweep, not evidence that nothing happened.",
		"A day can carry kinds from both families at once, which is why these are counts per kind and never one state \u2014 and why the page ids are listed per kind too.",
		"An unattended Daily Log is promoted by writing `consumed_by_state` on the twin (ADR-109 §2, ADR-110 §3) rather than inserting a second `synthesized` marker; `dos_daily_log_queue` is the authoritative queue for unpromoted logs.",
		"",
		"```json",
		JSON.stringify(days),
		"```",
	].join("\n");
}

export function createDosSynthesisCoverageAction(repo: ExternalLinkRepository) {
	return defineAction({
		id: "dos_synthesis_coverage",
		domain: "ops",
		description: DOS_SYNTHESIS_COVERAGE_DESCRIPTION,
		schema: dosSynthesisCoverageSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<DosSynthesisCoverageOutput> => {
			const span = daysBetween(args.from, args.to);
			if (span < 1) {
				throw new Error(
					`dos_synthesis_coverage: 'to' (${args.to}) must be on or after 'from' (${args.from}).`,
				);
			}
			if (span > MAX_COVERAGE_DAYS) {
				throw new Error(
					`dos_synthesis_coverage: window is ${span} days; the maximum is ${MAX_COVERAGE_DAYS}. Narrow the range.`,
				);
			}

			const days = await repo.getSynthesisCoverage(args.from, args.to, args.domain);
			let streak: SynthesisStreak | null = null;
			let streakError: string | undefined;
			try {
				streak = await repo.getStreak(args.domain);
			} catch (error) {
				streakError = error instanceof Error ? error.message : String(error);
				console.error(
					`[dos_synthesis_coverage] streak unavailable, returning coverage without it: ${streakError}`,
				);
			}

			return {
				from: args.from,
				to: args.to,
				span,
				...(args.domain !== undefined ? { domain: args.domain } : {}),
				days,
				streak,
				...(streakError !== undefined ? { streak_error: streakError } : {}),
			};
		},
		formatMcp: formatDosSynthesisCoverageMcp,
	});
}
