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

// Refs #120: entity_neighbourhood's provenance/"interactions" step reads artifacts
// linked to the starting entities. This must exclude soft-deleted (archived) artifacts
// by default, same as knowledge_search and the entity_query/person_query convention.

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

const ENTITY = { id: "entity-1", entity_type: "people", title: "Ada Lovelace", properties: {} };

describe("entityNeighbourhoodHandler — archived artifact exclusion (#120)", () => {
	it("filters the artifact provenance lookup by archived = false", async () => {
		const artifactsEqCalls: unknown[][] = [];

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				// Serves both step 1 (lookup by entity_id, ends in maybeSingle) and step 3
				// (node details for every reached id, ends in `.in()`).
				const b: any = {
					select: () => b,
					eq: () => b,
					in: () => Promise.resolve({ data: [ENTITY], error: null }),
					maybeSingle: () => Promise.resolve({ data: ENTITY, error: null }),
				};
				return b;
			}
			if (table === "entity_relationships") {
				// Chainable + awaitable: the edge traversal calls .select().in() and then
				// (when include_archived_edges is false, the default) .eq("archived", false)
				// before awaiting — see entityNeighbourhood.ts. The builder must therefore
				// expose .eq() and be thenable regardless of whether .eq() was chained.
				const b: any = {
					select: () => b,
					in: () => b,
					eq: () => b,
					then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
						resolve({ data: [], error: null }),
				};
				return b;
			}
			if (table === "artifact_entity_links") {
				return {
					select: () => ({
						in: () =>
							Promise.resolve({
								data: [{ entity_id: ENTITY.id, artifact_id: "art-1", link_type: "related", confidence_score: null }],
								error: null,
							}),
					}),
				};
			}
			if (table === "artifacts") {
				const b: any = {
					select: () => b,
					eq: (...args: unknown[]) => {
						artifactsEqCalls.push(args);
						return b;
					},
					in: () => Promise.resolve({ data: [{ id: "art-1", title: "Note", created_at: "2026-06-01T00:00:00Z" }], error: null }),
				};
				return b;
			}
			if (table === "user_preferences") {
				// ADR-084's resolver reads `dos_config` once per entity_neighbourhood
				// call (QA round 1, Medium).
				return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
			}
			throw new Error(`unexpected table: ${table}`);
		});

		const out = await entityNeighbourhoodHandler({ entity_id: ENTITY.id } as any);

		expect(artifactsEqCalls).toContainEqual(["user_id", TEST_USER]);
		expect(artifactsEqCalls).toContainEqual(["archived", false]);
		expect(out.content[0].text).toContain("Ada Lovelace");
	});
});
