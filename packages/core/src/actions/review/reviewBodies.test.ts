import { describe, expect, it, vi } from "vitest";
import type { DecisionRepository, SystemDecisionRow } from "../../ports/decisions.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type { EntityRepository, EntityRow } from "../../ports/entities.js";
import type { EntityMergeParams, EntityMergePort } from "../../ports/entityMerge.js";
import { formatReviewListMcp } from "./reviewList.js";
import { formatReviewResolveMcp } from "./reviewResolve.js";
import { reviewListCore, reviewResolveCore } from "./reviewBodies.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";

function makeDecision(overrides: Partial<SystemDecisionRow> = {}): SystemDecisionRow {
	return {
		id: "dec-1",
		decision_type: "merge_suggested",
		stage: "organize",
		title: "Possible duplicate",
		description: "Duplicate entity",
		confidence_score: 92,
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
		user_id: USER_ID,
		...overrides,
	};
}

function makeEntity(overrides: Partial<EntityRow> = {}): EntityRow {
	return {
		id: "ent-1",
		title: "Entity 1",
		entity_type: "person",
		description: "Desc",
		archived: false,
		archived_at: null,
		properties: {},
		tags: [],
		created_at: "2026-10-01T10:00:00Z",
		updated_at: "2026-10-01T10:00:00Z",
		user_id: USER_ID,
		...overrides,
	} as EntityRow;
}

function makeFakePorts(options: {
	decisions?: SystemDecisionRow[];
	totalDecisions?: number;
	entities?: EntityRow[];
	resolvePendingResult?: boolean;
	mergeOpId?: string;
	embedImpl?: (text: string) => Promise<number[]>;
} = {}) {
	const decisionsList = options.decisions ?? [];
	const entitiesList = options.entities ?? [];
	const resolvePending = vi.fn(async () => options.resolvePendingResult ?? true);
	const listPage = vi.fn(async () => ({
		rows: decisionsList,
		total: options.totalDecisions ?? decisionsList.length,
	}));
	const getOne = vi.fn(async (id: string) => decisionsList.find((d) => d.id === id) ?? null);

	const decisions = {
		listRecent: vi.fn(async () => []),
		get: vi.fn(),
		typesOf: vi.fn(async () => []),
		resolve: vi.fn(async () => []),
		listPage,
		getOne,
		resolvePending,
	} as unknown as DecisionRepository;

	const loadRows = vi.fn(async (filter: { ids?: string[] }) => {
		const ids = filter.ids ?? [];
		return {
			rows: entitiesList.filter((e) => ids.includes(e.id)),
			truncated: false,
		};
	});
	const getById = vi.fn(async (id: string) => entitiesList.find((e) => e.id === id) ?? null);

	const entities = {
		loadRows,
		getById,
	} as unknown as EntityRepository;

	const mergeCalls: EntityMergeParams[] = [];
	const mergeFn = vi.fn(async (params: EntityMergeParams) => {
		mergeCalls.push(params);
		return {
			op_id: options.mergeOpId ?? "op-123",
			merged_at: params.nowIso ?? "2026-10-02T00:00:00Z",
			winner_id: params.winnerId,
			moved_edge_ids: [],
			archived_edge_ids: [],
			aliases_added: params.aliasesAdded,
			properties_carried: params.propertiesCarried,
		};
	});
	const merge = {
		findLoserById: vi.fn(async () => null),
		findLoserByOpId: vi.fn(async () => null),
		unmerge: vi.fn(),
		merge: mergeFn,
	} as unknown as EntityMergePort;

	const embedFn = vi.fn(options.embedImpl ?? (async () => [0.1, 0.2]));
	const embedding: EmbeddingPort = {
		embed: embedFn,
		embedBatch: vi.fn(async (texts) => texts.map(() => [0.1, 0.2])),
	};
	const embeddingStore: EmbeddingStorePort = {
		setEmbedding: vi.fn(async () => {}),
	};

	return {
		decisions,
		entities,
		merge,
		embedding,
		embeddingStore,
		spies: {
			resolvePending,
			listPage,
			getOne,
			loadRows,
			getById,
			mergeFn,
			mergeCalls,
			embedFn,
		},
	};
}

