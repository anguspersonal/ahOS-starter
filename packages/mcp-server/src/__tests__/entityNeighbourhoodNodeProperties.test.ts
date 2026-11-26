/**
 * entity_neighbourhood `nodes` carry `archived` always and `properties` on
 * request (`node_properties: true`) — #1234 / #1231.
 *
 * The career ledger read (ADR099 §9) starts at the self entity and reaches
 * roles, education, achievements and competencies over two hops. Before this
 * change only the STARTING entity carried properties, so the read could not
 * tell an employment arrangement from an achievement (`properties.kind`), nor a
 * proposed entry from a confirmed one. And because archiving an entity leaves
 * its edges live, a rejected (archived) entry was still reached with nothing to
 * mark it as archived.
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

const SELF_ID = "11111111-1111-1111-1111-111111111111";
const LIVE_ID = "22222222-2222-2222-2222-222222222222";
const REJECTED_ID = "33333333-3333-3333-3333-333333333333";

const ROWS = [
	{ id: SELF_ID, entity_type: "people", title: "Self", properties: { self: true }, archived: false },
	{
		id: LIVE_ID,
		entity_type: "arrangement",
		title: "Shipped the thing",
		properties: {
			kind: "achievement",
			ledger_status: "proposed",
			sources: ["http://example.com"],
			notes: "internal note",
		},
		archived: false,
	},
	{
		id: REJECTED_ID,
		entity_type: "arrangement",
		title: "Did not happen",
		properties: { kind: "achievement", ledger_status: "rejected" },
		archived: true,
	},
];

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

function attributedEdges() {
	return [LIVE_ID, REJECTED_ID].map((id) => ({
		from_entity_id: id,
		to_entity_id: SELF_ID,
		relationship_type: "was_attributed_to",
		confidence_score: null,
		metadata: null,
		valid_from: null,
		valid_to: null,
	}));
}

/** Chainable + thenable edge builder (see entityNeighbourhoodArchive.test.ts). */
function edgeBuilder(rows: unknown[]) {
	const b: any = {
		eq: () => b,
		in: () => b,
		then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
	};
	return b;
}

function mockTables(nodeSelects: string[]) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "entities") {
			return {
				select: (cols: string) => ({
					eq: () => ({
						eq: () => ({
							maybeSingle: () => Promise.resolve({ data: ROWS[0], error: null }),
						}),
						in: (_col: string, ids: string[]) => {
							nodeSelects.push(cols);
							return Promise.resolve({ data: ROWS.filter((row) => ids.includes(row.id)), error: null });
						},
					}),
				}),
			};
		}
		if (table === "entity_relationships") {
			return { select: () => edgeBuilder(attributedEdges()) };
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

function nodeById(parsed: { nodes: Array<Record<string, unknown>> }, id: string) {
	return parsed.nodes.find((n) => n.id === id) as Record<string, unknown>;
}

describe("entityNeighbourhoodHandler — reached-node properties and archived flag (#1234, #1248)", () => {
	it("selects `archived` for reached nodes and flags each one, without properties by default", async () => {
		const nodeSelects: string[] = [];
		mockTables(nodeSelects);

		const result = await entityNeighbourhoodHandler({ entity_id: SELF_ID } as any);
		const parsed = parseResult(result.content[0].text);

		expect(nodeSelects).toHaveLength(1);
		expect(nodeSelects[0]).toContain("archived");
		expect(nodeById(parsed, LIVE_ID)).toEqual({
			id: LIVE_ID,
			type: "arrangement",
			title: "Shipped the thing",
			archived: false,
		});
		expect(nodeById(parsed, REJECTED_ID).archived).toBe(true);
		expect(nodeById(parsed, REJECTED_ID)).not.toHaveProperty("properties");
	});

	it("returns reached node properties without sources/notes by default when node_properties is true (#1248)", async () => {
		mockTables([]);

		const result = await entityNeighbourhoodHandler({
			entity_id: SELF_ID,
			edge_types: ["was_attributed_to"],
			node_properties: true,
		} as any);
		const parsed = parseResult(result.content[0].text);

		expect(nodeById(parsed, LIVE_ID).properties).toEqual({
			kind: "achievement",
			ledger_status: "proposed",
		});
		expect(nodeById(parsed, REJECTED_ID)).toMatchObject({
			archived: true,
			properties: { kind: "achievement", ledger_status: "rejected" },
		});
		// The starting entity keeps its own properties in `entities` as before.
		expect(parsed.entities[0].properties).toEqual({ self: true });
		// Default include_entity_edges is true
		expect(parsed.entities[0].edges).toBeDefined();
		expect(parsed.entities[0].edges.length).toBeGreaterThan(0);
	});

	it("includes sources and notes when include_source_notes is true", async () => {
		mockTables([]);

		const result = await entityNeighbourhoodHandler({
			entity_id: SELF_ID,
			edge_types: ["was_attributed_to"],
			node_properties: true,
			include_source_notes: true,
		} as any);
		const parsed = parseResult(result.content[0].text);

		expect(nodeById(parsed, LIVE_ID).properties).toEqual({
			kind: "achievement",
			ledger_status: "proposed",
			sources: ["http://example.com"],
			notes: "internal note",
		});
	});

	it("filters properties with exclude_properties and property_keys", async () => {
		mockTables([]);

		// Test exclude_properties
		const resExcluded = await entityNeighbourhoodHandler({
			entity_id: SELF_ID,
			edge_types: ["was_attributed_to"],
			node_properties: true,
			exclude_properties: ["ledger_status"],
		} as any);
		const parsedExcluded = parseResult(resExcluded.content[0].text);
		expect(nodeById(parsedExcluded, LIVE_ID).properties).toEqual({
			kind: "achievement",
		});

		// Test property_keys whitelist
		const resWhitelisted = await entityNeighbourhoodHandler({
			entity_id: SELF_ID,
			edge_types: ["was_attributed_to"],
			node_properties: true,
			property_keys: ["kind"],
		} as any);
		const parsedWhitelisted = parseResult(resWhitelisted.content[0].text);
		expect(nodeById(parsedWhitelisted, LIVE_ID).properties).toEqual({
			kind: "achievement",
		});
	});

	it("omits edges from starting entities when include_entity_edges is false (#1248)", async () => {
		mockTables([]);

		const result = await entityNeighbourhoodHandler({
			entity_id: SELF_ID,
			edge_types: ["was_attributed_to"],
			include_entity_edges: false,
		} as any);
		const parsed = parseResult(result.content[0].text);

		expect(parsed.entities[0]).not.toHaveProperty("edges");
		expect(parsed.edges).toHaveLength(2);
	});
});
