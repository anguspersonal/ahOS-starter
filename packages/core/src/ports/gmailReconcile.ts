/**
 * @ahkms/core/ports - gmailReconcile.ts
 *
 * Narrow persistence port for the three Supabase read queries used by Gmail
 * workflow reconciliation (ADR-100, ADR-101, Issue #1579) plus Tier-2 email
 * triage decision logging and graph-context contracts (Issue #1990, #2012).
 * Pure types only — no external SDK, database, or environment dependencies.
 */

import type {
	EmailIntentCategory,
	EmailStorageTier,
	GmailSweepAction,
	GmailTriageGraphContext,
} from "../domain/emailTriage.js";
import type { EmailRoute, ThinkingMode } from "../domain/emailRouting.js";
import type { ExtractedEmailEntity, ExtractedEmailTask } from "./emailReasoner.js";

export type { GmailTriageGraphContext };

export type GmailAccountDomain = "personal" | "work";

export interface CandidateGmailArtifactRow {
	id: string;
	user_id?: string | null;
	source_channel?: string | null;
	source_url?: string | null;
	processing_metadata?: Record<string, unknown> | null;
	tags?: string[] | null;
	text?: string | null;
	created_at?: string | null;
}

export interface CandidateGmailExternalLinkRow {
	artifact_id: string;
	provider: string;
	kind: string;
	external_id: string;
	external_url?: string | null;
}

export interface TaskExternalLinkRow {
	external_id: string;
	provider: string;
	kind: string;
}

export interface GmailTriageDecisionRecord {
	id?: string;
	thread_id: string;
	message_id: string;
	account: GmailAccountDomain | string;
	sender: string;
	subject: string;
	snippet?: string | null;
	intent_category: EmailIntentCategory;
	priority: number;
	confidence: number;
	storage_tier?: EmailStorageTier;
	gmail_action: GmailSweepAction;
	artifact_id?: string | null;
	linked_entity_ids?: string[];
	reasons?: string[];
	received_at?: string | null;
	created_at?: string | null;
	overridden_at?: string | null;
	// ---- ADR-118 pipeline fields (all optional: pre-118 rows carry none) ----
	/** Where the thread went after the HITL gate. */
	route?: EmailRoute;
	/** Where it would have gone without the gate. */
	natural_route?: EmailRoute;
	thinking_mode?: ThinkingMode;
	requires_human?: boolean;
	hitl_reasons?: string[];
	/** Shadow / label / act: what the run was allowed to do. */
	mode?: string;
	/** True when the run changed Gmail for this thread. */
	applied?: boolean;
	over_budget?: boolean;
	rubric_version?: string;
	rationale?: string | null;
	sender_kind?: string;
	gmail_category?: string;
	gmail_category_contradiction?: boolean;
	draft_id?: string | null;
	draft_reply?: string | null;
	extracted_tasks?: ExtractedEmailTask[];
	extracted_entities?: ExtractedEmailEntity[];
	created_task_count?: number;
}

export interface GmailTriageDecisionFilter {
	account?: GmailAccountDomain | "all" | string;
	minPriority?: number;
	maxPriority?: number;
	intentCategory?: EmailIntentCategory;
	storageTier?: EmailStorageTier;
	/** Only decisions created at or after this ISO timestamp. */
	since?: string;
	limit?: number;
	userId?: string;
}

export interface GmailTriageDecisionOverrideInput {
	thread_id: string;
	account?: GmailAccountDomain | string;
	priority?: number;
	intent_category?: EmailIntentCategory;
	gmail_action?: GmailSweepAction;
	storage_tier?: EmailStorageTier;
	reason?: string;
	userId?: string;
}

export interface GmailTriageStorePort {
	/**
	 * Persist one or more Tier-2 email triage decision records.
	 */
	recordTriageDecisions(
		decisions: GmailTriageDecisionRecord[],
		userId?: string,
	): Promise<GmailTriageDecisionRecord[]>;

	/**
	 * List persisted Tier-2 email triage decision records matching optional filters.
	 */
	listTriageDecisions(
		filter?: GmailTriageDecisionFilter,
	): Promise<GmailTriageDecisionRecord[]>;

	/**
	 * The subset of `threadIds` some earlier run already decided: the processing
	 * watermark that keeps a cadence from re-judging (and re-logging) the same mail.
	 */
	listDecidedThreadIds?(threadIds: string[], userId?: string): Promise<Set<string>>;

	/**
	 * Record a user override / correction on a previously triaged thread.
	 */
	overrideTriageDecision?(
		override: GmailTriageDecisionOverrideInput,
	): Promise<GmailTriageDecisionRecord | null>;
}

export interface GmailReconcileStore extends Partial<GmailTriageStorePort> {
	/**
	 * Load artifacts that could be Gmail-sourced, scoped to `userId` (or the
	 * default user resolved by the adapter when omitted).
	 */
	listCandidateGmailArtifacts(userId?: string): Promise<CandidateGmailArtifactRow[]>;

	/**
	 * Load external links that could point to Gmail threads, scoped to `userId`
	 * (or the default user resolved by the adapter when omitted).
	 */
	listCandidateGmailExternalLinks(userId?: string): Promise<CandidateGmailExternalLinkRow[]>;

	/**
	 * Check whether any of the given `artifactIds` has at least one row in
	 * `artifact_entity_links`.
	 */
	hasEntityLinksForArtifacts(artifactIds: string[]): Promise<boolean>;

	/**
	 * List external links with `kind = 'task'` associated with any of the
	 * given `artifactIds`.
	 */
	listTaskExternalLinksForArtifacts(artifactIds: string[]): Promise<TaskExternalLinkRow[]>;
}

