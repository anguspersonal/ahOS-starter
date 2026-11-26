/**
 * ADR-035 relationship reification — slices 3+4 (issue #327).
 *
 *  Slice 4 (collision-at-2 guard, relateEntitiesHandler): a 2nd same-type edge
 *  between the same pair carrying a DIFFERENT temporal window must be refused
 *  rather than silently overwriting the first fact's dates. `overwrite: true`
 *  is the intentional-correction escape hatch; a window-less or matching write
 *  is not a collision.
 *
 *  Slice 3 (entity_promote_edge): reify a binary edge into one or more
 *  `arrangement` nodes — per-role participant edges OUT of each node, provenance
 *  links to every node, original edge archived last. Includes the 1→N split.
 *
 * Mirrors the supabase.from monkeypatch style used in relationshipLifecycle.test.ts —
 * no vi.mock, just a thenable-at-terminal-method query-builder stub.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";

const relateEntitiesHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_relate")!).handler(args);
const promoteEdgeToNodeHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_promote_edge")!).handler(args);

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env
const FROM_ID = "11111111-1111-1111-1111-111111111111";
const TO_ID = "22222222-2222-2222-2222-222222222222";
const EDGE_ID = "33333333-3333-3333-3333-333333333333";
const ORG_ID = "44444444-4444-4444-4444-444444444444";
const PERSON_ID = "55555555-5555-5555-5555-555555555555";
const ART_ID = "66666666-6666-6666-6666-666666666666";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

// ── Slice 4: collision-at-2 guard ───────────────────────────────────────────

/** Endpoints exist (entity_relate' ownership pre-check). */
function endpointsOk() {
	return {
		select: () => ({
			eq: () => ({
				in: () =>
					Promise.resolve({ data: [{ id: FROM_ID }, { id: TO_ID }], error: null }),
			}),
		}),
	};
}

/** Dedup-lookup stub returning a pre-existing edge (with its stored window). */
function dedupExisting(existing: Record<string, unknown> | null) {
	const b: any = {
		eq: () => b,
		limit: () => b,
		maybeSingle: () => Promise.resolve({ data: existing, error: null }),
	};
	return b;
}

function updateCapture(capture: (payload: Record<string, unknown>) => void) {
	return (payload: Record<string, unknown>) => {
		capture(payload);
		const b: any = {
			eq: () => b,
			then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
		};
		return b;
	};
}

