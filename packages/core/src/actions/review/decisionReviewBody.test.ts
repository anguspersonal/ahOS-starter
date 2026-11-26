import { describe, expect, it, vi } from "vitest";
import type { DecisionRepository, SystemDecisionRow } from "../../ports/decisions.js";
import { formatDecisionReviewMcp } from "./decisionReview.js";
import { runDecisionReview } from "./decisionReviewBody.js";

const baseRow: SystemDecisionRow = {
	id: "11111111-1111-1111-1111-111111111111",
	decision_type: "entity_created",
	stage: "organize",
	title: "Link entity candidate",
	description: "Candidate entity identified in notes",
	confidence_score: 92,
	blocking: true,
	user_visible: true,
	requires_user_action: true,
	review_type: "approval",
	status: "pending",
	resolved_at: null,
	resolved_by: null,
	resolution_notes: null,
	decision_payload: { entity_name: "Acme Corp" },
	resolution_data: null,
	created_at: "2026-10-01T10:00:00.000Z",
	updated_at: "2026-10-01T10:00:00.000Z",
	user_id: "user-1",
};

function makeRepo(overrides: Partial<DecisionRepository> = {}): DecisionRepository {
	return {
		listRecent: vi.fn(async () => [baseRow]),
		get: vi.fn(async () => baseRow),
		typesOf: vi.fn(async () => [{ id: baseRow.id, decision_type: baseRow.decision_type }]),
		resolve: vi.fn(async (_ids, patch) => [{ ...baseRow, ...(patch as Partial<SystemDecisionRow>) }]),
		listPage: vi.fn(async () => ({ rows: [baseRow], total: 1 })),
		getOne: vi.fn(async () => baseRow),
		resolvePending: vi.fn(async () => true),
		...overrides,
	};
}

describe("runDecisionReview", () => {
	it("rejects approve, reject, modify_and_approve and bulk_resolve on action_approval without calling resolve, and requires ids on bulk_resolve", async () => {
		const repo = makeRepo({
			typesOf: vi.fn(async (ids: string[]) =>
				ids.map((id) => ({ id, decision_type: "action_approval" })),
			),
		});

		for (const operation of ["approve", "reject", "modify_and_approve"] as const) {
			await expect(
				runDecisionReview(repo, { operation, id: baseRow.id }),
			).rejects.toThrow(
				`Decision ${baseRow.id} is an action approval; approve or reject it in the Approvals inbox, not with decision_review.`,
			);
		}

		await expect(
			runDecisionReview(repo, { operation: "bulk_resolve", ids: [baseRow.id] }),
		).rejects.toThrow(
			`Decision ${baseRow.id} is an action approval; approve or reject it in the Approvals inbox, not with decision_review.`,
		);

		expect(repo.resolve).not.toHaveBeenCalled();

		await expect(
			runDecisionReview(repo, { operation: "bulk_resolve", ids: [] }),
		).rejects.toThrow("ids array is required for bulk_resolve operation");
	});

	it("writes status: modified with resolution_data on modify_and_approve and formats MCP output identically to dev", async () => {
		const repo = makeRepo();
		const res = await runDecisionReview(
			repo,
			{
				operation: "modify_and_approve",
				id: baseRow.id,
				resolution_notes: "Updated name",
				resolution_data: { entity_name: "Acme Corp Ltd" },
			},
			{ userId: "user-1", caller: "mcp", requestId: "req-1" },
		);

		expect(res.operation).toBe("modify_and_approve");
		expect(res.decision?.status).toBe("modified");
		expect(res.decision?.resolution_data).toEqual({ entity_name: "Acme Corp Ltd" });
		expect(repo.resolve).toHaveBeenCalledWith(
			[baseRow.id],
			expect.objectContaining({
				status: "modified",
				resolution_notes: "Updated name",
				resolution_data: { entity_name: "Acme Corp Ltd" },
				resolved_by: "user-1",
			}),
			{ excludeType: "action_approval" },
			"user-1",
		);

		expect(
			formatDecisionReviewMcp({ operation: "list_pending", count: 1, decisions: [baseRow] }),
		).toBe(
			`Found 1 decision(s):\n- [${baseRow.id}] (organize / approval) Link entity candidate: status=pending (BLOCKING)`,
		);
		expect(formatDecisionReviewMcp({ operation: "list_pending", count: 0, decisions: [] })).toBe(
			"No pending system decisions found.",
		);
		expect(formatDecisionReviewMcp({ operation: "bulk_resolve", resolved_count: 2 })).toBe(
			"Bulk resolved 2 decision(s).",
		);
		expect(
			formatDecisionReviewMcp({
				operation: "approve",
				decision: { ...baseRow, status: "approved" },
			}),
		).toBe(`Decision [${baseRow.id}] approved: status=approved, title="Link entity candidate".`);
	});
});
