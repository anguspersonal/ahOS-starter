/**
 * Issue #315: `entity_neighbourhood` accepts an optional `as_of` timestamp
 * that filters edges to those valid at that instant:
 *   valid_from <= as_of AND (valid_to IS NULL OR valid_to > as_of)
 * with NULL bounds treated as open-ended. Absent `as_of`, behaviour is
 * unchanged — all edges (regardless of validity window) are returned. This
 * file covers both the pure boundary predicate and the handler's opt-in
 * passthrough/filtering wiring.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry, isEdgeValidAt } from "@ahkms/core/actions";
import { createSupabaseGraphReadAdapter } from "@ahkms/core/adapters";
import { toMcpTool } from "../actions/index.js";
import { supabase } from "../supabase.js";

const entityNeighbourhoodHandler = toMcpTool(
	buildRegistry({ graphRead: createSupabaseGraphReadAdapter({ client: supabase as any }) }).get(
		"entity_neighbourhood",
	)!,
).handler;

describe("isEdgeValidAt (issue #315 boundary predicate)", () => {
	const asOf = "2026-06-15T00:00:00Z";

	it("is valid when both bounds are NULL (fully open-ended)", () => {
		expect(isEdgeValidAt(null, null, asOf)).toBe(true);
	});

	it("is valid when valid_from is NULL and valid_to is in the future", () => {
		expect(isEdgeValidAt(null, "2027-01-01T00:00:00Z", asOf)).toBe(true);
	});

	it("is valid when valid_to is NULL (still active) and valid_from is in the past", () => {
		expect(isEdgeValidAt("2020-01-01T00:00:00Z", null, asOf)).toBe(true);
	});

	it("is valid exactly at the valid_from instant (inclusive lower bound)", () => {
		expect(isEdgeValidAt(asOf, null, asOf)).toBe(true);
	});

	it("is invalid when valid_from is after as_of", () => {
		expect(isEdgeValidAt("2026-07-01T00:00:00Z", null, asOf)).toBe(false);
	});

	it("is invalid exactly at the valid_to instant (exclusive upper bound)", () => {
		expect(isEdgeValidAt(null, asOf, asOf)).toBe(false);
	});

	it("is invalid when valid_to is before as_of", () => {
		expect(isEdgeValidAt(null, "2026-01-01T00:00:00Z", asOf)).toBe(false);
	});

	it("is valid when as_of falls strictly inside a bounded window", () => {
		expect(isEdgeValidAt("2025-01-01T00:00:00Z", "2027-01-01T00:00:00Z", asOf)).toBe(true);
	});

	it("is invalid when as_of falls outside a bounded window on either side", () => {
		expect(isEdgeValidAt("2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z", asOf)).toBe(false);
		expect(isEdgeValidAt("2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z", asOf)).toBe(false);
	});
});

const START_ID = "11111111-1111-1111-1111-111111111111";
const CURRENT_SUPPLIER_ID = "22222222-2222-2222-2222-222222222222";
const OLD_SUPPLIER_ID = "33333333-3333-3333-3333-333333333333";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

function edgeRows() {
	return [
		{
			from_entity_id: START_ID,
			to_entity_id: CURRENT_SUPPLIER_ID,
			relationship_type: "employed_at",
			confidence_score: null,
			metadata: null,
			notes: "Recommended by Laura",
			valid_from: "2026-01-01T00:00:00Z",
			valid_to: null,
		},
		{
			from_entity_id: START_ID,
			to_entity_id: OLD_SUPPLIER_ID,
			relationship_type: "employed_at",
			confidence_score: null,
			metadata: null,
			valid_from: "2020-01-01T00:00:00Z",
			valid_to: "2025-01-01T00:00:00Z",
		},
	];
}

function edgeBuilder(rows: unknown[]) {
	const b: any = {
		eq: () => b,
		in: () => b,
		then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
	};
	return b;
}

function mockTables(rows: unknown[]) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "entities") {
			return {
				select: () => ({
					eq: () => ({
						eq: () => ({
							maybeSingle: () =>
								Promise.resolve({
									data: { id: START_ID, entity_type: "people", title: "Start", properties: {} },
									error: null,
								}),
						}),
						in: () =>
							Promise.resolve({
								data: [
									{ id: START_ID, entity_type: "people", title: "Start", properties: {} },
									{
										id: CURRENT_SUPPLIER_ID,
										entity_type: "organization",
										title: "Current Supplier",
										properties: {},
									},
									{
										id: OLD_SUPPLIER_ID,
										entity_type: "organization",
										title: "Old Supplier",
										properties: {},
									},
								],
								error: null,
							}),
					}),
				}),
			};
		}
		if (table === "entity_relationships") {
			return { select: () => edgeBuilder(rows) };
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

describe("entityNeighbourhoodHandler — as_of filtering (issue #315)", () => {
	it("returns all edges (regardless of validity window) when as_of is absent — non-breaking default", async () => {
		mockTables(edgeRows());

		const out = await entityNeighbourhoodHandler({ entity_id: START_ID } as any);
		const text = out.content[0].text;
		const json = JSON.parse(text.slice(text.indexOf("{")));

		expect(json.as_of).toBeNull();
		expect(json.edges).toHaveLength(2);
		const targets = json.edges.map((e: any) => e.to);
		expect(targets).toContain(CURRENT_SUPPLIER_ID);
		expect(targets).toContain(OLD_SUPPLIER_ID);
	});

	it("filters to only edges valid at as_of when provided", async () => {
		mockTables(edgeRows());

		const out = await entityNeighbourhoodHandler({
			entity_id: START_ID,
			as_of: "2026-06-15T00:00:00Z",
		} as any);
		const text = out.content[0].text;
		const json = JSON.parse(text.slice(text.indexOf("{")));

		expect(json.as_of).toBe("2026-06-15T00:00:00Z");
		expect(json.edges).toHaveLength(1);
		expect(json.edges[0].to).toBe(CURRENT_SUPPLIER_ID);
	});

	it("exposes valid_from/valid_to on returned edges for timeline rendering", async () => {
		mockTables(edgeRows());

		const out = await entityNeighbourhoodHandler({ entity_id: START_ID } as any);
		const text = out.content[0].text;
		const json = JSON.parse(text.slice(text.indexOf("{")));

		const oldEdge = json.edges.find((e: any) => e.to === OLD_SUPPLIER_ID);
		expect(oldEdge.valid_from).toBe("2020-01-01T00:00:00Z");
		expect(oldEdge.valid_to).toBe("2025-01-01T00:00:00Z");

		const entityRecord = json.entities[0];
		const entityEdge = entityRecord.edges.find((e: any) => e.other_id === OLD_SUPPLIER_ID);
		expect(entityEdge.valid_from).toBe("2020-01-01T00:00:00Z");
		expect(entityEdge.valid_to).toBe("2025-01-01T00:00:00Z");
		expect(entityEdge.notes).toBeNull();

		const currentEdge = json.edges.find((e: any) => e.to === CURRENT_SUPPLIER_ID);
		expect(currentEdge.notes).toBe("Recommended by Laura");
		const currentEntityEdge = entityRecord.edges.find((e: any) => e.other_id === CURRENT_SUPPLIER_ID);
		expect(currentEntityEdge.notes).toBe("Recommended by Laura");
	});
});
