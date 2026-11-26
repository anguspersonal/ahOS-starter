import { defineAction } from "../defineAction.js";
import {
	reviewResolveSchema,
	type ReviewResolveInput,
	type ReviewResolveResult,
} from "../domain/review.js";
import type { ReviewPort } from "../../ports/review.js";

export function formatReviewResolveMcp(result: ReviewResolveResult): string {
	if (result.status === "rejected") {
		return `Rejected proposal [${result.decisionId}] (${result.decisionType}). Notes: ${result.notes ?? "None"}`;
	}
	if (result.decisionType === "merge_suggested") {
		return [
			`Approved proposal [${result.decisionId}]: merged loser entity ${result.loserId} into winner ${result.winnerId}.`,
			result.survivorOverridden ? "Survivor entity was overridden by user." : "",
			result.mergeOpId ? `Merge operation ID: ${result.mergeOpId}` : "",
			result.mergeOpId ? `To undo this merge, run: entity_unmerge(op_id: "${result.mergeOpId}")` : "",
		]
			.filter(Boolean)
			.join("\n");
	}
	return `Approved proposal [${result.decisionId}] (${result.decisionType}).`;
}

export function createReviewResolveAction(port: ReviewPort | Pick<ReviewPort, "reviewResolve">) {
	return defineAction({
		id: "review_resolve",
		description:
			"Resolve a pending machine proposal by approving or rejecting it. Approving a merge_suggested decision merges entities and is reversible via entity_unmerge.",
		schema: reviewResolveSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (args: ReviewResolveInput, ctx) => {
			return await port.reviewResolve(args, ctx.userId);
		},
		formatMcp: formatReviewResolveMcp,
	});
}
