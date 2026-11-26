import type { SupabaseClient } from "@supabase/supabase-js";
import { DOMAIN_PROVIDER, type Domain } from "../../domain/domains.js";
import {
	ENRICHED_STAGES,
	GRAPH_SELECT,
	GRAPH_SELECT_LEGACY,
	MAX_URL_EXCLUDE_IDS,
	SEARCH_ARTIFACT_SELECT,
	type FilterArtifactsParams,
	type FindConsumedArtifactIdsParams,
	type FtsSearchArtifactsParams,
	type GraphKind,
	type GraphRow,
	type HybridSearchArtifactsParams,
	type Row,
	type SearchGraphParams,
	type SearchPort,
	type SearchUnconsumedArtifactsParams,
	type UnconsumedRow,
} from "../../ports/search.js";
import { scopeToDomain } from "./externalLinks.js";

const SYNTHESIS_MARKER_KINDS = ["synthesized", "synthesized_unattended"] as const;
const GRAPH_HYBRID_RPC: Record<GraphKind, "hybrid_search_entities" | "hybrid_search_people"> = {
	entity: "hybrid_search_entities",
	person: "hybrid_search_people",
};
const GRAPH_FTS_RPC: Record<GraphKind, "fts_search_entities" | "fts_search_people"> = {
	entity: "fts_search_entities",
	person: "fts_search_people",
};

export type SearchSupabaseClient = Pick<SupabaseClient, "from" | "rpc">;
export interface SupabaseSearchAdapterOptions {
	client: SearchSupabaseClient;
	ownerId: string | (() => string);
	domainProvider?: Record<Domain, string>;
	onWarning?: (message: string) => void;
}

const normalizeTags = (tags?: readonly string[] | null): string[] | null =>
	tags?.length ? [...new Set(tags)] : null;
const serializeEmbedding = (emb: string | number[]): string =>
	typeof emb === "string" ? emb : JSON.stringify(emb);

export function textArrayLiteral(values: string[]): string {
	return `{${values.map((v) => `"${v.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
}

export function rpcMigrationHint(
	tagsOrArgs: readonly string[] | { tags?: readonly string[] | null } | null | undefined,
	base: string,
): string {
	const raw = Array.isArray(tagsOrArgs)
		? tagsOrArgs
		: (tagsOrArgs as { tags?: readonly string[] | null } | null | undefined)?.tags;
	return normalizeTags(raw) ? `${base}; the \`tags\` filter needs migration 119` : base;
}

export function isMissingColumnError(
	error: { code?: string; message?: string } | null | undefined,
	column: string,
): boolean {
	if (!error || (error.code !== "42703" && error.code !== "PGRST204")) return false;
	return new RegExp(`\\b${column.replace(/[^a-z0-9_]/gi, "")}\\b`).test(error.message ?? "");
}

