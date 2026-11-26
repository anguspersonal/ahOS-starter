/**
 * Ports for automated entity derivation (ADR-101 §3).
 *
 * Types only. The action is written against these; adapters live in
 * `core/adapters/derive/` and are wired by a composition root. Every method
 * throws on a failed read or write; none swallows errors, and every method is
 * scoped to the owning `userId`.
 */

import type { CandidateArtifact, ExtractedEntity } from "./derive.js";
import type { DecisionConfidenceBand, DecisionJudgePort } from "../../ports/decisionJudge.js";

/** Persisted under `artifacts.processing_metadata.derivation`. */
export interface DerivationRecord {
	derived_at: string;
	status: "completed" | "skipped" | "failed";
	attempts: number;
	provider?: string;
	model?: string;
	entities_count?: number;
	entities_created?: number;
	relationships_count?: number;
	skip_reason?: string;
	error?: string;
}

export interface DeriveLlmRequest {
	system: string;
	prompt: string;
	provider?: "gemini" | "anthropic";
	model?: string;
}

export interface DeriveLlmResponse {
	text: string;
	provider: "gemini" | "anthropic";
	model: string;
}

export interface DeriveDecisionRecord {
	userId: string;
	artifactId: string;
	provider: string;
	model: string;
	confidence: number | null;
	entities: Array<{ id: string; title: string; entity_type: string; created: boolean; confidence?: number }>;
	relationships: Array<{ from: string; to: string; relationship_type: string }>;
	status?: "auto_applied" | "pending";
	requires_user_action?: boolean;
	user_visible?: boolean;
	review_type?: "suggestion" | "clarification" | "conflict" | "approval";
	confidence_band?: DecisionConfidenceBand;
	judge_probabilities?: Record<string, number>;
}

export interface EntityDerivePorts {
	/**
	 * One page of non-archived, content-bearing artifacts whose derivation is not
	 * `completed` or `skipped` (filtered in SQL), newest first.
	 */
	fetchCandidatePage(options: { userId: string; offset: number; pageSize: number }): Promise<CandidateArtifact[]>;
	/** Explicitly requested artifacts, owned by `userId`. */
	fetchArtifactsByIds(userId: string, ids: string[]): Promise<CandidateArtifact[]>;
	/** Count of artifacts still awaiting derivation (SQL-filtered, approximate). */
	countUnderived(userId: string): Promise<number>;
	generate(request: DeriveLlmRequest): Promise<DeriveLlmResponse>;
	/** Optional logprob judge (#2121) for noul pre-filtering and calibrated entity confidence. */
	judge?: DecisionJudgePort;
	/** Exact (case-sensitive, non-pattern) lookup of an existing entity id. */
	findEntity(userId: string, entityType: string, title: string): Promise<string | null>;
	createEntity(userId: string, entity: ExtractedEntity): Promise<string>;
	linkArtifactEntity(userId: string, artifactId: string, entityId: string, confidence: number): Promise<void>;
	createRelationship(
		userId: string,
		rel: {
			fromEntityId: string;
			toEntityId: string;
			relationshipType: string;
			confidence: number;
			artifactId: string;
		},
	): Promise<void>;
	/** Merges only the `derivation` key into processing_metadata; throws if no row was updated. */
	saveDerivation(userId: string, artifactId: string, derivation: DerivationRecord): Promise<void>;
	/** Records the machine decision in `system_decisions` (ADR-079 / ADR-101 §4). */
	recordDecision(decision: DeriveDecisionRecord): Promise<void>;
}