describe("relateEntitiesHandler — ADR-035 collision-at-2 guard (#327 slice 4)", () => {
	it("refuses to overwrite an edge whose window differs (2nd distinct fact)", async () => {
		let updated = false;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") return endpointsOk();
			return {
				select: () =>
					dedupExisting({
						id: EDGE_ID,
						archived: false,
						valid_from: "2018-01-01T00:00:00.000Z",
						valid_to: "2019-01-01T00:00:00.000Z",
					}),
				update: updateCapture(() => {
					updated = true;
				}),
			};
		});

		await expect(
			relateEntitiesHandler({
				from_entity_id: FROM_ID,
				to_entity_id: TO_ID,
				relationship_type: "employed_by",
				valid_from: "2019-01-01T00:00:00.000Z",
				valid_to: "2023-01-01T00:00:00.000Z",
			} as any),
		).rejects.toThrow(/collision-at-2|entity_promote_edge/);
		expect(updated).toBe(false); // never wrote the overwrite
	});

	it("allows the overwrite when overwrite: true (intentional date correction)", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") return endpointsOk();
			return {
				select: () =>
					dedupExisting({
						id: EDGE_ID,
						archived: false,
						valid_from: "2018-01-01T00:00:00.000Z",
						valid_to: "2019-01-01T00:00:00.000Z",
					}),
				update: updateCapture((p) => {
					updatePayload = p;
				}),
			};
		});

		const result = await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "employed_by",
			valid_from: "2019-01-01T00:00:00.000Z",
			valid_to: "2023-01-01T00:00:00.000Z",
			overwrite: true,
		} as any);

		expect(updatePayload).toMatchObject({
			valid_from: "2019-01-01T00:00:00.000Z",
			valid_to: "2023-01-01T00:00:00.000Z",
		});
		expect(result.content[0].text).toContain("Updated edge");
	});

	it("allows a matching window (a re-statement, not a collision)", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") return endpointsOk();
			return {
				select: () =>
					dedupExisting({
						id: EDGE_ID,
						archived: false,
						valid_from: "2018-01-01T00:00:00.000Z",
						valid_to: "2019-01-01T00:00:00.000Z",
					}),
				update: updateCapture((p) => {
					updatePayload = p;
				}),
			};
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "employed_by",
			valid_from: "2018-01-01T00:00:00.000Z",
			valid_to: "2019-01-01T00:00:00.000Z",
		} as any);

		expect(updatePayload).toBeDefined(); // no collision → normal update
	});

	it("does not fire on a window-less write (narrow guard: only different non-null windows), and the update preserves the existing window (#464)", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") return endpointsOk();
			return {
				select: () =>
					dedupExisting({
						id: EDGE_ID,
						archived: false,
						valid_from: "2018-01-01T00:00:00.000Z",
						valid_to: "2019-01-01T00:00:00.000Z",
					}),
				update: updateCapture((p) => {
					updatePayload = p;
				}),
			};
		});

		// No valid_from/valid_to on the incoming write → not a collision-at-2.
		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "employed_by",
			confidence: 90,
		} as any);

		// The guard doesn't fire — and since #464 the update that follows carries
		// the edge's stored window through untouched, so letting a window-less
		// write past the guard no longer costs the caller their dates.
		expect(updatePayload).toMatchObject({
			confidence_score: 0.9,
			valid_from: "2018-01-01T00:00:00.000Z",
			valid_to: "2019-01-01T00:00:00.000Z",
		});
	});
});

// ── Slice 3: entity_promote_edge ───────────────────────────────────────────

type PromoteMockOpts = {
	edge: Record<string, unknown> | null;
	ownedIds?: string[];
	captures: Record<string, any>;
};

/**
 * Routes by table. entity_relationships handles three intents across the call
 * (edge load via select→maybeSingle, participant-edge insert, archive update);
 * entities handles two (ownership select→in, node insert). The generic builder
 * supports every terminal the handler reaches for; the handler calls the right
 * one per table, so there is no cross-talk.
 */
function mockPromote(opts: PromoteMockOpts) {
	const owned = opts.ownedIds ?? [ORG_ID, PERSON_ID];
	(supabase as any).from = vi.fn((table: string) => ({
		select: () => {
			const b: any = {
				eq: () => b,
				in: () =>
					Promise.resolve({ data: owned.map((id) => ({ id })), error: null }),
				maybeSingle: () => Promise.resolve({ data: opts.edge, error: null }),
			};
			return b;
		},
		insert: (rows: any[]) => {
			opts.captures[`${table}_insert`] = rows;
			return Promise.resolve({ data: rows, error: null });
		},
		update: (payload: Record<string, unknown>) => {
			opts.captures[`${table}_update`] = payload;
			const b: any = {
				eq: () => b,
				then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
			};
			return b;
		},
	}));
}

const liveEmploymentEdge = {
	id: EDGE_ID,
	from_entity_id: PERSON_ID,
	to_entity_id: ORG_ID,
	relationship_type: "employed_by",
	valid_from: "2018-01-01T00:00:00.000Z",
	valid_to: "2023-01-01T00:00:00.000Z",
	archived: false,
};

