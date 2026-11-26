import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../embeddings.js", () => ({
	embed: vi.fn(async () => [0.1]),
	embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1])),
}));

import { supabase } from "../supabase.js";
import { embed } from "../embeddings.js";
import {
	reviewListCore,
	reviewResolveCore,
	reviewListHandler,
	reviewResolveHandler,
	reviewListAction,
	reviewResolveAction,
	formatReviewListMcp,
	formatReviewResolveMcp,
} from "../tools/review.js";
import { executeAction } from "../actions/adapters/direct.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const entityUnmergeHandler = (args: { op_id?: string; entity_id?: string }) =>
	toMcpTool(serverRegistry().get("entity_unmerge")!).handler(args);

const mockEmbed = vi.mocked(embed);
const origFrom = supabase.from;
const origRpc = (supabase as any).rpc;

const USER_ID = "00000000-0000-0000-0000-000000000000";

type Row = Record<string, any>;
type Filter =
	| { op: "eq" | "in" | "contains" | "jsonpath" | "neq"; field: string; value: any }
	| { op: "or"; value: string };

function rowMatches(row: Row, filters: Filter[]): boolean {
	return filters.every((f) => {
		switch (f.op) {
			case "eq":
				return row[f.field] === f.value;
			case "neq":
				return row[f.field] !== f.value;
			case "in":
				return Array.isArray(f.value) && f.value.includes(row[f.field]);
			case "contains": {
				const opId = f.value?._merge?.op_id;
				return row?.properties?._merge?.op_id === opId;
			}
			case "jsonpath":
				return row?.properties?._merge?.op_id === f.value;
			case "or": {
				const parts = String(f.value).split(",");
				return parts.some((part) => {
					const [col, op, val] = part.split(".");
					if (op === "eq") return row[col] === val;
					return false;
				});
			}
			default:
				return true;
		}
	});
}

