import { defineAction } from "../defineAction.js";
import {
	decisionReviewSchema,
	type DecisionReviewInput,
	type DecisionReviewResult,
} from "../domain/governance.js";
import type { ReviewPort } from "../../ports/review.js";

export function formatDecisionReviewMcp(result: DecisionReviewResult): string {
	if (result.operation === "list_pending") {
		if (!result.decisions || result.decisions.length === 0) {
			return "No pending system decisions found.";
		}
		const lines = [
			`Found ${result.count} decision(s):`,
			...result.decisions.map(
				(d) =>
					`- [${d.id}] (${d.stage} / ${d.review_type}) ${d.title}: status=${d.status}${d.blocking ? " (BLOCKING)" : ""}`,
			),
		];
		return lines.join("\n");
	}
	if (result.operation === "bulk_resolve") {
		return `Bulk resolved ${result.resolved_count} decision(s).`;
	}
	if (result.decision) {
		const d = result.decision;
		return `Decision [${d.id}] ${result.operation}d: status=${d.status}, title="${d.title}".`;
	}
	return JSON.stringify(result, null, 2);
}

export function createDecisionReviewAction(port: ReviewPort | Pick<ReviewPort, "decisionReview">) {
	return defineAction({
		id: "decision_review",
		name: "System Decision Review",
		description:
			"Review, inspect, approve, reject, modify, or bulk-resolve autonomous system decisions in ahOS (issue #1218).",
		domain: "governance",
		schema: decisionReviewSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (input: DecisionReviewInput, ctx) => port.decisionReview(input, ctx),
		formatMcp: formatDecisionReviewMcp,
	});
}
