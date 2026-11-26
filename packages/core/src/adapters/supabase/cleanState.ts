import type { SupabaseClient } from "@supabase/supabase-js";
import { DOMAIN_PROVIDER, type Domain } from "../../domain/domains.js";
import type {
	CleanStateArtifactSnapshot,
	CleanStateCheckQuery,
	CleanStateEntityLink,
	CleanStateEvaluationData,
	CleanStateExternalLink,
	CleanStateLedgerErrorRow,
	CleanStatePort,
} from "../../ports/cleanState.js";

export interface SupabaseCleanStateAdapterOptions {
	supabase: SupabaseClient;
}

interface RawArtifactRow {
	id: string;
	title: string | null;
	content: string | null;
	summary?: string | null;
	content_subtype?: string | null;
	surface?: string | null;
	source_channel?: string | null;
	source_url?: string | null;
	source_drive_file_id?: string | null;
	tags?: string[] | null;
	captured_at?: string | null;
	effective_at?: string | null;
	embedding?: unknown;
	derivation_status?: string | null;
	processing_metadata?: Record<string, unknown> | null;
}

function resolveRowDomain(
	row: RawArtifactRow,
	extLinks?: CleanStateExternalLink[],
): Domain | null {
	const metaDomain = row.processing_metadata?.domain;
	if (metaDomain === "angus" || metaDomain === "work") {
		return metaDomain;
	}
	const tags = Array.isArray(row.tags) ? row.tags : [];
	if (tags.includes("domain:work") || tags.includes("work")) return "work";
	if (tags.includes("domain:angus") || tags.includes("angus")) return "angus";
	if (row.surface === DOMAIN_PROVIDER.work) return "work";
	if (row.surface === DOMAIN_PROVIDER.angus) return "angus";
	if (extLinks) {
		for (const ext of extLinks) {
			const provider = ext.metadata?.provider;
			if (provider === DOMAIN_PROVIDER.work) return "work";
			if (provider === DOMAIN_PROVIDER.angus) return "angus";
		}
	}
	return null;
}

/**
 * Creates a Supabase-backed adapter implementing `CleanStatePort` (ADR-114, #1997).
 */
