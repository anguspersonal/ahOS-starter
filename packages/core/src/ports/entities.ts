import type { ActionContext } from "../actions/types.js";
import type {
	EntityCrudInput,
	EntitiesCrudResult,
	EntityBulkDeleteResult,
	EntityCreateResult,
	EntityGetResult,
	EntityQueryResult,
	EntityUpdateResult,
	EntityDeleteResult,
	EntityUpsertResult,
	EntityRow,
	EntitiesFilterInput,
	DomainResolution,
	ResolvedBy,
	EntityBulkDeleteInput,
	EntityCreateInput,
	EntityGetInput,
	EntityQueryInput,
	EntityUpdateInput,
	EntityDeleteInput,
	EntityUpsertInput,
} from "../actions/domain/entities.js";
import type { RelationshipRecord } from "../actions/domain/relationships.js";

export type {
	EntityRow,
	EntityCreateResult,
	EntityGetResult,
	EntityQueryResult,
	EntityUpdateResult,
	EntityDeleteResult,
	EntityBulkDeleteResult,
	EntityUpsertResult,
	EntitiesCrudResult,
	EntitiesFilterInput,
	DomainResolution,
	ResolvedBy,
	EntityBulkDeleteInput,
	EntityCreateInput,
	EntityGetInput,
	EntityQueryInput,
	EntityUpdateInput,
	EntityDeleteInput,
	EntityUpsertInput,
};

export const HARD_DELETE_APPROVAL_THRESHOLD = 50;
export interface EntityHardDeleteCheckInput {
	operation?: EntityCrudInput["operation"]; id?: string; ids?: string[];
	filter?: EntitiesFilterInput; archive_only?: boolean; dry_run?: boolean;
}

export interface EntitiesPort {
	entityCrud(input: EntityCrudInput, ctx?: ActionContext): Promise<EntitiesCrudResult>;
	entityBulkDelete(input: EntityBulkDeleteInput, ctx?: ActionContext): Promise<EntityBulkDeleteResult>;
	entityCreate(input: EntityCreateInput, ctx?: ActionContext): Promise<EntityCreateResult>;
	entityGet(input: EntityGetInput, ctx?: ActionContext): Promise<EntityGetResult>;
	entityQuery(input: EntityQueryInput, ctx?: ActionContext): Promise<EntityQueryResult>;
	entityUpdate(input: EntityUpdateInput, ctx?: ActionContext): Promise<EntityUpdateResult>;
	entityDelete(input: EntityDeleteInput, ctx?: ActionContext): Promise<EntityDeleteResult>;
	entityUpsert(input: EntityUpsertInput, ctx?: ActionContext): Promise<EntityUpsertResult>;
	needsHardDeleteApproval?(input: EntityHardDeleteCheckInput, userId?: string): boolean | Promise<boolean>;
}

export type EntityInsertInput = EntityCreateInput["entities"][number];
export type EntityPatchInput = EntityUpdateInput["patch"];
export type EntityLoadFilter = EntitiesFilterInput & {
	properties_contains?: Record<string, unknown>;
};
export type EntityLoadResult = { rows: EntityRow[]; truncated: boolean };

export type EntityDomainRow = {
	id: string;
	title: string | null;
	description: string | null;
	tags: string[] | null;
	properties: Record<string, unknown> | null;
	domain_override: string | null;
};

export type PromotableEdgeRow = {
	id: string;
	from_entity_id: string;
	to_entity_id: string;
	relationship_type: string;
	valid_from: string | null;
	valid_to: string | null;
	archived: boolean | null;
};

export type ArrangementNodeInsertRow = {
	id: string;
	entity_type: "arrangement";
	title: string;
	description: string | null;
	properties: Record<string, unknown>;
	tags: string[];
	archived: boolean;
	user_id: string;
	team_id: string | null;
};

export type ParticipantEdgeInsertRow = {
	user_id: string;
	from_entity_id: string;
	to_entity_id: string;
	relationship_type: string;
	confidence_score: number | null;
	metadata: Record<string, unknown>;
	created_by: string;
	notes: string;
	valid_from: string | null;
	valid_to: string | null;
};

export type ProvenanceLinkInsertRow = {
	user_id: string;
	artifact_id: string;
	entity_id: string;
	link_type: string;
	confidence_score: number | null;
	created_by: string;
	notes: string | null;
};

