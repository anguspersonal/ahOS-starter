/**
 * ADR-036 §2 / issue #359: `entity_neighbourhood` accepts an opt-in
 * `include_instance_of` flag that unions the virtual `graph_instance_of`
 * edge -- entity -> its vocabulary term-node -- into the traversal. Default
 * is false (ordinary neighbourhood queries never touch the view, and every
 * other test file's mock throws on an unexpected table, so any accidental
 * default-on regression fails loudly elsewhere too). The virtual hop is
 * forward-only (instance -> term-node) and, once reached, the term-node's
 * real edges traverse normally on later hops -- exercised here as a 2-hop
 * walk from an instance, through its term-node, to a hand-curated
 * `governed_by` edge.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "@ahkms/core/actions";
import { createSupabaseGraphReadAdapter } from "@ahkms/core/adapters";
import { toMcpTool } from "../actions/index.js";
import { supabase } from "../supabase.js";

const entityNeighbourhoodHandler = toMcpTool(
	buildRegistry({ graphRead: createSupabaseGraphReadAdapter({ client: supabase as any }) }).get(
		"entity_neighbourhood",
	)!,
).handler;

const PERSON_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_PERSON_ID = "44444444-4444-4444-4444-444444444444";
const TERM_NODE_ID = "22222222-2222-2222-2222-222222222222";
const PRINCIPLE_ID = "33333333-3333-3333-3333-333333333333";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

function instanceOfRow() {
	return {
		from_entity_id: PERSON_ID,
		to_entity_id: TERM_NODE_ID,
		relationship_type: "instance_of",
		confidence_score: null,
		metadata: null,
		valid_from: null,
		valid_to: null,
	};
}

function governedByRow() {
	return {
		from_entity_id: TERM_NODE_ID,
		to_entity_id: PRINCIPLE_ID,
		relationship_type: "governed_by",
		confidence_score: null,
		metadata: null,
		valid_from: null,
		valid_to: null,
	};
}

/** Chainable + thenable builder, mirroring the other entityNeighbourhood test files. */
function rowsBuilder(rows: unknown[]) {
	const b: any = {
		eq: () => b,
		in: () => b,
		then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
	};
	return b;
}

/**
 * Like rowsBuilder, but `.in(col, ids)` actually filters by the requested
 * column/id set -- needed here (unlike the other entityNeighbourhood test
 * files) so the 2-hop test can tell hop 0's out/in queries (anchored at
 * PERSON_ID) apart from hop 1's (anchored at whatever hop 0 reached), and so
 * governed_by only surfaces once TERM_NODE_ID actually enters the frontier.
 */
function filteredEdgeBuilder(rows: Array<Record<string, unknown>>) {
	let filtered = rows;
	const b: any = {
		eq: () => b,
		in: (col: string, ids: string[]) => {
			filtered = rows.filter((r) => ids.includes(r[col] as string));
			return b;
		},
		then: (resolve: (v: unknown) => void) => resolve({ data: filtered, error: null }),
	};
	return b;
}

function mockTables(opts: {
	instanceOfCalls: unknown[][];
	instanceOfRows: Array<Record<string, unknown>>;
	entityRelRows?: Array<Record<string, unknown>>;
}) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "entities") {
			return {
				select: () => ({
					eq: () => ({
						eq: () => ({
							maybeSingle: () =>
								Promise.resolve({
									data: { id: PERSON_ID, entity_type: "people", title: "Angus", properties: {} },
									error: null,
								}),
						}),
						in: (_col: string, ids: string[]) =>
							Promise.resolve({
								data: [
									{ id: PERSON_ID, entity_type: "people", title: "Angus", properties: {} },
									{
										id: OTHER_PERSON_ID,
										entity_type: "people",
										title: "Anne",
										properties: {},
									},
									{
										id: TERM_NODE_ID,
										entity_type: "concept",
										title: "people",
										properties: { type: "ahos_concept_term", term: "people" },
									},
									{
										id: PRINCIPLE_ID,
										entity_type: "concept",
										title: "ReifyByCategory",
										properties: {},
									},
								].filter((row) => ids.includes(row.id)),
								error: null,
							}),
					}),
				}),
			};
		}
		if (table === "entity_relationships") {
			return { select: () => filteredEdgeBuilder(opts.entityRelRows ?? []) };
		}
		if (table === "graph_instance_of") {
			return {
				select: () => ({
					in: (col: string, ids: string[]) => {
						opts.instanceOfCalls.push([col, ids]);
						const filtered = opts.instanceOfRows.filter((r) => ids.includes(r[col] as string));
						return Promise.resolve({ data: filtered, error: null });
					},
				}),
			};
		}
		if (table === "artifact_entity_links") {
			return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
		}
		if (table === "user_preferences") {
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		}
		throw new Error(`Unexpected table in test: ${table}`);
	});
}

