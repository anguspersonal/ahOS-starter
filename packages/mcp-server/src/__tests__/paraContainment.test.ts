/**
 * PARA primary/secondary containment (issue #170, decision 2026-07-17).
 *
 * Each project/resource keeps ONE live primary `belongs_to` parent (roll-ups
 * and counting traverse primary edges exclusively) plus zero-or-more secondary
 * `associated_with` edges (non-counted). These tests pin the entity_relate
 * single-parent guard built on that decision:
 *   1. asserting a 2nd primary `belongs_to` toward a DIFFERENT target is
 *      refused with an actionable error naming both alternatives
 *      (associated_with for a secondary link, overwrite: true to re-point) —
 *      the same refuse-unless-opted-in posture as ADR-035 collision-at-2;
 *   2. with overwrite: true the old primary edge is ARCHIVED (soft-deleted,
 *      matching the worker's merge-repoint treatment) and the new one written;
 *   3. re-asserting the SAME primary parent is a plain dedup update, never a
 *      violation;
 *   4. `associated_with` is unlimited — no guard query runs, and the type
 *      passes through resolveRelationshipType unchanged (EDGE_TYPES member);
 *   5. the guard is scoped to project/resource SOURCE entities — belongs_to
 *      from other entity types is untouched;
 *   6. archive: true skips the guard (removing an edge can never create a
 *      2nd parent).
 *
 * Mirrors the supabase.from monkeypatch style of relationshipLifecycle.test.ts —
 * no vi.mock, just thenable-at-terminal-method query builder stubs. The two
 * entity_relationships SELECT shapes are routed by their column list: the
 * guard selects "id, to_entity_id", the dedup lookup selects
 * "id, archived, valid_from, valid_to".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRelationshipType } from "@ahkms/core";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";

const relateEntitiesHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_relate")!).handler(args);

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env
const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const AREA_BUSINESS_ID = "22222222-2222-2222-2222-222222222222";
const AREA_TECH_ID = "33333333-3333-3333-3333-333333333333";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/** Endpoint-ownership stub returning rows WITH entity_type (the guard's scope input). */
function endpointsWithTypes(rows: Array<{ id: string; entity_type: string }>) {
	return () => ({
		select: () => ({
			eq: () => ({
				in: () => Promise.resolve({ data: rows, error: null }),
			}),
		}),
	});
}

interface RelationshipsStubOptions {
	/** Rows the single-parent guard query returns (live belongs_to out-edges). */
	guardRows?: Array<{ id: string; to_entity_id: string }>;
	/** Result of the dedup (from, to, type) lookup. */
	dedupResult?: { data: unknown; error: unknown };
	onInsert?: (payload: Record<string, unknown>) => void;
	onUpdate?: (payload: Record<string, unknown>, filters: Array<[string, unknown]>) => void;
	/** Incremented once per guard query, so tests can assert it did/didn't run. */
	guardQueryCount?: { count: number };
}

function relationshipsStub(opts: RelationshipsStubOptions) {
	return () => ({
		select: (cols: string) => {
			if (cols.includes("to_entity_id")) {
				// Single-parent guard query: .eq()... then awaited directly.
				if (opts.guardQueryCount) opts.guardQueryCount.count += 1;
				const b: any = {
					eq: () => b,
					then: (resolve: (v: { data: unknown; error: null }) => void) =>
						resolve({ data: opts.guardRows ?? [], error: null }),
				};
				return b;
			}
			// Dedup lookup: .eq()...limit().maybeSingle().
			const b: any = {
				eq: () => b,
				limit: () => b,
				maybeSingle: () => Promise.resolve(opts.dedupResult ?? { data: null, error: null }),
			};
			return b;
		},
		insert: (payload: Record<string, unknown>) => {
			opts.onInsert?.(payload);
			return {
				select: () => ({
					single: () => Promise.resolve({ data: { id: "edge-new" }, error: null }),
				}),
			};
		},
		update: (payload: Record<string, unknown>) => {
			const filters: Array<[string, unknown]> = [];
			const b: any = {
				eq: (field: string, value: unknown) => {
					filters.push([field, value]);
					return b;
				},
				in: (field: string, value: unknown) => {
					filters.push([field, value]);
					return b;
				},
				then: (resolve: (v: { error: null }) => void) => {
					opts.onUpdate?.(payload, filters);
					return resolve({ error: null });
				},
			};
			return b;
		},
	});
}

