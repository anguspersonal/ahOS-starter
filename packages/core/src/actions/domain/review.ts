import { z } from "zod";

export const reviewListInput = {
	status: z
		.enum(["pending", "approved", "rejected", "all"])
		.optional()
		.default("pending")
		.describe("Filter decisions by status (pending, approved, rejected, all). Defaults to pending."),
	decision_type: z
		.string()
		.optional()
		.describe("Filter by proposal type (e.g. 'merge_suggested')."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(20)
		.describe("Max decisions to return (default 20, max 100)."),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.default(0)
		.describe("Pagination offset (default 0)."),
};

export const reviewListSchema = z.object(reviewListInput);
export type ReviewListInput = z.infer<typeof reviewListSchema>;

export const reviewResolveInput = {
	decision_id: z
		.string()
		.uuid()
		.describe("UUID of the system_decisions row to resolve."),
	action: z
		.enum(["approve", "reject"])
		.describe("Resolution action: 'approve' to apply proposal, 'reject' to dismiss it."),
	selected_entity_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Optional entity ID override for merge_suggested: specifies which entity survives as the winner (per #310).",
		),
	resolution_notes: z
		.string()
		.optional()
		.describe("Optional notes explaining why the proposal was approved or rejected."),
};

export const reviewResolveSchema = z.object(reviewResolveInput);
export type ReviewResolveInput = z.infer<typeof reviewResolveSchema>;

export interface ReviewCandidateEntity {
	id: string;
	title: string | null;
	entity_type: string | null;
}

export interface ReviewDecisionItem {
	id: string;
	decision_type: string;
	review_type: string;
	stage: string;
	status: string;
	title: string | null;
	description: string | null;
	confidence_score: number | null;
	decision_payload: Record<string, unknown>;
	candidate_entities?: {
		winner?: ReviewCandidateEntity | null;
		loser?: ReviewCandidateEntity | null;
	};
	linked_entities?: ReviewCandidateEntity[];
	disambiguation_candidates?: ReviewCandidateEntity[];
	created_at: string;
	resolved_at?: string | null;
	resolved_by?: string | null;
	resolution_notes?: string | null;
}

export interface ReviewListResult {
	decisions: ReviewDecisionItem[];
	total: number;
	limit: number;
	offset: number;
}

export interface ReviewResolveResult {
	success: boolean;
	decisionId: string;
	status: "approved" | "rejected";
	action: "approve" | "reject";
	decisionType: string;
	mergeOpId?: string;
	winnerId?: string;
	loserId?: string;
	survivorOverridden?: boolean;
	notes?: string;
}
