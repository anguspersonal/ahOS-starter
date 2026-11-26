import { z } from "zod";
import { defineAction } from "../../defineAction.js";
import type { ActionDefinition } from "../../types.js";
import {
	DEFAULT_CAPTURE_PREFERENCES,
	SYNTHESIS_ROLES,
	combinedRoleTierFilter,
	hasRoleOverrideTag,
	isRobotAuthoredArtifact,
	resolveSynthesisRole,
	roleTierFilters,
	type CapturePreferences,
	type SynthesisRole,
} from "../../../domain/capturePreferences.js";
import { DOMAINS } from "../../../domain/domains.js";
import { isDegradableEmbeddingError } from "../../../domain/embeddings.js";
import { SYNTHESIS_MARKER_KINDS } from "../../../domain/vocab.js";
import type { ConfigRepository } from "../../../ports/config.js";
import type { EmbeddingPort } from "../../../ports/embeddings.js";
import {
	MAX_URL_EXCLUDE_IDS,
	type GraphKind,
	type Row,
	type SearchMode,
	type SearchPort,
} from "../../../ports/search.js";
import {
	type Arm,
	type DegradeReason,
	HYBRID_MAX_ROWS,
	RANKED_OVERFETCH,
	dropExcludedSubtypes,
	errDetail,
	excludeUnenrichedDiscovered,
	excludedSystemSubtypes,
	formatDisplayRows,
	graphArmsWanted,
	isSynthesisWindow,
	mergeArms,
	subtypeOptIns,
	tagFilter,
	toArtifactDisplayRows,
	toGraphDisplayRows,
} from "./rank.js";

export * from "./rank.js";

