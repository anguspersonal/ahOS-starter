import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	EntityMergeLoserRow,
	EntityMergePort,
	UnmergeExecutionResult,
} from "../../ports/entityMerge.js";
import {
	createEntityUnmergeAction,
	ENTITY_UNMERGE_DESCRIPTION,
	formatEntityUnmergeMcp,
} from "./unmerge.js";

const LEGACY_INPUT_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		op_id: {
			description:
				"UUID of the merge operation to reverse (from loser's properties._merge.op_id or system_decisions.decision_payload.mergeOpId).",
			type: "string",
			format: "uuid",
			pattern:
				"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
		},
		entity_id: {
			description:
				"UUID of the tombstoned loser entity. If provided without op_id, the merge record is read from this entity.",
			type: "string",
			format: "uuid",
			pattern:
				"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
		},
	},
	additionalProperties: false,
};

const USER_ID = "00000000-0000-0000-0000-000000000000";
const OP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OP_ID = "99999999-9999-4999-8999-999999999999";
const LOSER_ID = "22222222-2222-4222-8222-222222222222";
const WINNER_ID = "33333333-3333-4333-8333-333333333333";

function makeFakeMergePort(overrides?: Partial<EntityMergePort>): {
	port: EntityMergePort;
	calls: Array<{ method: string; args: unknown[] }>;
} {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const port: EntityMergePort = {
		findLoserById: async (id, userId) => {
			calls.push({ method: "findLoserById", args: [id, userId] });
			return null;
		},
		findLoserByOpId: async (opId, userId) => {
			calls.push({ method: "findLoserByOpId", args: [opId, userId] });
			return null;
		},
		unmerge: async (loserId, userId) => {
			calls.push({ method: "unmerge", args: [loserId, userId] });
			throw new Error("unexpected unmerge call");
		},
		merge: async (params) => {
			calls.push({ method: "merge", args: [params] });
			throw new Error("unexpected merge call");
		},
		...overrides,
	};
	return { port, calls };
}