describe("promoteEdgeToNodeHandler — reify an edge (#327 slice 3)", () => {
	it("1→1: creates one arrangement node, per-role edges, and archives the original", async () => {
		const captures: Record<string, any> = {};
		mockPromote({ edge: liveEmploymentEdge, captures });

		const result = await promoteEdgeToNodeHandler({
			edge_id: EDGE_ID,
			kind: "employment",
			arrangements: [
				{
					title: "PM at Acme",
					valid_from: "2018-01-01T00:00:00.000Z",
					valid_to: "2019-01-01T00:00:00.000Z",
					participants: [
						{ role: "employer", entity_id: ORG_ID },
						{ role: "employee", entity_id: PERSON_ID },
					],
				},
			],
		} as any);

		const nodes = captures.entities_insert;
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ entity_type: "arrangement", user_id: TEST_USER });
		expect(nodes[0].properties).toMatchObject({
			kind: "employment",
			valid_from: "2018-01-01T00:00:00.000Z",
			valid_to: "2019-01-01T00:00:00.000Z",
		});

		const edges = captures.entity_relationships_insert;
		expect(edges).toHaveLength(2);
		expect(edges.map((e: any) => e.relationship_type).sort()).toEqual([
			"employee",
			"employer",
		]);
		// Participant edges point OUT of the new node.
		expect(edges.every((e: any) => e.from_entity_id === nodes[0].id)).toBe(true);
		// Window mirrored onto the edges for the as-of read path.
		expect(edges[0]).toMatchObject({ valid_from: "2018-01-01T00:00:00.000Z" });

		expect(captures.entity_relationships_update).toEqual({ archived: true });
		expect(result.content[0].text).toContain("Promoted edge");
	});

	it("1→N: splits one edge into two job-nodes, links provenance to BOTH", async () => {
		const captures: Record<string, any> = {};
		mockPromote({ edge: liveEmploymentEdge, captures });

		await promoteEdgeToNodeHandler({
			edge_id: EDGE_ID,
			kind: "employment",
			source_artifact_id: ART_ID,
			arrangements: [
				{
					title: "PM at Acme",
					valid_from: "2018-01-01T00:00:00.000Z",
					valid_to: "2019-01-01T00:00:00.000Z",
					participants: [
						{ role: "employer", entity_id: ORG_ID },
						{ role: "employee", entity_id: PERSON_ID },
					],
				},
				{
					title: "Senior PM at Acme",
					valid_from: "2019-01-01T00:00:00.000Z",
					valid_to: "2023-01-01T00:00:00.000Z",
					participants: [
						{ role: "employer", entity_id: ORG_ID },
						{ role: "employee", entity_id: PERSON_ID },
					],
				},
			],
		} as any);

		expect(captures.entities_insert).toHaveLength(2);
		expect(captures.entity_relationships_insert).toHaveLength(4);

		const links = captures.artifact_entity_links_insert;
		expect(links).toHaveLength(2);
		expect(links.every((l: any) => l.artifact_id === ART_ID && l.link_type === "primary")).toBe(true);
		// Each new node gets its own provenance link.
		const nodeIds = captures.entities_insert.map((n: any) => n.id).sort();
		expect(links.map((l: any) => l.entity_id).sort()).toEqual(nodeIds);

		expect(captures.entity_relationships_update).toEqual({ archived: true });
	});

	it("rejects a participant that isn't yours (before writing anything)", async () => {
		const captures: Record<string, any> = {};
		mockPromote({ edge: liveEmploymentEdge, ownedIds: [ORG_ID], captures }); // PERSON_ID missing

		await expect(
			promoteEdgeToNodeHandler({
				edge_id: EDGE_ID,
				kind: "employment",
				arrangements: [
					{
						participants: [
							{ role: "employer", entity_id: ORG_ID },
							{ role: "employee", entity_id: PERSON_ID },
						],
					},
				],
			} as any),
		).rejects.toThrow(/aren't yours|don't exist/);
		expect(captures.entities_insert).toBeUndefined();
	});

	it("errors when the edge doesn't exist", async () => {
		const captures: Record<string, any> = {};
		mockPromote({ edge: null, captures });

		await expect(
			promoteEdgeToNodeHandler({
				edge_id: EDGE_ID,
				kind: "employment",
				arrangements: [
					{ participants: [{ role: "employer", entity_id: ORG_ID }] },
				],
			} as any),
		).rejects.toThrow(/No edge/);
	});

	it("leaves the original edge live when archive_original is false", async () => {
		const captures: Record<string, any> = {};
		mockPromote({ edge: liveEmploymentEdge, captures });

		const result = await promoteEdgeToNodeHandler({
			edge_id: EDGE_ID,
			kind: "employment",
			archive_original: false,
			arrangements: [
				{ participants: [{ role: "employer", entity_id: ORG_ID }] },
			],
		} as any);

		expect(captures.entity_relationships_update).toBeUndefined();
		expect(result.content[0].text).toContain("Left original edge");
	});

	it("flags a role outside the seed vocabulary but still stores it (open-vocab)", async () => {
		const captures: Record<string, any> = {};
		mockPromote({ edge: liveEmploymentEdge, ownedIds: [ORG_ID], captures });

		const result = await promoteEdgeToNodeHandler({
			edge_id: EDGE_ID,
			kind: "membership",
			arrangements: [
				{ participants: [{ role: "club_of", entity_id: ORG_ID }] },
			],
		} as any);

		expect(captures.entity_relationships_insert[0].relationship_type).toBe("club_of");
		expect(result.content[0].text).toContain("club_of");
	});

	it("refuses to promote an already-archived edge (no duplicate reification)", async () => {
		const captures: Record<string, any> = {};
		mockPromote({
			edge: { ...liveEmploymentEdge, archived: true },
			captures,
		});

		await expect(
			promoteEdgeToNodeHandler({
				edge_id: EDGE_ID,
				kind: "employment",
				arrangements: [
					{
						participants: [
							{ role: "employer", entity_id: ORG_ID },
							{ role: "employee", entity_id: PERSON_ID },
						],
					},
				],
			} as any),
		).rejects.toThrow(/already archived/);

		// Nothing was written — the check happens before any insert.
		expect(captures.entities_insert).toBeUndefined();
		expect(captures.entity_relationships_insert).toBeUndefined();
	});

	it("leaves the source edge un-archived when the participant-edge insert fails (archive-last safety)", async () => {
		const captures: Record<string, any> = {};
		const owned = [ORG_ID, PERSON_ID];
		(supabase as any).from = vi.fn((table: string) => ({
			select: () => {
				const b: any = {
					eq: () => b,
					in: () =>
						Promise.resolve({ data: owned.map((id) => ({ id })), error: null }),
					maybeSingle: () =>
						Promise.resolve({ data: liveEmploymentEdge, error: null }),
				};
				return b;
			},
			insert: (rows: any[]) => {
				captures[`${table}_insert`] = rows;
				if (table === "entity_relationships") {
					return Promise.resolve({
						data: null,
						error: { message: "simulated participant-edge insert failure" },
					});
				}
				return Promise.resolve({ data: rows, error: null });
			},
			update: (payload: Record<string, unknown>) => {
				captures[`${table}_update`] = payload;
				const b: any = {
					eq: () => b,
					then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
				};
				return b;
			},
		}));

		await expect(
			promoteEdgeToNodeHandler({
				edge_id: EDGE_ID,
				kind: "employment",
				arrangements: [
					{
						title: "PM at Acme",
						participants: [
							{ role: "employer", entity_id: ORG_ID },
							{ role: "employee", entity_id: PERSON_ID },
						],
					},
				],
			} as any),
		).rejects.toThrow(/Create participant edges failed/);

		// The node insert happened (now an orphan, per the documented worst case)...
		expect(captures.entities_insert).toHaveLength(1);
		// ...but the archive-last step was never reached: the source edge is
		// untouched, proving the non-atomic "archive last" ordering holds under
		// a mid-operation failure.
		expect(captures.entity_relationships_update).toBeUndefined();
	});
});