function mockSupabaseFrom(handlers: {
	entities: () => unknown;
	entity_relationships: () => unknown;
}) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "entities") return handlers.entities();
		if (table === "entity_relationships") return handlers.entity_relationships();
		throw new Error(`Unexpected table in test: ${table}`);
	});
}

describe("resolveRelationshipType — #170 containment vocabulary", () => {
	it("passes associated_with through unchanged (EDGE_TYPES member, not normalised to 'other')", () => {
		expect(resolveRelationshipType("associated_with")).toEqual({ type: "associated_with" });
	});

	it("passes belongs_to through unchanged", () => {
		expect(resolveRelationshipType("belongs_to")).toEqual({ type: "belongs_to" });
	});
});

describe("relateEntitiesHandler — PARA single-parent primary containment (issue #170)", () => {
	it("refuses a 2nd primary belongs_to from a project toward a different target, naming both alternatives", async () => {
		let inserted = false;
		mockSupabaseFrom({
			entities: endpointsWithTypes([
				{ id: PROJECT_ID, entity_type: "project" },
				{ id: AREA_TECH_ID, entity_type: "area" },
			]),
			entity_relationships: relationshipsStub({
				guardRows: [{ id: "edge-old", to_entity_id: AREA_BUSINESS_ID }],
				onInsert: () => {
					inserted = true;
				},
			}),
		});

		await expect(
			relateEntitiesHandler({
				from_entity_id: PROJECT_ID,
				to_entity_id: AREA_TECH_ID,
				relationship_type: "belongs_to",
			} as any),
		).rejects.toThrow(/associated_with[\s\S]*overwrite: true/);
		expect(inserted).toBe(false);
	});

	it("re-points under overwrite: true — archives the old primary edge, then writes the new one", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		const updates: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
		mockSupabaseFrom({
			entities: endpointsWithTypes([
				{ id: PROJECT_ID, entity_type: "project" },
				{ id: AREA_TECH_ID, entity_type: "area" },
			]),
			entity_relationships: relationshipsStub({
				guardRows: [{ id: "edge-old", to_entity_id: AREA_BUSINESS_ID }],
				onInsert: (payload) => {
					insertPayload = payload;
				},
				onUpdate: (payload, filters) => {
					updates.push({ payload, filters });
				},
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: PROJECT_ID,
			to_entity_id: AREA_TECH_ID,
			relationship_type: "belongs_to",
			overwrite: true,
		} as any);

		// Old primary is ARCHIVED (soft-deleted), never hard-deleted.
		expect(updates).toHaveLength(1);
		expect(updates[0].payload).toEqual({ archived: true });
		expect(updates[0].filters).toContainEqual(["user_id", TEST_USER]);
		expect(updates[0].filters).toContainEqual(["id", ["edge-old"]]);

		expect(insertPayload).toMatchObject({
			from_entity_id: PROJECT_ID,
			to_entity_id: AREA_TECH_ID,
			relationship_type: "belongs_to",
		});
		expect(result.content[0].text).toContain("re-pointed");
	});

	it("treats re-asserting the SAME primary parent as a plain update, not a violation", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsWithTypes([
				{ id: PROJECT_ID, entity_type: "project" },
				{ id: AREA_BUSINESS_ID, entity_type: "area" },
			]),
			entity_relationships: relationshipsStub({
				// The only live belongs_to edge already points at the SAME target.
				guardRows: [{ id: "edge-old", to_entity_id: AREA_BUSINESS_ID }],
				dedupResult: {
					data: { id: "edge-old", archived: false, valid_from: null, valid_to: null },
					error: null,
				},
				onUpdate: (payload) => {
					updatePayload = payload;
				},
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: PROJECT_ID,
			to_entity_id: AREA_BUSINESS_ID,
			relationship_type: "belongs_to",
			confidence: 95,
		} as any);

		expect(result.content[0].text).toContain("Updated edge edge-old");
		expect(updatePayload).toMatchObject({ confidence_score: 0.95, archived: false });
	});

	it("leaves associated_with unlimited — no guard query, and the type is stored unchanged", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		const guardQueryCount = { count: 0 };
		mockSupabaseFrom({
			entities: endpointsWithTypes([
				{ id: PROJECT_ID, entity_type: "project" },
				{ id: AREA_TECH_ID, entity_type: "area" },
			]),
			entity_relationships: relationshipsStub({
				guardQueryCount,
				onInsert: (payload) => {
					insertPayload = payload;
				},
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: PROJECT_ID,
			to_entity_id: AREA_TECH_ID,
			relationship_type: "associated_with",
		} as any);

		expect(guardQueryCount.count).toBe(0);
		expect(insertPayload).toMatchObject({ relationship_type: "associated_with" });
		// Not normalised — no "(normalised from ...)" suffix.
		expect(result.content[0].text).toContain("-[associated_with]->");
		expect(result.content[0].text).not.toContain("normalised");
	});

	it("scopes the guard to project/resource sources — belongs_to from other entity types skips it", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		const guardQueryCount = { count: 0 };
		mockSupabaseFrom({
			entities: endpointsWithTypes([
				{ id: PROJECT_ID, entity_type: "organization" },
				{ id: AREA_TECH_ID, entity_type: "area" },
			]),
			entity_relationships: relationshipsStub({
				guardQueryCount,
				onInsert: (payload) => {
					insertPayload = payload;
				},
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: PROJECT_ID,
			to_entity_id: AREA_TECH_ID,
			relationship_type: "belongs_to",
		} as any);

		expect(guardQueryCount.count).toBe(0);
		expect(insertPayload).toMatchObject({ relationship_type: "belongs_to" });
	});

	it("enforces for resource sources too (resources are single-primary-parent, same as projects)", async () => {
		mockSupabaseFrom({
			entities: endpointsWithTypes([
				{ id: PROJECT_ID, entity_type: "resource" },
				{ id: AREA_TECH_ID, entity_type: "area" },
			]),
			entity_relationships: relationshipsStub({
				guardRows: [{ id: "edge-old", to_entity_id: AREA_BUSINESS_ID }],
			}),
		});

		await expect(
			relateEntitiesHandler({
				from_entity_id: PROJECT_ID,
				to_entity_id: AREA_TECH_ID,
				relationship_type: "belongs_to",
			} as any),
		).rejects.toThrow(/2nd primary containment parent/);
	});

	it("skips the guard when archive: true — archiving can never create a 2nd parent", async () => {
		const guardQueryCount = { count: 0 };
		mockSupabaseFrom({
			entities: endpointsWithTypes([
				{ id: PROJECT_ID, entity_type: "project" },
				{ id: AREA_BUSINESS_ID, entity_type: "area" },
			]),
			entity_relationships: relationshipsStub({
				guardQueryCount,
				dedupResult: {
					data: { id: "edge-old", archived: false, valid_from: null, valid_to: null },
					error: null,
				},
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: PROJECT_ID,
			to_entity_id: AREA_BUSINESS_ID,
			relationship_type: "belongs_to",
			archive: true,
		} as any);

		expect(guardQueryCount.count).toBe(0);
		expect(result.content[0].text).toContain("Archived edge edge-old");
	});
});
