import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	DecisionRepository,
	EmbeddingPort,
	EntityMergePort,
	EntityRepository,
	EntityRow,
	SystemDecisionRow,
} from "@ahkms/core";
import {
	buildRegistry,
	createCoreReviewPort,
} from "@ahkms/core/actions";
import { executeAction } from "../actions/adapters/direct.js";
import { supabase } from "../supabase.js";

const origFrom = supabase.from;
const origRpc = (supabase as any).rpc;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
});

describe("review_list and review_resolve core bodies via registry (#1665)", () => {
	it("executes both tools through core ReviewPort without touching mcp-server supabase singleton", async () => {
		const boom = () => {
			throw new Error("mcp-server supabase singleton must not be called");
		};
		(supabase as any).from = boom;
		(supabase as any).rpc = boom;

		const decision: SystemDecisionRow = {
			id: "11111111-1111-4111-8111-111111111111",
			decision_type: "merge_suggested",
			stage: "organize",
			title: "Duplicate person",
			description: "Same person",
			confidence_score: 95,
			blocking: false,
			user_visible: true,
			requires_user_action: true,
			review_type: "approval",
			status: "pending",
			resolved_at: null,
			resolved_by: null,
			resolution_notes: null,
			decision_payload: {
				winnerEntityId: "22222222-2222-4222-8222-222222222222",
				loserEntityId: "33333333-3333-4333-8333-333333333333",
			},
			resolution_data: null,
			created_at: "2026-10-01T10:00:00Z",
			updated_at: "2026-10-01T10:00:00Z",
			user_id: "u-1",
		};

		const winner = {
			id: "22222222-2222-4222-8222-222222222222",
			title: "Alice Smith",
			entity_type: "person",
			description: "Lead",
			archived: false,
			properties: {},
		} as EntityRow;

		const loser = {
			id: "33333333-3333-4333-8333-333333333333",
			title: "Alice S.",
			entity_type: "person",
			description: "Eng",
			archived: false,
			properties: {},
		} as EntityRow;

		const decisions = {
			listRecent: vi.fn(async () => [decision]),
			get: vi.fn(async () => decision),
			typesOf: vi.fn(async () => []),
			resolve: vi.fn(async () => [decision]),
			listPage: vi.fn(async () => ({ rows: [decision], total: 1 })),
			getOne: vi.fn(async () => decision),
			resolvePending: vi.fn(async () => true),
		} as unknown as DecisionRepository;

		const entities = {
			loadRows: vi.fn(async () => ({ rows: [winner, loser], truncated: false })),
			getById: vi.fn(async (id: string) => (id === winner.id ? winner : id === loser.id ? loser : null)),
		} as unknown as EntityRepository;

		const merge = {
			findLoserById: vi.fn(async () => null),
			findLoserByOpId: vi.fn(async () => null),
			unmerge: vi.fn(),
			merge: vi.fn(async () => ({
				op_id: "op-core-1",
				merged_at: "2026-10-02T00:00:00Z",
				winner_id: winner.id,
				moved_edge_ids: [],
				archived_edge_ids: [],
				aliases_added: ["Alice S."],
				properties_carried: [],
			})),
		} as unknown as EntityMergePort;

		const embedding: EmbeddingPort = {
			embed: vi.fn(async () => [0.1]),
			embedBatch: vi.fn(async (t) => t.map(() => [0.1])),
		};

		const registry = buildRegistry({
			review: createCoreReviewPort({ decisions, entities, merge, embedding }),
		});

		const listAction = registry.get("review_list")!;
		const resolveAction = registry.get("review_resolve")!;

		const listRes = await executeAction(
			listAction,
			{ status: "pending", limit: 20, offset: 0 },
			{ context: { caller: "mcp", requestId: "req-1", userId: "u-1" } },
		);
		expect(listRes.total).toBe(1);
		expect(listRes.decisions[0].candidate_entities?.winner?.title).toBe("Alice Smith");

		const resolveRes = await executeAction(
			resolveAction,
			{ decision_id: decision.id, action: "approve" },
			{ context: { caller: "mcp", requestId: "req-2", userId: "u-1" } },
		);
		expect(resolveRes.status).toBe("approved");
		expect(resolveRes.mergeOpId).toBe("op-core-1");
		expect(embedding.embed).toHaveBeenCalledTimes(1);
	});
});