function parseResult(text: string) {
	return JSON.parse(text.slice(text.indexOf("\n") + 1));
}

describe("entityNeighbourhoodHandler — include_instance_of (ADR-036 §2, #359)", () => {
	it("never queries graph_instance_of when the flag is omitted (default off)", async () => {
		// mockTables throws on any table it doesn't recognise -- entity_relationships
		// is registered, graph_instance_of is not consulted unless the handler asks.
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				return {
					select: () => ({
						eq: () => ({
							eq: () => ({
								maybeSingle: () =>
									Promise.resolve({
										data: { id: PERSON_ID, entity_type: "people", title: "Angus", properties: {} },
										error: null,
									}),
							}),
							in: () => Promise.resolve({ data: [{ id: PERSON_ID, entity_type: "people", title: "Angus", properties: {} }], error: null }),
						}),
					}),
				};
			}
			if (table === "entity_relationships") return { select: () => rowsBuilder([]) };
			if (table === "artifact_entity_links") return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
			if (table === "user_preferences") return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
			throw new Error(`Unexpected table in test: ${table}`);
		});

		const result = await entityNeighbourhoodHandler({ entity_id: PERSON_ID } as any);
		expect(result.content[0].text).toContain("Neighbourhood");
	});

	it("unions the virtual instance_of edge into the traversal when opted in", async () => {
		const instanceOfCalls: unknown[][] = [];
		mockTables({ instanceOfCalls, instanceOfRows: [instanceOfRow()] });

		const result = await entityNeighbourhoodHandler({
			entity_id: PERSON_ID,
			include_instance_of: true,
		} as any);

		const parsed = parseResult(result.content[0].text);
		expect(instanceOfCalls).toContainEqual(["from_entity_id", [PERSON_ID]]);
		expect(parsed.edges).toContainEqual(
			expect.objectContaining({ from: PERSON_ID, to: TERM_NODE_ID, type: "instance_of" }),
		);
		const nodeIds = parsed.nodes.map((n: { id: string }) => n.id);
		expect(nodeIds).toContain(TERM_NODE_ID);
	});

	it("reaches a term-node's real edges (e.g. governed_by) on a subsequent hop", async () => {
		const instanceOfCalls: unknown[][] = [];
		mockTables({
			instanceOfCalls,
			instanceOfRows: [instanceOfRow()],
			entityRelRows: [governedByRow()],
		});

		const result = await entityNeighbourhoodHandler({
			entity_id: PERSON_ID,
			include_instance_of: true,
			hops: 2,
		} as any);

		const parsed = parseResult(result.content[0].text);
		const types = parsed.edges.map((e: { type: string }) => e.type).sort();
		expect(types).toEqual(["governed_by", "instance_of"]);
		const nodeIds = parsed.nodes.map((n: { id: string }) => n.id);
		expect(nodeIds).toContain(PRINCIPLE_ID);
	});

	it("edge_types filtering does not suppress the virtual instance_of edge (opt-in bypasses it)", async () => {
		const instanceOfCalls: unknown[][] = [];
		mockTables({ instanceOfCalls, instanceOfRows: [instanceOfRow()] });

		const result = await entityNeighbourhoodHandler({
			entity_id: PERSON_ID,
			include_instance_of: true,
			edge_types: ["employed_by"],
		} as any);

		const parsed = parseResult(result.content[0].text);
		expect(parsed.edges).toContainEqual(
			expect.objectContaining({ type: "instance_of" }),
		);
	});

	it("opted in but no term-node registered for this entity_type: queries the view, gets nothing back, adds no edge", async () => {
		// graph_instance_of is an INNER join (entities.entity_type -> term-node
		// registry) -- an entity_type with no matching term-node row (the
		// pre-seed state, #326) simply produces zero rows from the view. This
		// asserts the handler treats that as ordinary "no edges found", not an
		// error or a crash, and the traversal result is otherwise identical to
		// the default-off case.
		const instanceOfCalls: unknown[][] = [];
		mockTables({ instanceOfCalls, instanceOfRows: [] });

		const result = await entityNeighbourhoodHandler({
			entity_id: PERSON_ID,
			include_instance_of: true,
		} as any);

		const parsed = parseResult(result.content[0].text);
		expect(instanceOfCalls).toContainEqual(["from_entity_id", [PERSON_ID]]);
		expect(parsed.edges).toEqual([]);
		const nodeIds = parsed.nodes.map((n: { id: string }) => n.id);
		expect(nodeIds).not.toContain(TERM_NODE_ID);
	});
});
