import { describe, it, expect } from "vitest";
import * as core from "./index.js";

describe("@ahkms/core isomorphic contract integrity (#1319)", () => {
	it("exports all core action primitives and registry", () => {
		expect(core.ActionRegistry).toBeDefined();
		expect(core.defineAction).toBeDefined();
		expect(core.executeAction).toBeDefined();
	});

	it("exports domain constants and action schemas", () => {
		expect(core.DOMAINS).toBeDefined();
		expect(Array.isArray(core.DOMAINS)).toBe(true);
		expect(core.entityCrudSchema).toBeDefined();
		expect(core.taskCrudSchema).toBeDefined();
		expect(core.decisionReviewSchema).toBeDefined();
	});

	it("does not export Node-only utilities or leakage from shared", () => {
		// Verify that Node-only utilities from shared (like urlFetch / fetchUrlSafely)
		// are not re-exported by @ahkms/core
		expect((core as Record<string, unknown>).fetchUrlSafely).toBeUndefined();
		expect((core as Record<string, unknown>).MAX_RESPONSE_BYTES).toBeUndefined();
		expect((core as Record<string, unknown>).createSupabaseClient).toBeUndefined();
	});

	it("can instantiate and use ActionRegistry in an isolated isomorphic runtime", async () => {
		const registry = new core.ActionRegistry();
		const testAction = core.defineAction({
			id: "test:isomorphic",
			domain: "governance",
			description: "Isomorphic action test",
			schema: core.decisionReviewSchema,
			run: async (input) => ({
				echo: input.review_type,
			}),
		});

		registry.register(testAction);
		const retrieved = registry.get("test:isomorphic");
		expect(retrieved).toBeDefined();
		expect(retrieved?.id).toBe("test:isomorphic");

		const result = await retrieved?.run(
			{
				review_type: "daily_log",
			},
			{ userId: "test-user" },
		);
		expect(result).toEqual({ echo: "daily_log" });
	});
});
