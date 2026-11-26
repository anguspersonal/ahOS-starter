import type { Domain } from "../domain/domains.js";

export const MAX_URL_EXCLUDE_IDS = 150;
export const SEARCH_ARTIFACT_SELECT =
	"id, title, plain_text, created_at, captured_at, effective_at, lifecycle_stage, tags, content_subtype, surface, source_channel";
export const GRAPH_SELECT = "id, title, description, aliases, properties";
export const GRAPH_SELECT_LEGACY = "id, title, description, properties";
export const ENRICHED_STAGES = [
	"uploaded",
	"upload_failed",
	"processing",
	"analysed",
	"analysis_failed",
	"needs_review",
	"entities_extracted",
	"actions_extracted",
	"artifacts_created",
	"complete",
	"blocked",
	"archived",
	"extracted",
	"contextualized",
	"actionable",
	"refined",
	"processed",
] as const;

export type Row = {
	id: string;
	title: string | null;
	plain_text: string | null;
	created_at: string;
	captured_at: string | null;
	effective_at: string | null;
	lifecycle_stage: string | null;
	tags: string[] | null;
	content_subtype: string | null;
	surface?: string | null;
	source_channel?: string | null;
};

export type UnconsumedRow = Row & { total_count?: number };

export type GraphRow = {
	id: string;
	title: string | null;
	description: string | null;
	aliases?: string[] | null;
	properties?: Record<string, unknown> | null;
};

export type GraphKind = "entity" | "person";
export type SearchMode = "hybrid" | "full-text-only";

export interface FtsSearchArtifactsParams {
	query: string;
	matchLimit: number;
	includeArchived?: boolean;
	tags?: string[] | null;
	userId?: string;
}

export interface HybridSearchArtifactsParams extends FtsSearchArtifactsParams {
	queryEmbedding: string | number[];
}

export interface SearchGraphParams {
	kind: GraphKind;
	mode: SearchMode;
	query: string;
	queryEmbedding?: string | number[];
	matchLimit: number;
	includeArchived?: boolean;
	userId?: string;
}

export interface FilterArtifactsParams {
	includeArchived?: boolean;
	excludedSubtypes?: string[];
	capturedAfter?: string;
	capturedBefore?: string;
	consumedIds?: string[];
	tags?: string[] | null;
	excludeUnenriched?: boolean;
	roleOrFilter?: string;
	excludeNarrativeRobotTitles?: boolean;
	excludeRobotAuthored?: boolean;
	withCount?: boolean;
	retryLimit?: number;
	tierRole?: string;
	limit?: number;
	head?: boolean;
	userId?: string;
}

export interface FindConsumedArtifactIdsParams {
	consumingKinds?: string[];
	domain?: Domain;
	capturedAfter?: string;
	capturedBefore?: string;
	candidateIds?: string[];
	userId?: string;
}

export interface SearchUnconsumedArtifactsParams {
	consumingKinds?: string[];
	domain?: Domain;
	capturedAfter?: string;
	capturedBefore?: string;
	includeDiscovered?: boolean;
	roleHitKeys?: string[] | null;
	roleAllKeys?: string[] | null;
	roleDefaultHit?: boolean;
	roleOverrideTags?: string[] | null;
	excludeTitlePatterns?: string[];
	excludeRobotAuthored?: boolean;
	tags?: string[] | null;
	limit: number;
	retryLimit?: number;
	tierRole?: string;
	includeArchived?: boolean;
	excludedSubtypes?: string[];
	withCount: boolean;
	userId?: string;
}

export interface SearchPort {
	ftsSearchArtifacts(params: FtsSearchArtifactsParams): Promise<Row[]>;
	hybridSearchArtifacts(params: HybridSearchArtifactsParams): Promise<Row[]>;
	searchGraph(params: SearchGraphParams): Promise<GraphRow[]>;
	filterArtifacts(params: FilterArtifactsParams): Promise<{ rows: Row[]; count: number | null }>;
	findConsumedArtifactIds(params: FindConsumedArtifactIdsParams): Promise<string[]>;
	searchUnconsumedArtifacts?(
		params: SearchUnconsumedArtifactsParams,
	): Promise<{ rows: UnconsumedRow[]; timedOutCount?: boolean }>;
}