function makeFakeSupabase(
	tables: Record<string, Row[]>,
	options?: {
		mockRpcMissing?: boolean;
		afterSelect?: (table: string) => void;
		updateError?: any;
	},
) {
	const updateLog: Array<{ table: string; payload: any; filters: Filter[]; select?: string }> = [];
	const deleteLog: Array<{ table: string; filters: Filter[] }> = [];

	function selectChain(table: string) {
		const filters: Filter[] = [];
		let rangeOffset = 0;
		let rangeLimit: number | undefined;

		const resolve = (single: boolean) => {
			const rows = tables[table] ?? [];
			let found = rows.filter((r) => rowMatches(r, filters));
			const total = found.length;
			if (rangeLimit !== undefined) {
				found = found.slice(rangeOffset, rangeOffset + rangeLimit);
			}
			return Promise.resolve({
				data: single ? (found[0] ?? null) : found,
				count: total,
				error: null,
			});
		};

		const chain: any = {
			eq(field: string, value: any) {
				filters.push({ op: "eq", field, value });
				return chain;
			},
			neq(field: string, value: any) {
				filters.push({ op: "neq", field, value });
				return chain;
			},
			or(clause: string) {
				filters.push({ op: "or", value: clause });
				return chain;
			},
			limit(n: number) {
				rangeLimit = n;
				return chain;
			},
			in(field: string, value: any) {
				filters.push({ op: "in", field, value });
				return chain;
			},
			contains(field: string, value: any) {
				filters.push({ op: "contains", field, value });
				return chain;
			},
			filter(field: string, _op: string, value: any) {
				filters.push({ op: "jsonpath", field, value });
				return chain;
			},
			order() {
				return chain;
			},
			range(from: number, to: number) {
				rangeOffset = from;
				rangeLimit = to - from + 1;
				return chain;
			},
			maybeSingle: () => {
				const res = resolve(true);
				if (options?.afterSelect) {
					return res.then((r) => {
						const cloned = r.data ? JSON.parse(JSON.stringify(r.data)) : null;
						options.afterSelect!(table);
						return { ...r, data: cloned };
					});
				}
				return res;
			},
			single: () => resolve(true),
			then: (resolveFn: any, rejectFn: any) => resolve(false).then(resolveFn, rejectFn),
		};
		return chain;
	}

	function updateChain(table: string, payload: any) {
		const filters: Filter[] = [];
		let selectCols: string | undefined;

		const execute = () => {
			updateLog.push({ table, payload, filters: [...filters], select: selectCols });
			if (options?.updateError) {
				return Promise.resolve({ data: null, error: options.updateError });
			}
			const rows = tables[table] ?? [];
			const matchedRows: Row[] = [];
			for (const r of rows) {
				if (rowMatches(r, filters)) {
					matchedRows.push(r);
					Object.assign(r, payload);
				}
			}
			const data = selectCols !== undefined ? matchedRows.map((r) => ({ id: r.id })) : null;
			return Promise.resolve({ data, error: null });
		};

		const chain: any = {
			eq(field: string, value: any) {
				filters.push({ op: "eq", field, value });
				return chain;
			},
			in(field: string, value: any) {
				filters.push({ op: "in", field, value });
				return chain;
			},
			select(cols?: string) {
				selectCols = cols ?? "*";
				return chain;
			},
			then: (resolveFn: any, rejectFn: any) => {
				return execute().then(resolveFn, rejectFn);
			},
		};
		return chain;
	}

	function deleteChain(table: string) {
		const filters: Filter[] = [];
		const chain: any = {
			eq(field: string, value: any) {
				filters.push({ op: "eq", field, value });
				return chain;
			},
			in(field: string, value: any) {
				filters.push({ op: "in", field, value });
				return chain;
			},
			then: (resolveFn: any, rejectFn: any) => {
				deleteLog.push({ table, filters: [...filters] });
				const rows = tables[table] ?? [];
				const remaining = rows.filter((r) => !rowMatches(r, filters));
				rows.length = 0;
				rows.push(...remaining);
				return Promise.resolve({ error: null }).then(resolveFn, rejectFn);
			},
		};
		return chain;
	}

	const client: any = {
		from(table: string) {
			return {
				select: (_cols?: string, _opts?: any) => selectChain(table),
				update: (payload: any) => updateChain(table, payload),
				delete: () => deleteChain(table),
			};
		},
		rpc(fnName: string, params: any) {
			if (options?.mockRpcMissing && (fnName === "merge_entities" || fnName === "unmerge_entities")) {
				return Promise.resolve({
					data: null,
					error: {
						code: "PGRST202",
						message: `Could not find the function public.${fnName} in the schema cache`,
					},
				});
			}

			if (fnName === "merge_entities") {
				const {
					p_winner_id,
					p_loser_id,
					p_user_id,
					p_winner_properties,
					p_winner_aliases,
					p_aliases_added,
					p_properties_carried,
					p_properties_skipped = {},
					p_decision_id,
					p_resolution_notes = "Approved by user",
					p_survivor_overridden = false,
					p_decision_status = "approved",
					p_resolved_by,
				} = params;

				if (p_decision_id) {
					const decision = (tables.system_decisions ?? []).find((d) => d.id === p_decision_id);
					if (!decision || decision.status !== "pending") {
						return Promise.resolve({
							data: null,
							error: {
								code: "P0001",
								message: `Decision ${p_decision_id} was resolved concurrently; nothing changed.`,
							},
						});
					}
				}

				const winner = (tables.entities ?? []).find((e) => e.id === p_winner_id);
				const loser = (tables.entities ?? []).find((e) => e.id === p_loser_id);

				if (!winner) {
					return Promise.resolve({ data: null, error: { message: `Merge winner entity not found: ${p_winner_id}` } });
				}
				if (!loser) {
					return Promise.resolve({ data: null, error: { message: `Merge loser entity not found: ${p_loser_id}` } });
				}

				if (loser.archived && loser.properties?.merged_into === p_winner_id) {
					if (p_decision_id) {
						const decision = (tables.system_decisions ?? []).find((d) => d.id === p_decision_id);
						if (decision) {
							decision.status = p_decision_status;
							decision.resolved_by = p_resolved_by ?? p_user_id;
							decision.resolved_at = new Date().toISOString();
							decision.resolution_notes = p_resolution_notes;
							decision.decision_payload = {
								...decision.decision_payload,
								winnerEntityId: p_winner_id,
								loserEntityId: p_loser_id,
								survivorOverridden: p_survivor_overridden,
							};
						}
					}
					return Promise.resolve({
						data: {
							success: true,
							already_merged: true,
							idempotent: true,
							winner_id: p_winner_id,
							loser_id: p_loser_id,
						},
						error: null,
					});
				}

				const moved_edge_ids: string[] = [];
				const archived_edge_ids: string[] = [];
				const demoted_edge_types: Record<string, string> = {};

				for (const edge of tables.entity_relationships ?? []) {
					if (edge.from_entity_id !== p_loser_id && edge.to_entity_id !== p_loser_id) continue;
					if (p_user_id && edge.user_id && edge.user_id !== p_user_id) continue;

					const newFrom = edge.from_entity_id === p_loser_id ? p_winner_id : edge.from_entity_id;
					const newTo = edge.to_entity_id === p_loser_id ? p_winner_id : edge.to_entity_id;

					if (newFrom === newTo) {
						edge.archived = true;
						archived_edge_ids.push(edge.id);
						continue;
					}

					let newType = edge.relationship_type;
					if (
						edge.relationship_type === "belongs_to" &&
						edge.from_entity_id === p_loser_id &&
						!edge.archived &&
						(winner.entity_type === "project" || winner.entity_type === "resource")
					) {
						const hasLivePrimary = (tables.entity_relationships ?? []).some(
							(other) =>
								other.from_entity_id === p_winner_id &&
								other.relationship_type === "belongs_to" &&
								!other.archived &&
								other.to_entity_id !== newTo &&
								(!p_user_id || !other.user_id || other.user_id === p_user_id),
						);
						if (hasLivePrimary) {
							demoted_edge_types[edge.id] = edge.relationship_type;
							newType = "associated_with";
						}
					}

					const collision = (tables.entity_relationships ?? []).some(
						(other) =>
							other.id !== edge.id &&
							other.from_entity_id === newFrom &&
							other.to_entity_id === newTo &&
							other.relationship_type === newType &&
							!other.archived &&
							(!p_user_id || !other.user_id || other.user_id === p_user_id),
					);

					if (collision) {
						delete demoted_edge_types[edge.id];
						edge.archived = true;
						archived_edge_ids.push(edge.id);
						continue;
					}

					edge.from_entity_id = newFrom;
					edge.to_entity_id = newTo;
					edge.relationship_type = newType;
					moved_edge_ids.push(edge.id);
				}

				const links_moved: string[] = [];
				const links_deleted: string[] = [];
				const links = tables.artifact_entity_links ?? [];
				for (let i = links.length - 1; i >= 0; i--) {
					const link = links[i];
					if (link.entity_id === p_loser_id && (!p_user_id || !link.user_id || link.user_id === p_user_id)) {
						const collision = links.some(
							(other) =>
								other.id !== link.id &&
								other.artifact_id === link.artifact_id &&
								other.entity_id === p_winner_id &&
								other.link_type === link.link_type &&
								(!p_user_id || !other.user_id || other.user_id === p_user_id),
						);
						if (collision) {
							links_deleted.push(link.id);
							deleteLog.push({
								table: "artifact_entity_links",
								filters: [{ op: "eq", field: "id", value: link.id }],
							});
							links.splice(i, 1);
							continue;
						}
						link.entity_id = p_winner_id;
						links_moved.push(link.id);
					}
				}

				winner.properties = p_winner_properties;
				winner.aliases = p_winner_aliases;

				const op_id = randomUUID();
				const merged_at = new Date().toISOString();
				const merge_op = {
					op_id,
					merged_at,
					winner_id: p_winner_id,
					moved_edge_ids,
					archived_edge_ids,
					aliases_added: p_aliases_added,
					properties_carried: p_properties_carried,
					properties_skipped: Object.keys(p_properties_skipped).length > 0 ? p_properties_skipped : undefined,
					links_moved,
					links_deleted,
					demoted_edge_types: Object.keys(demoted_edge_types).length > 0 ? demoted_edge_types : undefined,
				};

				loser.archived = true;
				loser.archived_at = merged_at;
				loser.properties = {
					...(loser.properties || {}),
					merged_into: p_winner_id,
					merged_at,
					archived_reason: "merged_duplicate",
					_merge: merge_op,
				};

				if (p_decision_id) {
					const decision = (tables.system_decisions ?? []).find((d) => d.id === p_decision_id);
					if (decision) {
						decision.status = p_decision_status;
						decision.resolved_by = p_resolved_by ?? p_user_id;
						decision.resolved_at = merged_at;
						decision.resolution_notes = p_resolution_notes;
						decision.decision_payload = {
							...(decision.decision_payload || {}),
							winnerEntityId: p_winner_id,
							loserEntityId: p_loser_id,
							mergedAt: merged_at,
							survivorOverridden: p_survivor_overridden,
							mergeOpId: op_id,
						};
					}
				}

				return Promise.resolve({
					data: {
						success: true,
						winner_id: p_winner_id,
						loser_id: p_loser_id,
						op_id,
						merged_at,
						merge_op,
						winner_title: winner.title,
						winner_description: winner.description,
					},
					error: null,
				});
			}

			if (fnName === "unmerge_entities") {
				const { p_loser_id, p_user_id } = params;
				const loser = (tables.entities ?? []).find(
					(e) => e.id === p_loser_id && (e.user_id === p_user_id || !p_user_id),
				);
				if (!loser) {
					return Promise.resolve({ data: null, error: { message: `Entity ${p_loser_id} not found.` } });
				}
				const mergeRecord = loser.properties?._merge;
				const winnerId = mergeRecord?.winner_id;
				const winner = (tables.entities ?? []).find(
					(e) => e.id === winnerId && (e.user_id === p_user_id || !p_user_id),
				);

				const restoredLoserProps = { ...(loser.properties ?? {}) };
				delete restoredLoserProps.merged_into;
				delete restoredLoserProps.merged_at;
				delete restoredLoserProps.archived_reason;
				delete restoredLoserProps._merge;

				loser.archived = false;
				loser.archived_at = null;
				loser.properties = restoredLoserProps;

				return Promise.resolve({
					data: {
						success: true,
						loser_id: loser.id,
						winner_id: winnerId,
						loser_title: loser.title,
						loser_description: loser.description,
						loser_properties: restoredLoserProps,
						winner_title: winner?.title,
						winner_description: winner?.description,
						winner_properties: winner?.properties,
						moved_edge_ids: mergeRecord?.moved_edge_ids ?? [],
						archived_edge_ids: mergeRecord?.archived_edge_ids ?? [],
						type_restored_count: 0,
						links_moved: mergeRecord?.links_moved ?? [],
						aliases_removed: mergeRecord?.aliases_added ?? [],
						properties_removed: mergeRecord?.properties_carried ?? [],
					},
					error: null,
				});
			}

			return Promise.resolve({ data: null, error: null });
		},
	};

	(supabase as any).from = client.from;
	(supabase as any).rpc = client.rpc;

	return { client, updateLog, deleteLog };
}

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
	vi.clearAllMocks();
});

