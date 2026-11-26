import { describe, expect, it, vi } from "vitest";
import { buildRegistry, AdapterUnavailableError } from "../buildRegistry.js";
import { executeAction } from "../adapters/direct.js";
import type { ReviewPort } from "../../ports/review.js";
import { formatDecisionReviewMcp } from "./decisionReview.js";
import { formatReviewListMcp } from "./reviewList.js";
import { formatReviewResolveMcp } from "./reviewResolve.js";

describe("Review and Decision Actions in @ahkms/core (Issue #1510, ADR-101, ADR-105)", () => {
	it("1. buildRegistry({ review: fakePort }) holds the three ids; executeAction(review_list, {}, { context: { userId: 'u1' } }) calls fakePort.reviewList once with the parsed input and 'u1' and returns its result", async () => {
		const fakeListResult = {
			decisions: [],
			total: 0,
			limit: 20,
			offset: 0,
		};
		const fakePort: ReviewPort = {
			decisionReview: vi.fn(),
			reviewList: vi.fn().mockResolvedValue(fakeListResult),
			reviewResolve: vi.fn(),
		};

		const registry = buildRegistry({ review: fakePort });
		expect(registry.has("decision_review")).toBe(true);
		expect(registry.has("review_list")).toBe(true);
		expect(registry.has("review_resolve")).toBe(true);

		const action = registry.get("review_list")!;
		expect(action).toBeDefined();

		const result = await executeAction(action, {}, { context: { userId: "u1" } });

		expect(fakePort.reviewList).toHaveBeenCalledTimes(1);
		expect(fakePort.reviewList).toHaveBeenCalledWith(
			{
				status: "pending",
				limit: 20,
				offset: 0,
			},
			"u1",
		);
		expect(result).toEqual(fakeListResult);
	});

	it("2. Each moved definition keeps its dev contract: review_list readOnlyHint: true; review_resolve destructiveHint: true; decision_review domain governance; descriptions match", () => {
		const fakePort: ReviewPort = {
			decisionReview: vi.fn(),
			reviewList: vi.fn(),
			reviewResolve: vi.fn(),
		};
		const registry = buildRegistry({ review: fakePort });

		const reviewList = registry.get("review_list")!;
		expect(reviewList.annotations.readOnlyHint).toBe(true);
		expect(reviewList.annotations.destructiveHint).toBe(false);
		expect(reviewList.description).toBe(
			"List pending machine-generated proposals (e.g. entity merge suggestions from dedup sweeps) requiring human review. Supports status and type filtering.",
		);

		const reviewResolve = registry.get("review_resolve")!;
		expect(reviewResolve.annotations.readOnlyHint).toBe(false);
		expect(reviewResolve.annotations.destructiveHint).toBe(true);
		expect(reviewResolve.description).toBe(
			"Resolve a pending machine proposal by approving or rejecting it. Approving a merge_suggested decision merges entities and is reversible via entity_unmerge.",
		);

		const decisionReview = registry.get("decision_review")!;
		expect(decisionReview.domain).toBe("governance");
		expect(decisionReview.description).toBe(
			"Review, inspect, approve, reject, modify, or bulk-resolve autonomous system decisions in ahOS (issue #1218).",
		);
	});

	it("3. formatMcp on fixture results gives the same text the mcp-server formatters give on dev", () => {
		// formatDecisionReviewMcp fixtures
		expect(formatDecisionReviewMcp({ operation: "list_pending", count: 0, decisions: [] })).toBe(
			"No pending system decisions found.",
		);
		expect(
			formatDecisionReviewMcp({
				operation: "list_pending",
				count: 1,
				decisions: [
					{
						id: "d1",
						stage: "detect",
						review_type: "merge",
						title: "Test Decision",
						status: "pending",
						blocking: true,
					} as any,
				],
			}),
		).toBe("Found 1 decision(s):\n- [d1] (detect / merge) Test Decision: status=pending (BLOCKING)");
		expect(formatDecisionReviewMcp({ operation: "bulk_resolve", resolved_count: 5 })).toBe(
			"Bulk resolved 5 decision(s).",
		);
		expect(
			formatDecisionReviewMcp({
				operation: "approve",
				decision: { id: "d1", status: "approved", title: "Test Decision" } as any,
			}),
		).toBe('Decision [d1] approved: status=approved, title="Test Decision".');

		// formatReviewListMcp fixtures
		expect(formatReviewListMcp({ decisions: [], total: 0, limit: 20, offset: 0 })).toBe(
			"No review decisions found matching criteria.",
		);
		const listWithDecisions = formatReviewListMcp({
			total: 1,
			limit: 20,
			offset: 0,
			decisions: [
				{
					id: "d1",
					decision_type: "merge_suggested",
					review_type: "entity_dedup",
					stage: "review",
					status: "pending",
					title: "Merge duplicate contacts",
					description: "Found similar contacts",
					confidence_score: 95,
					decision_payload: {},
					candidate_entities: {
						winner: { id: "w1", title: "Winner Co", entity_type: "organization" },
						loser: { id: "l1", title: "Loser Co", entity_type: "organization" },
					},
					created_at: "2026-10-12T10:00:00Z",
				},
			],
		});
		expect(listWithDecisions).toBe(
			[
				"Review Backlog (1 of 1 decisions):",
				"",
				"• [d1] MERGE_SUGGESTED (pending)",
				"  Title: Merge duplicate contacts",
				"  Description: Found similar contacts",
				"  Confidence: 95%",
				'  Winner: "Winner Co" (w1) [organization]',
				'  Loser:  "Loser Co" (l1) [organization]',
				"  Created: 2026-10-12T10:00:00Z",
				"",
				"To resolve a decision, call `review_resolve(decision_id, action: 'approve' | 'reject')`.",
			].join("\n"),
		);

		const listWithHydratedEntities = formatReviewListMcp({
			total: 2,
			limit: 20,
			offset: 0,
			decisions: [
				{
					id: "d2",
					decision_type: "task_creation",
					review_type: "approval",
					stage: "review",
					status: "pending",
					title: "Follow up with Alice",
					description: "Send Q4 summary",
					confidence_score: 88,
					decision_payload: { linked_entity_ids: ["e1"] },
					linked_entities: [{ id: "e1", title: "Alice Smith", entity_type: "person" }],
					created_at: "2026-10-13T10:00:00Z",
				},
				{
					id: "d3",
					decision_type: "relationship_suggestion",
					review_type: "disambiguation",
					stage: "review",
					status: "pending",
					title: "Disambiguate Bob",
					description: "Multiple matches found",
					confidence_score: 65,
					decision_payload: { candidate_entity_ids: ["e2", "e3"] },
					disambiguation_candidates: [
						{ id: "e2", title: "Bob Jones", entity_type: "person" },
						{ id: "e3", title: "Bob Barker", entity_type: "person" },
					],
					created_at: "2026-10-14T10:00:00Z",
				},
			],
		});
		expect(listWithHydratedEntities).toBe(
			[
				"Review Backlog (2 of 2 decisions):",
				"",
				"• [d2] TASK_CREATION (pending)",
				"  Title: Follow up with Alice",
				"  Description: Send Q4 summary",
				"  Confidence: 88%",
				"  Linked entities: Alice Smith (person) [e1]",
				"  Created: 2026-10-13T10:00:00Z",
				"",
				"• [d3] RELATIONSHIP_SUGGESTION (pending)",
				"  Title: Disambiguate Bob",
				"  Description: Multiple matches found",
				"  Confidence: 65%",
				"  Candidate entities: Bob Jones (person) [e2], Bob Barker (person) [e3]",
				"  Created: 2026-10-14T10:00:00Z",
				"",
				"To resolve a decision, call `review_resolve(decision_id, action: 'approve' | 'reject')`.",
			].join("\n"),
		);

		// formatReviewResolveMcp fixtures
		expect(
			formatReviewResolveMcp({
				status: "rejected",
				decisionId: "d1",
				decisionType: "merge_suggested",
				action: "reject",
				notes: "Not a duplicate",
				success: true,
			}),
		).toBe("Rejected proposal [d1] (merge_suggested). Notes: Not a duplicate");

		expect(
			formatReviewResolveMcp({
				status: "approved",
				decisionId: "d1",
				decisionType: "merge_suggested",
				action: "approve",
				winnerId: "w1",
				loserId: "l1",
				survivorOverridden: true,
				mergeOpId: "op-123",
				success: true,
			}),
		).toBe(
			[
				"Approved proposal [d1]: merged loser entity l1 into winner w1.",
				"Survivor entity was overridden by user.",
				"Merge operation ID: op-123",
				'To undo this merge, run: entity_unmerge(op_id: "op-123")',
			].join("\n"),
		);

		expect(
			formatReviewResolveMcp({
				status: "approved",
				decisionId: "d1",
				decisionType: "other_type",
				action: "approve",
				success: true,
			}),
		).toBe("Approved proposal [d1] (other_type).");
	});

	it("4. With {}, review_resolve rejects with AdapterUnavailableError naming review", async () => {
		const registry = buildRegistry({});
		const action = registry.get("review_resolve")!;
		expect(action).toBeDefined();

		await expect(
			executeAction(action, {
				decision_id: "00000000-0000-0000-0000-000000000000",
				action: "approve",
			}),
		).rejects.toThrowError(AdapterUnavailableError);

		await expect(
			executeAction(action, {
				decision_id: "00000000-0000-0000-0000-000000000000",
				action: "approve",
			}),
		).rejects.toThrowError(/review adapter is not wired/i);
	});
});
