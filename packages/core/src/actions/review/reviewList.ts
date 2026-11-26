import { defineAction } from "../defineAction.js";
import {
	reviewListSchema,
	type ReviewListInput,
	type ReviewListResult,
} from "../domain/review.js";
import type { ReviewPort } from "../../ports/review.js";

export function formatReviewListMcp(result: ReviewListResult): string {
	if (result.decisions.length === 0) {
		return "No review decisions found matching criteria.";
	}
	const lines: string[] = [
		`Review Backlog (${result.decisions.length} of ${result.total} decisions):`,
		"",
	];
	for (const d of result.decisions) {
		lines.push(`• [${d.id}] ${d.decision_type.toUpperCase()} (${d.status})`);
		if (d.title) lines.push(`  Title: ${d.title}`);
		if (d.description) lines.push(`  Description: ${d.description}`);
		if (d.confidence_score != null) lines.push(`  Confidence: ${d.confidence_score}%`);
		if (d.candidate_entities) {
			const w = d.candidate_entities.winner;
			const l = d.candidate_entities.loser;
			if (w) lines.push(`  Winner: "${w.title ?? "Untitled"}" (${w.id}) [${w.entity_type ?? "unknown"}]`);
			if (l) lines.push(`  Loser:  "${l.title ?? "Untitled"}" (${l.id}) [${l.entity_type ?? "unknown"}]`);
		}
		if (d.linked_entities && d.linked_entities.length > 0) {
			const formatted = d.linked_entities
				.map((e) => `${e.title ?? "Untitled"} (${e.entity_type ?? "unknown"}) [${e.id}]`)
				.join(", ");
			lines.push(`  Linked entities: ${formatted}`);
		}
		if (d.disambiguation_candidates && d.disambiguation_candidates.length > 0) {
			const formatted = d.disambiguation_candidates
				.map((e) => `${e.title ?? "Untitled"} (${e.entity_type ?? "unknown"}) [${e.id}]`)
				.join(", ");
			lines.push(`  Candidate entities: ${formatted}`);
		}
		lines.push(`  Created: ${d.created_at}`);
		lines.push("");
	}
	lines.push("To resolve a decision, call `review_resolve(decision_id, action: 'approve' | 'reject')`.");
	return lines.join("\n").trim();
}

export function createReviewListAction(port: ReviewPort | Pick<ReviewPort, "reviewList">) {
	return defineAction({
		id: "review_list",
		description:
			"List pending machine-generated proposals (e.g. entity merge suggestions from dedup sweeps) requiring human review. Supports status and type filtering.",
		schema: reviewListSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args: ReviewListInput, ctx) => {
			return await port.reviewList(args, ctx.userId);
		},
		formatMcp: formatReviewListMcp,
	});
}