describe("review_list action and tool", () => {
	it("returns empty result when no decisions exist", async () => {
		const { client } = makeFakeSupabase({ system_decisions: [], entities: [] });
		(supabase as any).from = client.from;

		const result = await reviewListCore({ status: "pending", limit: 20, offset: 0 }, USER_ID);
		expect(result.decisions).toEqual([]);
		expect(result.total).toBe(0);

		const formatted = formatReviewListMcp(result);
		expect(formatted).toBe("No review decisions found matching criteria.");
	});

	it("filters by status and enriches merge_suggested decisions with candidate entities", async () => {
		const decisions = [
			{
				id: "dec-1",
				user_id: USER_ID,
				decision_type: "merge_suggested",
				review_type: "approval",
				stage: "organize",
				status: "pending",
				title: "Possible duplicate",
				description: "Entity B looks like a duplicate of Entity A",
				confidence_score: 95,
				decision_payload: {
					winnerEntityId: "ent-winner",
					loserEntityId: "ent-loser",
					winnerName: "Project Alpha",
					loserName: "Project Alpha Copy",
					entityType: "project",
				},
				created_at: "2026-10-01T10:00:00Z",
			},
			{
				id: "dec-2",
				user_id: USER_ID,
				decision_type: "merge_suggested",
				review_type: "approval",
				stage: "organize",
				status: "approved",
				title: "Already approved",
				description: null,
				confidence_score: 90,
				decision_payload: {
					winnerEntityId: "ent-winner",
					loserEntityId: "ent-loser",
				},
				created_at: "2026-09-30T10:00:00Z",
			},
		];

		const entities = [
			{ id: "ent-winner", user_id: USER_ID, title: "Project Alpha (Canonical)", entity_type: "project" },
			{ id: "ent-loser", user_id: USER_ID, title: "Project Alpha Copy", entity_type: "project" },
		];

		const { client } = makeFakeSupabase({ system_decisions: decisions, entities });
		(supabase as any).from = client.from;

		const pendingResult = await reviewListCore({ status: "pending", limit: 20, offset: 0 }, USER_ID);
		expect(pendingResult.decisions).toHaveLength(1);
		expect(pendingResult.decisions[0].id).toBe("dec-1");
		expect(pendingResult.decisions[0].candidate_entities).toBeDefined();
		expect(pendingResult.decisions[0].candidate_entities?.winner?.title).toBe("Project Alpha (Canonical)");
		expect(pendingResult.decisions[0].candidate_entities?.loser?.title).toBe("Project Alpha Copy");

		const formatted = formatReviewListMcp(pendingResult);
		expect(formatted).toContain("[dec-1] MERGE_SUGGESTED (pending)");
		expect(formatted).toContain('Winner: "Project Alpha (Canonical)"');
		expect(formatted).toContain('Loser:  "Project Alpha Copy"');
		expect(formatted).toContain("review_resolve(decision_id, action: 'approve' | 'reject')");

		// Status = all
		const allResult = await reviewListCore({ status: "all", limit: 20, offset: 0 }, USER_ID);
		expect(allResult.decisions).toHaveLength(2);
	});

	it("executes via direct Unified Action wrapper", async () => {
		const decisions = [
			{
				id: "dec-1",
				user_id: USER_ID,
				decision_type: "merge_suggested",
				review_type: "approval",
				stage: "organize",
				status: "pending",
				title: "Possible duplicate",
				description: "Dup check",
				confidence_score: 88,
				decision_payload: {},
				created_at: "2026-10-01T10:00:00Z",
			},
		];

		const { client } = makeFakeSupabase({ system_decisions: decisions, entities: [] });
		(supabase as any).from = client.from;

		const res = await executeAction(
			reviewListAction,
			{ status: "pending" },
			{ context: { caller: "worker", requestId: "req-1", userId: USER_ID } },
		);

		expect(res.total).toBe(1);
		expect(res.decisions[0].id).toBe("dec-1");
	});

	it("hydrates linked_entity_ids and candidate_entity_ids and formats them via formatReviewListMcp (#2111)", async () => {
		const entityA = "00000000-0000-0000-0000-0000000000a1";
		const entityB = "00000000-0000-0000-0000-0000000000b2";
		const entityC = "00000000-0000-0000-0000-0000000000c3";
		const missingEntity = "00000000-0000-0000-0000-000000000099";

		const decisions = [
			{
				id: "dec-task",
				user_id: USER_ID,
				decision_type: "task_creation",
				review_type: "approval",
				stage: "organize",
				status: "pending",
				title: "Create follow-up task",
				description: "Follow up on Q3 metrics",
				confidence_score: 82,
				decision_payload: {
					linked_entity_ids: [entityA, missingEntity],
				},
				created_at: "2026-10-02T10:00:00Z",
			},
			{
				id: "dec-rel",
				user_id: USER_ID,
				decision_type: "relationship_suggestion",
				review_type: "disambiguation",
				stage: "organize",
				status: "pending",
				title: "Link artifact to person",
				description: "Ambiguous person mention",
				confidence_score: 64,
				decision_payload: {
					candidate_entity_ids: [entityB, entityC],
				},
				created_at: "2026-10-03T10:00:00Z",
			},
		];

		const entities = [
			{ id: entityA, user_id: USER_ID, title: "Acme Corp", entity_type: "organization" },
			{ id: entityB, user_id: USER_ID, title: "Jane Doe (Sales)", entity_type: "person" },
			{ id: entityC, user_id: USER_ID, title: "Jane Doe (Eng)", entity_type: "person" },
		];

		const { client } = makeFakeSupabase({ system_decisions: decisions, entities });
		(supabase as any).from = client.from;

		const result = await reviewListCore({ status: "pending", limit: 20, offset: 0 }, USER_ID);
		expect(result.decisions).toHaveLength(2);

		const taskDecision = result.decisions.find((d) => d.id === "dec-task")!;
		expect(taskDecision.linked_entities).toEqual([
			{ id: entityA, title: "Acme Corp", entity_type: "organization" },
			{ id: missingEntity, title: null, entity_type: null },
		]);
		expect(taskDecision.disambiguation_candidates).toBeUndefined();

		const relDecision = result.decisions.find((d) => d.id === "dec-rel")!;
		expect(relDecision.disambiguation_candidates).toEqual([
			{ id: entityB, title: "Jane Doe (Sales)", entity_type: "person" },
			{ id: entityC, title: "Jane Doe (Eng)", entity_type: "person" },
		]);
		expect(relDecision.linked_entities).toBeUndefined();

		const formatted = formatReviewListMcp(result);
		expect(formatted).toContain(
			`  Linked entities: Acme Corp (organization) [${entityA}], Untitled (unknown) [${missingEntity}]`,
		);
		expect(formatted).toContain(
			`  Candidate entities: Jane Doe (Sales) (person) [${entityB}], Jane Doe (Eng) (person) [${entityC}]`,
		);
	});
});

