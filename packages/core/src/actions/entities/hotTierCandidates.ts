import { z } from "zod";
import { MACHINE_INGEST_SURFACES } from "../../domain/capturePreferences.js";
import type { EntityRepository, HotTierCandidateRow } from "../../ports/entities.js";
import { defineAction } from "../defineAction.js";
import { ENTITY_TYPES } from "../domain/entities.js";

const MS_PER_DAY = 86_400_000;

export const DEFAULT_HOT_TIER_DAYS = 30;
export const DEFAULT_HOT_TIER_MIN_MENTIONS = 3;
export const DEFAULT_HOT_TIER_MAX_SUGGESTIONS = 5;
export const DEFAULT_HOT_TIER_TARGET = 12;
export const DEFAULT_HOT_TIER_DECLINE_QUIET_DAYS = 90;

const EXCLUDED_DEFAULT_ENTITY_TYPES = new Set<string>([
	"event",
	"signal",
	"decision",
	"arrangement",
	"domain",
]);

export const DEFAULT_HOT_TIER_ENTITY_TYPES = ENTITY_TYPES.filter(
	(t) => !EXCLUDED_DEFAULT_ENTITY_TYPES.has(t),
);

export const hotTierCandidatesInput = {
	days: z
		.number()
		.int()
		.min(1)
		.max(365)
		.optional()
		.describe(`Trailing window in days (1-365, default ${DEFAULT_HOT_TIER_DAYS}).`),
	min_mentions: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(`Minimum distinct owner-authored artifact mentions (default ${DEFAULT_HOT_TIER_MIN_MENTIONS}).`),
	max_suggestions: z
		.number()
		.int()
		.min(0)
		.max(20)
		.optional()
		.describe(`Maximum candidates to return (0-20, default ${DEFAULT_HOT_TIER_MAX_SUGGESTIONS}).`),
	target: z
		.number()
		.int()
		.min(1)
		.max(90)
		.optional()
		.describe(`Target hot-tier size (1-90, default ${DEFAULT_HOT_TIER_TARGET}).`),
	decline_quiet_days: z
		.number()
		.int()
		.min(0)
		.max(365)
		.optional()
		.describe(
			`Days to suppress entities with properties.hot_declined_at (0-365, default ${DEFAULT_HOT_TIER_DECLINE_QUIET_DAYS}).`,
		),
	entity_types: z
		.array(z.enum(ENTITY_TYPES))
		.min(1)
		.optional()
		.describe(
			"Entity types to consider (defaults to all types except event, signal, decision, arrangement, domain).",
		),
} as const;

export const hotTierCandidatesSchema = z.object(hotTierCandidatesInput);

export type HotTierCandidatesInput = z.infer<typeof hotTierCandidatesSchema>;

export interface HotTierCandidatesOutput {
	hot_count: number;
	target: number;
	slots: number;
	candidates: HotTierCandidateRow[];
}

export interface HotTierCandidatesDeps {
	entities: Pick<EntityRepository, "getHotTierCandidates">;
	now?: () => Date;
}

export const HOT_TIER_CANDIDATES_DESCRIPTION =
	"Return non-hot entities most mentioned in the owner's own captures over a trailing window, " +
	"ranked to fill the hot tier up to its target size. Read-only. " +
	"Full notes: docs/guides/tools/hot_tier_candidates.md";

export function formatHotTierCandidatesMcp(output: HotTierCandidatesOutput): string {
	const header = `hot tier: ${output.hot_count} of ${output.target} rows, ${output.slots} suggestion slots`;
	if (output.slots === 0) {
		return `${header}\nHot tier is at its target (${output.hot_count}/${output.target}); no suggestions.`;
	}
	if (output.candidates.length === 0) {
		return `${header}\nNo eligible candidates met the minimum mention threshold.`;
	}
	const lines = output.candidates.map((c) => {
		const date = c.last_mention_at ? c.last_mention_at.slice(0, 10) : "unknown";
		const aliases = c.aliases.length > 0 ? ` [aliases: ${c.aliases.join(", ")}]` : "";
		return `- ${c.title}${aliases} (${c.entity_type}) — ${c.mentions} mentions, last ${date} [${c.id}]`;
	});
	return [header, ...lines].join("\n");
}

export function createHotTierCandidatesAction(deps: HotTierCandidatesDeps) {
	return defineAction({
		id: "hot_tier_candidates",
		domain: "kg",
		description: HOT_TIER_CANDIDATES_DESCRIPTION,
		schema: hotTierCandidatesSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args, ctx): Promise<HotTierCandidatesOutput> => {
			if (!deps.entities.getHotTierCandidates) {
				throw new Error("hot_tier_candidates requires EntityRepository.getHotTierCandidates.");
			}
			const now = (deps.now ?? (() => new Date()))();
			const days = args.days ?? DEFAULT_HOT_TIER_DAYS;
			const minMentions = args.min_mentions ?? DEFAULT_HOT_TIER_MIN_MENTIONS;
			const maxSuggestions = args.max_suggestions ?? DEFAULT_HOT_TIER_MAX_SUGGESTIONS;
			const target = args.target ?? DEFAULT_HOT_TIER_TARGET;
			const declineQuietDays = args.decline_quiet_days ?? DEFAULT_HOT_TIER_DECLINE_QUIET_DAYS;
			const entityTypes = args.entity_types ?? [...DEFAULT_HOT_TIER_ENTITY_TYPES];

			const windowStart = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
			const quietStart = new Date(now.getTime() - declineQuietDays * MS_PER_DAY).toISOString();

			const res = await deps.entities.getHotTierCandidates(
				{
					windowStart,
					minMentions,
					limit: maxSuggestions,
					quietStart,
					excludedSurfaces: [...MACHINE_INGEST_SURFACES],
					entityTypes,
				},
				ctx?.userId,
			);

			const slots = Math.max(0, Math.min(maxSuggestions, target - res.hot_count));
			const candidates = res.candidates.slice(0, slots);
			return {
				hot_count: res.hot_count,
				target,
				slots,
				candidates,
			};
		},
		formatMcp: formatHotTierCandidatesMcp,
	});
}
