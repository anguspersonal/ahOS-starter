import { describe, expect, it, vi, beforeEach } from "vitest";
import { decisionReviewAction, decisionReviewCore } from "./governance.js";
import { supabase } from "../supabase.js";

const mockDecisions = [
	{
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
		user_id: "test-user-id",
	},
];

let mockQueryData: any = mockDecisions;
let mockSingleData: any = mockDecisions[0];
let mockUpdateData: any = { ...mockDecisions[0], status: "approved" };

vi.mock("../supabase.js", () => {
	const chain: any = {
		select: vi.fn(() => chain),
		order: vi.fn(() => chain),
		limit: vi.fn(() => chain),
		eq: vi.fn(() => chain),
		neq: vi.fn(() => chain),
		in: vi.fn(() => chain),
		single: vi.fn(async () => ({ data: mockSingleData, error: null })),
		update: vi.fn(() => chain),
		then: (resolve: any) => resolve({ data: mockQueryData, error: null }),
	};

	return {
		supabase: {
			from: vi.fn(() => chain),
		},
	};
});

vi.mock("../identity.js", () => ({
	getCurrentUserId: () => "test-user-id",
}));

describe("decisionReviewAction", () => {
	beforeEach(() => {
		mockQueryData = mockDecisions;
		mockSingleData = mockDecisions[0];
		mockUpdateData = { ...mockDecisions[0], status: "approved" };
	});

	it("has correct domain and annotations", () => {
		expect(decisionReviewAction.id).toBe("decision_review");
		expect(decisionReviewAction.domain).toBe("governance");
		expect(decisionReviewAction.annotations.readOnlyHint).toBe(false);
	});

	it("lists pending decisions", async () => {
		const result = await decisionReviewCore({
			operation: "list_pending",
			blocking_only: true,
		});

		expect(result.operation).toBe("list_pending");
		expect(result.count).toBe(1);
		expect(result.decisions).toHaveLength(1);
		expect(result.decisions![0].id).toBe("11111111-1111-1111-1111-111111111111");
	});

	it("gets a decision by id", async () => {
		const result = await decisionReviewCore({
			operation: "get",
			id: "11111111-1111-1111-1111-111111111111",
		});

		expect(result.operation).toBe("get");
		expect(result.decision?.id).toBe("11111111-1111-1111-1111-111111111111");
	});

	it("approves a decision with resolution notes", async () => {
		mockSingleData = {
			...mockDecisions[0],
			status: "approved",
			resolved_at: "2026-10-03T12:00:00.000Z",
			resolution_notes: "Approved by human reviewer",
		};

		const result = await decisionReviewCore({
			operation: "approve",
			id: "11111111-1111-1111-1111-111111111111",
			resolution_notes: "Approved by human reviewer",
		});

		expect(result.operation).toBe("approve");
		expect(result.decision?.status).toBe("approved");
		expect(result.decision?.resolution_notes).toBe("Approved by human reviewer");
	});

	it("rejects a decision", async () => {
		mockSingleData = {
			...mockDecisions[0],
			status: "rejected",
			resolved_at: "2026-10-03T12:00:00.000Z",
			resolution_notes: "Rejected false positive",
		};

		const result = await decisionReviewCore({
			operation: "reject",
			id: "11111111-1111-1111-1111-111111111111",
			resolution_notes: "Rejected false positive",
		});

		expect(result.operation).toBe("reject");
		expect(result.decision?.status).toBe("rejected");
	});

	it("modifies and approves a decision with resolution data", async () => {
		mockSingleData = {
			...mockDecisions[0],
			status: "modified",
			resolved_at: "2026-10-03T12:00:00.000Z",
			resolution_data: { entity_name: "Acme Corp Ltd" },
		};

		const result = await decisionReviewCore({
			operation: "modify_and_approve",
			id: "11111111-1111-1111-1111-111111111111",
			resolution_data: { entity_name: "Acme Corp Ltd" },
		});

		expect(result.operation).toBe("modify_and_approve");
		expect(result.decision?.status).toBe("modified");
		expect(result.decision?.resolution_data).toEqual({ entity_name: "Acme Corp Ltd" });
	});

	it("bulk resolves decisions", async () => {
		mockQueryData = [
			{ id: "11111111-1111-1111-1111-111111111111" },
			{ id: "22222222-2222-2222-2222-222222222222" },
		];

		const result = await decisionReviewCore({
			operation: "bulk_resolve",
			ids: [
				"11111111-1111-1111-1111-111111111111",
				"22222222-2222-2222-2222-222222222222",
			],
			status: "approved",
		});

		expect(result.operation).toBe("bulk_resolve");
		expect(result.resolved_count).toBe(2);
	});

	it("formats mcp output appropriately", () => {
		const format = decisionReviewAction.formatMcp!;
		const textList = format({
			operation: "list_pending",
			count: 1,
			decisions: mockDecisions as any,
		});
		expect(textList).toContain("Found 1 decision(s):");
		expect(textList).toContain("Link entity candidate");

		const textApprove = format({
			operation: "approve",
			decision: { ...mockDecisions[0], status: "approved" } as any,
		});
		expect(textApprove).toContain("status=approved");
	});
});

describe("decision_review refuses action approvals", () => {
	const id = "11111111-1111-1111-1111-111111111111";

	it("refuses approve, reject, and modify_and_approve for action_approval", async () => {
		mockQueryData = [{ id, decision_type: "action_approval" }];
		const chain = (supabase.from as any)("system_decisions");
		chain.update.mockClear();

		await expect(
			decisionReviewCore({ operation: "approve", id }),
		).rejects.toThrow(/action approval.*Approvals inbox/);
		expect(chain.update).not.toHaveBeenCalled();

		await expect(
			decisionReviewCore({ operation: "reject", id }),
		).rejects.toThrow(/action approval.*Approvals inbox/);
		expect(chain.update).not.toHaveBeenCalled();

		await expect(
			decisionReviewCore({ operation: "modify_and_approve", id }),
		).rejects.toThrow(/action approval.*Approvals inbox/);
		expect(chain.update).not.toHaveBeenCalled();
	});

	it("refuses bulk_resolve for action_approval", async () => {
		mockQueryData = [{ id, decision_type: "action_approval" }];
		const chain = (supabase.from as any)("system_decisions");
		chain.update.mockClear();

		await expect(
			decisionReviewCore({ operation: "bulk_resolve", ids: [id], status: "pending" }),
		).rejects.toThrow(/action approval.*Approvals inbox/);
		expect(chain.update).not.toHaveBeenCalled();
	});

	it("approves non-action_approval and calls neq('decision_type', 'action_approval')", async () => {
		mockQueryData = [{ id, decision_type: "entity_created" }];
		mockSingleData = { id, decision_type: "entity_created", status: "approved" };
		const chain = (supabase.from as any)("system_decisions");
		chain.update.mockClear();
		chain.neq.mockClear();

		const result = await decisionReviewCore({ operation: "approve", id });
		expect(result.operation).toBe("approve");
		expect(chain.neq).toHaveBeenCalledWith("decision_type", "action_approval");
	});
});

