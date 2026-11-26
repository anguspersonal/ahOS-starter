/**
 * Ports for artifact management and deduplication interactions (ADR-101 §1, §4, ADR-105 R1, R7).
 * Pure types only. No external SDKs, database, or environment dependencies.
 */

import type {
	CaptureInput,
	DocumentDuplicatesInput,
} from "../actions/domain/capture.js";

export type CaptureResult = {
	id: string;
	title: string;
	tags: string[];
	source_channel: string;
	storage_bucket: string;
	storage_path: string;
	captured_at: string;
	captured_at_declared: boolean;
	/**
	 * True when this call matched an existing artifact (#993) and returned ITS id rather
	 * than inserting a new row. `id`/`title`/`tags`/`source_channel`/`storage_bucket`/
	 * `storage_path`/`captured_at` all describe the EXISTING (first) artifact in that case,
	 * not this call's own (never-written) content.
	 */
	deduplicated: boolean;
	/**
	 * True when `options.updateOnDedupKey` matched an existing `dedup_key` row whose
	 * content/message-set grew and updated that artifact in-place (overwriting storage,
	 * resetting derivation status, and re-embedding).
	 */
	updated?: boolean;
};

export interface CaptureOptions {
	/**
	 * When true and `input.dedup_key` matches an existing artifact, check whether the
	 * incoming payload has new messages/content compared to the stored row. If unchanged,
	 * return `{ deduplicated: true, updated: false }`; if grown/changed, overwrite the
	 * artifact's Markdown in storage, update `plain_text` + `processing_metadata` (clearing
	 * `derivation` so `entity_derive` re-runs once on the fuller transcript), re-embed,
	 * and return `{ deduplicated: false, updated: true }`.
	 */
	updateOnDedupKey?: boolean;
}

export type ClusterRow = {
	cluster_kind: "exact" | "version_family";
	cluster_key: string;
	cluster_rank: number;
	member_count: number;
	ranked_members: number;
	distinct_contents: number;
	unhashed_members: number;
	member_rank: number;
	artifact_id: string;
	title: string | null;
	link: string | null;
	connector: string | null;
	external_id: string | null;
	source_created_at: string | null;
	source_modified_at: string | null;
	owner: string | null;
	owner_email: string | null;
	content_hash: string | null;
	content_hash_kind: "md5" | "modified_time" | null;
	owned_by_self: boolean;
	enriched: boolean;
	lifecycle_stage: string | null;
	archived: boolean;
	archived_reason: string | null;
};

export type Cluster = {
	kind: ClusterRow["cluster_kind"];
	key: string;
	memberCount: number;
	rankedMembers: number;
	distinctContents: number;
	unhashedMembers: number;
	members: ClusterRow[];
};

export interface DocumentDuplicatesResult {
	rows: ClusterRow[];
	clusters: Cluster[];
	args: DocumentDuplicatesInput;
}

export interface DuplicateClustersParams {
	userId?: string;
	query?: string | null;
	connector?: string | null;
	min_cluster?: number;
	limit?: number;
	include_archived?: boolean;
}

export interface CapturePort {
	capture(input: CaptureInput, userId?: string, options?: CaptureOptions): Promise<CaptureResult>;
}

export interface DocumentDuplicatesPort {
	documentDuplicates(input: DocumentDuplicatesInput, userId?: string): Promise<DocumentDuplicatesResult>;
}

export interface ArtifactsPort extends CapturePort, DocumentDuplicatesPort {}

export const ARTIFACT_SELECT_COLUMNS =
	"id, title, description, plain_text, tags, lifecycle_stage, source, source_url, source_channel, surface, trust_override, source_drive_file_id, source_parent_folder_ids, source_parent_folder_path, routing_decision, routing_confidence, routing_reason, drive_action, drive_action_at, created_at, storage_bucket, storage_path, storage_url, file_type, file_size, processing_metadata";

export const ARTIFACT_PATCH_SELECT_COLUMNS =
	"id, title, description, plain_text, storage_bucket, storage_path, file_type, routing_decision, drive_action, archived, updated_at";

export type ArtifactRow = {
	id: string;
	title: string | null;
	description: string | null;
	plain_text: string | null;
	tags: string[] | null;
	lifecycle_stage: string | null;
	source: string | null;
	source_url: string | null;
	source_channel: string | null;
	surface: string | null;
	trust_override: string | null;
	source_drive_file_id: string | null;
	source_parent_folder_ids: string[] | null;
	source_parent_folder_path: string | null;
	routing_decision: string | null;
	routing_confidence: number | null;
	routing_reason: string | null;
	drive_action: string | null;
	drive_action_at: string | null;
	created_at: string;
	storage_bucket: string;
	storage_path: string;
	storage_url: string;
	file_type: string | null;
	file_size?: number | null;
	processing_metadata?: unknown;
};

export type LinkedArtifactEntity = {
	title: string;
	entity_type: string;
};

export type ArtifactPatch = {
	source_url?: string | null;
	source_drive_file_id?: string | null;
	source_parent_folder_ids?: string[] | null;
	source_parent_folder_path?: string | null;
	routing_decision?: string | null;
	routing_confidence?: number | null;
	routing_reason?: string | null;
	drive_action?: string | null;
	drive_action_at?: string | null;
	title?: string | null;
	description?: string | null;
	plain_text?: string | null;
	tags?: string[] | null;
	processing_status?: string | null;
	lifecycle_stage?: string | null;
	processing_metadata?: Record<string, unknown> | null;
	archived?: boolean | null;
	archived_at?: string | null;
	archived_reason?: string | null;
	file_size?: number | null;
	content_fingerprint?: string | null;
	[key: string]: unknown;
};