export type TrackedEntityRow = {
	id: string;
	title: string | null;
	aliases?: string[] | null;
	properties: Record<string, unknown> | null;
	archived: boolean | null;
};

export interface FindTrackedResourcesFilter {
	entity_id?: string;
	include_archived?: boolean;
	limit?: number;
}

export type EntityEndpointRow = {
	id: string;
	entity_type?: string | null;
};

export type PrimaryContainmentEdgeRow = {
	id: string;
	to_entity_id: string;
};

export type ExistingRelationshipEdgeRow = {
	id: string;
	archived?: boolean | null;
	valid_from?: string | null;
	valid_to?: string | null;
	confidence_score?: number | null;
	metadata?: unknown;
	notes?: string | null;
};

export type SupersessionRelationshipEdgeRow = {
	id: string;
	user_id?: string;
	valid_from: string | null;
	valid_to: string | null;
	metadata: unknown;
};

export type RelationshipEdgeUpdatePatch = {
	confidence_score?: number | null;
	metadata?: Record<string, unknown>;
	notes?: string | null;
	valid_from?: string | null;
	valid_to?: string | null;
	archived?: boolean;
};

export type RelationshipEdgeInsertInput = {
	from_entity_id: string;
	to_entity_id: string;
	relationship_type: string;
	confidence_score: number | null;
	metadata: Record<string, unknown>;
	created_by: string;
	notes: string | null;
	valid_from: string | null;
	valid_to: string | null;
};

export type SyncEntityRow = {
	id: string;
	entity_type: string;
	title: string | null;
	description: string | null;
	archived: boolean | null;
	properties: Record<string, unknown> | null;
	tags: string[] | null;
	aliases?: string[] | null;
};

export type SyncEntityCreateInput = {
	id: string;
	entity_type: string;
	title: string;
	description: string | null;
	tags: string[];
	properties: Record<string, unknown>;
};

export interface EntityRepository {
	getById(id: string, userId?: string): Promise<EntityRow | null>;
	loadRows(filter: EntityLoadFilter, userId?: string): Promise<EntityLoadResult>;
	insert(items: readonly EntityInsertInput[], userId?: string): Promise<EntityRow[]>;
	update(ids: string | readonly string[], patch: EntityPatchInput, userId?: string): Promise<EntityRow[]>;
	mutateByIds(
		ids: readonly string[],
		archiveOnly: boolean,
		userId?: string,
	): Promise<Array<{ id: string; title: string | null }>>;
	getDomainRow(id: string, userId?: string): Promise<EntityDomainRow | null>;
	fetchPrimaryParentId(id: string, userId?: string): Promise<string | null>;
	fetchPrimaryParentsBatch(ids: readonly string[], userId?: string): Promise<Map<string, string>>;
	getEdgeById(edgeId: string, userId?: string): Promise<PromotableEdgeRow | null>;
	findOwnedEntityIds(ids: readonly string[], userId?: string): Promise<Set<string>>;
	insertArrangementNodes(rows: readonly ArrangementNodeInsertRow[], userId?: string): Promise<void>;
	insertParticipantEdges(rows: readonly ParticipantEdgeInsertRow[], userId?: string): Promise<void>;
	insertProvenanceLinks(rows: readonly ProvenanceLinkInsertRow[], userId?: string): Promise<void>;
	archiveEdge(edgeId: string, userId?: string): Promise<void>;
	findEntityEndpoints?(ids: readonly string[], userId?: string): Promise<EntityEndpointRow[]>;
	findLivePrimaryContainmentEdges?(
		fromEntityId: string,
		userId?: string,
	): Promise<PrimaryContainmentEdgeRow[]>;
	findRelationshipEdge?(
		fromEntityId: string,
		toEntityId: string,
		relationshipType: string,
		userId?: string,
	): Promise<ExistingRelationshipEdgeRow | null>;
	archiveEdgesByIds?(edgeIds: readonly string[], userId?: string): Promise<void>;
	getRelationshipForSupersession?(
		edgeId: string,
		userId?: string,
	): Promise<SupersessionRelationshipEdgeRow | null>;
	updateRelationshipEdge?(
		edgeId: string,
		patch: RelationshipEdgeUpdatePatch,
		userId?: string,
	): Promise<void>;
	insertRelationshipEdge?(
		row: RelationshipEdgeInsertInput,
		userId?: string,
	): Promise<{ id: string }>;
	getRelationship?(id: string, userId?: string): Promise<RelationshipRecord | null>;
	queryRelationships?(filter: RelationshipQueryFilter, userId?: string): Promise<RelationshipRecord[]>;
	insertRelationship?(row: RelationshipInsertRow, userId?: string): Promise<RelationshipRecord>;
	updateRelationship?(
		id: string,
		patch: RelationshipUpdatePatch,
		userId?: string,
	): Promise<RelationshipRecord | null>;
	deleteRelationships?(target: RelationshipDeleteTarget, userId?: string): Promise<void>;
	findTrackedResources(
		filter: FindTrackedResourcesFilter,
		userId?: string,
	): Promise<TrackedEntityRow[]>;
	getTitleById(id: string, userId?: string): Promise<string | null>;
	findExactForSync?(
		query: { id?: string; entity_type: string; title: string; place_type?: string | null },
		userId?: string,
	): Promise<SyncEntityRow | null>;
	findSyncCandidates?(
		query: { entity_type: string; title: string },
		userId?: string,
	): Promise<SyncEntityRow[]>;
	/**
	 * Active (non-archived) entities of one type whose title equals the trimmed
	 * `title`, ignoring case. The match runs in the query, so it is not subject to
	 * the `loadRows` scan window or its substring search (#2294). A stored title
	 * with leading or trailing whitespace is not matched. Newest first.
	 */
	findByExactTitle?(
		query: { entity_type: string; title: string; limit?: number },
		userId?: string,
	): Promise<EntityRow[]>;
	createForSync?(
		input: SyncEntityCreateInput,
		userId?: string,
	): Promise<{ created: SyncEntityRow | null; conflict: boolean }>;
	getHotTierCandidates?(
		params: HotTierCandidatesParams,
		userId?: string,
	): Promise<HotTierCandidatesResult>;
}

