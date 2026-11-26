import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionRegistry } from "./registry.js";
import { defineAction } from "./defineAction.js";

describe("ActionRegistry", () => {
	it("registers and retrieves actions by ID", () => {
		const registry = new ActionRegistry();

		const testAction = defineAction({
			id: "test_action_1",
			description: "First test action",
			domain: "kg",
			schema: z.object({ value: z.string() }),
			run: async ({ value }) => ({ echo: value }),
		});

		expect(registry.has("test_action_1")).toBe(false);
		registry.register(testAction);
		expect(registry.has("test_action_1")).toBe(true);
		expect(registry.get("test_action_1")).toBe(testAction);
		expect(registry.size).toBe(1);
	});

	it("throws on empty or invalid action ID", () => {
		const registry = new ActionRegistry();

		expect(() =>
			registry.register({
				id: "",
				name: "",
				description: "Invalid",
				schema: z.object({}),
				annotations: {},
				run: async () => {},
			}),
		).toThrow(/Action must have a valid non-empty id/);
	});

	it("prevents duplicate action registration", () => {
		const registry = new ActionRegistry();

		const actionA = defineAction({
			id: "duplicate_action",
			description: "Version A",
			schema: z.object({}),
			run: async () => "A",
		});

		const actionB = defineAction({
			id: "duplicate_action",
			description: "Version B",
			schema: z.object({}),
			run: async () => "B",
		});

		registry.register(actionA);
		expect(() => registry.register(actionB)).toThrow(
			/Action "duplicate_action" is already registered in CAR/,
		);
	});

	it("filters actions by domain and readOnlyHint", () => {
		const registry = new ActionRegistry();

		const readKgAction = defineAction({
			id: "kg_read",
			description: "Read KG",
			domain: "kg",
			annotations: { readOnlyHint: true },
			schema: z.object({}),
			run: async () => "kg_read",
		});

		const writeKgAction = defineAction({
			id: "kg_write",
			description: "Write KG",
			domain: "kg",
			annotations: { readOnlyHint: false },
			schema: z.object({}),
			run: async () => "kg_write",
		});

		const readParaAction = defineAction({
			id: "para_read",
			description: "Read PARA",
			domain: "para",
			annotations: { readOnlyHint: true },
			schema: z.object({}),
			run: async () => "para_read",
		});

		registry.register(readKgAction);
		registry.register(writeKgAction);
		registry.register(readParaAction);

		expect(registry.list()).toHaveLength(3);
		expect(registry.list({ domain: "kg" })).toEqual([readKgAction, writeKgAction]);
		expect(registry.list({ domain: "para" })).toEqual([readParaAction]);
		expect(registry.list({ readOnly: true })).toEqual([readKgAction, readParaAction]);
		expect(registry.list({ domain: "kg", readOnly: true })).toEqual([readKgAction]);
	});

	it("executes registered actions directly with input validation", async () => {
		const registry = new ActionRegistry();

		const calcAction = defineAction({
			id: "calculate_sum",
			description: "Sums numbers",
			schema: z.object({ x: z.number(), y: z.number() }),
			run: async ({ x, y }) => ({ sum: x + y }),
		});

		registry.register(calcAction);

		const result = await registry.execute<{ x: number; y: number }, { sum: number }>(
			"calculate_sum",
			{ x: 7, y: 14 },
		);
		expect(result).toEqual({ sum: 21 });
	});

	it("throws when executing an unregistered action", async () => {
		const registry = new ActionRegistry();

		await expect(registry.execute("unknown_id", {})).rejects.toThrow(
			/Action "unknown_id" is not registered in CAR/,
		);
	});
});
