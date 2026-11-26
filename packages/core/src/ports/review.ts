/**
 * Ports for review & system decision governance interactions (ADR-101 §1, §4, ADR-105 R1, R7).
 * Pure types only. No external SDKs, database, or environment dependencies.
 */

import type { ActionContext } from "../actions/types.js";
import type {
	DecisionReviewInput,
	DecisionReviewResult,
} from "../actions/domain/governance.js";
import type {
	ReviewListInput,
	ReviewListResult,
	ReviewResolveInput,
	ReviewResolveResult,
} from "../actions/domain/review.js";

export type {
	DecisionReviewResult,
	ReviewListResult,
	ReviewResolveResult,
};

export interface ReviewPort {
	decisionReview(input: DecisionReviewInput, ctx?: ActionContext): Promise<DecisionReviewResult>;
	reviewList(input: ReviewListInput, userId?: string): Promise<ReviewListResult>;
	reviewResolve(input: ReviewResolveInput, userId?: string): Promise<ReviewResolveResult>;
}