export const knowledgeSearchInput = {
	query: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Natural-language or keyword query. Searches artifacts hybrid (full-text + semantic vector, RRF-fused) when the OpenAI embedding key is configured, and falls back to full-text-only when it is not \u2014 or when the embedding provider is rate-limited/down, in which case the result is labelled as degraded rather than failing. Optional when structured filters are supplied.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe("Max results (default 10)."),
	captured_after: z
		.string()
		.optional()
		.describe(
			"Only include artifacts whose EFFECTIVE date >= this ISO timestamp (e.g. '2026-06-15T00:00:00Z'). Inclusive. Effective date is `originated_at` where the source told us when the content is from, else `captured_at` (ADR-088, #571) \u2014 so a 2016 contract enriched today is filtered as 2016, not as today. The parameter keeps the `captured_` name deliberately: renaming it is a real API break for callers already wired to it, and the widened meaning is spelled out here and in the tool description, so nobody is misled by the name alone (same call made for `include_discovered`).",
		),
	captured_before: z
		.string()
		.optional()
		.describe(
			"Only include artifacts whose EFFECTIVE date <= this ISO timestamp. Inclusive. See captured_after for what 'effective' means and why the name still says captured (ADR-088, #571).",
		),
	not_consumed: z
		.boolean()
		.optional()
		.describe(
			"Exclude artifacts already folded into a daily-log / synthesis entry (i.e. with an artifact_external_links row carrying any synthesis marker kind: 'synthesized' or 'synthesized_unattended'). Used by synthesis consumers like dos-eod to find unconsumed atoms. When not_consumed is true and `roles` is omitted, `roles` defaults to ['narrative'] (ADR-108 \u00A75, ADR-046 \u00A73); pass an explicit `roles` array to override. See ADR-013 \u00A77, ADR-018 \u00A75, ADR-050 \u00A76.",
		),
	consumed_kinds: z
		.array(z.enum(SYNTHESIS_MARKER_KINDS))
		.min(1)
		.optional()
		.describe(
			"Which synthesis marker kinds `not_consumed` should treat as consuming. Defaults to ALL of them ('synthesized' and 'synthesized_unattended'), which is what an ordinary day-window read wants. Pass ['synthesized'] to treat only human-confirmed synthesis as consumption, so atoms a machine sweep closed unattended (#561) come back as unconsumed and the day can still be reviewed attended. Ignored unless not_consumed is true. See ADR-050 \u00A76/\u00A78.",
		),
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Whose consumption `not_consumed` should count: 'work' (the Work ritual) or 'angus' (the personal one). Each domain folds atoms into its OWN Daily Log and stamps markers under its own provider, so a domain-scoped ritual must pass its own domain or it treats the other domain's synthesis as its own and skips atoms it never consumed (#677, ADR-051 \u00A711). This is the dos ritual's routing axis (ADR-051 \u00A71) \u2014 not the subject-area 'topic' an atom is about. Omitted, no provider predicate is applied at all and EVERY domain's markers count as consumption, which is what a cross-domain audit wants and exactly what every caller got before this argument existed. Ignored unless not_consumed is true.",
		),
	include_archived: z
		.boolean()
		.optional()
		.describe(
			"Include soft-deleted (archived) artifacts in results. Defaults to false, matching entity_query/person_query. See artifact_delete.",
		),
	include_task_requests: z
		.boolean()
		.optional()
		.describe(
			"Include task-request provenance artifacts (content_subtype='task_request') in results. These are auto-captured by task_create as the source of an artifact-less task (issue #413) \u2014 the message that requested the task. Defaults to false so one-line task requests ('add task: buy milk') don't crowd search results; set true when you specifically want to see them.",
		),
	include_event_requests: z
		.boolean()
		.optional()
		.describe(
			"Include event-request provenance artifacts (content_subtype='event_request') in results. These are auto-captured by event_create as the source of an artifact-less calendar event (issue #126), mirroring include_task_requests. Defaults to false so one-line event requests don't crowd search results; set true when you specifically want to see them.",
		),
	include_daily_logs: z
		.boolean()
		.optional()
		.describe(
			"Include Daily Log twins (content_subtype='daily_log') in results. These are the EOD ritual's own output, captured back into the store so a day's synthesis is answerable from the memory side \u2014 'what did I decide on 12 August' (#562, ADR-050 \u00A77). Defaults to false, and that default is load-bearing rather than cosmetic: it is how ADR-051 \u00A79's 'the ritual's own output is never the ritual's input' holds, so tomorrow's day-window read cannot consume today's log and synthesise the synthesis. Set true for exactly the read that wants the synthesis rather than the atoms; never in a day-window/not_consumed synthesis read.",
		),
	include_scaffolds: z
		.boolean()
		.optional()
		.describe(
			"Include scheduled-task scaffold artifacts (content_subtype='scaffold') in results. These are a Cowork scheduled task's own ritual output, captured back into the store as the INPUT to a later ritual \u2014 e.g. friday-reflection-prep's 'Weekly Reflection' scaffold, which dos-reflect reads and archives or consumes (#994, ADR-051 \u00A79). Defaults to false, same load-bearing reasoning as include_daily_logs: it is what keeps an ordinary dos day-window read from surfacing a scaffold as material. Set true only in the read that specifically wants scaffolds, e.g. dos-reflect's own read.",
		),
	include_reflections: z
		.boolean()
		.optional()
		.describe(
			"Include reflection twins (content_subtype='reflection') in results. These are reflect's own output, captured back into the store alongside the Daily Log entry (#2316). Defaults to false, kept out of day-window reads for the same reason as include_daily_logs and include_scaffolds (ADR-051 \u00A79): the ritual's own output must not come back as an input. Set true only when you specifically want reflections.",
		),
	include_discovered: z
		.boolean()
		.optional()
		.describe(
			"Include unenriched pointers (lifecycle_stage='discovered' or 'failed' \u2014 registered by discover/ingest_enrich_next but never enriched to a body, or enrichment attempted and errored) in day-window/synthesis reads (captured_after/captured_before/not_consumed). Defaults to false: these rows have nothing to narrate, so a connector backfill of hundreds of bare pointers doesn't drown the day's real atoms (issue #567). Does not affect a bare query with no structured filters \u2014 that always surfaces discovered/failed pointers by title (ADR-016's 'what I have' search; ADR-046 \u00A73). Set true to audit the discover backlog, e.g. to see what a flood landed or what ingest_enrich_next needs to retry \u2014 there is no dedicated list_by_stage tool yet.",
		),
	rank_by_role: z
		.boolean()
		.optional()
		.describe(
			"Rank a filter-only read (no `query`) by ADR-046 \u00A73 source role BEFORE the limit is taken: every `narrative` row first, then `evidence`, `metrics`, `excluded`; within a role, newest effective date first (the same `effective_at` the window filters on, ADR-088). A row's role is resolved from the owner's surface\u2192role map exactly as artifact_get's `role=` reports it. The ranking covers the WHOLE matching set, not the returned page, and drops robot-authored rows from non-excluded tiers (use `roles` to filter membership explicitly). The response opens with each role's count. Defaults to false (newest effective date first, role ignored). Built for the dos ritual's bounded backlog slice (ADR-067 \u00A73, #911). Refused alongside `query`, whose order is relevance.",
		),
	roles: z
		.array(z.enum(SYNTHESIS_ROLES))
		.min(1)
		.optional()
		.describe(
			"Filter artifacts by effective ADR-046 \u00A73 synthesis role ('narrative', 'evidence', 'metrics', 'excluded'). Honors surface_role_map, role:<role> tag overrides, and robot-authored exclusion (unless 'excluded' is included or 'not_robot_authored' is set). Defaults to ['narrative'] when `not_consumed` is true and `roles` is omitted (ADR-108 \u00A75); pass an explicit array to override.",
		),
	tags: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(20)
		.optional()
		.describe(
			"Only artifacts carrying ALL of these tags (exact, case-sensitive match on the artifact's tags, e.g. ['doc:cv', 'golden']). Applied inside the search itself, before its row ceiling: the full-text arm filters before its cap, and the semantic arm ranks the tagged artifacts themselves by exact distance, so a tagged match is never crowded out by untagged ones. Skips the entity and people arms, which have no artifact tags. May be the only filter: with no `query` it lists the tagged artifacts newest first.",
		),
	artifacts_only: z
		.boolean()
		.optional()
		.describe(
			"Skip the entity and people arms: return artifacts only. Defaults to false. Use it for document-shaped queries (a document name, a filename), where name-matching entities and people otherwise fill the top of the list. Changes nothing on a filter-only read, which is artifacts-only already.",
		),
};

