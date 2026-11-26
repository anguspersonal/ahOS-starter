import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	relationshipCrudAction,
	resolveRelationshipEndpoints,
} from "../actions/relationships.js";
import { executeAction } from "@ahkms/core";

// Mock supabase client
vi.mock("../supabase.js", () => {
	const tableData: Record<string, any[]> = {
		entity_relationships: [],
	};

	return {
		supabase: {
			from: (table: string) => {
				const rows = tableData[table] || [];
				let currentRows = [...rows];
				let singleMode = false;
				let maybeSingleMode = false;

				const builder: any = {
					select: vi.fn(() => builder),
					insert: vi.fn((record: any) => {
						const inserted = { ...record };
						rows.push(inserted);
						currentRows = [inserted];
						return builder;
					}),
					update: vi.fn((patch: any) => {
						for (const r of currentRows) {
							Object.assign(r, patch);
						}
						return builder;
					}),
					delete: vi.fn(() => {
						for (const r of currentRows) {
							const idx = rows.indexOf(r);
							if (idx !== -1) rows.splice(idx, 1);
						}
						return builder;
					}),
					eq: vi.fn((col: string, val: any) => {
						currentRows = currentRows.filter((r) => r[col] === val);
						return builder;
					}),
					or: vi.fn((condition: string) => {
						// Mock simple OR filter: from_entity_id.eq.X,to_entity_id.eq.X
						const match = condition.match(/from_entity_id\.eq\.([^,]+),to_entity_id\.eq\.([^,]+)/);
						if (match) {
							const id1 = match[1];
							const id2 = match[2];
							currentRows = currentRows.filter(
								(r) => r.from_entity_id === id1 || r.to_entity_id === id2,
							);
						}
						return builder;
					}),
					order: vi.fn(() => builder),
					limit: vi.fn((n: number) => {
						currentRows = currentRows.slice(0, n);
						return builder;
					}),
					single: vi.fn(async () => {
						if (currentRows.length === 0) throw new Error("No rows found");
						return { data: currentRows[0], error: null };
					}),
					maybeSingle: vi.fn(async () => {
						return { data: currentRows[0] || null, error: null };
					}),
					then: (resolve: any) => {
						return resolve({ data: currentRows, error: null });
					},
				};
				return builder;
			},
		},
	};
});

describe("relationship_crud Action (server-side CAR)", () => {
	const nodeA = "11111111-aaaa-4111-8111-111111111111";
	const nodeB = "22222222-bbbb-4222-8222-222222222222";
	const nodeC = "33333333-cccc-4333-8333-333333333333";

	it("resolves endpoints for child role (focal -> target)", () => {
		const res = resolveRelationshipEndpoints(nodeA, nodeB, "child");
		expect(res.fromId).toBe(nodeA);
		expect(res.toId).toBe(nodeB);
		expect(res.relType).toBe("contains");
	});

	it("resolves endpoints for parent role (target -> focal)", () => {
		const res = resolveRelationshipEndpoints(nodeA, nodeC, "parent");
		expect(res.fromId).toBe(nodeC);
		expect(res.toId).toBe(nodeA);
		expect(res.relType).toBe("contains");
	});

	it("resolves endpoints for sibling role", () => {
		const res = resolveRelationshipEndpoints(nodeA, nodeB, "sibling");
		expect(res.fromId).toBe(nodeA);
		expect(res.toId).toBe(nodeB);
		expect(res.relType).toBe("siblingOf");
	});

	it("executes create relationship action via executeAction", async () => {
		const result = await executeAction(
			relationshipCrudAction,
			{
				operation: "create",
				from_entity_id: nodeA,
				to_entity_id: nodeB,
				role: "child",
				confidence_score: 0.9,
			},
			{
				context: {
					caller: "ui",
					userId: "user-123",
					requestId: "req-1",
				},
			},
		);

		expect(result.success).toBe(true);
		expect(result.operation).toBe("create");
		expect(result.relationship).toBeDefined();
		expect(result.relationship?.from_entity_id).toBe(nodeA);
		expect(result.relationship?.to_entity_id).toBe(nodeB);
	});

	it("rejects self-referencing relationships", async () => {
		await expect(
			executeAction(relationshipCrudAction, {
				operation: "create",
				from_entity_id: nodeA,
				to_entity_id: nodeA,
			}),
		).rejects.toThrow(/differ/i);
	});
});