describe("entity_unmerge core action (#1498)", () => {
	it("case 1: contract parity (id, JSON schema snapshot, description, annotations)", () => {
		const { port } = makeFakeMergePort();
		const action = createEntityUnmergeAction(port);

		expect(action.id).toBe("entity_unmerge");
		expect(z.toJSONSchema(action.schema)).toEqual(LEGACY_INPUT_JSON_SCHEMA);
		expect(action.description).toBe(
			"Reverse an entity merge operation by op_id or loser entity_id. Restores the loser entity (archived=false, " +
				"clears merged_into), moves repointed relationship edges and artifact links back, un-archives redundant edges, " +
				"and removes merged-in aliases and carried properties from the winner. Refuses if any affected edge has been edited since the merge.",
		);
		expect(action.description).toBe(ENTITY_UNMERGE_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
	});

	it("case 2: rejects when neither op_id nor entity_id is provided before any port call", async () => {
		const { port, calls } = makeFakeMergePort();
		const action = createEntityUnmergeAction(port);

		await expect(
			executeAction(action, {}, { context: { caller: "mcp", requestId: "r-1", userId: USER_ID } }),
		).rejects.toThrow("Provide op_id or entity_id to unmerge.");
		expect(calls).toHaveLength(0);
	});

	it("case 3: rejects as not found when entity_id is missing or belongs to another user", async () => {
		const { port, calls } = makeFakeMergePort({
			findLoserById: async (id, userId) => {
				calls.push({ method: "findLoserById", args: [id, userId] });
				return null;
			},
		});
		const action = createEntityUnmergeAction(port);

		await expect(
			executeAction(
				action,
				{ entity_id: LOSER_ID },
				{ context: { caller: "mcp", requestId: "r-2", userId: USER_ID } },
			),
		).rejects.toThrow(`Entity not found: ${LOSER_ID}`);
		expect(calls).toEqual([{ method: "findLoserById", args: [LOSER_ID, USER_ID] }]);
	});

	it("case 4: rejects when _merge record is missing or op_id mismatches", async () => {
		const missingMergeLoser: EntityMergeLoserRow = {
			id: LOSER_ID,
			title: "Loser Entity",
			properties: {},
		};
		const { port: portMissing } = makeFakeMergePort({
			findLoserById: async () => missingMergeLoser,
		});
		const actionMissing = createEntityUnmergeAction(portMissing);

		await expect(
			executeAction(
				actionMissing,
				{ entity_id: LOSER_ID },
				{ context: { caller: "mcp", requestId: "r-3", userId: USER_ID } },
			),
		).rejects.toThrow(
			`Entity ${LOSER_ID} ("Loser Entity") does not contain a valid _merge record (properties._merge is missing).`,
		);

		const mismatchedLoser: EntityMergeLoserRow = {
			id: LOSER_ID,
			title: "Loser Entity",
			properties: {
				_merge: {
					op_id: OTHER_OP_ID,
					winner_id: WINNER_ID,
					merged_at: "2026-09-26T10:00:00.000Z",
				},
			},
		};
		const { port: portMismatch, calls: mismatchCalls } = makeFakeMergePort({
			findLoserById: async (id, userId) => {
				mismatchCalls.push({ method: "findLoserById", args: [id, userId] });
				return mismatchedLoser;
			},
		});
		const actionMismatch = createEntityUnmergeAction(portMismatch);

		await expect(
			executeAction(
				actionMismatch,
				{ entity_id: LOSER_ID, op_id: OP_ID },
				{ context: { caller: "mcp", requestId: "r-4", userId: USER_ID } },
			),
		).rejects.toThrow(
			`Entity ${LOSER_ID} merge record op_id ("${OTHER_OP_ID}") does not match requested op_id ("${OP_ID}").`,
		);
		expect(mismatchCalls.some((c) => c.method === "unmerge")).toBe(false);
	});

	it("case 5: unmerges via port, re-embeds winner then loser (swallowing embed failure to stderr), and formats six-line MCP summary", async () => {
		const loserRow: EntityMergeLoserRow = {
			id: LOSER_ID,
			title: "Loser Corp",
			properties: {
				_merge: {
					op_id: OP_ID,
					winner_id: WINNER_ID,
					merged_at: "2026-09-26T10:00:00.000Z",
				},
			},
		};
		const rpcResult: UnmergeExecutionResult = {
			success: true,
			loser_id: LOSER_ID,
			winner_id: WINNER_ID,
			loser_title: "Loser Corp",
			loser_description: "Loser description",
			loser_properties: { industry: "Tech" },
			winner_title: "Winner Corp",
			winner_description: "Winner description",
			winner_properties: { aliases: ["Winner Corp", "WC"], established: 2010 },
			moved_edge_ids: ["edge-1", "edge-2"],
			archived_edge_ids: ["edge-arch-1"],
			type_restored_count: 1,
			links_moved: ["link-1"],
			aliases_removed: ["Loser Corp", "LC"],
			properties_removed: ["industry", "phone"],
		};

		const { port, calls } = makeFakeMergePort({
			findLoserByOpId: async (opId, userId) => {
				calls.push({ method: "findLoserByOpId", args: [opId, userId] });
				return loserRow;
			},
			unmerge: async (loserId, userId) => {
				calls.push({ method: "unmerge", args: [loserId, userId] });
				return rpcResult;
			},
		});

		const embedTexts: string[] = [];
		const storedIds: string[] = [];
		const embeddingPort: EmbeddingPort = {
			embed: async (text) => {
				embedTexts.push(text);
				return [0.1, 0.2];
			},
			embedBatch: async (texts) => texts.map(() => [0.1, 0.2]),
		};
		const embeddingStore: EmbeddingStorePort = {
			setEmbedding: async (_table, id) => {
				storedIds.push(id);
			},
		};

		const action = createEntityUnmergeAction({
			merge: port,
			embeddings: embeddingPort,
			embeddingStore,
		});

		const output = await executeAction(
			action,
			{ op_id: OP_ID },
			{ context: { caller: "mcp", requestId: "r-5", userId: USER_ID } },
		);

		expect(output).toEqual(rpcResult);
		expect(calls).toEqual([
			{ method: "findLoserByOpId", args: [OP_ID, USER_ID] },
			{ method: "unmerge", args: [LOSER_ID, USER_ID] },
		]);
		expect(storedIds).toEqual([WINNER_ID, LOSER_ID]);
		expect(embedTexts[0]).toContain("Winner Corp");
		expect(embedTexts[1]).toContain("Loser Corp");

		const formatted = action.formatMcp!(output);
		expect(formatted).toBe(formatEntityUnmergeMcp(output));
		expect(formatted).toBe(
			`Successfully unmerged entity "Loser Corp" from "Winner Corp":\n` +
				`- Restored entity: ${LOSER_ID} (archived=false, cleared merged_into)\n` +
				`- Edges restored: 2 moved back (1 relationship_type restored), 1 un-archived\n` +
				`- Artifact links restored: 1 moved back\n` +
				`- Winner cleaned: ${WINNER_ID} (removed 2 aliases, 2 carried properties)\n` +
				`- Re-embedded both entities`,
		);

		// Embed failure is reported on stderr and does not fail the call
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const failingEmbeddingPort: EmbeddingPort = {
				embed: async () => {
					throw new Error("provider down");
				},
				embedBatch: async () => {
					throw new Error("provider down");
				},
			};
			const actionWithFailingEmbed = createEntityUnmergeAction({
				merge: port,
				embeddings: failingEmbeddingPort,
				embeddingStore,
				retryOptions: { maxAttempts: 1 },
			});
			const res2 = await executeAction(
				actionWithFailingEmbed,
				{ op_id: OP_ID },
				{ context: { caller: "mcp", requestId: "r-6", userId: USER_ID } },
			);
			expect(res2.success).toBe(true);
			const stderrMessages = stderrSpy.mock.calls.map((c) => String(c[0]));
			expect(
				stderrMessages.some((m) =>
					m.includes(`[entity_unmerge] Failed to re-embed winner ${WINNER_ID}: Error: provider down`),
				),
			).toBe(true);
			expect(
				stderrMessages.some((m) =>
					m.includes(`[entity_unmerge] Failed to re-embed loser ${LOSER_ID}: Error: provider down`),
				),
			).toBe(true);
		} finally {
			stderrSpy.mockRestore();
		}
	});
});
