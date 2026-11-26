import type { Domain } from "../domain/domains.js";

/**
 * Per-layer status for the 5-layer Clean State contract (ADR-114, #1997).
 */
export type CleanStateLayerStatus = "ok" | "warn" | "fail";

/**
 * Overall verdict across evaluated layers and artifacts.
 */
export type CleanStateVerdict = "ok" | "warn" | "fail";

/**
 * The five Clean State layer results for a single artifact.
 */
export interface CleanStateLayers {
	layer1_artifact_integrity: CleanStateLayerStatus;
	layer2_graph_hygiene: CleanStateLayerStatus;
	layer3_task_parity: CleanStateLayerStatus;
	layer4_synthesis_alignment: CleanStateLayerStatus;
	layer5_ledger_health: CleanStateLayerStatus;
}

/**
 * Per-artifact Clean State evaluation result.
 */
export interface CleanStateArtifactEvaluation {
	id: string;
	title: string;
	layers: CleanStateLayers;
	missing: string[];
}

/**
 * Structured output returned by the `clean_state_check` action.
 */
export interface CleanStateCheckResult {
	clean: boolean;
	verdict: CleanStateVerdict;
	artifacts: CleanStateArtifactEvaluation[];
	text: string;
}

/**
 * External link row attached to an artifact in `artifact_external_links`.
 */
export interface CleanStateExternalLink {
	id?: string;
	kind: string;
	url?: string | null;
	title?: string | null;
	metadata?: Record<string, unknown> | null;
}

/**
 * Graph entity link row attached to an artifact in `artifact_entity_links`.
 */
export interface CleanStateEntityLink {
	entity_id: string;
	relationship_type: string;
	entity_type?: string | null;
	entity_title?: string | null;
}

/**
 * Normalized snapshot of an artifact and its graph/external lineage used to
 * evaluate Layers 1–4 of the Clean State contract.
 */
export interface CleanStateArtifactSnapshot {
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
	has_embedding: boolean;
	derivation_status?: string | null;
	processing_metadata?: Record<string, unknown> | null;
	domain?: Domain | null;
	external_links: CleanStateExternalLink[];
	entity_links: CleanStateEntityLink[];
	structural_relationship_count: number;
}

/**
 * Summary of an unresolved `action_ledger` failure (`status = 'error'`).
 */
export interface CleanStateLedgerErrorRow {
	id: string;
	action_id: string;
	created_at: string;
	error_code?: string | null;
}

/**
 * Layer 5 (`action_ledger`) health summary for the target session or window.
 */
export interface CleanStateLedgerSummary {
	error_count: number;
	failed_actions?: CleanStateLedgerErrorRow[];
}

/**
 * Query parameters passed to `CleanStatePort.loadEvaluationData`.
 */
export interface CleanStateCheckQuery {
	userId: string;
	artifactId?: string;
	domain?: Domain;
	windowDays?: number;
	sessionId?: string;
}

/**
 * Data bundle returned by `CleanStatePort.loadEvaluationData`.
 */
export interface CleanStateEvaluationData {
	artifacts: CleanStateArtifactSnapshot[];
	ledger: CleanStateLedgerSummary;
}

/**
 * Port interface for loading artifact, graph, external link, and ledger state
 * to evaluate the 5-layer Clean State contract (ADR-114, #1997).
 */
export interface CleanStatePort {
	loadEvaluationData(query: CleanStateCheckQuery): Promise<CleanStateEvaluationData>;
}
