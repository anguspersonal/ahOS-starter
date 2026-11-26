import { describe, expect, it, vi } from "vitest";
import type { DecisionRepository, SystemDecisionRow } from "../../ports/decisions.js";
import type { EmbeddingPort } from "../../ports/embeddings.js";
import type { EntityRepository } from "../../ports/entities.js";
import type { EntityMergePort } from "../../ports/entityMerge.js";
import { createCoreReviewPort } from "./port.js";

describe("createCoreReviewPort (#1665)", () => {
	it("wires decisionReview, reviewList, and reviewResolve over the provided ports", async () => {
		const row: SystemDecisionRow = {
			id: "dec-1",
			decision_type: "task_creation",
			stage: "organize",
			title: "Follow up",
			description: "Create task",
			confidence_score: 80,
			blocking: false,
			user_visible: true,
			requires_user_action: true,
			review_type: "approval",
			status: "pending",
			resolved_at: null,
			resolved_by: null,
			resolution_notes: null,
			decision_payload: {},
			resolution_data: null,
			created_at: "2026-10-01T10:00:00Z",
			updated_at: "2026-10-01T10:00:00Z",
			user_id: "u-1",
		};

		const decisions = {
			listRecent: vi.fn(async () => [row]),
			get: vi.fn(async () => row),
			typesOf: vi.fn(async () => []),
			resolve: vi.fn(async () => [row]),
			listPage: vi.fn(async () => ({ rows: [row], total: 1 })),
			getOne: vi.fn(async () => row),
			resolvePending: vi.fn(async () => true),
		} as unknown as DecisionRepository;

		const entities = {
			loadRows: vi.fn(async () => ({ rows: [], truncated: false })),
			getById: vi.fn(async () => null),
		} as unknown as EntityRepository;

		const merge = {
			findLoserById: vi.fn(async () => null),
			findLoserByOpId: vi.fn(async () => null),
			unmerge: vi.fn(),
			merge: vi.fn(),
		} as unknown as EntityMergePort;

		const embedding: EmbeddingPort = {
			embed: vi.fn(async () => [0.1]),
			embedBatch: vi.fn(async (t) => t.map(() => [0.1])),
		};

		const port = createCoreReviewPort({ decisions, entities, merge, embedding });

		const dr = await port.decisionReview(
			{ operation: "list_pending" },
			{ caller: "mcp", requestId: "req-1", userId: "u-1" },
		);
		expect(dr.count).toBe(1);

		const listRes = await port.reviewList({ status: "pending", limit: 10, offset: 0 }, "u-1");
		expect(listRes.total).toBe(1);
		expect(listRes.decisions[0].id).toBe("dec-1");

		const resolveRes = await port.reviewResolve({ decision_id: "dec-1", action: "approve" }, "u-1");
		expect(resolveRes.status).toBe("approved");
		expect(decisions.resolvePending).toHaveBeenCalledTimes(1);
	});
});
