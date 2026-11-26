import { describe, expect, it, vi } from "vitest";
import { createSupabaseGraphReadAdapter } from "./graphRead.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ENTITY_ID = "11111111-1111-4111-8111-111111111111";

describe("createSupabaseGraphReadAdapter (#1491)", () => {
	it("scopes entity lookup and query by user_id and surfaces Lookup/Query failed errors", async () => {
		const eqCalls: unknown[][] = [];
		const client: any = {
			from: vi.fn(() => {
				const b: any = {
					select: () => b,
					eq: (...args: unknown[]) => {
						eqCalls.push(args);
						return b;
					},
					ilike: () => b,
					contains: () => b,
					maybeSingle: async () => ({
						data: { id: ENTITY_ID, entity_type: "people", title: "Ada", properties: {} },
						error: null,
					}),
					limit: async () => ({ data: [], error: { message: "db boom" } }),
				};
				return b;
			}),
		};
		const adapter = createSupabaseGraphReadAdapter({ client });
		const row = await adapter.getStartingEntityById(ENTITY_ID, USER_ID);
		expect(row?.title).toBe("Ada");
		expect(eqCalls).toContainEqual(["user_id", USER_ID]);

		await expect(
			adapter.queryStartingEntities({ entity_type: "people", limit: 10 }, USER_ID),
		).rejects.toThrow("Query failed: db boom");
	});
});
