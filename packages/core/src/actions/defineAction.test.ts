import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createActionContext, defineAction } from "./defineAction.js";

describe("defineAction in @ahkms/core", () => {
	it("constructs a valid action definition with annotations and defaults", () => {
		const sampleAction = defineAction({
			id: "test_echo",
			description: "Echoes the input back",
			domain: "kg",
			schema: z.object({
				message: z.string(),
			}),
			outputSchema: z.object({
				echoed: z.string(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			run: async (input) => ({ echoed: input.message }),
		});

		expect(sampleAction.id).toBe("test_echo");
		expect(sampleAction.name).toBe("test_echo");
		expect(sampleAction.description).toBe("Echoes the input back");
		expect(sampleAction.domain).toBe("kg");
		expect(sampleAction.annotations.readOnlyHint).toBe(true);
		expect(sampleAction.annotations.destructiveHint).toBe(false);
	});

	it("honors destructive and idempotent annotations", () => {
		const deleteAction = defineAction({
			id: "test_delete",
			description: "Deletes a resource",
			schema: z.object({ id: z.string() }),
			annotations: {
				destructiveHint: true,
				idempotentHint: true,
			},
			run: async () => ({ deleted: true }),
		});

		expect(deleteAction.annotations.destructiveHint).toBe(true);
		expect(deleteAction.annotations.idempotentHint).toBe(true);
	});

	it("throws if required parameters are missing", () => {
		expect(() =>
			defineAction({
				id: "",
				description: "Desc",
				schema: z.object({}),
				run: async () => ({}),
			}),
		).toThrow(/Action id must be a non-empty string/);

		expect(() =>
			defineAction({
				id: "sample",
				description: "",
				schema: z.object({}),
				run: async () => ({}),
			}),
		).toThrow(/description must be a non-empty string/);
	});

	it("createActionContext constructs defaults and preserves overrides", () => {
		const ctx = createActionContext({ domain: "work", userId: "usr_123" });
		expect(ctx.domain).toBe("work");
		expect(ctx.userId).toBe("usr_123");
		expect(ctx.caller).toBe("test");
		expect(typeof ctx.requestId).toBe("string");
	});

	it("copies mcpStructured hook through when provided (#2333)", () => {
		const hook = (result: { id: string; secret: string }) => ({ id: result.id });
		const action = defineAction({
			id: "test_mcp_structured",
			description: "Action with mcpStructured hook",
			schema: z.object({}),
			run: async () => ({ id: "1", secret: "s" }),
			mcpStructured: hook,
		});

		expect(action.mcpStructured).toBe(hook);
	});
});
