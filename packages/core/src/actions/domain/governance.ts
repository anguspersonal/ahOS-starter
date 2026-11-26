import { z } from "zod";

/**
 * Zod schema for governance decision reviews (ADR-100).
 * Handles human-in-the-loop approvals, clarifications, suggestions, and quality checks.
 */
export const decisionReviewSchema = z.object({
	operation: z
		.enum(["list_pending", "get", "approve", "reject", "modify_and_approve", "bulk_resolve"])
		.describe("The governance review operation to perform."),
	id: z
		.string()
		.uuid()
		.optional()
		.describe("Decision ID (required for get, approve, reject, modify_and_approve)."),
	ids: z
		.array(z.string().uuid())
		.optional()
		.describe("Array of decision IDs (required for bulk_resolve)."),
	status: z
		.enum(["pending", "approved", "rejected", "modified", "snoozed", "auto_applied"])
		.optional()
		.describe("Filter status for list_pending, or target status for bulk_resolve."),
	stage: z
		.string()
		.optional()
		.describe(
			"Filter by processing stage (capture, organize, pre_process, extract, contextualize, act, refine, automate).",
		),
	review_type: z
		.enum(["approval", "clarification", "suggestion", "quality_check"])
		.optional()
		.describe("Filter by review classification."),
	blocking_only: z
		.boolean()
		.optional()
		.describe("Filter only blocking decisions that pause workflows."),
	resolution_notes: z
		.string()
		.optional()
		.describe("Explanation or rationale recorded upon resolving the decision."),
	resolution_data: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Modified decision payload or patch data when modifying."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Maximum number of decisions to return (default: 20)."),
});

export type DecisionReviewInput = z.infer<typeof decisionReviewSchema>;

export interface SystemDecisionRow {
	id: string;
	decision_type: string;
	stage: string;
	title: string;
	description: string;
	confidence_score: number | null;
	blocking: boolean;
	user_visible: boolean;
	requires_user_action: boolean;
	review_type: string;
	status: string;
	resolved_at: string | null;
	resolved_by: string | null;
	resolution_notes: string | null;
	decision_payload: Record<string, unknown> | null;
	resolution_data: Record<string, unknown> | null;
	created_at: string;
	updated_at: string;
	user_id: string;
}

export interface DecisionReviewResult {
	operation: string;
	count?: number;
	decisions?: SystemDecisionRow[];
	decision?: SystemDecisionRow;
	resolved_count?: number;
	ids?: string[];
}
