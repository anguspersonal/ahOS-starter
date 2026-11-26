/**
 * Ports for on-demand entity synthesis (ADR-101 §3, #1353).
 *
 * Types only. The action is written against these; adapters live in
 * `core/adapters/synthesize/` and are wired by a composition root.
 * Every read and write is scoped to the owning `userId`.
 */

import type { SynthesizedProfile } from "./synthesize.js";
import type { DeriveLlmRequest, DeriveLlmResponse } from "./derivePorts.js";

export interface SynthesizeEntityRecord {
	id: string;
	title: string;
	entity_type: string;
	description: string | null;
	properties: Record<string, unknown> | null;
	updated_at: string;
}

export interface SynthesizeArtifactRecord {
	id: string;
	title?: string | null;
	plain_text?: string | null;
}

export interface SynthesizeDecisionRecord {
	userId: string;
	entityId: string;
	artifactIds: string[];
	provider: string;
	model: string;
	outcome: "completed" | "skipped" | "conflict" | "error";
	profile?: SynthesizedProfile;
	error?: string;
}

export interface EntitySynthesizePorts {
	/** Fetches the entity record owned by userId, or null if not found. */
	fetchEntity(userId: string, entityId: string): Promise<SynthesizeEntityRecord | null>;

	/** Fetches up to `limit` linked artifacts with content for the entity owned by userId. */
	fetchLinkedArtifacts(userId: string, entityId: string, limit: number): Promise<SynthesizeArtifactRecord[]>;

	/** LLM generation port (reuses DeriveLlmRequest/Response shape; ADR-101). */
	generate(request: DeriveLlmRequest): Promise<DeriveLlmResponse>;

	/**
	 * Optimistic-concurrency update: updates description and properties only if
	 * updated_at matches expectedUpdatedAt. Returns true if updated, false if conflict.
	 */
	updateEntityProfile(
		userId: string,
		update: {
			entityId: string;
			description: string;
			properties: Record<string, unknown>;
			expectedUpdatedAt: string;
		},
	): Promise<boolean>;

	/** Records the machine decision in system_decisions (ADR-079 / ADR-101 §4). */
	recordDecision(decision: SynthesizeDecisionRecord): Promise<void>;
}
