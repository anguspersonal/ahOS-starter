/**
 * DecisionRepository port over `public.system_decisions` (ADR-101, #1664).
 * Pure types only.
 */

import type { SystemDecisionRow } from "../actions/domain/governance.js";

export type { SystemDecisionRow };

export interface DecisionListRecentFilter {
	status?: string;
	blockingOnly?: boolean;
	stage?: string;
	reviewType?: string;
	limit?: number;
}

export interface DecisionListPageFilter {
	status?: string;
	decisionType?: string;
	offset?: number;
	limit?: number;
}

export interface DecisionResolveOptions {
	excludeType?: string;
}

export interface JobApplicationWatermarkRecord {
	message_id: string;
	item_key: string;
	mode: "shadow" | "label" | "act";
	outcome: string;
	thread_id?: string | null;
	application_id?: string | null;
	decision_id?: string | null;
	organisation?: string | null;
	role_title?: string | null;
	stage?: string | null;
	confidence?: number | null;
	title?: string;
	description?: string;
	artifact_id?: string | null;
	candidate_ids?: string[];
	candidates?: Array<{ id: string; title: string }>;
	hiring_contact?: { name?: string; email?: string } | null;
}

/**
 * Build the composite watermark key (`<messageId>::<itemKey>`) used to deduplicate
 * processed job-application Gmail items, including multi-role digest entries.
 */
export function jobApplicationWatermarkKey(messageId: string, itemKey = "primary"): string {
	return `${messageId}::${itemKey || "primary"}`;
}

export interface DecisionRepository {
	listRecent(filter: DecisionListRecentFilter, userId?: string): Promise<SystemDecisionRow[]>;
	get(id: string, userId?: string): Promise<SystemDecisionRow>;
	typesOf(
		ids: string[],
		userId?: string,
	): Promise<Array<{ id: string; decision_type?: string }>>;
	resolve(
		ids: string[],
		patch: Record<string, unknown>,
		options?: DecisionResolveOptions,
		userId?: string,
	): Promise<SystemDecisionRow[]>;
	listPage(
		filter: DecisionListPageFilter,
		userId: string,
	): Promise<{ rows: SystemDecisionRow[]; total: number }>;
	getOne(id: string, userId: string): Promise<SystemDecisionRow | null>;
	resolvePending(
		id: string,
		patch: Record<string, unknown>,
		userId: string,
	): Promise<boolean>;
	listJobApplicationWatermarks?(
		messageIds: readonly string[],
		userId?: string,
	): Promise<Set<string>>;
	recordJobApplicationWatermarks?(
		records: readonly JobApplicationWatermarkRecord[],
		userId?: string,
	): Promise<void>;
}
