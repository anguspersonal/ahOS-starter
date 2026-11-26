import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseEntityMergeAdapter } from "./entityMerge.js";

const USER_ID = "00000000-0000-0000-0000-000000000000";
const WINNER_ID = "33333333-3333-4333-8333-333333333333";
const LOSER_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "44444444-4444-4444-8444-444444444444";
const EDGE_ID = "55555555-5555-4555-8555-555555555555";
const DECISION_ID = "66666666-6666-4666-8666-666666666666";
const OP_ID = "11111111-1111-4111-8111-111111111111";
const NOW_ISO = "2026-10-11T12:00:00.000Z";

function makeMergeParams() {
	return {
		winnerId: WINNER_ID,
		loserId: LOSER_ID,
		userId: USER_ID,
		winnerRow: {
			id: WINNER_ID,
			entity_type: "people",
			properties: { email: "winner@example.com" },
		},
		loserRow: {
			id: LOSER_ID,
			entity_type: "people",
			properties: { role: "Founder" },
		},
		finalWinnerProps: { email: "winner@example.com", role: "Founder" },
		winnerAliases: ["Loser Alias"],
		aliasesAdded: ["Loser Alias"],
		propertiesCarried: ["role"],
		propertiesSkipped: { email: "conflict_winner_preferred" },
		decisionId: DECISION_ID,
		resolutionNotes: "Approved by user",
		survivorOverridden: false,
		payload: { confidence: 0.94 },
		nowIso: NOW_ISO,
	};
}

describe("EntityMergePort.merge and client-side fallback (#1663)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("case 1: calls merge_entities RPC with the 13 p_* arguments and returns merge_op", async () => {
		const fake = createFakeSupabase();
		const expectedMergeOp = {
			op_id: OP_ID,
			merged_at: NOW_ISO,
			winner_id: WINNER_ID,
			moved_edge_ids: [EDGE_ID],
			archived_edge_ids: [],
			aliases_added: ["Loser Alias"],
			properties_carried: ["role"],
			properties_skipped: { email: "conflict_winner_preferred" },
			links_moved: [],
			links_deleted: [],
		};
		fake.setRpcResponder((fn, args) => {
			expect(fn).toBe("merge_entities");
			expect(args).toEqual({
				p_winner_id: WINNER_ID,
				p_loser_id: LOSER_ID,
				p_user_id: USER_ID,
				p_winner_properties: { email: "winner@example.com", role: "Founder" },
				p_winner_aliases: ["Loser Alias"],
				p_aliases_added: ["Loser Alias"],
				p_properties_carried: ["role"],
				p_properties_skipped: { email: "conflict_winner_preferred" },
				p_decision_id: DECISION_ID,
				p_resolution_notes: "Approved by user",
				p_survivor_overridden: false,
				p_decision_status: "approved",
				p_resolved_by: USER_ID,
			});
			return { data: { merge_op: expectedMergeOp }, error: null };
		});

		const adapter = createSupabaseEntityMergeAdapter({
			client: fake.client,
			ownerId: USER_ID,
		});
		const result = await adapter.merge(makeMergeParams());

		expect(result).toEqual(expectedMergeOp);
		expect(fake.rpcCalls).toHaveLength(1);
		expect(Object.keys(fake.rpcCalls[0].args as Record<string, unknown>)).toHaveLength(13);
		expect(fake.calls).toHaveLength(0);
	});

	it("case 2: on PGRST202 writes stderr notice and executes fallback writes in dev order", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		let relSelectCount = 0;
		const fake = createFakeSupabase((call) => {
			if (call.table === "entity_relationships" && call.op === "select") {
				relSelectCount++;
				if (relSelectCount === 1) {
					return {
						data: [
							{
								id: EDGE_ID,
								from_entity_id: LOSER_ID,
								to_entity_id: TARGET_ID,
								relationship_type: "knows",
								archived: false,
							},
						],
						error: null,
					};
				}
				return { data: [], error: null };
			}
			return { data: [], error: null };
		});
		fake.setRpcResponder(() => ({
			data: null,
			error: {
				code: "PGRST202",
				message: "Could not find the function public.merge_entities in the schema cache",
			},
		}));

		const adapter = createSupabaseEntityMergeAdapter({
			client: fake.client,
			ownerId: USER_ID,
		});
		const mergeOp = await adapter.merge(makeMergeParams());

		expect(stderrSpy).toHaveBeenCalledWith(
			"[review_resolve] merge_entities RPC missing from schema cache; executing client-side merge fallback.\n",
		);
		expect(mergeOp?.winner_id).toBe(WINNER_ID);
		expect(mergeOp?.moved_edge_ids).toEqual([EDGE_ID]);

		const writes = fake.calls.filter((c) => c.op !== "select");
		expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual([
			"entity_relationships:update",
			"entities:update",
			"entities:update",
			"system_decisions:update",
		]);
		expect(writes[0].payload).toEqual({
			from_entity_id: WINNER_ID,
			to_entity_id: TARGET_ID,
			relationship_type: "knows",
			updated_at: NOW_ISO,
		});
		expect(writes[1].payload).toEqual({
			properties: { email: "winner@example.com", role: "Founder" },
			aliases: ["Loser Alias"],
			updated_at: NOW_ISO,
		});
		expect(writes[2].payload).toEqual({
			archived: true,
			archived_at: NOW_ISO,
			properties: {
				role: "Founder",
				merged_into: WINNER_ID,
				merged_at: NOW_ISO,
				archived_reason: "merged_duplicate",
				_merge: mergeOp,
			},
			updated_at: NOW_ISO,
		});
		expect(writes[3].payload).toEqual({
			status: "approved",
			resolved_by: USER_ID,
			resolved_at: NOW_ISO,
			resolution_notes: "Approved by user",
			decision_payload: {
				confidence: 0.94,
				winnerEntityId: WINNER_ID,
				loserEntityId: LOSER_ID,
				mergedAt: NOW_ISO,
				survivorOverridden: false,
				mergeOpId: mergeOp?.op_id,
			},
		});
	});

	it("case 3: on P0001 rejects with Failed to execute entity merge and runs no fallback", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const fake = createFakeSupabase();
		fake.setRpcResponder(() => ({
			data: null,
			error: { code: "P0001", message: "Decision was resolved concurrently" },
		}));

		const adapter = createSupabaseEntityMergeAdapter({
			client: fake.client,
			ownerId: USER_ID,
		});

		await expect(adapter.merge(makeMergeParams())).rejects.toThrow(
			"Failed to execute entity merge: Decision was resolved concurrently",
		);
		expect(fake.calls).toHaveLength(0);
		expect(stderrSpy).not.toHaveBeenCalled();
	});
});