describe("review_resolve action and tool", () => {
	it("rejects a pending proposal", async () => {
		const decId = "00000000-0000-0000-0000-000000000001";
		const decisions = [
			{
				id: decId,
				user_id: USER_ID,
				decision_type: "merge_suggested",
				status: "pending",
				decision_payload: { winnerEntityId: "w1", loserEntityId: "l1" },
			},
		];
		const { client, updateLog } = makeFakeSupabase({ system_decisions: decisions, entities: [] });
		(supabase as any).from = client.from;

		const result = await reviewResolveCore(
			{ decision_id: decId, action: "reject", resolution_notes: "Not duplicates" },
			USER_ID,
		);

		expect(result.success).toBe(true);
		expect(result.status).toBe("rejected");
		expect(result.notes).toBe("Not duplicates");

		const decUpdate = updateLog.find((u) => u.table === "system_decisions");
		expect(decUpdate).toBeDefined();
		expect(decUpdate?.payload.status).toBe("rejected");
		expect(decUpdate?.payload.resolution_notes).toBe("Not duplicates");

		const mcpText = formatReviewResolveMcp(result);
		expect(mcpText).toContain("Rejected proposal");
		expect(mcpText).toContain("Not duplicates");
	});

	it("refuses to reprocess already resolved non-pending decision", async () => {
		const decisions = [
			{
				id: "00000000-0000-0000-0000-000000000001",
				user_id: USER_ID,
				decision_type: "merge_suggested",
				status: "approved",
			},
		];
		const { client } = makeFakeSupabase({ system_decisions: decisions, entities: [] });
		(supabase as any).from = client.from;

		await expect(
			reviewResolveCore(
				{ decision_id: "00000000-0000-0000-0000-000000000001", action: "reject" },
				USER_ID,
			),
		).rejects.toThrow(/not pending/);
	});

	it("approves merge_suggested: repoints edges and links, merges properties and aliases, tombstones loser, and updates decision", async () => {
		const decisionId = "00000000-0000-0000-0000-000000000001";
		const winnerId = "00000000-0000-0000-0000-000000000010";
		const loserId = "00000000-0000-0000-0000-000000000020";
		const targetEntityId = "00000000-0000-0000-0000-000000000030";

		const decisions = [
			{
				id: decisionId,
				user_id: USER_ID,
				decision_type: "merge_suggested",
				status: "pending",
				decision_payload: {
					winnerEntityId: winnerId,
					loserEntityId: loserId,
					winnerName: "Alice Smith",
					loserName: "Alice S.",
				},
			},
		];

		const entities = [
			{
				id: winnerId,
				user_id: USER_ID,
				title: "Alice Smith",
				entity_type: "person",
				description: "Lead engineer",
				properties: {
					role: "Lead",
					aliases: ["Alice"],
				},
				archived: false,
			},
			{
				id: loserId,
				user_id: USER_ID,
				title: "Alice S.",
				entity_type: "person",
				description: "Engineer",
				properties: {
					email: "alice@example.com",
					aliases: ["A. Smith"],
				},
				archived: false,
			},
		];

		const relationships = [
			// Normal edge to be repointed
			{
				id: "edge-1",
				user_id: USER_ID,
				from_entity_id: loserId,
				to_entity_id: targetEntityId,
				relationship_type: "works_on",
				archived: false,
			},
			// Self-loop edge between loser and winner
			{
				id: "edge-self",
				user_id: USER_ID,
				from_entity_id: loserId,
				to_entity_id: winnerId,
				relationship_type: "collaborates_with",
				archived: false,
			},
		];

		const links = [
			{
				id: "link-1",
				user_id: USER_ID,
				artifact_id: "art-1",
				entity_id: loserId,
				link_type: "mention",
			},
		];

		const { client } = makeFakeSupabase({
			system_decisions: decisions,
			entities,
			entity_relationships: relationships,
			artifact_entity_links: links,
		});
		(supabase as any).from = client.from;

		const result = await reviewResolveCore(
			{ decision_id: decisionId, action: "approve" },
			USER_ID,
		);

		expect(result.success).toBe(true);
		expect(result.status).toBe("approved");
		expect(result.winnerId).toBe(winnerId);
		expect(result.loserId).toBe(loserId);
		expect(result.mergeOpId).toBeDefined();

		// Check winner was updated with merged properties and aliases
		const winnerRow = entities.find((e) => e.id === winnerId) as Row | undefined;
		expect(winnerRow?.properties.email).toBe("alice@example.com");
		expect(winnerRow?.properties.role).toBe("Lead");
		expect(winnerRow?.aliases).toContain("Alice");
		expect(winnerRow?.aliases).toContain("Alice S.");
		expect(winnerRow?.aliases).toContain("A. Smith");

		// Check loser was tombstoned
		const loserRow = entities.find((e) => e.id === loserId) as Row;
		expect(loserRow.archived).toBe(true);
		expect(loserRow.properties.merged_into).toBe(winnerId);
		expect(loserRow.properties._merge).toBeDefined();
		expect(loserRow.properties._merge.op_id).toBe(result.mergeOpId);

		// Check self-loop edge was archived
		const edgeSelf = relationships.find((r) => r.id === "edge-self");
		expect(edgeSelf?.archived).toBe(true);

		// Check normal edge was repointed
		const edge1 = relationships.find((r) => r.id === "edge-1");
		expect(edge1?.from_entity_id).toBe(winnerId);

		// Check artifact link was repointed
		const link1 = links.find((l) => l.id === "link-1");
		expect(link1?.entity_id).toBe(winnerId);

		// Check embed-on-write was called for survivor
		expect(mockEmbed).toHaveBeenCalledWith(expect.stringContaining("Alice Smith"));

		// Check decision was updated to approved with mergeOpId
		const decRow = decisions.find((d) => d.id === decisionId) as Row;
		expect(decRow.status).toBe("approved");
		expect(decRow.decision_payload.mergeOpId).toBe(result.mergeOpId);

		// Test round-trip reversal with entity_unmerge!
		const unmergeRes = await entityUnmergeHandler({ op_id: result.mergeOpId });
		expect(unmergeRes.content[0].text).toContain("Successfully unmerged entity");
		expect(loserRow.archived).toBe(false);
		expect(loserRow.properties.merged_into).toBeUndefined();
	});

	it("supports overriding winner via selected_entity_id", async () => {
		const decisionId = "00000000-0000-0000-0000-000000000002";
		const winnerId = "00000000-0000-0000-0000-000000000010";
		const loserId = "00000000-0000-0000-0000-000000000020";

		const decisions = [
			{
				id: decisionId,
				user_id: USER_ID,
				decision_type: "merge_suggested",
				status: "pending",
				decision_payload: {
					winnerEntityId: winnerId,
					loserEntityId: loserId,
				},
			},
		];

		const entities = [
			{ id: winnerId, user_id: USER_ID, title: "Entity A", entity_type: "project", properties: {}, archived: false },
			{ id: loserId, user_id: USER_ID, title: "Entity B", entity_type: "project", properties: {}, archived: false },
		];

		const { client } = makeFakeSupabase({
			system_decisions: decisions,
			entities,
			entity_relationships: [],
			artifact_entity_links: [],
		});
		(supabase as any).from = client.from;

		// Select loserId as the surviving winner
		const result = await reviewResolveCore(
			{ decision_id: decisionId, action: "approve", selected_entity_id: loserId },
			USER_ID,
		);

		expect(result.success).toBe(true);
		expect(result.survivorOverridden).toBe(true);
		expect(result.winnerId).toBe(loserId);
		expect(result.loserId).toBe(winnerId);

		const entityARow = entities.find((e) => e.id === winnerId) as Row;
		expect(entityARow.archived).toBe(true);
		expect(entityARow.properties.merged_into).toBe(loserId);

		const entityBRow = entities.find((e) => e.id === loserId) as Row;
		expect(entityBRow.archived).toBe(false);
	});

	it("demotes #170 primary containment edge when winner already has another primary", async () => {
		const decisionId = "00000000-0000-0000-0000-000000000003";
		const winnerId = "00000000-0000-0000-0000-000000000010";
		const loserId = "00000000-0000-0000-0000-000000000020";
		const areaA = "00000000-0000-0000-0000-000000000030";
		const areaB = "00000000-0000-0000-0000-000000000040";

		const decisions = [
			{
				id: decisionId,
				user_id: USER_ID,
				decision_type: "merge_suggested",
				status: "pending",
				decision_payload: { winnerEntityId: winnerId, loserEntityId: loserId },
			},
		];

		const entities = [
			{ id: winnerId, user_id: USER_ID, title: "Proj A", entity_type: "project", properties: {}, archived: false },
			{ id: loserId, user_id: USER_ID, title: "Proj B", entity_type: "project", properties: {}, archived: false },
		];

		const relationships = [
			// Winner's existing primary containment to Area A
			{
				id: "winner-primary",
				user_id: USER_ID,
				from_entity_id: winnerId,
				to_entity_id: areaA,
				relationship_type: "belongs_to",
				archived: false,
			},
			// Loser's primary containment to Area B (should be demoted to associated_with)
			{
				id: "loser-primary",
				user_id: USER_ID,
				from_entity_id: loserId,
				to_entity_id: areaB,
				relationship_type: "belongs_to",
				archived: false,
			},
		];

		const { client } = makeFakeSupabase({
			system_decisions: decisions,
			entities,
			entity_relationships: relationships,
			artifact_entity_links: [],
		});
		(supabase as any).from = client.from;

		const result = await reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID);
		expect(result.success).toBe(true);

		const loserEdge = relationships.find((r) => r.id === "loser-primary");
		expect(loserEdge?.from_entity_id).toBe(winnerId);
		expect(loserEdge?.relationship_type).toBe("associated_with");
	});

	it("handles redundant edge and link collisions during merge", async () => {
		const decisionId = "00000000-0000-0000-0000-000000000004";
		const winnerId = "00000000-0000-0000-0000-000000000010";
		const loserId = "00000000-0000-0000-0000-000000000020";
		const sharedTarget = "00000000-0000-0000-0000-000000000030";
		const sharedArtifact = "00000000-0000-0000-0000-000000000040";

		const decisions = [
			{
				id: decisionId,
				user_id: USER_ID,
				decision_type: "merge_suggested",
				status: "pending",
				decision_payload: { winnerEntityId: winnerId, loserEntityId: loserId },
			},
		];

		const entities = [
			{ id: winnerId, user_id: USER_ID, title: "Proj A", entity_type: "project", properties: {}, archived: false },
			{ id: loserId, user_id: USER_ID, title: "Proj B", entity_type: "project", properties: {}, archived: false },
		];

		const relationships = [
			{
				id: "edge-winner",
				user_id: USER_ID,
				from_entity_id: winnerId,
				to_entity_id: sharedTarget,
				relationship_type: "relates_to",
				archived: false,
			},
			{
				id: "edge-loser-colliding",
				user_id: USER_ID,
				from_entity_id: loserId,
				to_entity_id: sharedTarget,
				relationship_type: "relates_to",
				archived: false,
			},
		];

		const links = [
			{
				id: "link-winner",
				user_id: USER_ID,
				artifact_id: sharedArtifact,
				entity_id: winnerId,
				link_type: "mention",
			},
			{
				id: "link-loser-colliding",
				user_id: USER_ID,
				artifact_id: sharedArtifact,
				entity_id: loserId,
				link_type: "mention",
			},
		];

		const { client, deleteLog } = makeFakeSupabase({
			system_decisions: decisions,
			entities,
			entity_relationships: relationships,
			artifact_entity_links: links,
		});
		(supabase as any).from = client.from;

		const result = await reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID);
		expect(result.success).toBe(true);

		// Colliding edge was archived, not repointed
		const collidingEdge = relationships.find((r) => r.id === "edge-loser-colliding");
		expect(collidingEdge?.archived).toBe(true);

		// Colliding link was deleted
		expect(deleteLog.some((d) => d.table === "artifact_entity_links")).toBe(true);
		expect(links.find((l) => l.id === "link-loser-colliding")).toBeUndefined();
	});

	it("approves generic non-merge decision types", async () => {
		const decisionId = "00000000-0000-0000-0000-000000000005";
		const decisions = [
			{
				id: decisionId,
				user_id: USER_ID,
				decision_type: "document_consolidation_suggested",
				status: "pending",
				decision_payload: {},
			},
		];

		const { client } = makeFakeSupabase({ system_decisions: decisions });
		(supabase as any).from = client.from;

		const result = await reviewResolveCore(
			{ decision_id: decisionId, action: "approve", resolution_notes: "Consolidate docs" },
			USER_ID,
		);

		expect(result.success).toBe(true);
		expect(result.status).toBe("approved");
		expect(decisions[0].status).toBe("approved");
	});

	it("persists selected_entity_id in decision_payload when approving non-merge decision types (#2111)", async () => {
		const decisionId = "00000000-0000-0000-0000-000000000006";
		const entityB = "00000000-0000-0000-0000-0000000000b2";
		const entityC = "00000000-0000-0000-0000-0000000000c3";
		const decisions: Row[] = [
			{
				id: decisionId,
				user_id: USER_ID,
				decision_type: "relationship_suggestion",
				status: "pending",
				decision_payload: {
					candidate_entity_ids: [entityB, entityC],
					relationship_type: "works_at",
				},
			},
		];

		const { client, updateLog } = makeFakeSupabase({ system_decisions: decisions });
		(supabase as any).from = client.from;

		const result = await reviewResolveCore(
			{
				decision_id: decisionId,
				action: "approve",
				selected_entity_id: entityB,
				resolution_notes: "Selected Jane Doe (Sales)",
			},
			USER_ID,
		);

		expect(result.success).toBe(true);
		expect(result.status).toBe("approved");
		expect(decisions[0].status).toBe("approved");
		expect(decisions[0].decision_payload).toEqual({
			candidate_entity_ids: [entityB, entityC],
			relationship_type: "works_at",
			selected_entity_id: entityB,
		});

		const decUpdate = updateLog.find((u) => u.table === "system_decisions");
		expect(decUpdate?.payload.decision_payload).toEqual({
			candidate_entity_ids: [entityB, entityC],
			relationship_type: "works_at",
			selected_entity_id: entityB,
		});
	});

	it("dispatches via MCP handlers (reviewListHandler and reviewResolveHandler)", async () => {
		const decId = randomUUID();
		const decisions = [
			{
				id: decId,
				user_id: USER_ID,
				decision_type: "merge_suggested",
				status: "pending",
				decision_payload: { winnerEntityId: "w", loserEntityId: "l" },
			},
		];

		const { client } = makeFakeSupabase({ system_decisions: decisions, entities: [] });
		(supabase as any).from = client.from;

		const listRes = await reviewListHandler({ status: "pending" });
		expect(listRes.content[0].type).toBe("text");
		expect(listRes.content[0].text).toContain(`[${decId}] MERGE_SUGGESTED (pending)`);

		const resolveRes = await reviewResolveHandler({
			decision_id: decId,
			action: "reject",
			resolution_notes: "MCP reject",
		});
		expect(resolveRes.content[0].type).toBe("text");
		expect(resolveRes.content[0].text).toContain("Rejected proposal");
	});

	it("executes reviewResolveAction directly via Unified Action wrapper", async () => {
		const decId = randomUUID();
		const decisions = [
			{
				id: decId,
				user_id: USER_ID,
				decision_type: "document_consolidation_suggested",
				status: "pending",
				decision_payload: {},
			},
		];

		const { client } = makeFakeSupabase({ system_decisions: decisions });
		(supabase as any).from = client.from;

		const res = await executeAction(
			reviewResolveAction,
			{ decision_id: decId, action: "approve" },
			{ context: { caller: "worker", requestId: "req-resolve", userId: USER_ID } },
		);

		expect(res.success).toBe(true);
		expect(res.status).toBe("approved");
		expect(decisions[0].status).toBe("approved");
	});

	it("approves merge_suggested via client-side fallback when RPC is missing from schema cache (#1367), while entity_unmerge requires unmerge_entities RPC (#1498)", async () => {
		const decisionId = "00000000-0000-0000-0000-000000000001";
		const winnerId = "00000000-0000-0000-0000-000000000010";
		const loserId = "00000000-0000-0000-0000-000000000020";
		const targetEntityId = "00000000-0000-0000-0000-000000000030";

		const decisions = [
			{
				id: decisionId,
				user_id: USER_ID,
				decision_type: "merge_suggested",
				status: "pending",
				decision_payload: {
					winnerEntityId: winnerId,
					loserEntityId: loserId,
					winnerName: "Laura Sharp",
					loserName: "Laura",
				},
			},
		];

		const entities: Row[] = [
			{
				id: winnerId,
				user_id: USER_ID,
				title: "Laura Sharp",
				entity_type: "person",
				description: "Principal Consultant",
				properties: {
					role: "Consultant",
				},
				aliases: ["Laura Sharp"],
				archived: false,
			},
			{
				id: loserId,
				user_id: USER_ID,
				title: "Laura",
				entity_type: "person",
				description: "Laura at Work",
				properties: {
					phone: "+44 7000 000000",
				},
				aliases: ["Laura"],
				archived: false,
			},
		];

		const relationships = [
			{
				id: "edge-1",
				user_id: USER_ID,
				from_entity_id: loserId,
				to_entity_id: targetEntityId,
				relationship_type: "collaborates_with",
				archived: false,
			},
			{
				id: "edge-self",
				user_id: USER_ID,
				from_entity_id: loserId,
				to_entity_id: winnerId,
				relationship_type: "associated_with",
				archived: false,
			},
		];

		const links = [
			{
				id: "link-1",
				user_id: USER_ID,
				artifact_id: "art-1",
				entity_id: loserId,
				link_type: "mention",
			},
		];

		const { client } = makeFakeSupabase(
			{
				system_decisions: decisions,
				entities,
				entity_relationships: relationships,
				artifact_entity_links: links,
			},
			{ mockRpcMissing: true },
		);
		(supabase as any).from = client.from;
		(supabase as any).rpc = client.rpc;

		// 1. Approve merge_suggested: calls merge_entities RPC, gets schema cache missing error, falls back to client-side merge
		const result = await reviewResolveCore(
			{
				decision_id: decisionId,
				action: "approve",
				resolution_notes: "Angus approved the merge 5 Oct 2026",
			},
			USER_ID,
		);

		expect(result.success).toBe(true);
		expect(result.status).toBe("approved");
		expect(result.mergeOpId).toBeDefined();
		expect(result.winnerId).toBe(winnerId);
		expect(result.loserId).toBe(loserId);

		// Check winner updated
		const winner = entities.find((e) => e.id === winnerId);
		expect(winner?.aliases).toContain("Laura");
		expect(winner?.properties.phone).toBe("+44 7000 000000");

		// Check loser tombstoned with _merge op
		const loser = entities.find((e) => e.id === loserId);
		expect(loser?.archived).toBe(true);
		expect(loser?.properties.merged_into).toBe(winnerId);
		expect(loser?.properties._merge).toBeDefined();
		expect(loser?.properties._merge.op_id).toBe(result.mergeOpId);

		// Check relationship repointing and self-loop archiving
		const edge1 = relationships.find((e) => e.id === "edge-1");
		expect(edge1?.from_entity_id).toBe(winnerId);
		const edgeSelf = relationships.find((e) => e.id === "edge-self");
		expect(edgeSelf?.archived).toBe(true);

		// Check artifact link moved
		const link1 = links.find((l) => l.id === "link-1");
		expect(link1?.entity_id).toBe(winnerId);

		// 2. Unmerge via entityUnmergeHandler: client-side unmerge fallback was deleted in #1498, so missing RPC rejects directly
		await expect(entityUnmergeHandler({ entity_id: loserId })).rejects.toThrow(
			/Could not find the function public\.unmerge_entities in the schema cache/,
		);
	});
});

