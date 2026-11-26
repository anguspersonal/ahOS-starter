import { describe, expect, it, vi } from "vitest";
import { createSupabaseGraphEdgeAdapter, isGraphEdgeValidAt } from "./graphEdges.js";

describe("createSupabaseGraphEdgeAdapter", () => {
	it("isGraphEdgeValidAt handles open and bounded validity windows", () => {
		expect(isGraphEdgeValidAt(null, null, "2026-06-01T00:00:00Z")).toBe(true);
		expect(isGraphEdgeValidAt("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "2026-06-01T00:00:00Z")).toBe(true);
		expect(isGraphEdgeValidAt("2026-07-01T00:00:00Z", null, "2026-06-01T00:00:00Z")).toBe(false);
		expect(isGraphEdgeValidAt(null, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z")).toBe(false);
	});

	it("listEdges filters by userId, direction, archived, edgeTypes, and asOf", async () => {
		const eqCalls: Array<[string, unknown]> = [];
		const inCalls: Array<[string, unknown]> = [];
		const builder: any = {
			select: vi.fn(() => builder),
			eq: vi.fn((col: string, val: unknown) => {
				eqCalls.push([col, val]);
				return builder;
			}),
			in: vi.fn((col: string, val: unknown) => {
				inCalls.push([col, val]);
				return builder;
			}),
			then: (resolve: any) =>
				resolve({
					data: [
						{
							from_entity_id: "a",
							to_entity_id: "b",
							relationship_type: "belongs_to",
							valid_from: "2026-01-01T00:00:00Z",
							valid_to: null,
							archived: false,
						},
						{
							from_entity_id: "a",
							to_entity_id: "c",
							relationship_type: "belongs_to",
							valid_from: "2027-01-01T00:00:00Z",
							valid_to: null,
							archived: false,
						},
					],
					error: null,
				}),
		};
		const supabase: any = { from: vi.fn(() => builder) };
		const adapter = createSupabaseGraphEdgeAdapter(supabase);

		const edges = await adapter.listEdges({
			userId: "u1",
			frontier: ["a"],
			direction: "out",
			edgeTypes: ["belongs_to"],
			includeArchived: false,
			asOf: "2026-06-01T00:00:00Z",
		});

		expect(edges).toHaveLength(1);
		expect(edges[0]?.to_entity_id).toBe("b");
		expect(eqCalls).toContainEqual(["user_id", "u1"]);
		expect(eqCalls).toContainEqual(["archived", false]);
		expect(inCalls).toContainEqual(["from_entity_id", ["a"]]);
		expect(inCalls).toContainEqual(["relationship_type", ["belongs_to"]]);
	});

	it("listArtifactHops links co-mentioned entities across shared artifacts", async () => {
		let callCount = 0;
		const supabase: any = {
			from: vi.fn(() => {
				callCount++;
				const currentCall = callCount;
				const builder: any = {
					select: vi.fn(() => builder),
					eq: vi.fn(() => builder),
					in: vi.fn(() => builder),
					then: (resolve: any) =>
						resolve({
							data:
								currentCall === 1
									? [{ entity_id: "a", artifact_id: "art-1" }]
									: [
											{ entity_id: "a", artifact_id: "art-1" },
											{ entity_id: "b", artifact_id: "art-1" },
										],
							error: null,
						}),
				};
				return builder;
			}),
		};
		const adapter = createSupabaseGraphEdgeAdapter(supabase);
		const hops = await adapter.listArtifactHops({ userId: "u1", frontier: ["a"] });
		expect(hops).toEqual([
			{ from_entity_id: "a", to_entity_id: "b", relationship_type: "co_mentioned" },
		]);
	});
});