export const searchInput = knowledgeSearchInput;
export const knowledgeSearchSchema = z.object(knowledgeSearchInput);
export type KnowledgeSearchInput = z.input<typeof knowledgeSearchSchema>;

export interface KnowledgeSearchResult {
	content: { type: "text"; text: string }[];
	text: string;
}

export interface KnowledgeSearchPorts {
	search: SearchPort;
	embeddings?: EmbeddingPort | (() => EmbeddingPort | null | undefined) | null;
	config?: Pick<ConfigRepository, "loadCapturePreferences">;
	onWarning?: (message: string) => void;
}

export const KNOWLEDGE_SEARCH_DESCRIPTION =
	"Search the knowledge store \u2014 artifacts and the entity/people graph fused into one ranked list. " +
	"At least one of `query`, `tags`, `captured_after`, `captured_before` or `not_consumed` must be supplied. " +
	"Structured filters (`roles`, `tags`, date window, `not_consumed`) apply to the artifact arm only. " +
	"`tags` (all-of) and `artifacts_only` drop the graph arms. `rank_by_role` ranks a filter-only read by source role. " +
	"Full notes: docs/guides/tools/knowledge_search.md";

const wrapOut = (res: { content: { type: "text"; text: string }[] }): KnowledgeSearchResult => ({
	content: res.content,
	text: res.content[0]?.text ?? "",
});

const createInputGuardError = (message: string): Error =>
	new Proxy(new Error(message), {
		defineProperty(target, prop, descriptor) {
			if (prop === "message") return true;
			return Reflect.defineProperty(target, prop, descriptor);
		},
	});