export type ArtifactPatchedRow = {
	id: string;
	title: string | null;
	description: string | null;
	plain_text: string | null;
	storage_bucket: string | null;
	storage_path: string | null;
	file_type: string | null;
	routing_decision: string | null;
	drive_action: string | null;
	archived: boolean | null;
	updated_at: string | null;
};

export type ArtifactSummaryRow = {
	id: string;
	title: string | null;
};

export const ARTIFACT_DEDUP_SELECT_COLUMNS =
	"id, title, tags, source_channel, storage_bucket, storage_path, captured_at, content_fingerprint, processing_metadata";

export type DedupMatch = {
	id: string;
	title: string;
	tags: string[] | null;
	source_channel: string;
	storage_bucket: string;
	storage_path: string;
	captured_at: string;
	content_fingerprint?: string | null;
	processing_metadata?: Record<string, unknown> | null;
};

export type ArtifactInsertRow = {
	id: string;
	user_id: string;
	storage_bucket: string;
	storage_path: string;
	storage_url: string;
	filename: string;
	original_file_name: string;
	file_type: string;
	content_type: string;
	file_extension: string | null;
	file_size: number;
	artifact_type: string;
	captured_at: string;
	originated_at?: string | null;
	surface: string;
	lifecycle_stage: string;
	processing_status: string;
	title: string;
	plain_text: string | null;
	source?: string | null;
	source_url?: string | null;
	source_channel?: string | null;
	source_drive_file_id?: string | null;
	source_parent_folder_ids?: string[] | null;
	source_parent_folder_path?: string | null;
	trust_override?: string | null;
	captured_by?: string | null;
	tags?: string[] | null;
	content_subtype?: string | null;
	urgency?: string | null;
	processing_metadata?: Record<string, unknown> | null;
	dedup_key?: string | null;
	content_fingerprint?: string | null;
};

export type ArtifactInsertedRow = {
	id: string;
	title: string;
	created_at: string;
};

export class ArtifactWriteError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "ArtifactWriteError";
		this.code = code;
	}
}

export const DOCUMENT_RESOLVE_SELECT_COLUMNS =
	"id, title, storage_bucket, storage_url, source_url, source, source_channel, surface, file_type, archived, archived_reason, lifecycle_stage, processing_metadata";

export type DocumentResolveArtifactRow = {
	id: string;
	title: string | null;
	storage_bucket: string | null;
	storage_url: string | null;
	source_url: string | null;
	source: string | null;
	source_channel: string | null;
	surface: string | null;
	file_type: string | null;
	archived: boolean | null;
	archived_reason: string | null;
	lifecycle_stage: string | null;
	processing_metadata: unknown;
};

export type DocEditAuditEntry = {
	timestamp?: string;
	revision_before: string;
	revision_after: string | null;
	request_count: number;
	suggest: boolean;
};

export type LinkedArtifactForEntityRow = {
	entity_id: string;
	artifact_id: string;
	link_type: string | null;
	confidence_score: number | null;
	notes: string | null;
	artifact: {
		id: string;
		title: string | null;
		source: string | null;
		source_channel: string | null;
		source_url: string | null;
		storage_url: string | null;
		file_type: string | null;
		captured_at: string | null;
		originated_at: string | null;
		created_at: string | null;
		archived: boolean | null;
		processing_metadata: unknown;
	};
};

/**
 * Persistence port over `artifacts` and `artifact_entity_links` (ADR-101 §1, #1511, #1611, #1622).
 */
export interface ArtifactRepository {
	getById(id: string): Promise<ArtifactRow | null>;
	getLinkedEntities(artifactId: string): Promise<LinkedArtifactEntity[]>;
	findExistingSources(sources: string[]): Promise<Set<string>>;
	insert(row: ArtifactInsertRow): Promise<ArtifactInsertedRow>;
	findOldestByDedupKey(key: string): Promise<DedupMatch | null>;
	findOldestByFingerprint(fingerprint: string, sinceIso: string): Promise<DedupMatch | null>;
	patch(id: string, patch: ArtifactPatch): Promise<ArtifactPatchedRow>;
	mutateByIds(
		ids: string[],
		archiveOnly: boolean,
		archivedReason?: string | null,
	): Promise<ArtifactSummaryRow[]>;
	archive(ids: string | string[], reason?: string | null): Promise<ArtifactSummaryRow[]>;
	hardDelete(ids: string | string[]): Promise<ArtifactSummaryRow[]>;
	getDocumentsByIds(
		candidateIds: readonly string[],
		userId?: string,
	): Promise<Map<string, DocumentResolveArtifactRow>>;
	getPrimaryLinksForEntities(
		entityIds: readonly string[],
	): Promise<Map<string, string[]>>;
	listLinkedArtifactsForEntities?(
		entityIds: readonly string[],
		userId?: string,
	): Promise<LinkedArtifactForEntityRow[]>;
	searchDocumentTitleCandidates(
		terms: readonly string[],
		limit: number,
		userId?: string,
	): Promise<DocumentResolveArtifactRow[]>;
	duplicateClusters(params?: DuplicateClustersParams): Promise<ClusterRow[]>;
	saveExtractedText?(
		id: string,
		fields: {
			extracted_content: string;
			plain_text: string;
			description: string | null;
			processing_status?: string;
		},
	): Promise<void>;
	appendDocEditAudit?(
		sourceDriveFileId: string,
		entry: DocEditAuditEntry,
	): Promise<void>;
}