export type HotTierCandidateRow = {
	id: string;
	entity_type: string;
	title: string;
	aliases: string[];
	mentions: number;
	last_mention_at: string;
};

export type HotTierCandidatesParams = {
	windowStart: string;
	minMentions: number;
	limit: number;
	quietStart: string;
	excludedSurfaces: readonly string[];
	entityTypes: readonly string[];
};

export type HotTierCandidatesResult = {
	hot_count: number;
	candidates: HotTierCandidateRow[];
};

export interface RelationshipInsertRow {
	id: string;
	from_entity_id: string;
	to_entity_id: string;
	relationship_type: string;
	confidence_score: number;
	metadata: Record<string, unknown>;
}

export interface RelationshipQueryFilter {
	entity_id?: string;
	direction?: "outgoing" | "incoming" | "both";
	relationship_type?: string;
	limit?: number;
}

export interface RelationshipUpdatePatch {
	updated_at: string;
	relationship_type?: string;
	confidence_score?: number;
	metadata?: Record<string, unknown>;
}

export type RelationshipDeleteTarget =
	| { id: string }
	| { from_entity_id: string; to_entity_id: string; relationship_type?: string };

export interface ArtifactEntityLinkRow {
	id: string;
	artifact_id: string;
	entity_id: string;
	link_type: string | null;
	confidence_score: number | null;
	created_by: string | null;
	notes: string | null;
	created_at: string;
}

export interface ArtifactEntityLinkQueryFilter {
	artifact_id?: string;
	entity_id?: string;
	link_type?: string;
	limit?: number;
}

export interface ArtifactEntityLinkInput {
	artifact_id: string;
	entity_id: string;
	link_type?: string;
	confidence_score?: number;
	created_by?: string;
	notes?: string;
}

export interface LinkRepository {
	get(id: string, userId?: string): Promise<ArtifactEntityLinkRow | null>;
	query(
		filter: ArtifactEntityLinkQueryFilter,
		userId?: string,
	): Promise<ArtifactEntityLinkRow[]>;
	create?(
		links: readonly ArtifactEntityLinkInput[],
		userId?: string,
	): Promise<Array<{ id: string; artifact_id: string; entity_id: string }>>;
	upsert?(
		links: readonly ArtifactEntityLinkInput[],
		options?: { markArtifactDerived?: boolean; userId?: string },
	): Promise<Array<{ id: string; artifact_id: string; entity_id: string; link_type: string | null }>>;
	delete?(
		id: string,
		userId?: string,
	): Promise<Array<{ id: string; artifact_id: string; entity_id: string }>>;
}
