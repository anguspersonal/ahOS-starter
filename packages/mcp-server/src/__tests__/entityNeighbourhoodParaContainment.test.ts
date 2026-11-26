/**
 * PARA roll-up traversal semantics (issue #170, decision 2026-07-17).
 *
 * Primary containment = `belongs_to` (single-parent, the ONLY edge roll-ups
 * and counting traverse); secondary containment = `associated_with`
 * (zero-or-more, non-counted). Because secondary containment is a DISTINCT
 * edge type, entity_neighbourhood needs no special-case code: a roll-up query
 * passes edge_types: ['belongs_to'] and secondary edges are excluded by the
 * existing type filter, while a default (unfiltered) traversal still surfaces
 * both kinds, each flagged by its `type` field. These tests pin exactly that —
 * they are the executable form of "roll-ups count primary edges only;
 * secondary edges are traversable but flagged/excludable".
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

const AREA_ID = "11111111-1111-1111-1111-111111111111";
const PRIMARY_PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const SECONDARY_PROJECT_ID = "33333333-3333-3333-3333-333333333333";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/** One primary child + one secondary (associated) child pointing at the same Area. */
function containmentEdges() {
	return [
		{
			from_entity_id: PRIMARY_PROJECT_ID,
			to_entity_id: AREA_ID,
			relationship_type: "belongs_to",
			confidence_score: 90,
			metadata: null,
			valid_from: null,
			valid_to: null,
		},
		{
			from_entity_id: SECONDARY_PROJECT_ID,
			to_entity_id: AREA_ID,
			relationship_type: "associated_with",
			confidence_score: 80,
			metadata: null,
			valid_from: null,
			valid_to: null,
		},
	];
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

function mockTables(edgeRows: unknown[]) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "entities") {
			return {
				select: () => ({
					eq: () => ({
						eq: () => ({
							maybeSingle: () =>
								Promise.resolve({
									data: { id: AREA_ID, entity_type: "area", title: "Business", properties: {} },
									error: null,
								}),
						}),
						// Honour the requested id list — the "nodes never include the
						// secondary child" assertion depends on the handler only asking
						// for ids it actually reached.
						in: (_col: string, ids: string[]) =>
							Promise.resolve({
								data: [
									{ id: AREA_ID, entity_type: "area", title: "Business", properties: {} },
									{ id: PRIMARY_PROJECT_ID, entity_type: "project", title: "Work AI", properties: {} },
									{ id: SECONDARY_PROJECT_ID, entity_type: "project", title: "Side Quest", properties: {} },
								].filter((row) => ids.includes(row.id)),
								error: null,
							}),
					}),
				}),
			};
		}
		if (table === "entity_relationships") {
			return { select: () => edgeBuilder(edgeRows) };
		}
		if (table === "artifact_entity_links") {
			return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
		}
		if (table === "user_preferences") {
			// ADR-084's resolver reads `dos_config` once per entity_neighbourhood
			// call (QA round 1, Medium); this suite doesn't assert on `domain`.
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		}
		throw new Error(`Unexpected table in test: ${table}`);
	});
}

function parseResult(text: string) {
	return JSON.parse(text.slice(text.indexOf("\n") + 1));
}

describe("entityNeighbourhoodHandler — PARA primary/secondary containment (issue #170)", () => {
	it("a roll-up filtered to ['belongs_to'] traverses ONLY primary edges — associated_with is not counted", async () => {
		mockTables(containmentEdges());

		const result = await entityNeighbourhoodHandler({
			entity_id: AREA_ID,
			edge_types: ["belongs_to"],
		} as any);

		const parsed = parseResult(result.content[0].text);
		expect(parsed.edges).toHaveLength(1);
		expect(parsed.edges[0]).toMatchObject({
			from: PRIMARY_PROJECT_ID,
			to: AREA_ID,
			type: "belongs_to",
		});
		// The secondary child never enters the traversal at all.
		const nodeIds = parsed.nodes.map((n: { id: string }) => n.id);
		expect(nodeIds).not.toContain(SECONDARY_PROJECT_ID);
	});

	it("a default (unfiltered) traversal surfaces BOTH kinds, each flagged by its type", async () => {
		mockTables(containmentEdges());

		const result = await entityNeighbourhoodHandler({ entity_id: AREA_ID } as any);

		const parsed = parseResult(result.content[0].text);
		const types = parsed.edges.map((e: { type: string }) => e.type).sort();
		expect(types).toEqual(["associated_with", "belongs_to"]);
	});

	it("secondary containment remains directly traversable when asked for explicitly", async () => {
		mockTables(containmentEdges());

		const result = await entityNeighbourhoodHandler({
			entity_id: AREA_ID,
			edge_types: ["associated_with"],
		} as any);

		const parsed = parseResult(result.content[0].text);
		expect(parsed.edges).toHaveLength(1);
		expect(parsed.edges[0].type).toBe("associated_with");
	});
});