describe("review_resolve resolves pending only", () => {
	it("refuses action_approval rows for approve and reject", async () => {
		const decisionId = "d-action-appr-1";
		const row = {
			id: decisionId,
			user_id: USER_ID,
			decision_type: "action_approval",
			status: "pending",
		};
		const { updateLog } = makeFakeSupabase({
			system_decisions: [row],
		});

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID),
		).rejects.toThrow(/action approval.*Approvals inbox/);

		expect(updateLog.filter((u) => u.table === "system_decisions")).toHaveLength(0);
		expect(row.status).toBe("pending");

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "reject" }, USER_ID),
		).rejects.toThrow(/action approval.*Approvals inbox/);

		expect(updateLog.filter((u) => u.table === "system_decisions")).toHaveLength(0);
		expect(row.status).toBe("pending");
	});

	it("rejects when another resolver won concurrently", async () => {
		const decisionId = "d-concurrent-1";
		const row = {
			id: decisionId,
			user_id: USER_ID,
			decision_type: "document_consolidation_suggested",
			status: "pending",
		};
		makeFakeSupabase(
			{ system_decisions: [row] },
			{
				afterSelect: (table) => {
					if (table === "system_decisions") {
						row.status = "approved";
					}
				},
			},
		);

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID),
		).rejects.toThrow(/resolved concurrently/);
		expect(row.status).toBe("approved");

		row.status = "pending";
		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "reject" }, USER_ID),
		).rejects.toThrow(/resolved concurrently/);
		expect(row.status).toBe("approved");
	});

	it("rejects on update error during plain approve", async () => {
		const decisionId = "d-err-1";
		const row = {
			id: decisionId,
			user_id: USER_ID,
			decision_type: "document_consolidation_suggested",
			status: "pending",
		};
		makeFakeSupabase(
			{ system_decisions: [row] },
			{
				updateError: { message: "permission denied for table system_decisions" },
			},
		);

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID),
		).rejects.toThrow("permission denied for table system_decisions");
	});

	it("records status=pending filter and select('id') on plain approve and reject updates", async () => {
		const decisionIdApprove = "d-filters-appr";
		const decisionIdReject = "d-filters-rej";
		const rowApprove = {
			id: decisionIdApprove,
			user_id: USER_ID,
			decision_type: "document_consolidation_suggested",
			status: "pending",
		};
		const rowReject = {
			id: decisionIdReject,
			user_id: USER_ID,
			decision_type: "document_consolidation_suggested",
			status: "pending",
		};
		const { updateLog } = makeFakeSupabase({
			system_decisions: [rowApprove, rowReject],
		});

		await reviewResolveCore({ decision_id: decisionIdApprove, action: "approve" }, USER_ID);
		const approveUpdate = updateLog.find(
			(u) => u.table === "system_decisions" && u.payload.status === "approved",
		);
		expect(approveUpdate).toBeDefined();
		expect(approveUpdate?.select).toBe("id");
		expect(approveUpdate?.filters).toContainEqual({
			op: "eq",
			field: "status",
			value: "pending",
		});

		await reviewResolveCore({ decision_id: decisionIdReject, action: "reject" }, USER_ID);
		const rejectUpdate = updateLog.find(
			(u) => u.table === "system_decisions" && u.payload.status === "rejected",
		);
		expect(rejectUpdate).toBeDefined();
		expect(rejectUpdate?.select).toBe("id");
		expect(rejectUpdate?.filters).toContainEqual({
			op: "eq",
			field: "status",
			value: "pending",
		});
	});
});