export function createSupabaseCleanStateAdapter(
	options: SupabaseCleanStateAdapterOptions,
): CleanStatePort {
	const { supabase } = options;

	return {
		async loadEvaluationData(query: CleanStateCheckQuery): Promise<CleanStateEvaluationData> {
			const windowDays = query.windowDays ?? 7;
			const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

			let artifactReq = supabase
				.from("artifacts")
				.select(
					"id, title, content, summary, content_subtype, surface, source_channel, source_url, source_drive_file_id, tags, captured_at, effective_at, embedding, derivation_status, processing_metadata",
				)
				.eq("user_id", query.userId);

			if (query.artifactId) {
				artifactReq = artifactReq.eq("id", query.artifactId);
			} else {
				artifactReq = artifactReq
					.gte("captured_at", sinceIso)
					.order("captured_at", { ascending: false })
					.limit(50);
			}

			const { data: rawArtifacts, error: artifactErr } = await artifactReq;
			if (artifactErr) {
				throw new Error(`clean_state_check failed reading artifacts: ${artifactErr.message}`);
			}

			let rows = (rawArtifacts ?? []) as RawArtifactRow[];
			if (!query.artifactId && query.domain) {
				rows = rows.filter((r) => resolveRowDomain(r) === query.domain);
			}

			const artifactIds = rows.map((r) => r.id);
			const externalLinksByArtifact = new Map<string, CleanStateExternalLink[]>();
			const entityLinksByArtifact = new Map<string, CleanStateEntityLink[]>();
			const structuralCountByArtifact = new Map<string, number>();

			if (artifactIds.length > 0) {
				const [extRes, entLinkRes] = await Promise.all([
					supabase
						.from("artifact_external_links")
						.select("id, artifact_id, provider, kind, external_id, external_url, dedup_key")
						.eq("user_id", query.userId)
						.in("artifact_id", artifactIds),
					supabase
						.from("artifact_entity_links")
						.select("artifact_id, entity_id, relationship_type")
						.eq("user_id", query.userId)
						.in("artifact_id", artifactIds),
				]);

				if (extRes.error) {
					throw new Error(
						`clean_state_check failed reading artifact_external_links: ${extRes.error.message}`,
					);
				}
				if (entLinkRes.error) {
					throw new Error(
						`clean_state_check failed reading artifact_entity_links: ${entLinkRes.error.message}`,
					);
				}

				for (const ext of (extRes.data ?? []) as Array<{
					id: string;
					artifact_id: string;
					provider?: string | null;
					kind: string;
					external_id?: string | null;
					external_url?: string | null;
					dedup_key?: string | null;
				}>) {
					const list = externalLinksByArtifact.get(ext.artifact_id) ?? [];
					list.push({
						id: ext.id,
						kind: ext.kind,
						url: ext.external_url ?? null,
						title: ext.dedup_key ?? null,
						metadata: {
							provider: ext.provider ?? null,
							external_id: ext.external_id ?? null,
						},
					});
					externalLinksByArtifact.set(ext.artifact_id, list);
				}

				const rawEntLinks = (entLinkRes.data ?? []) as Array<{
					artifact_id: string;
					entity_id: string;
					relationship_type: string;
				}>;

				const allEntityIds = Array.from(new Set(rawEntLinks.map((l) => l.entity_id)));
				const entityMetaById = new Map<string, { title: string | null; entity_type: string | null }>();
				const relRows: Array<{ id: string; source_entity_id: string; target_entity_id: string }> = [];

				if (allEntityIds.length > 0) {
					const [entitiesRes, relSourceRes, relTargetRes] = await Promise.all([
						supabase
							.from("entities")
							.select("id, title, entity_type")
							.eq("user_id", query.userId)
							.in("id", allEntityIds),
						supabase
							.from("entity_relationships")
							.select("id, source_entity_id, target_entity_id")
							.eq("user_id", query.userId)
							.in("source_entity_id", allEntityIds),
						supabase
							.from("entity_relationships")
							.select("id, source_entity_id, target_entity_id")
							.eq("user_id", query.userId)
							.in("target_entity_id", allEntityIds),
					]);

					if (entitiesRes.error) {
						throw new Error(
							`clean_state_check failed reading entities: ${entitiesRes.error.message}`,
						);
					}
					if (relSourceRes.error) {
						throw new Error(
							`clean_state_check failed reading entity_relationships (source): ${relSourceRes.error.message}`,
						);
					}
					if (relTargetRes.error) {
						throw new Error(
							`clean_state_check failed reading entity_relationships (target): ${relTargetRes.error.message}`,
						);
					}

					for (const ent of (entitiesRes.data ?? []) as Array<{
						id: string;
						title: string | null;
						entity_type: string | null;
					}>) {
						entityMetaById.set(ent.id, {
							title: ent.title ?? null,
							entity_type: ent.entity_type ?? null,
						});
					}

					const seenRelIds = new Set<string>();
					for (const rel of [
						...((relSourceRes.data ?? []) as Array<{
							id: string;
							source_entity_id: string;
							target_entity_id: string;
						}>),
						...((relTargetRes.data ?? []) as Array<{
							id: string;
							source_entity_id: string;
							target_entity_id: string;
						}>),
					]) {
						if (!seenRelIds.has(rel.id)) {
							seenRelIds.add(rel.id);
							relRows.push(rel);
						}
					}
				}

				for (const link of rawEntLinks) {
					const meta = entityMetaById.get(link.entity_id);
					const list = entityLinksByArtifact.get(link.artifact_id) ?? [];
					list.push({
						entity_id: link.entity_id,
						relationship_type: link.relationship_type,
						entity_type: meta?.entity_type ?? null,
						entity_title: meta?.title ?? null,
					});
					entityLinksByArtifact.set(link.artifact_id, list);
				}

				for (const artifactId of artifactIds) {
					const links = entityLinksByArtifact.get(artifactId) ?? [];
					const linkedIds = new Set(links.map((l) => l.entity_id));
					let relCount = 0;
					for (const rel of relRows) {
						if (linkedIds.has(rel.source_entity_id) || linkedIds.has(rel.target_entity_id)) {
							relCount += 1;
						}
					}
					structuralCountByArtifact.set(artifactId, relCount);
				}
			}

			let ledgerReq = supabase
				.from("action_ledger")
				.select("id, action_id, created_at, error_code")
				.eq("user_id", query.userId)
				.eq("status", "error");

			if (query.sessionId) {
				ledgerReq = ledgerReq.eq("mcp_session_id", query.sessionId);
			} else {
				ledgerReq = ledgerReq.gte("created_at", sinceIso);
			}

			const { data: ledgerRows, error: ledgerErr } = await ledgerReq
				.order("created_at", { ascending: false })
				.limit(50);

			if (ledgerErr) {
				throw new Error(
					`clean_state_check failed reading action_ledger: ${ledgerErr.message}`,
				);
			}

			const failedActions: CleanStateLedgerErrorRow[] = (
				(ledgerRows ?? []) as Array<{
					id: string;
					action_id: string;
					created_at: string;
					error_code?: string | null;
				}>
			).map((r) => ({
				id: r.id,
				action_id: r.action_id,
				created_at: r.created_at,
				error_code: r.error_code ?? null,
			}));

			const snapshots: CleanStateArtifactSnapshot[] = rows.map((row) => ({
				id: row.id,
				title: row.title ?? null,
				content: row.content ?? null,
				summary: row.summary ?? null,
				content_subtype: row.content_subtype ?? null,
				surface: row.surface ?? null,
				source_channel: row.source_channel ?? null,
				source_url: row.source_url ?? null,
				source_drive_file_id: row.source_drive_file_id ?? null,
				tags: Array.isArray(row.tags) ? row.tags : null,
				captured_at: row.captured_at ?? null,
				effective_at: row.effective_at ?? null,
				has_embedding: row.embedding !== null && row.embedding !== undefined,
				derivation_status: row.derivation_status ?? null,
				processing_metadata: row.processing_metadata ?? null,
				domain: resolveRowDomain(row),
				external_links: externalLinksByArtifact.get(row.id) ?? [],
				entity_links: entityLinksByArtifact.get(row.id) ?? [],
				structural_relationship_count: structuralCountByArtifact.get(row.id) ?? 0,
			}));

			return {
				artifacts: snapshots,
				ledger: {
					error_count: failedActions.length,
					failed_actions: failedActions,
				},
			};
		},
	};
}
