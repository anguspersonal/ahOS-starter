import type { SupabaseClient } from "@supabase/supabase-js";
import { loadDosConfig } from "../../domain/dosConfig.js";
import {
	fetchPrimaryParentsBatch,
	resolveEntityDomainSafely,
} from "../../domain/entityDomain.js";
import type {
	DomainResolution,
	GraphArtifactLinkRow,
	GraphArtifactRow,
	GraphEdgeRow,
	GraphEdgeTraversalOptions,
	GraphEntityRow,
	GraphReadPort,
	GraphStartingEntitiesFilter,
} from "../../ports/graphRead.js";
import { createSupabaseConfigRepository, type ConfigSupabaseClient } from "./config.js";
import { createSupabaseEntityRepository, type EntitiesSupabaseClient } from "./entities.js";

export type GraphReadSupabaseClient = Pick<SupabaseClient, "from">;

export interface SupabaseGraphReadAdapterOptions {
	client: GraphReadSupabaseClient;
}

const EDGE_SELECT =
	"from_entity_id, to_entity_id, relationship_type, confidence_score, metadata, valid_from, valid_to";
const REAL_EDGE_SELECT = `${EDGE_SELECT}, notes`;

export function createSupabaseGraphReadAdapter(
	options: SupabaseGraphReadAdapterOptions,
): GraphReadPort {
	const { client } = options;

	return {
		async getStartingEntityById(id: string, userId: string): Promise<GraphEntityRow | null> {
			const { data, error } = await client
				.from("entities")
				.select("id, entity_type, title, properties")
				.eq("user_id", userId)
				.eq("id", id)
				.maybeSingle();
			if (error) throw new Error(`Lookup failed: ${error.message}`);
			return (data as GraphEntityRow | null) ?? null;
		},

		async queryStartingEntities(
			filter: GraphStartingEntitiesFilter,
			userId: string,
		): Promise<GraphEntityRow[]> {
			let q = client
				.from("entities")
				.select("id, entity_type, title, properties")
				.eq("user_id", userId)
				.eq("archived", false);
			if (filter.entity_type) q = q.eq("entity_type", filter.entity_type);
			if (filter.title_contains) q = q.ilike("title", `%${filter.title_contains}%`);
			if (filter.properties_match) q = q.contains("properties", filter.properties_match);
			const { data, error } = await q.limit(filter.limit);
			if (error) throw new Error(`Query failed: ${error.message}`);
			return (data ?? []) as GraphEntityRow[];
		},

		async getOutEdges(
			frontierIds: readonly string[],
			_userId: string,
			traversalOptions?: GraphEdgeTraversalOptions,
		): Promise<GraphEdgeRow[]> {
			let outQ = client
				.from("entity_relationships")
				.select(REAL_EDGE_SELECT)
				.in("from_entity_id", [...frontierIds]);
			if (!traversalOptions?.includeArchivedEdges) {
				outQ = outQ.eq("archived", false);
			}
			const { data, error } = await outQ;
			if (error) throw new Error(`Edge query failed: ${error.message}`);
			return (data ?? []) as GraphEdgeRow[];
		},

		async getInEdges(
			frontierIds: readonly string[],
			_userId: string,
			traversalOptions?: GraphEdgeTraversalOptions,
		): Promise<GraphEdgeRow[]> {
			let incQ = client
				.from("entity_relationships")
				.select(REAL_EDGE_SELECT)
				.in("to_entity_id", [...frontierIds]);
			if (!traversalOptions?.includeArchivedEdges) {
				incQ = incQ.eq("archived", false);
			}
			const { data, error } = await incQ;
			if (error) throw new Error(`Edge query failed: ${error.message}`);
			return (data ?? []) as GraphEdgeRow[];
		},

		async getInstanceOfEdges(
			frontierIds: readonly string[],
			_userId: string,
		): Promise<GraphEdgeRow[]> {
			const { data, error } = await client
				.from("graph_instance_of")
				.select(EDGE_SELECT)
				.in("from_entity_id", [...frontierIds]);
			if (error) throw new Error(`instance_of query failed: ${error.message}`);
			return (data ?? []) as GraphEdgeRow[];
		},

		async getNodesByIds(ids: readonly string[], userId: string): Promise<GraphEntityRow[]> {
			const { data, error } = await client
				.from("entities")
				.select("id, entity_type, title, properties, archived")
				.eq("user_id", userId)
				.in("id", [...ids]);
			if (error) throw new Error(`Node fetch failed: ${error.message}`);
			return (data ?? []) as GraphEntityRow[];
		},

		async getArtifactLinks(
			entityIds: readonly string[],
			_userId: string,
		): Promise<GraphArtifactLinkRow[]> {
			const { data, error } = await client
				.from("artifact_entity_links")
				.select("entity_id, artifact_id, link_type, confidence_score")
				.in("entity_id", [...entityIds]);
			if (error) throw new Error(`Link fetch failed: ${error.message}`);
			return (data ?? []) as GraphArtifactLinkRow[];
		},

		async getArtifactsByIds(
			artifactIds: readonly string[],
			userId: string,
		): Promise<GraphArtifactRow[]> {
			if (artifactIds.length === 0) return [];
			const { data, error } = await client
				.from("artifacts")
				.select("id, title, created_at")
				.eq("user_id", userId)
				.eq("archived", false)
				.in("id", [...artifactIds]);
			if (error) throw new Error(`Artifact fetch failed: ${error.message}`);
			return (data ?? []) as GraphArtifactRow[];
		},

		async resolveDomains(
			ids: readonly string[],
			userId: string,
		): Promise<Map<string, DomainResolution>> {
			const entityRepo = createSupabaseEntityRepository({
				client: client as EntitiesSupabaseClient,
				ownerId: userId,
			});
			const configRepo = createSupabaseConfigRepository({
				client: client as ConfigSupabaseClient,
				ownerId: userId,
			});
			const [dosConfig, primaryParents] = await Promise.all([
				loadDosConfig(configRepo),
				fetchPrimaryParentsBatch(entityRepo, [...ids]),
			]);
			const domains = await Promise.all(
				ids.map((id) => resolveEntityDomainSafely(entityRepo, id, { dosConfig, primaryParents })),
			);
			return new Map(ids.map((id, i) => [id, domains[i]]));
		},
	};
}