describe("review_resolve merge paths resolve pending only", () => {
	const decisionId = "00000000-0000-0000-0000-000000000099";
	const winnerId = "00000000-0000-0000-0000-000000000010";
	const loserId = "00000000-0000-0000-0000-000000000020";
	const otherId = "00000000-0000-0000-0000-000000000030";

	function makeFixture(loserOverrides: Partial<Row> = {}) {
		const decision: Row = {
			id: decisionId,
			user_id: USER_ID,
			decision_type: "merge_suggested",
			status: "pending",
			decision_payload: {
				winnerEntityId: winnerId,
				loserEntityId: loserId,
			},
		};
		const entities: Row[] = [
			{ id: winnerId, user_id: USER_ID, title: "Winner W", entity_type: "project", properties: {}, archived: false },
			{
				id: loserId,
				user_id: USER_ID,
				title: "Loser L",
				entity_type: "project",
				properties: {},
				archived: false,
				...loserOverrides,
			},
			{ id: otherId, user_id: USER_ID, title: "Entity X", entity_type: "project", properties: {}, archived: false },
		];
		return { decision, entities };
	}

	it("superseded path rejects when another resolver won concurrently", async () => {
		const { decision, entities } = makeFixture({
			archived: true,
			properties: { merged_into: otherId },
		});
		makeFakeSupabase(
			{ system_decisions: [decision], entities },
			{
				afterSelect: (table) => {
					if (table === "system_decisions") {
						decision.status = "approved";
					}
				},
			},
		);

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID),
		).rejects.toThrow(/resolved concurrently/);
		expect(decision.status).toBe("approved");
	});

	it("already-merged path rejects when another resolver won concurrently", async () => {
		const { decision, entities } = makeFixture({
			archived: true,
			properties: { merged_into: winnerId },
		});
		makeFakeSupabase(
			{ system_decisions: [decision], entities },
			{
				afterSelect: (table) => {
					if (table === "system_decisions") {
						decision.status = "rejected";
					}
				},
			},
		);

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID),
		).rejects.toThrow(/resolved concurrently/);
		expect(decision.status).toBe("rejected");
	});

	it("surfaces update errors on superseded and already-merged paths", async () => {
		const superseded = makeFixture({
			archived: true,
			properties: { merged_into: otherId },
		});
		makeFakeSupabase(
			{ system_decisions: [superseded.decision], entities: superseded.entities },
			{ updateError: { message: "permission denied for table system_decisions" } },
		);

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID),
		).rejects.toThrow(/Failed to reject decision .*permission denied/);

		const alreadyMerged = makeFixture({
			archived: true,
			properties: { merged_into: winnerId },
		});
		makeFakeSupabase(
			{ system_decisions: [alreadyMerged.decision], entities: alreadyMerged.entities },
			{ updateError: { message: "permission denied for table system_decisions" } },
		);

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID),
		).rejects.toThrow(/Failed to approve decision .*permission denied/);
	});

	it("filters on status=pending and selects id on superseded and already-merged writes", async () => {
		const superseded = makeFixture({
			archived: true,
			properties: { merged_into: otherId },
		});
		const { updateLog: supLog } = makeFakeSupabase({
			system_decisions: [superseded.decision],
			entities: superseded.entities,
		});

		const supRes = await reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID);
		expect(supRes.status).toBe("rejected");
		const supUpdate = supLog.find((u) => u.table === "system_decisions");
		expect(supUpdate?.select).toBe("id");
		expect(supUpdate?.filters).toContainEqual({
			op: "eq",
			field: "status",
			value: "pending",
		});

		const alreadyMerged = makeFixture({
			archived: true,
			properties: { merged_into: winnerId },
		});
		const { updateLog: amLog } = makeFakeSupabase({
			system_decisions: [alreadyMerged.decision],
			entities: alreadyMerged.entities,
		});

		const amRes = await reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID);
		expect(amRes.status).toBe("approved");
		const amUpdate = amLog.find((u) => u.table === "system_decisions");
		expect(amUpdate?.select).toBe("id");
		expect(amUpdate?.filters).toContainEqual({
			op: "eq",
			field: "status",
			value: "pending",
		});
	});

	it("RPC lost the race: rejects without running client-side fallback or embedAndStore", async () => {
		const { decision, entities } = makeFixture();
		const { updateLog } = makeFakeSupabase(
			{ system_decisions: [decision], entities },
			{
				afterSelect: (table) => {
					if (table === "system_decisions") {
						decision.status = "rejected";
					}
				},
			},
		);

		await expect(
			reviewResolveCore({ decision_id: decisionId, action: "approve" }, USER_ID),
		).rejects.toThrow(/resolved concurrently/);

		const loser = entities.find((e) => e.id === loserId);
		expect(loser?.archived).toBe(false);
		expect(updateLog.filter((u) => u.table === "entities")).toHaveLength(0);
		expect(mockEmbed).not.toHaveBeenCalled();
	});
});


