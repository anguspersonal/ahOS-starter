import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "./defineAction.js";
import { ActionRegistry } from "./registry.js";

describe("ActionRegistry in @ahkms/core", () => {
	it("registers and retrieves actions", () => {
		const registry = new ActionRegistry();
		const testAction = defineAction({
			id: "kg_lookup",
			description: "Lookup entities in KG",
			domain: "kg",
			schema: z.object({ id: z.string() }),
			run: async (input) => ({ found: input.id }),
		});

		registry.register(testAction);
		expect(registry.has("kg_lookup")).toBe(true);
		expect(registry.get("kg_lookup")).toBe(testAction);
		expect(registry.size).toBe(1);
	});

	it("prevents duplicate action registration", () => {
		const registry = new ActionRegistry();
		const actionA = defineAction({
			id: "action_x",
			description: "X",
			schema: z.object({}),
			run: async () => ({}),
		});
		registry.register(actionA);

		expect(() => registry.register(actionA)).toThrow(/already registered in CAR/);
	});

	it("filters actions by domain and readOnly", () => {
		const registry = new ActionRegistry();
		registry.register(
			defineAction({
				id: "read_kg",
				description: "Read KG",
				domain: "kg",
				schema: z.object({}),
				annotations: { readOnlyHint: true },
				run: async () => ({}),
			}),
		);
		registry.register(
			defineAction({
				id: "write_kg",
				description: "Write KG",
				domain: "kg",
				schema: z.object({}),
				annotations: { readOnlyHint: false },
				run: async () => ({}),
			}),
		);
		registry.register(
			defineAction({
				id: "read_para",
				description: "Read PARA",
				domain: "para",
				schema: z.object({}),
				annotations: { readOnlyHint: true },
				run: async () => ({}),
			}),
		);

		const kgActions = registry.list({ domain: "kg" });
		expect(kgActions).toHaveLength(2);

		const readOnlyActions = registry.list({ readOnly: true });
		expect(readOnlyActions).toHaveLength(2);

		const kgReadOnly = registry.list({ domain: "kg", readOnly: true });
		expect(kgReadOnly).toHaveLength(1);
		expect(kgReadOnly[0]?.id).toBe("read_kg");
	});

	it("executes registered actions directly", async () => {
		const registry = new ActionRegistry();
		registry.register(
			defineAction({
				id: "calc_add",
				description: "Add two numbers",
				schema: z.object({ a: z.number(), b: z.number() }),
				run: async (input) => ({ sum: input.a + input.b }),
			}),
		);

		const res = await registry.execute<{ a: number; b: number }, { sum: number }>(
			"calc_add",
			{ a: 10, b: 20 },
		);
		expect(res.sum).toBe(30);
	});
});
