import type { DomainResolution } from "./entities.js";

export type { DomainResolution };

export interface GraphEntityRow {
	id: string;
	entity_type: string;
	title: string;
	properties: Record<string, unknown> | null;
	archived?: boolean | null;
}

export interface GraphEdgeRow {
	from_entity_id: string;
	to_entity_id: string;
	relationship_type: string;
	confidence_score: number | null;
	metadata: unknown;
	notes?: string | null;
	valid_from: string | null;
	valid_to: string | null;
}

export interface GraphTraversedEdge {
	from: string;
	to: string;
	type: string;
	confidence: number | null;
	metadata: Record<string, unknown> | null;
	notes?: string | null;
	valid_from: string | null;
	valid_to: string | null;
}

export interface GraphArtifactLinkRow {
	entity_id: string;
	artifact_id: string;
	link_type: string | null;
	confidence_score: number | null;
}

export interface GraphArtifactRow {
	id: string;
	title: string | null;
	created_at: string;
}

export interface GraphStartingEntitiesFilter {
	entity_type?: string;
	title_contains?: string;
	properties_match?: Record<string, unknown>;
	limit: number;
}

export interface GraphEdgeTraversalOptions {
	includeArchivedEdges?: boolean;
	edgeTypes?: ReadonlySet<string> | null;
	asOf?: string;
}

export interface GraphReadPort {
	getStartingEntityById(id: string, userId: string): Promise<GraphEntityRow | null>;
	queryStartingEntities(filter: GraphStartingEntitiesFilter, userId: string): Promise<GraphEntityRow[]>;
	getOutEdges(
		frontierIds: readonly string[],
		userId: string,
		options?: GraphEdgeTraversalOptions,
	): Promise<GraphEdgeRow[]>;
	getInEdges(
		frontierIds: readonly string[],
		userId: string,
		options?: GraphEdgeTraversalOptions,
	): Promise<GraphEdgeRow[]>;
	getInstanceOfEdges(frontierIds: readonly string[], userId: string): Promise<GraphEdgeRow[]>;
	getNodesByIds(ids: readonly string[], userId: string): Promise<GraphEntityRow[]>;
	getArtifactLinks(entityIds: readonly string[], userId: string): Promise<GraphArtifactLinkRow[]>;
	getArtifactsByIds(artifactIds: readonly string[], userId: string): Promise<GraphArtifactRow[]>;
	resolveDomains(ids: readonly string[], userId: string): Promise<Map<string, DomainResolution>>;
}
