import type { ReviewPort } from "../../ports/review.js";
import { runDecisionReview } from "./decisionReviewBody.js";
import {
	reviewListCore,
	reviewResolveCore,
	type CoreReviewDeps,
} from "./reviewBodies.js";

export type { CoreReviewDeps };

export function createCoreReviewPort(deps: CoreReviewDeps): ReviewPort {
	return {
		decisionReview: (input, ctx) =>
			runDecisionReview(deps.decisions, input, ctx, deps.resolveUserId),
		reviewList: (input, userId) => reviewListCore(deps, input, userId),
		reviewResolve: (input, userId) => reviewResolveCore(deps, input, userId),
	};
}