describe("reviewBodies (#1665)", () => {
	it("1. review_list hydrates merge_suggested from EntityRepository, falls back to payload names, and preserves exact total", async () => {
		const dec = makeDecision({
			id: "dec-merge",
			decision_type: "merge_suggested",
			decision_payload: {
				winnerEntityId: "w-1",
				loserEntityId: "l-missing",
				winnerName: "Payload Winner",
				loserName: "Payload Loser",
				entityType: "project",
			},
		});
		const winner = makeEntity({ id: "w-1", title: "Canonical Winner", entity_type: "project" });
		const ports = makeFakePorts({
			decisions: [dec],
			totalDecisions: 42,
			entities: [winner],
		});

		const result = await reviewListCore(ports, { status: "pending", limit: 1, offset: 0 }, USER_ID);
		expect(result.total).toBe(42);
		expect(result.decisions).toHaveLength(1);
		expect(result.decisions[0].candidate_entities).toEqual({
			winner: { id: "w-1", title: "Canonical Winner", entity_type: "project" },
			loser: { id: "l-missing", title: "Payload Loser", entity_type: "project" },
		});

		const mcp = formatReviewListMcp(result);
		expect(mcp).toContain("Review Backlog (1 of 42 decisions):");
		expect(mcp).toContain('Winner: "Canonical Winner" (w-1) [project]');
		expect(mcp).toContain('Loser:  "Payload Loser" (l-missing) [project]');
	});

	it("2. review_resolve reject calls resolvePending once, rejects on concurrent false, and rejects action_approval before any write", async () => {
		const dec = makeDecision({ id: "dec-rej", decision_type: "merge_suggested", status: "pending" });
		const portsOk = makeFakePorts({ decisions: [dec], resolvePendingResult: true });

		const res = await reviewResolveCore(
			portsOk,
			{ decision_id: "dec-rej", action: "reject", resolution_notes: "Not dupes" },
			USER_ID,
		);
		expect(portsOk.spies.resolvePending).toHaveBeenCalledTimes(1);
		expect(res).toEqual({
			success: true,
			decisionId: "dec-rej",
			status: "rejected",
			action: "reject",
			decisionType: "merge_suggested",
			notes: "Not dupes",
		});
		expect(formatReviewResolveMcp(res)).toBe(
			"Rejected proposal [dec-rej] (merge_suggested). Notes: Not dupes",
		);

		const portsRace = makeFakePorts({ decisions: [dec], resolvePendingResult: false });
		await expect(
			reviewResolveCore(portsRace, { decision_id: "dec-rej", action: "reject" }, USER_ID),
		).rejects.toThrow("Decision dec-rej was resolved concurrently; nothing changed.");

		const approvalDec = makeDecision({ id: "dec-app", decision_type: "action_approval", status: "pending" });
		const portsApproval = makeFakePorts({ decisions: [approvalDec] });
		await expect(
			reviewResolveCore(portsApproval, { decision_id: "dec-app", action: "reject" }, USER_ID),
		).rejects.toThrow(/action approval/);
		expect(portsApproval.spies.resolvePending).not.toHaveBeenCalled();
	});

	it("3. merge passes computed aliases, carried, and skipped keys, embeds winner once (best effort), and swaps on selected_entity_id", async () => {
		const winner = makeEntity({
			id: "w-1",
			title: "Alice Smith",
			entity_type: "person",
			description: "Lead engineer",
			properties: { role: "Lead", aliases: ["Alice"] },
		});
		const loser = makeEntity({
			id: "l-1",
			title: "Alice S.",
			entity_type: "person",
			description: "Engineer",
			properties: { role: "IC", email: "alice@example.com", aliases: ["A. Smith"] },
		});
		const dec = makeDecision({
			id: "dec-m",
			decision_type: "merge_suggested",
			decision_payload: { winnerEntityId: "w-1", loserEntityId: "l-1" },
		});

		const ports = makeFakePorts({
			decisions: [dec],
			entities: [winner, loser],
			mergeOpId: "op-merge-1",
			embedImpl: async () => {
				throw new Error("embed outage");
			},
		});

		const res = await reviewResolveCore(
			{ ...ports, retryOptions: { maxRetries: 0, baseDelayMs: 0 } },
			{ decision_id: "dec-m", action: "approve" },
			USER_ID,
		);

		expect(ports.spies.mergeFn).toHaveBeenCalledTimes(1);
		const call = ports.spies.mergeCalls[0];
		expect(call.winnerId).toBe("w-1");
		expect(call.loserId).toBe("l-1");
		expect(call.winnerAliases).toEqual(["Alice", "Alice S.", "A. Smith"]);
		expect(call.aliasesAdded).toEqual(["Alice S.", "A. Smith"]);
		expect(call.propertiesCarried).toEqual(["email"]);
		expect(call.propertiesSkipped).toEqual({ role: "conflict_winner_preferred" });
		expect(ports.spies.embedFn).toHaveBeenCalledTimes(1);
		expect(res.mergeOpId).toBe("op-merge-1");
		expect(formatReviewResolveMcp(res)).toContain(
			"Approved proposal [dec-m]: merged loser entity l-1 into winner w-1.",
		);

		// Swap winner and loser when selected_entity_id names the loser
		const portsSwap = makeFakePorts({
			decisions: [dec],
			entities: [winner, loser],
			mergeOpId: "op-swap-1",
		});
		const swapRes = await reviewResolveCore(
			portsSwap,
			{ decision_id: "dec-m", action: "approve", selected_entity_id: "l-1" },
			USER_ID,
		);
		expect(swapRes.winnerId).toBe("l-1");
		expect(swapRes.loserId).toBe("w-1");
		expect(swapRes.survivorOverridden).toBe(true);
		expect(formatReviewResolveMcp(swapRes)).toContain("Survivor entity was overridden by user.");
	});

	it("4. superseded and already-merged paths write through resolvePending and return expected results", async () => {
		const winner = makeEntity({ id: "w-1", title: "Winner", archived: false });
		const supersededLoser = makeEntity({
			id: "l-1",
			title: "Loser",
			archived: true,
			properties: { merged_into: "other-winner" },
		});
		const dec = makeDecision({
			id: "dec-sup",
			decision_type: "merge_suggested",
			decision_payload: { winnerEntityId: "w-1", loserEntityId: "l-1" },
		});
		const portsSup = makeFakePorts({ decisions: [dec], entities: [winner, supersededLoser] });
		const supRes = await reviewResolveCore(
			portsSup,
			{ decision_id: "dec-sup", action: "approve" },
			USER_ID,
		);
		expect(portsSup.spies.mergeFn).not.toHaveBeenCalled();
		expect(portsSup.spies.resolvePending).toHaveBeenCalledTimes(1);
		expect(supRes).toEqual({
			success: true,
			decisionId: "dec-sup",
			status: "rejected",
			action: "reject",
			decisionType: "merge_suggested",
			notes: "Superseded: loser entity l-1 was already merged into other-winner",
		});

		const alreadyLoser = makeEntity({
			id: "l-1",
			title: "Loser",
			archived: true,
			properties: { merged_into: "w-1" },
		});
		const decAm = makeDecision({
			id: "dec-am",
			decision_type: "merge_suggested",
			decision_payload: { winnerEntityId: "w-1", loserEntityId: "l-1", mergeOpId: "op-existing" },
		});
		const portsAm = makeFakePorts({ decisions: [decAm], entities: [winner, alreadyLoser] });
		const amRes = await reviewResolveCore(
			portsAm,
			{ decision_id: "dec-am", action: "approve" },
			USER_ID,
		);
		expect(portsAm.spies.mergeFn).not.toHaveBeenCalled();
		expect(portsAm.spies.resolvePending).toHaveBeenCalledTimes(1);
		expect(amRes).toEqual({
			success: true,
			decisionId: "dec-am",
			status: "approved",
			action: "approve",
			decisionType: "merge_suggested",
			mergeOpId: "op-existing",
			winnerId: "w-1",
			loserId: "l-1",
			survivorOverridden: false,
			notes: "Approved by user",
		});
	});
});
