import { z } from "zod";
import {
	DEFAULT_CAPTURE_PREFERENCES,
	effectiveSurfaceRoleMap,
} from "../../domain/capturePreferences.js";
import { DOMAINS, DOMAIN_DESCRIPTION } from "../../domain/domains.js";
import type { ConfigRepository } from "../../ports/config.js";
import type {
	DosEvidenceAggregateDay,
	DosEvidenceAggregateRow,
	ExternalLinkRepository,
} from "../../ports/externalLinks.js";
import { defineAction } from "../defineAction.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_EVIDENCE_AGGREGATE_DAYS = 90;

export const dosEvidenceAggregateInput = {
	domain: z.enum(DOMAINS).describe(DOMAIN_DESCRIPTION),
	days: z
		.number()
		.int()
		.min(1)
		.max(MAX_EVIDENCE_AGGREGATE_DAYS)
		.optional()
		.describe(
			`Number of trailing calendar days (1-${MAX_EVIDENCE_AGGREGATE_DAYS}, default 14) in the target timezone when since/until are omitted.`,
		),
	since: z
		.string()
		.regex(DATE_ONLY)
		.optional()
		.describe("First arrival date 'YYYY-MM-DD' (inclusive, in timezone)."),
	until: z
		.string()
		.regex(DATE_ONLY)
		.optional()
		.describe("Last arrival date 'YYYY-MM-DD' (inclusive, in timezone)."),
	timezone: z
		.string()
		.min(1)
		.optional()
		.describe("IANA timezone for arrival/event date bucketing (default 'Europe/London')."),
	top_n: z
		.number()
		.int()
		.min(0)
		.max(50)
		.optional()
		.describe("Maximum evidence preview items per group (default 5)."),
} as const;

export const dosEvidenceAggregateSchema = z.object(dosEvidenceAggregateInput);

export type DosEvidenceAggregateInput = z.infer<typeof dosEvidenceAggregateSchema>;

export type DosEvidenceAggregateOutput = DosEvidenceAggregateRow;

export interface DosEvidenceAggregateDeps {
	externalLinks: ExternalLinkRepository;
	config?: Pick<ConfigRepository, "loadCapturePreferences">;
}

export const DOS_EVIDENCE_AGGREGATE_DESCRIPTION =
	"Aggregate per-day, per-domain evidence and excluded/robot-authored material counts, " +
	"structural evidence items, arrival-vs-event-date notes, and late arrivals after a day's " +
	"closing link. Full notes: docs/guides/tools/dos_evidence_aggregate.md";

function formatDayLine(day: DosEvidenceAggregateDay): string {
	const header =
		`${day.date}: material=${day.material_total} (evidence=${day.evidence_total}, ` +
		`excluded_or_robot=${day.excluded_or_robot_total})` +
		(day.closed_at ? ` [closed_at=${day.closed_at}]` : " [unclosed]") +
		(day.dated_earlier_note ? ` — ${day.dated_earlier_note}` : "");
	const groupLines = day.groups.map(
		(g) =>
			`  - ${g.connection} (${g.surface ?? "?"}/${g.source_channel ?? "?"}/${g.content_subtype ?? "?"}): ` +
			`count=${g.count} (evidence=${g.evidence_count}, excluded_or_robot=${g.excluded_or_robot_count})`,
	);
	return [header, ...groupLines].join("\n");
}

export function formatDosEvidenceAggregateMcp(
	output: DosEvidenceAggregateOutput,
): string {
	const dayText =
		output.days.length > 0
			? output.days.map(formatDayLine).join("\n")
			: "(no material rows in window)";
	const lateText =
		output.late_arrivals.length > 0
			? `\nlate_arrivals (${output.late_arrivals.length}):\n` +
				output.late_arrivals
					.map(
						(l) =>
							`  - ${l.captured_date} ${l.connection} "${l.title ?? "(untitled)"}" (captured=${l.captured_at} > closed=${l.closed_at})`,
					)
					.join("\n")
			: "\nlate_arrivals: (none)";

	return [
		`evidence aggregate domain=${output.domain} window=${output.since} → ${output.until} (${output.timezone}):`,
		"",
		dayText,
		lateText,
		"",
		"```json",
		JSON.stringify(output),
		"```",
	].join("\n");
}

export function createDosEvidenceAggregateAction(
	deps: DosEvidenceAggregateDeps,
) {
	return defineAction({
		id: "dos_evidence_aggregate",
		domain: "ops",
		description: DOS_EVIDENCE_AGGREGATE_DESCRIPTION,
		schema: dosEvidenceAggregateSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args): Promise<DosEvidenceAggregateOutput> => {
			if (args.since && args.until && args.since > args.until) {
				throw new Error(
					`dos_evidence_aggregate: 'until' (${args.until}) must be on or after 'since' (${args.since}).`,
				);
			}
			const prefs = deps.config?.loadCapturePreferences
				? await deps.config.loadCapturePreferences()
				: DEFAULT_CAPTURE_PREFERENCES;

			return deps.externalLinks.getDosEvidenceAggregate({
				domain: args.domain,
				days: args.days,
				since: args.since,
				until: args.until,
				timezone: args.timezone,
				topN: args.top_n,
				surfaceRoleMap: effectiveSurfaceRoleMap(prefs),
				defaultRole: prefs.default_role,
			});
		},
		formatMcp: formatDosEvidenceAggregateMcp,
	});
}