export function createKnowledgeSearchAction(
	ports: KnowledgeSearchPorts,
): ActionDefinition<typeof knowledgeSearchSchema, KnowledgeSearchResult> {
	return defineAction({
		id: "knowledge_search",
		domain: "artifacts",
		description: KNOWLEDGE_SEARCH_DESCRIPTION,
		schema: knowledgeSearchSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args, ctx) => {
			const userId = ctx?.userId;
			const limit = args.limit ?? 10;

			if (
				!args.query &&
				!args.tags?.length &&
				!args.captured_after &&
				!args.captured_before &&
				!args.not_consumed
			) {
				throw createInputGuardError(
					"knowledge_search: provide at least one of query, tags, captured_after, captured_before, not_consumed=true.",
				);
			}
			if (args.rank_by_role && args.query) {
				throw createInputGuardError(
					"knowledge_search: rank_by_role ranks a filter-only read and cannot be combined with `query` (a query-bearing read is ordered by relevance). Drop one of them.",
				);
			}

			const effectiveRoles: readonly SynthesisRole[] | undefined = args.roles?.length
				? args.roles
				: args.not_consumed
					? ["narrative"]
					: undefined;
			const allowedRoles = effectiveRoles?.length ? new Set<SynthesisRole>(effectiveRoles) : null;
			let cachedPrefs: CapturePreferences | null = null;
			const getPrefs = async (): Promise<CapturePreferences> => {
				if (cachedPrefs) return cachedPrefs;
				const rawPrefs = ports.config?.loadCapturePreferences
					? await ports.config.loadCapturePreferences()
					: DEFAULT_CAPTURE_PREFERENCES;
				cachedPrefs = {
					...DEFAULT_CAPTURE_PREFERENCES,
					...rawPrefs,
				};
				return cachedPrefs;
			};

			const excludeConsumedCandidateRows = async (rows: Row[]): Promise<Row[]> => {
				if (!args.not_consumed || rows.length === 0) return rows;
				const consumedIds = await ports.search.findConsumedArtifactIds({
					consumingKinds: args.consumed_kinds
						? [...args.consumed_kinds]
						: [...SYNTHESIS_MARKER_KINDS],
					domain: args.domain,
					candidateIds: rows.map((r) => r.id),
					userId,
				});
				const consumedSet = new Set(consumedIds);
				return rows.filter((r) => !consumedSet.has(r.id));
			};

			const fetchGraphArm = async (
				kind: GraphKind,
				mode: SearchMode,
				query: string,
				matchLimit: number,
				queryEmbedding?: string | number[],
			): Promise<Arm> => {
				const ceiling = mode === "hybrid" ? Math.min(matchLimit, HYBRID_MAX_ROWS) : matchLimit;
				const rows = await ports.search.searchGraph({
					kind,
					mode,
					query,
					queryEmbedding,
					matchLimit,
					includeArchived: args.include_archived ?? false,
					userId,
				});
				return { kind, rows: toGraphDisplayRows(rows, kind), rpcRowCount: rows.length, ceiling };
			};

			const postFilterRankedRows = async (initial: Row[]): Promise<Row[]> => {
				let rows = initial;
				if (args.captured_after) {
					rows = rows.filter((r) => r.effective_at && r.effective_at >= args.captured_after!);
				}
				if (args.captured_before) {
					rows = rows.filter((r) => r.effective_at && r.effective_at <= args.captured_before!);
				}
				if (isSynthesisWindow(args) && !args.include_discovered) {
					rows = excludeUnenrichedDiscovered(rows);
				}
				rows = dropExcludedSubtypes(rows, excludedSystemSubtypes(subtypeOptIns(args)));
				if (allowedRoles) {
					const prefs = await getPrefs();
					rows = rows.filter((r) => allowedRoles.has(resolveSynthesisRole(prefs, r)));
				}
				return excludeConsumedCandidateRows(rows);
			};

			const fullTextSearch = async (
				query: string,
				degrade: { reason: DegradeReason; detail?: string },
			): Promise<KnowledgeSearchResult> => {
				const matchLimit = limit * RANKED_OVERFETCH;
				const rawRows = await ports.search.ftsSearchArtifacts({
					query,
					matchLimit,
					includeArchived: args.include_archived ?? false,
					tags: tagFilter(args),
					userId,
				});
				const rpcRowCount = rawRows.length;
				const rows = await postFilterRankedRows(rawRows);
				const graphArms = graphArmsWanted(args)
					? await Promise.all([
							fetchGraphArm("entity", "full-text-only", query, matchLimit),
							fetchGraphArm("person", "full-text-only", query, matchLimit),
						])
					: [];
				return wrapOut(
					mergeArms(
						[
							{
								kind: "artifact",
								rows: toArtifactDisplayRows(rows),
								rpcRowCount,
								ceiling: matchLimit,
							},
							...graphArms,
						],
						query,
						limit,
						"full-text-only",
						degrade,
					),
				);
			};

			const embeddingPort =
				typeof ports.embeddings === "function" ? ports.embeddings() : ports.embeddings;

			if (args.query && embeddingPort) {
				let queryEmbedding: number[];
				try {
					queryEmbedding = await embeddingPort.embed(args.query);
				} catch (err) {
					if (!isDegradableEmbeddingError(err)) throw err;
					ports.onWarning?.(
						`[knowledge_search] embedding provider unavailable, falling back to full-text: ${String(err)}`,
					);
					return fullTextSearch(args.query, {
						reason: "provider-unavailable",
						detail: errDetail(err),
					});
				}

				const matchLimit = limit * RANKED_OVERFETCH;
				const embeddingJson = JSON.stringify(queryEmbedding);
				const rawRows = await ports.search.hybridSearchArtifacts({
					query: args.query,
					queryEmbedding: embeddingJson,
					matchLimit,
					includeArchived: args.include_archived ?? false,
					tags: tagFilter(args),
					userId,
				});
				const rpcRowCount = rawRows.length;
				const rows = await postFilterRankedRows(rawRows);
				const graphArms = graphArmsWanted(args)
					? await Promise.all([
							fetchGraphArm("entity", "hybrid", args.query, matchLimit, embeddingJson),
							fetchGraphArm("person", "hybrid", args.query, matchLimit, embeddingJson),
						])
					: [];
				return wrapOut(
					mergeArms(
						[
							{
								kind: "artifact",
								rows: toArtifactDisplayRows(rows),
								rpcRowCount,
								ceiling: Math.min(matchLimit, HYBRID_MAX_ROWS),
							},
							...graphArms,
						],
						args.query,
						limit,
						"hybrid",
					),
				);
			}

			if (args.query) {
				return fullTextSearch(args.query, { reason: "no-key" });
			}

			const excludedSubtypes = excludedSystemSubtypes(subtypeOptIns(args));
			const consumingKinds = args.consumed_kinds
				? [...args.consumed_kinds]
				: [...SYNTHESIS_MARKER_KINDS];

			if (args.rank_by_role) {
				const prefs = await getPrefs();
				const rows: Row[] = [];
				const tierSizes: string[] = [];
				let total = 0;
				let allExact = true;
				const fallbackConsumedIds =
					args.not_consumed && !ports.search.searchUnconsumedArtifacts
						? await ports.search.findConsumedArtifactIds({
								consumingKinds,
								domain: args.domain,
								capturedAfter: args.captured_after,
								capturedBefore: args.captured_before,
								userId,
							})
						: undefined;

				for (const tier of roleTierFilters(prefs)) {
					if (allowedRoles && !allowedRoles.has(tier.role)) {
						tierSizes.push(`${tier.role} 0`);
						continue;
					}
					if (tier.match === "none") {
						tierSizes.push(`${tier.role} 0`);
						continue;
					}
					const room = limit - rows.length;
					const overFetch = tier.role !== "excluded";

					if (args.not_consumed && ports.search.searchUnconsumedArtifacts) {
						const rpcLimit = room > 0 ? (overFetch ? room + 50 : room) : 1;
						const { rows: rpcRows, timedOutCount } =
							await ports.search.searchUnconsumedArtifacts({
								consumingKinds,
								domain: args.domain,
								capturedAfter: args.captured_after,
								capturedBefore: args.captured_before,
								includeDiscovered: args.include_discovered ?? false,
								roleHitKeys: tier.hitKeys,
								roleAllKeys: tier.allKeys,
								roleDefaultHit: tier.defaultHit,
								excludeTitlePatterns:
									tier.role === "narrative" ? ["%auto-task%", "%scheduled routine%"] : [],
								excludeRobotAuthored: tier.role !== "excluded",
								tags: tagFilter(args),
								limit: rpcLimit,
								tierRole: tier.role,
								includeArchived: args.include_archived ?? false,
								excludedSubtypes,
								withCount: true,
								userId,
							});
						const tierExact = !timedOutCount;
						let tierRows = rpcRows as (Row & { total_count?: number | string | null })[];
						const rawTotal =
							tierRows.length > 0 && tierRows[0].total_count != null
								? Number(tierRows[0].total_count)
								: tierExact && tierRows.length === 0
									? 0
									: null;
						const probeCount = tierRows.length;
						let jsDropped = 0;
						if (room === 0) {
							tierRows = [];
						} else {
							if (tier.role !== "excluded") {
								tierRows = tierRows.filter(
									(r) => !isRobotAuthoredArtifact(r) || hasRoleOverrideTag(r.tags),
								);
							}
							jsDropped = probeCount - tierRows.length;
							if (probeCount === rpcLimit && tierRows.length < room) {
								allExact = false;
							}
							tierRows = tierRows.slice(0, room);
						}
						if (rawTotal == null || !tierExact) allExact = false;
						const estimatedCount =
							rawTotal != null
								? Math.max(tierRows.length, rawTotal - jsDropped)
								: room === 0
									? probeCount
									: tierRows.length;
						if (room > 0) rows.push(...tierRows);
						total += estimatedCount;
						tierSizes.push(`${tier.role} ${estimatedCount}`);
						continue;
					}

					const fetchLimit = room > 0 ? (overFetch ? room + 50 : room) : 0;
					const { rows: fetchedRows, count } = await ports.search.filterArtifacts({
						includeArchived: args.include_archived ?? false,
						excludedSubtypes,
						capturedAfter: args.captured_after,
						capturedBefore: args.captured_before,
						consumedIds: fallbackConsumedIds,
						tags: tagFilter(args),
						excludeUnenriched: isSynthesisWindow(args) && !args.include_discovered,
						roleOrFilter: tier.match === "filter" ? tier.or : undefined,
						excludeNarrativeRobotTitles: tier.role === "narrative",
						excludeRobotAuthored: tier.role !== "excluded",
						withCount: true,
						head: room === 0,
						limit: room > 0 ? fetchLimit : undefined,
						tierRole: tier.role,
						userId,
					});
					let tierRows = fetchedRows;
					const rawPageCount = tierRows.length;
					if (tier.role !== "excluded") {
						tierRows = tierRows.filter(
							(r) => !isRobotAuthoredArtifact(r) || hasRoleOverrideTag(r.tags),
						);
					}
					const jsDropped = rawPageCount - tierRows.length;
					if (room > 0 && rawPageCount === fetchLimit && tierRows.length < room) {
						allExact = false;
					}
					tierRows = tierRows.slice(0, room);
					if (count == null) allExact = false;
					const estimatedCount = count != null ? count - jsDropped : tierRows.length;
					const tierCount = Math.max(tierRows.length, estimatedCount);
					rows.push(...tierRows);
					total += tierCount;
					tierSizes.push(`${tier.role} ${tierCount}`);
				}

				const preamble = `\u2139\uFE0F ranked by source role (ADR-046 \u00A73), newest effective date first within each role: ${tierSizes.join(" \u00B7 ")}.\n\n`;
				return wrapOut(
					formatDisplayRows(
						toArtifactDisplayRows(rows),
						{ count: total > rows.length ? total - rows.length : 0, exact: allExact },
						undefined,
						undefined,
						preamble,
					),
				);
			}

			const isWideUnbounded =
				!args.captured_after && (!isSynthesisWindow(args) || Boolean(args.include_discovered));
			const withCount = !isWideUnbounded;
			const fetchLimit = isWideUnbounded ? limit + 50 : limit;
			const excludeRobotAuthored = allowedRoles ? !allowedRoles.has("excluded") : Boolean(args.not_consumed);

			if (args.not_consumed && ports.search.searchUnconsumedArtifacts) {
				const prefs = allowedRoles ? await getPrefs() : null;
				const combined =
					prefs && effectiveRoles && !allowedRoles?.has("excluded")
						? combinedRoleTierFilter(prefs, effectiveRoles)
						: null;
				const { rows: rpcRows, timedOutCount } =
					await ports.search.searchUnconsumedArtifacts({
						consumingKinds,
						domain: args.domain,
						capturedAfter: args.captured_after,
						capturedBefore: args.captured_before,
						includeDiscovered: args.include_discovered ?? false,
						roleHitKeys: combined ? combined.hitKeys : null,
						roleAllKeys: combined ? combined.allKeys : null,
						roleDefaultHit: combined ? combined.defaultHit : false,
						roleOverrideTags: combined ? combined.overrideTags : null,
						excludeTitlePatterns:
							allowedRoles && !allowedRoles.has("excluded")
								? ["%auto-task%", "%scheduled routine%"]
								: [],
						excludeRobotAuthored,
						tags: tagFilter(args),
						limit: fetchLimit,
						retryLimit: limit + 50,
						includeArchived: args.include_archived ?? false,
						excludedSubtypes,
						withCount,
						userId,
					});
				const effectiveFetchLimit = timedOutCount ? limit + 50 : fetchLimit;
				const hasRpcTotal = rpcRows.length > 0 && rpcRows[0].total_count != null;
				let filteredRpcRows = rpcRows;
				if (allowedRoles && prefs) {
					filteredRpcRows = filteredRpcRows.filter((r) => {
						if (r.surface !== undefined || r.source_channel !== undefined || hasRoleOverrideTag(r.tags)) {
							return allowedRoles.has(resolveSynthesisRole(prefs, r));
						}
						return !excludeRobotAuthored || !isRobotAuthoredArtifact(r);
					});
				}
				const jsDropped = rpcRows.length - filteredRpcRows.length;
				const totalCount = hasRpcTotal
					? Math.max(filteredRpcRows.length, Number(rpcRows[0].total_count) - jsDropped)
					: filteredRpcRows.length;
				const exact =
					(hasRpcTotal && jsDropped === 0) || rpcRows.length < effectiveFetchLimit;
				const rows = filteredRpcRows.slice(0, limit);
				const truncatedCount = totalCount > rows.length ? totalCount - rows.length : 0;
				return wrapOut(
					formatDisplayRows(
						toArtifactDisplayRows(rows),
						{ count: truncatedCount, exact },
						undefined,
					),
				);
			}

			const consumedIds = args.not_consumed
				? await ports.search.findConsumedArtifactIds({
						consumingKinds,
						domain: args.domain,
						capturedAfter: args.captured_after,
						capturedBefore: args.captured_before,
						userId,
					})
				: undefined;
			const prefsForFilter = allowedRoles ? await getPrefs() : null;
			const combinedFilter =
				prefsForFilter && effectiveRoles && !allowedRoles?.has("excluded")
					? combinedRoleTierFilter(prefsForFilter, effectiveRoles)
					: null;
			const { rows: rawRows, count } = await ports.search.filterArtifacts({
				includeArchived: args.include_archived ?? false,
				excludedSubtypes,
				capturedAfter: args.captured_after,
				capturedBefore: args.captured_before,
				consumedIds,
				tags: tagFilter(args),
				excludeUnenriched: isSynthesisWindow(args) && !args.include_discovered,
				roleOrFilter: combinedFilter?.match === "filter" ? combinedFilter.or : undefined,
				excludeNarrativeRobotTitles: Boolean(allowedRoles && !allowedRoles.has("excluded")),
				excludeRobotAuthored,
				withCount,
				limit: fetchLimit,
				retryLimit: limit + 50,
				userId,
			});
			let postFiltered =
				consumedIds && consumedIds.length > MAX_URL_EXCLUDE_IDS
					? rawRows.filter((r) => !new Set(consumedIds).has(r.id))
					: rawRows;
			if (allowedRoles && prefsForFilter) {
				postFiltered = postFiltered.filter((r) => {
					if (r.surface !== undefined || r.source_channel !== undefined || hasRoleOverrideTag(r.tags)) {
						return allowedRoles.has(resolveSynthesisRole(prefsForFilter, r));
					}
					return !excludeRobotAuthored || !isRobotAuthoredArtifact(r);
				});
			}
			const rows = postFiltered.slice(0, limit);
			const isExact = count != null && !allowedRoles;
			const totalCount = (allowedRoles ? null : count) ?? postFiltered.length;
			const truncatedCount = totalCount > rows.length ? totalCount - rows.length : 0;
			return wrapOut(
				formatDisplayRows(
					toArtifactDisplayRows(rows),
					{ count: truncatedCount, exact: isExact },
					undefined,
				),
			);
		},
		formatMcp: (out) => out.text,
	});
}
