import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createActionContext, defineAction } from "./index.js";

describe("defineAction", () => {
	it("defines a valid action with inferred input and output types", async () => {
		const sampleAction = defineAction({
			id: "sample_add",
			description: "Add two numbers together.",
			schema: z.object({
				a: z.number(),
				b: z.number(),
			}),
			outputSchema: z.object({
				result: z.number(),
			}),
			run: async ({ a, b }, ctx) => {
				expect(ctx.caller).toBe("test");
				return { result: a + b };
			},
		});

		expect(sampleAction.id).toBe("sample_add");
		expect(sampleAction.name).toBe("sample_add");
		expect(sampleAction.description).toBe("Add two numbers together.");
		expect(sampleAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});

		const ctx = createActionContext({ caller: "test" });
		const out = await sampleAction.run({ a: 10, b: 20 }, ctx);
		expect(out).toEqual({ result: 30 });
	});

	it("preserves custom name and annotations configuration", () => {
		const deleteAction = defineAction({
			id: "delete_record",
			name: "Delete Record",
			description: "Permanently delete a record.",
			schema: z.object({
				id: z.string().uuid(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
			run: async ({ id }) => {
				return { deletedId: id };
			},
		});

		expect(deleteAction.id).toBe("delete_record");
		expect(deleteAction.name).toBe("Delete Record");
		expect(deleteAction.annotations.destructiveHint).toBe(true);
		expect(deleteAction.annotations.idempotentHint).toBe(true);
		expect(deleteAction.annotations.readOnlyHint).toBe(false);
	});

	it("validates action constructor preconditions", () => {
		// Missing or invalid id
		expect(() =>
			defineAction({
				id: "",
				description: "Desc",
				schema: z.object({}),
				run: async () => {},
			}),
		).toThrow(/Action id must be a non-empty string/);

		// Missing description
		expect(() =>
			defineAction({
				id: "test_id",
				description: "",
				schema: z.object({}),
				run: async () => {},
			}),
		).toThrow(/description must be a non-empty string/);

		// Missing schema
		expect(() =>
			defineAction({
				id: "test_id",
				description: "Desc",
				schema: null as unknown as z.ZodTypeAny,
				run: async () => {},
			}),
		).toThrow(/requires an input schema/);

		// Missing run function
		expect(() =>
			defineAction({
				id: "test_id",
				description: "Desc",
				schema: z.object({}),
				run: null as unknown as () => Promise<void>,
			}),
		).toThrow(/requires an async run function/);
	});
});

describe("createActionContext", () => {
	it("supplies default context parameters", () => {
		const ctx = createActionContext();
		expect(ctx.caller).toBe("test");
		expect(typeof ctx.requestId).toBe("string");
		expect(ctx.requestId.length).toBeGreaterThan(0);
		expect(ctx.domain).toBeUndefined();
		expect(ctx.userId).toBeUndefined();
	});

	it("applies context overrides correctly", () => {
		const ctx = createActionContext({
			caller: "mcp",
			domain: "work",
			userId: "usr_12345",
			requestId: "req_fixed_id",
			metadata: { surface: "chat" },
		});

		expect(ctx.caller).toBe("mcp");
		expect(ctx.domain).toBe("work");
		expect(ctx.userId).toBe("usr_12345");
		expect(ctx.requestId).toBe("req_fixed_id");
		expect(ctx.metadata).toEqual({ surface: "chat" });
	});
});
