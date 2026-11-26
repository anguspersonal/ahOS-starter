/**
 * entity_neighbourhood excludes archived (soft-deleted) relationship edges by
 * default, per issue #175's "surface it through mcp-server" requirement — an
 * archived edge is history, not a live connection an agent should traverse.
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

const START_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

function edgeRow() {
	return {
		from_entity_id: START_ID,
		to_entity_id: OTHER_ID,
		relationship_type: "works_with",
		confidence_score: null,
		metadata: null,
	};
}

/**
 * entity_relationships builder mirroring Supabase's real PostgrestFilterBuilder:
 * .in()/.eq() remain chainable AND the object itself is thenable (awaiting it
 * resolves the query), matching production code that does
 * `.select(...).in(...).eq(...)` and then `await`s the result directly without
 * a terminal method call.
 */
function edgeBuilder(eqCalls: unknown[][], rows: unknown[]) {
	const b: any = {
		eq: (...a: unknown[]) => {
			eqCalls.push(a);
			return b;
		},
		in: () => b,
		then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
	};
	return b;
}

/**
 * ADR-084's `resolveEntityDomain` also reads `entities` (by id, `.maybeSingle()`),
 * `entity_relationships` for the primary `belongs_to` parent (batched for the
 * whole starting set via `fetchPrimaryParentsBatch`'s
 * `select("from_entity_id, to_entity_id")`, one query instead of one per
 * entity — QA round 1, Medium), and `user_preferences` (`dos_config`, also
 * loaded once for the whole call). Routed separately from the traversal's own
 * queries below by their distinct `.select()` columns, so the resolver's
 * calls never land in `edgeEqCalls` — this suite is about the NEIGHBOURHOOD
 * traversal's archived-edge filter, not the resolver's (separate,
 * always-live) primary-containment lookup. No containment/override is set up
 * here, so the resolver reports `unresolved` for both starting entities;
 * these tests don't assert on `domain`.
 */
function domainResolverEntityBuilder() {
	const b: any = {
		select: () => b,
		eq: () => b,
		maybeSingle: () => Promise.resolve({ data: null, error: null }),
	};
	return b;
}

function domainResolverBatchedParentBuilder() {
	const b: any = {
		eq: () => b,
		in: () => b,
		then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
	};
	return b;
}

function domainResolverConfigBuilder() {
	const b: any = {
		eq: () => b,
		maybeSingle: () => Promise.resolve({ data: null, error: null }),
	};
	return b;
}

function mockTables(opts: { edgeEqCalls: unknown[][]; edgeRows: unknown[] }) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "entities") {
			return {
				select: (cols: string) => {
					if (cols.includes("domain_override")) return domainResolverEntityBuilder();
					return {
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
										{ id: OTHER_ID, entity_type: "people", title: "Other", properties: {} },
									],
									error: null,
								}),
						}),
					};
				},
			};
		}
		if (table === "entity_relationships") {
			return {
				select: (cols: string) => {
					if (cols === "from_entity_id, to_entity_id") return domainResolverBatchedParentBuilder();
					return edgeBuilder(opts.edgeEqCalls, opts.edgeRows);
				},
			};
		}
		if (table === "artifact_entity_links") {
			return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
		}
		if (table === "user_preferences") {
			return { select: () => domainResolverConfigBuilder() };
		}
		throw new Error(`Unexpected table in test: ${table}`);
	});
}

describe("entityNeighbourhoodHandler — archived edge filtering (issue #175)", () => {
	it("filters archived=false on edge queries by default", async () => {
		const edgeEqCalls: unknown[][] = [];
		mockTables({ edgeEqCalls, edgeRows: [edgeRow()] });

		await entityNeighbourhoodHandler({ entity_id: START_ID } as any);

		expect(edgeEqCalls).toContainEqual(["archived", false]);
	});

	it("does not filter by archived when include_archived_edges: true", async () => {
		const edgeEqCalls: unknown[][] = [];
		mockTables({ edgeEqCalls, edgeRows: [edgeRow()] });

		await entityNeighbourhoodHandler({
			entity_id: START_ID,
			include_archived_edges: true,
		} as any);

		expect(edgeEqCalls).not.toContainEqual(["archived", false]);
	});
});
