import {
	decisionReviewSchema,
	createDecisionReviewAction,
	formatDecisionReviewMcp,
	runDecisionReview,
	type DecisionReviewInput,
	type SystemDecisionRow,
	type DecisionReviewResult,
} from "@ahkms/core";
import { createSupabaseDecisionRepository } from "@ahkms/core/adapters";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import type { ActionContext } from "./types.js";

export {
	decisionReviewSchema,
	formatDecisionReviewMcp,
	type DecisionReviewInput,
	type SystemDecisionRow,
	type DecisionReviewResult,
};

export const decisionRepository = createSupabaseDecisionRepository(supabase);

export async function decisionReviewCore(
	input: DecisionReviewInput,
	ctx?: ActionContext,
): Promise<DecisionReviewResult> {
	return runDecisionReview(decisionRepository, input, ctx, getCurrentUserId);
}

/**
 * Centralised Action definition for system decision governance (issue #1218).
 * Enables multi-surface human-in-the-loop triage of autonomous proposals.
 */
export const decisionReviewAction = createDecisionReviewAction({
	decisionReview: decisionReviewCore,
});