export function createSupabaseSearchAdapter(options: SupabaseSearchAdapterOptions): SearchPort {
	const resolveOwnerId = (userId?: string) =>
		userId ?? (typeof options.ownerId === "function" ? options.ownerId() : options.ownerId);
	const domainProvider = options.domainProvider ?? DOMAIN_PROVIDER;

	return {
		async ftsSearchArtifacts(params: FtsSearchArtifactsParams): Promise<Row[]> {
			const tags = normalizeTags(params.tags);
			const { data, error } = await options.client
				.rpc("fts_search_artifacts", {
					query_text: params.query,
					match_user_id: resolveOwnerId(params.userId),
					match_limit: params.matchLimit,
					include_archived: params.includeArchived ?? false,
					...(tags ? { filter_tags: tags } : {}),
				})
				.select(SEARCH_ARTIFACT_SELECT);
			if (error) {
				throw new Error(
					`Full-text search failed: ${error.message}. If this mentions "fts_search_artifacts", apply ${rpcMigrationHint(tags, "migration 066 and 069")}.`,
				);
			}
			return (data ?? []) as Row[];
		},

		async hybridSearchArtifacts(params: HybridSearchArtifactsParams): Promise<Row[]> {
			const tags = normalizeTags(params.tags);
			const { data, error } = await options.client
				.rpc("hybrid_search_artifacts", {
					query_text: params.query,
					query_embedding: serializeEmbedding(params.queryEmbedding),
					match_user_id: resolveOwnerId(params.userId),
					match_limit: params.matchLimit,
					include_archived: params.includeArchived ?? false,
					...(tags ? { filter_tags: tags } : {}),
				})
				.select(SEARCH_ARTIFACT_SELECT);
			if (error) {
				throw new Error(
					`Hybrid search failed: ${error.message}. If this mentions "hybrid_search_artifacts", apply ${rpcMigrationHint(tags, "migration 051 and 069")}.`,
				);
			}
			return (data ?? []) as Row[];
		},

		async searchGraph(params: SearchGraphParams): Promise<GraphRow[]> {
			const rpcName =
				params.mode === "hybrid" ? GRAPH_HYBRID_RPC[params.kind] : GRAPH_FTS_RPC[params.kind];
			const rpcParams: Record<string, unknown> = {
				query_text: params.query,
				...(params.mode === "hybrid" && params.queryEmbedding !== undefined
					? { query_embedding: serializeEmbedding(params.queryEmbedding) }
					: {}),
				match_user_id: resolveOwnerId(params.userId),
				match_limit: params.matchLimit,
				include_archived: params.includeArchived ?? false,
			};
			const res = await options.client.rpc(rpcName, rpcParams).select(GRAPH_SELECT);
			let rows = (res.data ?? []) as GraphRow[];
			let error = res.error;
			if (error && isMissingColumnError(error, "aliases")) {
				const fallback = await options.client.rpc(rpcName, rpcParams).select(GRAPH_SELECT_LEGACY);
				rows = (fallback.data ?? []) as GraphRow[];
				error = fallback.error;
			}
			if (error) {
				options.onWarning?.(
					`[knowledge_search] ${rpcName} failed, continuing with artifact-only results: ${error.message}`,
				);
				return [];
			}
			return rows;
		},

		async filterArtifacts(
			params: FilterArtifactsParams,
		): Promise<{ rows: Row[]; count: number | null }> {
			const buildQuery = (selectOpts: { count?: "exact"; head?: boolean }) => {
				let q = options.client
					.from("artifacts")
					.select(SEARCH_ARTIFACT_SELECT, selectOpts)
					.eq("user_id", resolveOwnerId(params.userId));
				if (!params.includeArchived) q = q.eq("archived", false);
				const excluded = params.excludedSubtypes ?? [];
				if (excluded.length === 1) {
					q = q.or(`content_subtype.is.null,content_subtype.neq.${excluded[0]}`);
				} else if (excluded.length > 1) {
					q = q.or(`content_subtype.is.null,content_subtype.not.in.(${excluded.join(",")})`);
				}
				if (params.capturedAfter) q = q.gte("effective_at", params.capturedAfter);
				if (params.capturedBefore) q = q.lte("effective_at", params.capturedBefore);
				if (params.consumedIds?.length && params.consumedIds.length <= MAX_URL_EXCLUDE_IDS) {
					q = q.not("id", "in", `(${params.consumedIds.join(",")})`);
				}
				const tags = normalizeTags(params.tags);
				if (tags) q = q.filter("tags", "cs", textArrayLiteral(tags));
				if (params.excludeUnenriched) {
					q = q.or(`lifecycle_stage.is.null,lifecycle_stage.in.(${[...ENRICHED_STAGES].join(",")})`);
				}
				if (params.roleOrFilter) q = q.or(params.roleOrFilter);
				if (params.excludeNarrativeRobotTitles) {
					q = q.not("title", "ilike", "%auto-task%").not("title", "ilike", "%scheduled routine%");
				}
				if (params.excludeRobotAuthored) {
					q = q.or('tags.is.null,tags.cs.{"not_robot_authored"},tags.not.ov.{"robot_authored","auto-task"}');
				}
				return q;
			};

			const withCount = params.head || params.withCount !== false;
			const selectOptions: { count?: "exact"; head?: boolean } = params.head
				? { count: "exact", head: true }
				: withCount
					? { count: "exact" }
					: {};
			const initialQuery = buildQuery(selectOptions);
			let { data, error, count } =
				!params.head && params.limit !== undefined
					? await initialQuery.order("effective_at", { ascending: false }).limit(params.limit)
					: await initialQuery;

			if (error && error.message?.includes("statement timeout") && withCount) {
				if (params.tierRole) {
					console.warn(
						`[knowledge_search] statement timeout ranking tier ${params.tierRole}; retrying without count`,
					);
				} else {
					console.warn("[knowledge_search] exact count timed out; retrying without count");
				}
				if (params.head) {
					return { rows: [], count: null };
				}
				const retryLimit = params.retryLimit ?? params.limit;
				const retryQuery = buildQuery({});
				const retry =
					retryLimit !== undefined
						? await retryQuery.order("effective_at", { ascending: false }).limit(retryLimit)
						: await retryQuery;
				data = retry.data;
				error = retry.error;
				count = null;
			}
			if (error) {
				if (params.tierRole) {
					throw new Error(`Search failed ranking the ${params.tierRole} tier: ${error.message}`);
				}
				throw new Error(
					`Search failed: ${error.message}. If this mentions "search_vector", apply migration 044.`,
				);
			}
			return { rows: (data ?? []) as Row[], count: count ?? null };
		},

		async findConsumedArtifactIds(params: FindConsumedArtifactIdsParams): Promise<string[]> {
			const userId = resolveOwnerId(params.userId);
			const consumingKinds = params.consumingKinds ?? [...SYNTHESIS_MARKER_KINDS];
			let linkQuery = scopeToDomain(
				options.client.from("artifact_external_links").select("artifact_id").eq("user_id", userId),
				params.domain,
				domainProvider,
			).in("kind", consumingKinds);
			if (params.candidateIds) linkQuery = linkQuery.in("artifact_id", params.candidateIds);
			const { data: consumed, error: cErr } = await linkQuery;
			if (cErr) {
				throw new Error(
					`Consumption-link lookup failed: ${cErr.message}. If this mentions an undefined relation, apply migration 047.`,
				);
			}
			let consumedIds = (consumed ?? [])
				.map((r: { artifact_id: string | null }) => r.artifact_id)
				.filter((id): id is string => Boolean(id));
			if ((params.capturedAfter || params.capturedBefore) && consumedIds.length > 0) {
				const scoped: string[] = [];
				for (let i = 0; i < consumedIds.length; i += MAX_URL_EXCLUDE_IDS) {
					const chunk = consumedIds.slice(i, i + MAX_URL_EXCLUDE_IDS);
					let q = options.client.from("artifacts").select("id").eq("user_id", userId).in("id", chunk);
					if (params.capturedAfter) q = q.gte("effective_at", params.capturedAfter);
					if (params.capturedBefore) q = q.lte("effective_at", params.capturedBefore);
					const { data: matched, error: mErr } = await q;
					if (mErr) throw new Error(`Scoping consumed artifacts failed: ${mErr.message}`);
					for (const r of (matched ?? []) as Array<{ id: string | null }>) {
						if (r.id) scoped.push(r.id);
					}
				}
				consumedIds = scoped;
			}
			return consumedIds;
		},

		async searchUnconsumedArtifacts(
			params: SearchUnconsumedArtifactsParams,
		): Promise<{ rows: UnconsumedRow[]; timedOutCount?: boolean }> {
			const userId = resolveOwnerId(params.userId);
			const consumingKinds = params.consumingKinds ?? [...SYNTHESIS_MARKER_KINDS];
			const provider = params.domain ? domainProvider[params.domain] : null;
			const baseParams = {
				p_user_id: userId,
				p_kinds: consumingKinds,
				p_provider: provider,
				p_effective_after: params.capturedAfter ?? null,
				p_effective_before: params.capturedBefore ?? null,
				p_include_discovered: params.includeDiscovered ?? false,
				p_role_hit_keys: params.roleHitKeys ?? null,
				p_role_all_keys: params.roleAllKeys ?? null,
				p_role_default_hit: params.roleDefaultHit ?? false,
				p_role_override_tags: params.roleOverrideTags ?? null,
				p_exclude_title_patterns: params.excludeTitlePatterns ?? [],
				p_tags: normalizeTags(params.tags),
				p_limit: params.limit,
				p_include_archived: params.includeArchived ?? false,
				p_excluded_subtypes: params.excludedSubtypes ?? [],
				p_with_count: params.withCount,
				p_exclude_robot_authored: params.excludeRobotAuthored ?? true,
			};
			let { data, error } = await options.client.rpc("search_unconsumed_artifacts", baseParams);
			let timedOutCount = false;
			if (error && error.message?.includes("statement timeout") && params.withCount) {
				if (params.tierRole) {
					console.warn(
						`[knowledge_search] statement timeout ranking tier ${params.tierRole}; retrying without count`,
					);
				} else {
					console.warn("[knowledge_search] exact count timed out; retrying without count");
				}
				const retry = await options.client.rpc("search_unconsumed_artifacts", {
					...baseParams,
					p_limit: params.retryLimit ?? params.limit,
					p_with_count: false,
				});
				data = retry.data;
				error = retry.error;
				timedOutCount = true;
			}
			if (error) {
				if (params.tierRole) {
					throw new Error(`Search failed ranking the ${params.tierRole} tier: ${error.message}`);
				}
				throw new Error(`Search failed: ${error.message}`);
			}
			return { rows: (data ?? []) as UnconsumedRow[], timedOutCount };
		},
	};
}

